#!/usr/bin/env node
/**
 * `scripts/dr-drill.ts` — automated PostgreSQL disaster-recovery drill.
 *
 * Dumps the live DATA PLANE with `pg_dump -Fc`, restores it into a dedicated,
 * disposable validation database with `pg_restore`, and proves fidelity with:
 *   - exact per-table row counts,
 *   - SHA-256 content checksums over every row (deterministic ORDER BY),
 *   - RLS policy parity including the required 4 data-plane isolation policies,
 *   - `pg_class.relrowsecurity` parity,
 *   - `schema_migrations` parity.
 *
 * SAFETY:
 *   - The source database is only ever READ. `pg_dump` and SELECTs only.
 *   - The target must be a different database whose name looks like a scratch/DR
 *     database, and `--allow-target-reset` is required before `DROP SCHEMA`.
 *   - Connection strings are loaded with dotenv from `.env.phase5.local`. They are
 *     NEVER printed: child processes receive discrete PG* env vars, so no URL or
 *     password appears in argv or logs.
 *
 * Usage:
 *   npx tsx scripts/dr-drill.ts --dry-run
 *   npx tsx scripts/dr-drill.ts --execute --allow-target-reset
 *   npx tsx scripts/dr-drill.ts --verify-only
 *   npx tsx scripts/dr-drill.ts --help
 */

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRawPgClient, loadEnvFiles, type RawPgClient } from "../packages/database-control/src/index.js";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const TMP_DIR = "/tmp/opencode";

/** Tables with a deterministic primary key used for checksum ordering. */
const CHECKSUM_TABLES: ReadonlyArray<{ name: string; orderBy: string }> = [
  { name: "documents", orderBy: "project_id, path" },
  { name: "document_indexes", orderBy: "id" },
  { name: "document_index_entries", orderBy: "index_id, sort_key, document_id" },
  { name: "realtime_outbox", orderBy: "seq_id" },
];

const ISOLATION_TABLES = [
  "documents",
  "document_indexes",
  "document_index_entries",
  "realtime_outbox",
] as const;

interface CliOptions {
  mode: "dry-run" | "execute" | "verify-only";
  envFile: string;
  targetDb: string;
  allowTargetReset: boolean;
  keepDump: boolean;
}

interface DbEnv {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  sslmode: string;
  childEnv: NodeJS.ProcessEnv;
}

interface TableSnapshot {
  table: string;
  count: number;
  checksum: string;
}

interface PolicySnapshot {
  total: number;
  isolation: number;
  names: string[];
  rls: Array<{ table: string; enabled: boolean; forced: boolean }>;
}

interface Snapshot {
  database: string;
  tables: TableSnapshot[];
  policies: PolicySnapshot;
  migrations: string[];
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: "dry-run",
    envFile: path.join(REPO_ROOT, ".env.phase5.local"),
    targetDb: process.env.DR_RESTORE_DATABASE ?? "phase5_restore",
    allowTargetReset: false,
    keepDump: false,
  };
  for (const arg of argv) {
    if (arg === "--dry-run") options.mode = "dry-run";
    else if (arg === "--execute") options.mode = "execute";
    else if (arg === "--verify-only") options.mode = "verify-only";
    else if (arg === "--allow-target-reset") options.allowTargetReset = true;
    else if (arg === "--keep-dump") options.keepDump = true;
    else if (arg.startsWith("--env-file=")) options.envFile = arg.slice("--env-file=".length);
    else if (arg.startsWith("--target-db=")) options.targetDb = arg.slice("--target-db=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: npx tsx scripts/dr-drill.ts [mode] [options]",
          "  Modes: --dry-run (default, read-only) | --execute | --verify-only",
          "  Options: --env-file=<path>  --target-db=<name>  --allow-target-reset  --keep-dump",
          "  Env: DR_RESTORE_DATABASE selects the disposable validation database.",
        ].join("\n")
      );
      process.exit(0);
    } else throw new Error(`Unknown argument '${arg}'`);
  }
  return options;
}

