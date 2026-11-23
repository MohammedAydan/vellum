#!/usr/bin/env node
/**
 * `scripts/verify-ops.ts` — focused, read-only operations verification harness.
 *
 * 1. Proves `/v1/health/live` never touches PostgreSQL (bogus URLs => still 200).
 * 2. Proves `/v1/health/ready` runs real SQL: exact `SELECT 1` rows, migration rows,
 *    dedicated LISTEN backend id, and 503 on unreachable databases.
 * 3. Proves the migration advisory lock is mutually exclusive across two sessions.
 *
 * No DDL, no data mutation, no secrets printed. Exit code 0 only if all assertions pass.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { healthRoutes } from "../apps/api/src/routes/health.js";
import {
  createRawPgClient,
  getMigrationStatus,
  MIGRATION_ADVISORY_LOCK,
  withMigrationAdvisoryLock,
} from "../packages/database-control/src/index.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

function loadDotenv(): void {
  const require = createRequire(import.meta.url);
  const dotenvPath = require.resolve("dotenv", { paths: [path.join(REPO_ROOT, "apps/api")] });
  const dotenv = require(dotenvPath) as {
    config(options: { path: string; override?: boolean }): { error?: Error };
  };
  const result = dotenv.config({ path: path.join(REPO_ROOT, ".env.phase5.local"), override: false });
  if (result.error) throw result.error;
}

interface JsonRecord {
  [key: string]: unknown;
}

async function json(res: Response): Promise<JsonRecord> {
  return (await res.json()) as JsonRecord;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main(): Promise<void> {
  loadDotenv();
  const controlUrl = process.env.CONTROL_DATABASE_URL_DIRECT ?? process.env.CONTROL_DATABASE_URL;
  const dataUrl = process.env.DATA_DATABASE_URL_DIRECT ?? process.env.DATA_DATABASE_URL;
  assert(typeof controlUrl === "string" && controlUrl.length > 0, "CONTROL_DATABASE_URL is configured");
  assert(typeof dataUrl === "string" && dataUrl.length > 0, "DATA_DATABASE_URL is configured");

  process.env.DATABASE_MODE = "postgres";

  // --- 1. Liveness must be database-independent ---------------------------------
  const originalControl = process.env.CONTROL_DATABASE_URL;
  const originalData = process.env.DATA_DATABASE_URL;
  process.env.CONTROL_DATABASE_URL = "postgresql://nobody@127.0.0.1:1/nonexistent";
  process.env.DATA_DATABASE_URL = "postgresql://nobody@127.0.0.1:1/nonexistent";
  delete process.env.CONTROL_DATABASE_URL_DIRECT;
  delete process.env.DATA_DATABASE_URL_DIRECT;
  delete process.env.DATA_DATABASE_URL_LISTEN;

  const liveRes = await healthRoutes.request("/health/live");
  const liveBody = await json(liveRes);
  assert(liveRes.status === 200, "live endpoint returns 200 with unreachable databases");
  assert(liveBody["status"] === "alive", "live endpoint reports status=alive");

  const unreadyRes = await healthRoutes.request("/health/ready");
  const unreadyBody = await json(unreadyRes);
  assert(unreadyRes.status === 503, "ready endpoint returns 503 with unreachable databases");
  assert(unreadyBody["ready"] === false, "ready endpoint reports ready=false");
  const failedChecks = unreadyBody["checks"] as JsonRecord;
  assert(
    (failedChecks["controlDb"] as JsonRecord)["state"] === "failed",
    "control_db probe failed against unreachable URL"
  );
  assert(
    typeof (failedChecks["controlDb"] as JsonRecord)["errorCode"] === "string",
    "failed probe exposes a SQLSTATE/error code (not a fabricated string)"
  );
  console.log("PASS  /live is DB-free; /ready returns 503 with real failure codes");

  // --- 2. Readiness against the real Neon planes ---------------------------------
  process.env.CONTROL_DATABASE_URL = originalControl;
  process.env.DATA_DATABASE_URL = originalData;
  const readyRes = await healthRoutes.request("/health/ready");
  const readyBody = await json(readyRes);
  const checks = readyBody["checks"] as JsonRecord;
  const controlProbe = checks["controlDb"] as JsonRecord;
  const dataProbe = checks["dataDb"] as JsonRecord;
  const controlMigrations = checks["controlMigrations"] as JsonRecord;
  const dataMigrations = checks["dataMigrations"] as JsonRecord;
  const listen = checks["realtimeListen"] as JsonRecord;

  assert(controlProbe["query"] === "SELECT 1 AS probe_ok", "control probe uses the literal SQL query");
  assert(
    JSON.stringify(controlProbe["result"]) === JSON.stringify({ probe_ok: 1 }),
    "control probe returns the exact SQL row {probe_ok: 1}"
  );
  assert(
    JSON.stringify(dataProbe["result"]) === JSON.stringify({ probe_ok: 1 }),
    "data probe returns the exact SQL row {probe_ok: 1}"
  );
  assert(Array.isArray(controlMigrations["applied"]), "control migration status is a real row array");
  assert(Array.isArray(dataMigrations["applied"]), "data migration status is a real row array");
  assert(typeof (listen["result"] as JsonRecord)["backend_pid"] !== "undefined", "LISTEN probe returns pg_backend_pid()");
  assert(typeof (listen["result"] as JsonRecord)["server_version"] !== "undefined", "LISTEN probe returns server_version");
  console.log(
    `INFO  /ready against Neon -> HTTP ${String(readyRes.status)}, ready=${String(readyBody["ready"])}, ` +
      `controlMigrations=${String((controlMigrations["applied"] as unknown[]).length)} applied, ` +
      `dataMigrations=${String((dataMigrations["applied"] as unknown[]).length)} applied, ` +
      `dataMissing=${JSON.stringify(dataMigrations["missing"])}`
  );
  console.log("PASS  /ready returns exact SQL probe results (no fabricated strings)");

  // --- 3. Advisory lock is mutually exclusive ------------------------------------
  if (!dataUrl) throw new Error("DATA_DATABASE_URL is required for the advisory-lock test");
  // Session-level advisory locks require a session-mode connection. Neon's
  // `-pooler` endpoint uses transaction pooling and cannot hold one — the same
  // constraint that prevents LISTEN on the pooled host.
  // Use the disposable DR validation database so the proof never leaves a lock
  // (or a session) on the shared production data plane.
  const sessionUrl = new URL(
    (process.env.DATA_DATABASE_URL_DIRECT ?? dataUrl).replace("-pooler.", ".")
  );
  sessionUrl.pathname = `/${process.env.DR_RESTORE_DATABASE ?? "phase5_restore"}`;
  const holder = createRawPgClient({
    connectionString: sessionUrl.toString(),
    connectionTimeoutMillis: 10_000,
    applicationName: "vellum-ops-lock-holder",
  });
  const contender = createRawPgClient({
    connectionString: sessionUrl.toString(),
    connectionTimeoutMillis: 10_000,
    applicationName: "vellum-ops-lock-contender",
  });
  await holder.connect();
  await contender.connect();
  const { key1, key2 } = MIGRATION_ADVISORY_LOCK;
  let contenderHoldsLock = false;
  try {
    await withMigrationAdvisoryLock(
      holder,
      async () => {
        const tryLock = await contender.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired",
          [key1, key2]
        );
        assert(tryLock.rows[0]?.acquired === false, "second session cannot acquire the held migration lock");
      },
      { onProgress: (message) => console.log(`      ${message}`) }
    );
    const afterRelease = await contender.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired",
      [key1, key2]
    );
    contenderHoldsLock = afterRelease.rows[0]?.acquired === true;
    assert(contenderHoldsLock, "lock is reacquirable after release");
    const status = await getMigrationStatus(holder);
    console.log(
      `PASS  advisory lock (${String(key1)},${String(key2)}) is exclusive; ` +
        `schema_migrations rows=${String(status.length)}`
    );
  } finally {
    if (contenderHoldsLock) {
      try {
        await contender.query("SELECT pg_advisory_unlock($1::int, $2::int)", [key1, key2]);
      } catch {
        // end() below releases any session-scoped lock regardless.
      }
    }
    await contender.end();
    await holder.end();
  }

  console.log("\nOPS VERIFICATION PASSED");
}

main().catch((err: unknown) => {
  console.error(`OPS VERIFICATION FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
