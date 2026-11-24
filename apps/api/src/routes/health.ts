/**
 * @vellum/api - Liveness, Readiness & OpenAPI Metadata Routes
 *
 * `/v1/health/live` and `/v1/health/ready` are deliberately distinct.
 *
 *  - `/live` and `/health` never touch PostgreSQL (in root `/health`). They
 *             answer "is this Node process able to serve requests?"
 *  - `/ready` and `/v1/health/ready` run REAL SQL probes against the control
 *             plane, the data plane, their `schema_migrations` tables, and the
 *             dedicated LISTEN endpoint, using a short-TTL single-flight probe
 *             cache to prevent connection-pool exhaustion under rapid polling
 *             or unauthenticated probe floods. During graceful shutdown they
 *             immediately return 503 (`draining`) so load balancers stop
 *             routing traffic.
 */

import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { generateOpenApiSpec } from "@vellum/api-contract";
import {
  checksumOfSql,
  controlMigrationsDir,
  dataMigrationsDir,
  getMigrationStatus,
  isMigrationChecksumCompatible,
  listMigrationFiles,
  type MigrationStatusRow,
  type RawPgClient,
} from "@vellum/database-control";
import { defaultReadinessProbe, type ReadinessProbePort } from "../composition/root.js";

export const healthRoutes = new Hono();

const SERVICE_VERSION = "0.0.3";
const PROCESS_STARTED_AT = Date.now();
const PROBE_TIMEOUT_MS = 3_000;
const PROBE_CACHE_TTL_MS = 3_000;
const LISTEN_CHANNEL = "vellum_health_ready_probe";

let shuttingDown = false;
let activeReadinessProbe: ReadinessProbePort = defaultReadinessProbe;

/** Override the readiness probe port (primarily for testing or custom composition). */
export function setReadinessProbe(probe: ReadinessProbePort): void {
  activeReadinessProbe = probe;
  cachedReadiness = null;
}

/** Mark the server as draining so readiness probes immediately return 503. */
export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
  if (value) {
    cachedReadiness = null;
  }
}

/** True once graceful shutdown has begun. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

type CheckState = "ok" | "failed" | "skipped";

/** Exact result of a `SELECT`-style probe — `query` is the literal SQL sent to PG. */
interface SqlProbeResult {
  state: CheckState;
  target: string;
  query: string;
  result: Record<string, unknown> | null;
  latencyMs: number;
  /** PostgreSQL SQLSTATE / Node error code only. Never a URL, host or password. */
  errorCode: string | null;
  reason: string | null;
}

interface MigrationProbeResult {
  state: CheckState;
  target: string;
  table: "present" | "absent" | "unknown";
  applied: MigrationStatusRow[];
  expected: string[];
  missing: string[];
  drift: string[];
  latencyMs: number;
  errorCode: string | null;
  reason: string | null;
}

interface CachedReadiness {
  ready: boolean;
  checks: {
    controlDb: SqlProbeResult;
    dataDb: SqlProbeResult;
    controlMigrations: MigrationProbeResult;
    dataMigrations: MigrationProbeResult;
    realtimeListen: SqlProbeResult;
  };
  expiresAt: number;
}

let cachedReadiness: CachedReadiness | null = null;
let inFlightReadiness: Promise<CachedReadiness> | null = null;

function databaseMode(): string {
  return (process.env["DATABASE_MODE"] ?? "memory").toLowerCase();
}

function isProduction(): boolean {
  return process.env["NODE_ENV"] === "production";
}

function errorCodeOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const candidate: unknown = (err as { code?: unknown }).code;
    if (typeof candidate === "string" && candidate.length > 0) return candidate.slice(0, 64);
  }
  return "UNKNOWN";
}

function skippedSql(target: string, reason: string): SqlProbeResult {
  return {
    state: "skipped",
    target,
    query: "",
    result: null,
    latencyMs: 0,
    errorCode: null,
    reason,
  };
}

function skippedMigrations(target: string, reason: string): MigrationProbeResult {
  return {
    state: "skipped",
    target,
    table: "unknown",
    applied: [],
    expected: [],
    missing: [],
    drift: [],
    latencyMs: 0,
    errorCode: null,
    reason,
  };
}

