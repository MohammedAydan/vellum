/**
 * `packages/database-control/src/migrations-runner.ts`
 * Idempotent SQL migration runner for the Control Plane (`control_db`) and
 * Data Plane (`data_db`) databases.
 *
 * Guarantees:
 *  - A session-scoped PostgreSQL advisory lock serialises concurrent runners, so two
 *    containers / CLI invocations can never interleave DDL on the same database.
 *  - Migrations are applied in lexical filename order.
 *  - Each file runs inside its own transaction; a failing migration rolls back only itself.
 *  - Applied filenames are recorded in `schema_migrations` and skipped on re-run.
 *  - A content checksum is stored so drift on an already-applied file is detected loudly.
 *
 * Used by `scripts/migrate.ts` (CLI), by `scripts/docker-entrypoint.sh` (pre-boot
 * container hook) and by `tests/e2e-real` (programmatic bootstrap). Migrations MUST
 * run BEFORE the API container starts serving: see docs/operations/container-startup.md.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RawPgClient } from "./raw-sql.js";

export interface AppliedMigration {
  filename: string;
  applied: boolean;
  durationMs: number;
  checksum: string;
}

export interface MigrationRunResult {
  label: string;
  directory: string;
  applied: AppliedMigration[];
  alreadyApplied: string[];
}

export interface MigrationStatusRow {
  filename: string;
  appliedAt: string;
  checksum: string;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAX_ADVISORY_LOCK_TIMEOUT_MS = 3_600_000;
const MAX_MIGRATION_FILE_BYTES = 16 * 1024 * 1024; // 16 MiB safety cap

function timingSafeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** `packages/database-control/migrations` — resolves identically from `src/` and `dist/`. */
export function controlMigrationsDir(): string {
  return path.resolve(MODULE_DIR, "..", "migrations");
}

/** `packages/database-data/migrations` — resolves identically from `src/` and `dist/`. */
export function dataMigrationsDir(): string {
  return path.resolve(MODULE_DIR, "..", "..", "database-data", "migrations");
}

/** SHA-256 of the migration file contents — also used by the readiness probe for drift detection. */
export function checksumOfSql(sql: string): string {
  return crypto.createHash("sha256").update(sql, "utf8").digest("hex");
}

/** One pinned historical repair, shared by migration execution and readiness. */
export function isMigrationChecksumCompatible(
  label: string,
  filename: string,
  recordedChecksum: string,
  currentChecksum: string
): boolean {
  if (timingSafeHexEqual(recordedChecksum, currentChecksum)) return true;
  return label === "data_db" && filename === "0013_vellum_rebrand.sql"
    && recordedChecksum === "636e94d843980b47344ba6edc43d187959d4db3887ab65a9a09670d098d2ec06"
    && currentChecksum === "aab0460c41b187ae7119caa508892c7fb04f152c1fe9af5d1ccd3d4442840720";
}