/** dotenv is a dependency of @vellum/api, not of the workspace root. Resolve it there. */
function loadDotenv(envFile: string): void {
  const require = createRequire(import.meta.url);
  try {
    const dotenvPath = require.resolve("dotenv", { paths: [path.join(REPO_ROOT, "apps/api")] });
    const dotenv = require(dotenvPath) as {
      config(options: { path: string; override?: boolean }): { error?: Error };
    };
    const result = dotenv.config({ path: envFile, override: false });
    if (result.error) throw result.error;
    console.log(`Loaded configuration with dotenv from ${path.relative(REPO_ROOT, envFile)}`);
    return;
  } catch (err) {
    // Defensive fallback: the repo's dependency-free parser used by other scripts.
    const loaded = loadEnvFiles([envFile]);
    if (!loaded) throw err;
    console.log(`Loaded configuration with built-in parser from ${path.relative(REPO_ROOT, loaded.path)}`);
  }
}

function sanitize(text: string): string {
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "[REDACTED_URL]")
    .replace(/(password|sslpassword)=[^\s&'"]+/gi, "$1=[REDACTED]")
    .slice(0, 1000);
}

function dbEnv(connectionString: string, databaseOverride?: string): DbEnv {
  const url = new URL(connectionString);
  const database = databaseOverride ?? decodeURIComponent(url.pathname.replace(/^\//, ""));
  const host = url.hostname;
  const port = url.port || "5432";
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get("sslmode") ?? "require";
  return {
    host,
    port,
    user,
    password,
    database,
    sslmode,
    childEnv: {
      ...process.env,
      PGHOST: host,
      PGPORT: port,
      PGUSER: user,
      PGPASSWORD: password,
      PGDATABASE: database,
      PGSSLMODE: sslmode,
    },
  };
}

/** Human-readable target identity. Host is intentionally omitted (secret hygiene). */
function redactedIdentity(env: DbEnv): string {
  return `db=${env.database} user=${env.user} sslmode=${env.sslmode}`;
}

function assertSafeTarget(sourceUrl: string, targetEnv: DbEnv, destructive: boolean, acknowledged: boolean): void {
  const sourceDb = decodeURIComponent(new URL(sourceUrl).pathname.replace(/^\//, ""));
  if (targetEnv.database === sourceDb) {
    throw new Error(`Refusing to overwrite the SOURCE database ('${sourceDb}').`);
  }
  if (["postgres", "template0", "template1", "control_db", "data_db"].includes(targetEnv.database)) {
    throw new Error(`Refusing to use '${targetEnv.database}' as a DR target.`);
  }
  if (!/(?:^|_)(?:dr|restore|recovery)(?:_|$)/i.test(targetEnv.database)) {
    throw new Error(
      `Target '${targetEnv.database}' does not look like a disposable DR database ` +
        `(expected a name containing 'dr_', 'restore_' or 'recovery_').`
    );
  }
  if (!destructive || acknowledged || process.env.DR_ALLOW_TARGET_RESET === "1") return;
  throw new Error("Destructive restore requires --allow-target-reset (or DR_ALLOW_TARGET_RESET=1).");
}

async function connect(env: DbEnv): Promise<RawPgClient> {
  const client = createRawPgClient({
    connectionString: new URL(`postgresql://${encodeURIComponent(env.user)}:${encodeURIComponent(env.password)}@${env.host}:${env.port}/${encodeURIComponent(env.database)}?sslmode=${encodeURIComponent(env.sslmode)}`).toString(),
    connectionTimeoutMillis: 15_000,
    applicationName: "vellum-dr-drill",
  });
  await client.connect();
  // After a target `DROP SCHEMA public CASCADE; CREATE SCHEMA public`, Neon can leave
  // the role's search_path empty. Pin it explicitly so unqualified table reads work.
  await client.query("SET search_path = public");
  return client;
}

async function snapshot(client: RawPgClient, database: string): Promise<Snapshot> {
  const tables: TableSnapshot[] = [];
  for (const spec of CHECKSUM_TABLES) {
    const exists = await client.query<{ exists: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [`public.${spec.name}`]
    );
    if (exists.rows[0]?.exists !== true) continue;
    const rows = await client.query<Record<string, unknown>>(
      `SELECT * FROM ${spec.name} ORDER BY ${spec.orderBy}`
    );
    const hash = crypto.createHash("sha256");
    hash.update(`${spec.name}\n`);
    for (const row of rows.rows) hash.update(`${JSON.stringify(row)}\n`);
    tables.push({ table: spec.name, count: rows.rowCount ?? rows.rows.length, checksum: hash.digest("hex") });
  }

  const policies = await client.query<{ total: number; isolation: number }>(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (
        WHERE tablename = ANY($1::text[]) AND policyname LIKE 'tenant%'
      )::int AS isolation
    FROM pg_policies WHERE schemaname = 'public'
  `, [[...ISOLATION_TABLES]]);
  const names = await client.query<{ name: string }>(
    "SELECT tablename || '.' || policyname AS name FROM pg_policies WHERE schemaname = 'public' ORDER BY 1"
  );
  const rlsRows = await client.query<{ relname: string; enabled: boolean; forced: boolean }>(`
    SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
    FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname = ANY($1::text[])
    ORDER BY relname
  `, [[...ISOLATION_TABLES]]);
  const migrations = await client.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations ORDER BY filename"
  );

  return {
    database,
    tables,
    policies: {
      total: policies.rows[0]?.total ?? 0,
      isolation: policies.rows[0]?.isolation ?? 0,
      names: names.rows.map((row) => row.name),
      rls: rlsRows.rows.map((row) => ({ table: row.relname, enabled: row.enabled, forced: row.forced })),
    },
    migrations: migrations.rows.map((row) => row.filename),
  };
}

function printSnapshot(label: string, snap: Snapshot): void {
  console.log(`\n── ${label} (${snap.database}) ─────────────────────────────`);
  for (const table of snap.tables) {
    console.log(`   ${table.table.padEnd(28)} rows=${String(table.count).padStart(7)}  sha256=${table.checksum}`);
  }
  console.log(
    `   pg_policies: total=${String(snap.policies.total)} isolation=${String(snap.policies.isolation)}` +
      ` rlsTables=${String(snap.policies.rls.filter((r) => r.enabled).length)}`
  );
  console.log(`   schema_migrations: ${snap.migrations.length === 0 ? "(none)" : snap.migrations.join(", ")}`);
}

interface DrReport {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

function compare(source: Snapshot, target: Snapshot): DrReport {
  const checks: DrReport["checks"] = [];
  for (const expected of source.tables) {
    const actual = target.tables.find((table) => table.table === expected.table);
    checks.push({
      name: `${expected.table} row count`,
      passed: actual?.count === expected.count,
      detail: `source=${String(expected.count)} restored=${String(actual?.count ?? "MISSING")}`,
    });
    checks.push({
      name: `${expected.table} sha256`,
      passed: actual?.checksum === expected.checksum,
      detail: `source=${expected.checksum} restored=${actual?.checksum ?? "MISSING"}`,
    });
  }
  checks.push({
    name: "pg_policies = 4 (data-plane isolation)",
    passed: source.policies.isolation === 4 && target.policies.isolation === 4,
    detail: `source=${String(source.policies.isolation)} restored=${String(target.policies.isolation)}`,
  });
  checks.push({
    name: "pg_policies parity (all policies)",
    passed:
      source.policies.total === target.policies.total &&
      JSON.stringify(source.policies.names) === JSON.stringify(target.policies.names),
    detail: `source=${String(source.policies.total)} restored=${String(target.policies.total)}`,
  });
  checks.push({
    name: "RLS flags parity",
    passed: JSON.stringify(source.policies.rls) === JSON.stringify(target.policies.rls),
    detail: `${String(source.policies.rls.filter((r) => r.enabled).length)} protected tables`,
  });
  checks.push({
    name: "schema_migrations parity",
    passed: JSON.stringify(source.migrations) === JSON.stringify(target.migrations),
    detail: `source=${String(source.migrations.length)} restored=${String(target.migrations.length)}`,
  });
  return { passed: checks.every((check) => check.passed), checks };
}

function findPgTool(name: "pg_dump" | "pg_restore"): string {
  const override = name === "pg_dump" ? process.env.PG_DUMP_BIN : process.env.PG_RESTORE_BIN;
  if (override) return override;
  for (const root of ["/usr/lib/postgresql/18/bin", "/usr/lib/postgresql/16/bin"]) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return name; // resolve from PATH
}

async function runTool(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await execFileAsync(binary, args, { env, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const failure = err as { code?: number; stderr?: string; message?: string };
    throw new Error(
      `${path.basename(binary)} failed (exit ${String(failure.code ?? "?")}): ` +
        sanitize(failure.stderr ?? failure.message ?? "unknown error")
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  loadDotenv(options.envFile);

  const sourceUrl = process.env.DATA_DATABASE_URL_DIRECT ?? process.env.DATA_DATABASE_URL;
  if (!sourceUrl) throw new Error("DATA_DATABASE_URL / DATA_DATABASE_URL_DIRECT is not configured.");

  const sourceEnv = dbEnv(sourceUrl);
  const targetEnv = dbEnv(sourceUrl, options.targetDb);
  assertSafeTarget(sourceUrl, targetEnv, options.mode === "execute", options.allowTargetReset);

  console.log(`source : ${redactedIdentity(sourceEnv)} [READ-ONLY]`);
  console.log(`target : ${redactedIdentity(targetEnv)} [DISPOSABLE DR VALIDATION DB]`);
  console.log(`mode   : ${options.mode}`);

  const pgDump = findPgTool("pg_dump");
  const pgRestore = findPgTool("pg_restore");
  console.log(`tools  : pg_dump=${path.basename(pgDump)} pg_restore=${path.basename(pgRestore)}`);

  const sourceClient = await connect(sourceEnv);
  let source: Snapshot;
  try {
    source = await snapshot(sourceClient, sourceEnv.database);
  } finally {
    await sourceClient.end();
  }
  printSnapshot("SOURCE BASELINE", source);

  if (options.mode === "dry-run") {
    console.log("\nDRY RUN complete — no DDL, no restore, no data modified.");
    return;
  }

  let dumpFile = "";
  if (options.mode === "execute") {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    dumpFile = path.join(TMP_DIR, `vellum-data-plane-${Date.now()}.dump`);
    console.log("\n[1/4] pg_dump (custom format, source is read-only)…");
    await runTool(pgDump, ["--format=custom", "--no-owner", "--no-privileges", `--file=${dumpFile}`], sourceEnv.childEnv);
    const bytes = fs.statSync(dumpFile).size;
    console.log(`       dump written: ${String(bytes)} bytes`);

    console.log("[2/4] Reset target public schema…");
    const targetClient = await connect(targetEnv);
    try {
      await targetClient.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await targetClient.query(`GRANT ALL ON SCHEMA public TO "${targetEnv.user.replace(/"/g, '""')}"`);
    } finally {
      await targetClient.end();
    }

    console.log("[3/4] pg_restore into disposable target…");
    await runTool(
      pgRestore,
      ["--no-owner", "--no-privileges", "--no-acl", "--exit-on-error", `--dbname=${targetEnv.database}`, dumpFile],
      targetEnv.childEnv
    );
  } else {
    console.log("\n[1/4] --verify-only: using the existing target database (no dump/restore).");
  }

  console.log("[4/4] Verifying row counts, checksums and RLS policies…");
  const targetClient = await connect(targetEnv);
  let target: Snapshot;
  try {
    target = await snapshot(targetClient, targetEnv.database);
  } finally {
    await targetClient.end();
  }
  printSnapshot("RESTORED TARGET", target);

  const report = compare(source, target);
  console.log("\n── verification ──────────────────────────────────────────");
  for (const check of report.checks) {
    console.log(`   ${check.passed ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
  }
  console.log(`\nDR DRILL ${report.passed ? "PASSED" : "FAILED"}`);

  if (dumpFile && !options.keepDump) {
    fs.rmSync(dumpFile, { force: true });
    console.log(`Removed temporary dump ${path.basename(dumpFile)}`);
  }
  if (!report.passed) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`\nDR DRILL ABORTED: ${sanitize(err instanceof Error ? err.message : String(err))}`);
  process.exitCode = 1;
});