async function withProbeClient<T>(
  connectionString: string,
  applicationName: string,
  work: (client: RawPgClient) => Promise<T>
): Promise<T> {
  return activeReadinessProbe.withClient(
    {
      connectionString,
      connectionTimeoutMillis: PROBE_TIMEOUT_MS,
      applicationName,
    },
    work
  );
}

/** Runs the literal `query` and returns the first row verbatim. */
async function runSqlProbe(target: string, connectionString: string, query: string): Promise<SqlProbeResult> {
  const startedAt = Date.now();
  try {
    const row = await withProbeClient(connectionString, "vellum-health-ready", async (client) => {
      const response = await client.query<Record<string, unknown>>(query);
      return response.rows[0] ?? null;
    });
    return {
      state: row === null ? "failed" : "ok",
      target,
      query,
      result: row,
      latencyMs: Date.now() - startedAt,
      errorCode: null,
      reason: row === null ? "probe returned no rows" : null,
    };
  } catch (err: unknown) {
    return {
      state: "failed",
      target,
      query,
      result: null,
      latencyMs: Date.now() - startedAt,
      errorCode: errorCodeOf(err),
      reason: "SQL probe failed",
    };
  }
}

/**
 * Reads the exact applied-migration rows and compares them with the migration files
 * present on disk. A missing file or a checksum drift marks the database unready.
 */
async function runMigrationProbe(
  target: string,
  connectionString: string,
  directory: string,
  label: "control_db" | "data_db"
): Promise<MigrationProbeResult> {
  const startedAt = Date.now();
  try {
    return await withProbeClient(connectionString, "vellum-health-migrations", async (client) => {
      const presence = await client.query<{ exists: boolean }>(
        "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists"
      );
      const table: MigrationProbeResult["table"] = presence.rows[0]?.exists === true ? "present" : "absent";
      const applied = await getMigrationStatus(client);
      const expected = listMigrationFiles(directory);
      const appliedByFile = new Map(applied.map((row) => [row.filename, row.checksum]));
      const missing = expected.filter((filename) => !appliedByFile.has(filename));
      const drift = expected.filter((filename) => {
        const recorded = appliedByFile.get(filename);
        if (recorded === undefined) return false;
        const current = checksumOfSql(fs.readFileSync(path.join(directory, filename), "utf8"));
        return !isMigrationChecksumCompatible(label, filename, recorded, current);
      });
      const state: CheckState =
        table === "present" && missing.length === 0 && drift.length === 0 ? "ok" : "failed";
      return {
        state,
        target,
        table,
        applied,
        expected,
        missing,
        drift,
        latencyMs: Date.now() - startedAt,
        errorCode: null,
        reason:
          state === "ok"
            ? null
            : `schema_migrations=${table}, missing=${String(missing.length)}, drift=${String(drift.length)}`,
      };
    });
  } catch (err: unknown) {
    return {
      state: "failed",
      target,
      table: "unknown",
      applied: [],
      expected: [],
      missing: [],
      drift: [],
      latencyMs: Date.now() - startedAt,
      errorCode: errorCodeOf(err),
      reason: "migration status probe failed",
    };
  }
}

/**
 * LISTEN is only available on a session-mode PostgreSQL endpoint. A dedicated
 * client issues LISTEN/UNLISTEN and reports the backend probe status.
 */
async function runListenProbe(connectionString: string): Promise<SqlProbeResult> {
  const target = "realtime_listen";
  const query = "SELECT pg_backend_pid() AS backend_pid, current_setting('server_version') AS server_version";
  const startedAt = Date.now();
  try {
    const row = await withProbeClient(connectionString, "vellum-health-listen", async (client) => {
      await client.query(`LISTEN ${LISTEN_CHANNEL}`);
      try {
        const response = await client.query<Record<string, unknown>>(query);
        return response.rows[0] ?? null;
      } finally {
        await client.query(`UNLISTEN ${LISTEN_CHANNEL}`).catch(() => undefined);
      }
    });
    // In production, never leak exact PostgreSQL server version or backend PID.
    const safeRow =
      row === null ? null : isProduction() ? { listen_ok: true } : row;
    return {
      state: row === null ? "failed" : "ok",
      target,
      query: isProduction() ? "" : query,
      result: safeRow,
      latencyMs: Date.now() - startedAt,
      errorCode: null,
      reason: row === null ? "LISTEN probe returned no rows" : null,
    };
  } catch (err: unknown) {
    return {
      state: "failed",
      target,
      query: isProduction() ? "" : query,
      result: null,
      latencyMs: Date.now() - startedAt,
      errorCode: errorCodeOf(err),
      reason: "LISTEN probe failed",
    };
  }
}