/** Migration filenames in lexical (application) order — shared with the readiness probe. */
export function listMigrationFiles(directory: string): string[] {
  if (typeof directory !== "string" || directory.length === 0 || directory.includes("\0")) {
    throw new Error("Invalid migration directory path");
  }
  if (!fs.existsSync(directory)) {
    throw new Error(`Migration directory not found: ${directory}`);
  }
  const dirStat = fs.statSync(directory);
  if (!dirStat.isDirectory()) {
    throw new Error(`Migration path is not a directory: ${directory}`);
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries
    .filter((entry) => {
      if (!entry.isFile()) return false;
      const name = entry.name;
      if (!name.toLowerCase().endsWith(".sql")) return false;
      if (name.includes("/") || name.includes("\\") || name.includes("..") || name.includes("\0")) {
        return false;
      }
      return true;
    })
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function ensureMigrationTable(client: RawPgClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/**
 * 31-bit FNV-1a — the same stable hash family used by the OCC row locks in
 * `pg-store.ts`. Two-key advisory locks are cluster-wide, so a control-plane and a
 * data-plane runner starting at the same time also serialise against each other.
 * Namespace constant 903 fixes the advisory-lock key for all deployments.
 */
function fnv1a31(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash & 0x7fffffff;
}

export const MIGRATION_ADVISORY_LOCK = Object.freeze({
  namespace: "vellum:migrations",
  key1: fnv1a31("vellum:migrations"),
  key2: 903,
});

export interface AdvisoryLockOptions {
  /** Maximum time to WAIT for the lock; does not limit the migrations themselves. */
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

/**
 * Holds a session-scoped PostgreSQL advisory lock for the whole migration run.
 * Each migration still commits in its own transaction, so a session-level lock
 * (not `pg_advisory_xact_lock`) is required — the latter would be released at the
 * first `COMMIT`. The lock is released in `finally`, including on checksum drift.
 */
export async function withMigrationAdvisoryLock<T>(
  client: RawPgClient,
  work: () => Promise<T>,
  { timeoutMs = 15_000, onProgress }: AdvisoryLockOptions = {}
): Promise<T> {
  const { key1, key2 } = MIGRATION_ADVISORY_LOCK;
  const numericTimeout =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? timeoutMs : 15_000;
  const boundedMs = Math.min(MAX_ADVISORY_LOCK_TIMEOUT_MS, Math.max(1, Math.floor(numericTimeout)));
  onProgress?.(`[advisory-lock] acquiring (${String(key1)},${String(key2)}) timeout=${String(boundedMs)}ms`);

  let acquired = false;
  try {
    await client.query("SELECT set_config('statement_timeout', $1, false)", [`${boundedMs}ms`]);
    await client.query("SELECT pg_advisory_lock($1::int, $2::int)", [key1, key2]);
    acquired = true;
  } finally {
    try {
      await client.query("RESET statement_timeout");
    } catch {
      // Connection may be broken; the acquire error (if any) is the root cause.
    }
  }
  if (!acquired) throw new Error("[advisory-lock] migration lock could not be acquired");
  onProgress?.("[advisory-lock] acquired");

  let workResult: T | undefined;
  let workError: unknown;
  let hasWorkError = false;
  try {
    workResult = await work();
  } catch (err: unknown) {
    hasWorkError = true;
    workError = err;
  }

  // Always release the session-level lock before returning or propagating an error.
  // The unlock error is captured (not thrown from a `finally`) so it can never mask
  // the original migration failure.
  let unlockError: unknown;
  let hasUnlockError = false;
  try {
    await client.query("SELECT pg_advisory_unlock($1::int, $2::int)", [key1, key2]);
    onProgress?.("[advisory-lock] released");
  } catch (unlockErr: unknown) {
    hasUnlockError = true;
    unlockError = unlockErr;
  }

  if (hasWorkError) throw workError;
  if (hasUnlockError) throw unlockError;
  return workResult as T;
}

export interface RunMigrationsOptions {
  client: RawPgClient;
  directory: string;
  label: string;
  /** When true, only report what would run. */
  dryRun?: boolean;
  onProgress?: (message: string) => void;
  /** Override the advisory-lock acquisition timeout (milliseconds). */
  advisoryLockTimeoutMs?: number;
}

/** Applies every not-yet-applied migration in `directory` under the advisory lock. */
export async function runMigrationsOnClient(options: RunMigrationsOptions): Promise<MigrationRunResult> {
  return withMigrationAdvisoryLock(
    options.client,
    () => runMigrationsUnlocked(options),
    {
      ...(options.advisoryLockTimeoutMs !== undefined
        ? { timeoutMs: options.advisoryLockTimeoutMs }
        : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    }
  );
}

async function runMigrationsUnlocked({
  client,
  directory,
  label,
  dryRun = false,
  onProgress,
}: RunMigrationsOptions): Promise<MigrationRunResult> {
  const log = onProgress ?? (() => {});
  await ensureMigrationTable(client);

  const { rows } = await client.query<{ filename: string; checksum: string }>(
    "SELECT filename, checksum FROM schema_migrations"
  );
  const appliedChecksums = new Map(rows.map((r) => [r.filename, r.checksum]));

  const resolvedDir = path.resolve(directory);
  const dirPrefix = resolvedDir.endsWith(path.sep) ? resolvedDir : `${resolvedDir}${path.sep}`;
  const result: MigrationRunResult = { label, directory, applied: [], alreadyApplied: [] };

  for (const filename of listMigrationFiles(directory)) {
    const fullPath = path.resolve(resolvedDir, filename);
    if (!fullPath.startsWith(dirPrefix)) {
      throw new Error(`[${label}] Refusing to read migration outside directory: '${filename}'`);
    }
    const stat = fs.statSync(fullPath);
    if (stat.size > MAX_MIGRATION_FILE_BYTES) {
      throw new Error(
        `[${label}] Migration '${filename}' exceeds maximum size (${MAX_MIGRATION_FILE_BYTES} bytes)`
      );
    }

    const sql = fs.readFileSync(fullPath, "utf8");
    const checksum = checksumOfSql(sql);
    const previousChecksum = appliedChecksums.get(filename);

    if (previousChecksum !== undefined) {
      // One documented repair exception: the original data-plane rebrand renamed
      // a cluster-global role. Accept only its exact historical bytes paired
      // with the exact safe replacement; 0014 repairs already-applied databases.
      if (!isMigrationChecksumCompatible(label, filename, previousChecksum, checksum)) {
        throw new Error(
          `[${label}] Migration '${filename}' was already applied with a different checksum. ` +
            `Migrations are immutable — add a new migration instead of editing '${filename}'.`
        );
      }
      result.alreadyApplied.push(filename);
      log(`[${label}] skip     ${filename} (already applied)`);
      continue;
    }

    if (dryRun) {
      log(`[${label}] pending  ${filename}`);
      result.applied.push({ filename, applied: false, durationMs: 0, checksum });
      continue;
    }

    const startedAt = Date.now();
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [
        filename,
        checksum,
      ]);
      await client.query("COMMIT");
    } catch (err: unknown) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Connection may already be broken; the original error is what matters.
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[${label}] Migration '${filename}' failed and was rolled back: ${message}`);
    }

    const durationMs = Date.now() - startedAt;
    result.applied.push({ filename, applied: true, durationMs, checksum });
    log(`[${label}] applied  ${filename} (${durationMs}ms)`);
  }

  return result;
}

/** Returns the recorded migrations for a database (empty when the table does not exist yet). */
export async function getMigrationStatus(client: RawPgClient): Promise<MigrationStatusRow[]> {
  const { rows } = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists"
  );
  if (!rows[0]?.exists) return [];
  const status = await client.query<{ filename: string; applied_at: Date | string; checksum: string }>(
    "SELECT filename, applied_at, checksum FROM schema_migrations ORDER BY filename ASC"
  );
  return status.rows.map((row) => ({
    filename: row.filename,
    appliedAt:
      row.applied_at instanceof Date ? row.applied_at.toISOString() : String(row.applied_at),
    checksum: row.checksum,
  }));
}