function missingConfigProbe(target: string, variable: string): SqlProbeResult {
  return {
    state: "failed",
    target,
    query: "",
    result: null,
    latencyMs: 0,
    errorCode: "MISSING_CONFIG",
    reason: isProduction() ? "required database configuration missing" : `${variable} is not set`,
  };
}

/** Neon pooled endpoints cannot carry LISTEN; prefer the explicit session URL. */
function resolveListenUrl(): string | null {
  const explicit = process.env["DATA_DATABASE_URL_LISTEN"];
  if (explicit && !explicit.includes("CHANGE_ME")) return explicit;
  const dataUrl = process.env["DATA_DATABASE_URL"];
  if (!dataUrl) return null;
  return dataUrl.replace("-pooler.", ".");
}

const PROBE_SQL = "SELECT 1 AS probe_ok";

/**
 * Coalesced readiness probe runner: shares a single in-flight probe across
 * concurrent callers and caches results for `PROBE_CACHE_TTL_MS` (3s) so rapid
 * load-balancer checks cannot exhaust PostgreSQL connections.
 */
async function evaluatePostgresReadiness(): Promise<CachedReadiness> {
  const now = Date.now();
  if (cachedReadiness && cachedReadiness.expiresAt > now) {
    return cachedReadiness;
  }
  if (inFlightReadiness) {
    return inFlightReadiness;
  }

  inFlightReadiness = (async () => {
    // Ignore unfilled DIRECT placeholders so readiness follows the configured
    // runtime connection string until the operator supplies a direct endpoint.
    const configuredControlDirect = process.env["CONTROL_DATABASE_URL_DIRECT"];
    const configuredDataDirect = process.env["DATA_DATABASE_URL_DIRECT"];
    const controlUrl =
      configuredControlDirect && !configuredControlDirect.includes("CHANGE_ME")
        ? configuredControlDirect
        : process.env["CONTROL_DATABASE_URL"];
    const dataUrl =
      configuredDataDirect && !configuredDataDirect.includes("CHANGE_ME")
        ? configuredDataDirect
        : process.env["DATA_DATABASE_URL"];
    const listenUrl = resolveListenUrl();

    const [controlDb, dataDb, controlMigrations, dataMigrations, realtimeListen] = await Promise.all([
      controlUrl
        ? runSqlProbe("control_db", controlUrl, PROBE_SQL)
        : Promise.resolve(missingConfigProbe("control_db", "CONTROL_DATABASE_URL")),
      dataUrl
        ? runSqlProbe("data_db", dataUrl, PROBE_SQL)
        : Promise.resolve(missingConfigProbe("data_db", "DATA_DATABASE_URL")),
      controlUrl
        ? runMigrationProbe("control_db_migrations", controlUrl, controlMigrationsDir(), "control_db")
        : Promise.resolve(skippedMigrations("control_db_migrations", "CONTROL_DATABASE_URL is not set")),
      dataUrl
        ? runMigrationProbe("data_db_migrations", dataUrl, dataMigrationsDir(), "data_db")
        : Promise.resolve(skippedMigrations("data_db_migrations", "DATA_DATABASE_URL is not set")),
      listenUrl
        ? runListenProbe(listenUrl)
        : Promise.resolve(missingConfigProbe("realtime_listen", "DATA_DATABASE_URL_LISTEN")),
    ]);

    const checks = { controlDb, dataDb, controlMigrations, dataMigrations, realtimeListen };
    const ready = Object.values(checks).every((check) => check.state === "ok");
    const entry: CachedReadiness = {
      ready,
      checks,
      expiresAt: Date.now() + PROBE_CACHE_TTL_MS,
    };
    cachedReadiness = entry;
    return entry;
  })().finally(() => {
    inFlightReadiness = null;
  });

  return inFlightReadiness;
}

healthRoutes.get("/health/live", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({
    status: "alive",
    version: SERVICE_VERSION,
    mode: databaseMode(),
    uptimeMs: Date.now() - PROCESS_STARTED_AT,
    timestamp: new Date().toISOString(),
    checks: {
      process: { state: "ok" as const, probe: "event loop responsive", result: { alive: true } },
    },
  });
});

healthRoutes.get("/health/ready", async (c) => {
  c.header("Cache-Control", "no-store");
  const mode = databaseMode();
  const envelope = {
    version: SERVICE_VERSION,
    mode,
    uptimeMs: Date.now() - PROCESS_STARTED_AT,
    timestamp: new Date().toISOString(),
  };

  if (shuttingDown) {
    return c.json(
      {
        ...envelope,
        status: "draining",
        ready: false,
      },
      503
    );
  }

  if (mode !== "postgres") {
    const reason = "DATABASE_MODE is not 'postgres'; in-process stores are used";
    return c.json({
      ...envelope,
      status: "ready",
      ready: true,
      checks: {
        controlDb: skippedSql("control_db", reason),
        dataDb: skippedSql("data_db", reason),
        controlMigrations: skippedMigrations("control_db_migrations", reason),
        dataMigrations: skippedMigrations("data_db_migrations", reason),
        realtimeListen: skippedSql("realtime_listen", reason),
      },
    });
  }

  const probe = await evaluatePostgresReadiness();
  return c.json(
    {
      ...envelope,
      status: probe.ready ? "ready" : "unready",
      ready: probe.ready,
      checks: probe.checks,
    },
    probe.ready ? 200 : 503
  );
});

/**
 * Deprecated compatibility endpoint. Kept so existing monitors and the published
 * OpenAPI contract keep working; prefer `/live` + `/ready` for new integrations.
 */
healthRoutes.get("/health", async (c) => {
  c.header("Cache-Control", "no-store");
  const mode = databaseMode();
  let controlState: "connected" | "disconnected" = "connected";
  let dataState: "connected" | "disconnected" = "connected";

  if (mode === "postgres") {
    const probe = await evaluatePostgresReadiness();
    controlState = probe.checks.controlDb.state === "ok" ? "connected" : "disconnected";
    dataState = probe.checks.dataDb.state === "ok" ? "connected" : "disconnected";
  }

  return c.json({
    status: "ok",
    version: SERVICE_VERSION,
    deprecated: true,
    useInstead: ["/v1/health/live", "/v1/health/ready"],
    mode,
    planes: {
      controlDb: controlState,
      dataDb: dataState,
      realtimePubSub: dataState,
    },
    timestamp: new Date().toISOString(),
  });
});

healthRoutes.get("/openapi.json", (c) => {
  const url = new URL(c.req.url);
  return c.json(generateOpenApiSpec(url.origin));
});

/**
 * Fast, non-leaking root `/health` (liveness) and `/ready` (readiness) routes
 * for Kubernetes/container orchestrators and load balancers. Never exposes SQL,
 * database versions, PIDs, migration filenames, or hostnames.
 */
export function createRootHealthRoutes(): Hono {
  const root = new Hono();

  root.get("/health", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      status: "ok",
      uptimeMs: Date.now() - PROCESS_STARTED_AT,
      timestamp: new Date().toISOString(),
    });
  });

  root.get("/ready", async (c) => {
    c.header("Cache-Control", "no-store");
    const timestamp = new Date().toISOString();

    if (shuttingDown) {
      return c.json({ status: "draining", ready: false, timestamp }, 503);
    }

    if (databaseMode() !== "postgres") {
      return c.json({ status: "ready", ready: true, timestamp }, 200);
    }

    const probe = await evaluatePostgresReadiness();
    return c.json(
      {
        status: probe.ready ? "ready" : "unready",
        ready: probe.ready,
        timestamp,
      },
      probe.ready ? 200 : 503
    );
  });

  return root;
}
