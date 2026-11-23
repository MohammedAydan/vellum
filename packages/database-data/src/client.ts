/**
 * @vellum/database-data - Dual-Mode Drizzle PostgreSQL Client for Data Plane (`data_db`)
 * Supports Neon Serverless (HTTP / WebSockets) and Node pg (TCP / Docker / Local).
 */

import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzleNeon, type NeonDatabase } from "drizzle-orm/neon-serverless";
import pg from "pg";
import { Pool as NeonPool } from "@neondatabase/serverless";
import * as schema from "./schema.js";

export type DataDb = NodePgDatabase<typeof schema> | NeonDatabase<typeof schema>;

interface CachedDataClient {
  db: DataDb;
  pool: pg.Pool | NeonPool;
  close: () => Promise<void>;
}

let cachedClient: CachedDataClient | null = null;

const DEFAULT_DEV_CONNECTION_STRING =
  "postgresql://vellum_data:data_secret@localhost:5433/data_db";

const DEFAULT_POOL_MAX = 20;
const DEFAULT_NEON_POOL_MAX = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_QUERY_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_USES = 7_500;
const DEFAULT_APPLICATION_NAME = "vellum-data-plane";

/** PostgreSQL SQLSTATE codes that are safe to retry on idempotent operations. */
const TRANSIENT_PG_SQLSTATES = new Set<string>([
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

const TRANSIENT_NODE_CODES = new Set<string>([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

export interface DataDbOptions {
  connectionString?: string;
  driver?: "auto" | "pg" | "neon";
  /** Maximum number of pooled connections (default: 20 for pg, 10 for neon). */
  max?: number;
  /** Idle connection timeout in milliseconds (default: 30000). */
  idleTimeoutMillis?: number;
  /** Connection acquisition timeout in milliseconds (default: 5000). */
  connectionTimeoutMillis?: number;
  /** Client-side query timeout in milliseconds (PgBouncer/Neon safe, default: 15000). */
  queryTimeoutMs?: number;
  /** Recycle pg connections after N uses to avoid long-lived drift (default: 7500). */
  maxUses?: number;
  /** Allow Node.js process to exit when all connections are idle (default: false). */
  allowExitOnIdle?: boolean;
  /** Application name tag for pg_stat_activity (skipped on PgBouncer/Neon pooler URLs). */
  applicationName?: string;
  /** Optional pool-level error handler to prevent uncaught EventEmitter crashes. */
  onPoolError?: (err: Error) => void;
}

export interface RetryOptions {
  /** Maximum number of retry attempts after the initial try (default: 3). */
  maxRetries?: number;
  /** Initial backoff delay in milliseconds (default: 50). */
  baseDelayMs?: number;
  /** Maximum backoff delay in milliseconds (default: 2000). */
  maxDelayMs?: number;
  /** Custom predicate to decide if an error is retryable (defaults to `isTransientPgError`). */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

function parseConnectionUrl(connectionString: string): URL {
  if (typeof connectionString !== "string" || connectionString.trim().length === 0) {
    throw new Error("Invalid data-plane connectionString: expected a non-empty PostgreSQL URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("Invalid data-plane connectionString: malformed URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      `Invalid data-plane connectionString protocol: expected postgres:// or postgresql://`
    );
  }
  return parsed;
}

function isNeonHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "neon.tech" || lower.endsWith(".neon.tech");
}

function isPooledEndpoint(parsedUrl: URL): boolean {
  const host = parsedUrl.hostname.toLowerCase();
  return (
    host.includes("-pooler.") ||
    parsedUrl.searchParams.get("pgbouncer") === "true" ||
    parsedUrl.searchParams.get("pool_mode") === "transaction"
  );
}

function assertPositiveInt(value: number, name: string, maxValue: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maxValue) {
    throw new RangeError(`Invalid ${name}: expected integer between 1 and ${maxValue}`);
  }
  return value;
}

function resolveConnectionString(options: DataDbOptions): string {
  const explicit =
    options.connectionString ?? process.env["DATA_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }
  if (process.env["NODE_ENV"] === "production") {
    throw new Error(
      "DATA_DATABASE_URL (or DATABASE_URL) must be configured when NODE_ENV is production"
    );
  }
  return DEFAULT_DEV_CONNECTION_STRING;
}

function resolveDriver(options: DataDbOptions, parsedUrl: URL): "pg" | "neon" {
  if (options.driver === "pg" || options.driver === "neon") {
    return options.driver;
  }
  if (options.driver !== undefined && options.driver !== "auto") {
    throw new Error(`Unsupported database driver: "${String(options.driver)}"`);
  }
  return process.env["DATA_DATABASE_DRIVER"] === "neon" || isNeonHost(parsedUrl.hostname)
    ? "neon"
    : "pg";
}

function attachPoolErrorHandler(
  pool: { on?: unknown },
  onPoolError?: (err: Error) => void
): void {
  // pg.Pool / NeonPool use overloaded EventEmitter `on` signatures that are not
  // assignable to a single function type under `exactOptionalPropertyTypes`.
  // Duck-type it as unknown and call with the correct `this` binding instead.
  const on = pool.on as ((event: string, listener: (err: Error) => void) => unknown) | undefined;
  if (typeof on !== "function") return;
  on.call(pool, "error", (err: Error) => {
    if (onPoolError) {
      try {
        onPoolError(err);
      } catch {
        // Never allow user error callback to crash the event loop.
      }
      return;
    }
    const code = (err as { code?: string }).code ?? "UNKNOWN";
    // Log sanitized error metadata without leaking connection credentials.
    console.error(`[vellum/database-data] Idle pool client error (${code}): ${err.message}`);
  });
}

function createIdempotentClose(pool: { end: () => Promise<void> }): () => Promise<void> {
  let closingPromise: Promise<void> | null = null;
  return async (): Promise<void> => {
    if (!closingPromise) {
      closingPromise = pool.end();
    }
    await closingPromise;
  };
}

export function createDataDb(options: DataDbOptions = {}): {
  db: DataDb;
  pool: pg.Pool | NeonPool;
  close: () => Promise<void>;
} {
  const connectionString = resolveConnectionString(options);
  const parsedUrl = parseConnectionUrl(connectionString);
  const driver = resolveDriver(options, parsedUrl);

  const idleTimeoutMillis = assertPositiveInt(
    options.idleTimeoutMillis ?? DEFAULT_IDLE_TIMEOUT_MS,
    "idleTimeoutMillis",
    600_000
  );
  const connectionTimeoutMillis = assertPositiveInt(
    options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    "connectionTimeoutMillis",
    120_000
  );

  if (driver === "neon") {
    const max = assertPositiveInt(options.max ?? DEFAULT_NEON_POOL_MAX, "max", 200);
    const pool = new NeonPool({
      connectionString,
      max,
      idleTimeoutMillis,
      connectionTimeoutMillis,
    });
    attachPoolErrorHandler(pool, options.onPoolError);
    const db = drizzleNeon(pool, { schema });
    return {
      db,
      pool,
      close: createIdempotentClose(pool),
    };
  }

  const max = assertPositiveInt(options.max ?? DEFAULT_POOL_MAX, "max", 200);
  const queryTimeoutMs = assertPositiveInt(
    options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
    "queryTimeoutMs",
    300_000
  );
  const maxUses = assertPositiveInt(options.maxUses ?? DEFAULT_MAX_USES, "maxUses", 1_000_000);

  const poolConfig: pg.PoolConfig = {
    connectionString,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    query_timeout: queryTimeoutMs,
    maxUses,
    allowExitOnIdle: options.allowExitOnIdle ?? false,
  };

  // Avoid sending startup parameters that PgBouncer / Neon transaction poolers reject.
  if (!isPooledEndpoint(parsedUrl)) {
    poolConfig.application_name = options.applicationName ?? DEFAULT_APPLICATION_NAME;
  }

  const pool = new pg.Pool(poolConfig);
  attachPoolErrorHandler(pool, options.onPoolError);

  const db = drizzlePg(pool, { schema });
  return {
    db,
    pool,
    close: createIdempotentClose(pool),
  };
}

export function getDataDb(options?: DataDbOptions): DataDb {
  if (!cachedClient) {
    cachedClient = createDataDb(options);
  }
  return cachedClient.db;
}

/**
 * Returns the underlying singleton pool associated with `getDataDb()`,
 * initializing it if necessary.
 */
export function getDataDbPool(options?: DataDbOptions): pg.Pool | NeonPool {
  if (!cachedClient) {
    cachedClient = createDataDb(options);
  }
  return cachedClient.pool;
}

export async function closeDataDb(): Promise<void> {
  const client = cachedClient;
  if (!client) return;
  // Clear singleton reference synchronously before awaiting end() so concurrent
  // callers never receive a closing pool or trigger double-close races.
  cachedClient = null;
  await client.close();
}

/**
 * Returns true if `err` represents a transient PostgreSQL, PgBouncer, Neon,
 * or TCP transport error that is safe to retry for idempotent operations.
 */
export function isTransientPgError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as { code?: unknown; message?: unknown; cause?: unknown };

  if (typeof record.code === "string") {
    if (TRANSIENT_PG_SQLSTATES.has(record.code) || TRANSIENT_NODE_CODES.has(record.code)) {
      return true;
    }
  }

  if (typeof record.message === "string") {
    const msg = record.message.toLowerCase();
    if (
      msg.includes("connection terminated unexpectedly") ||
      msg.includes("connection ended unexpectedly") ||
      msg.includes("client has encountered a connection error") ||
      msg.includes("websocket closed") ||
      msg.includes("cannot acquire a connection")
    ) {
      return true;
    }
  }

  if (record.cause && record.cause !== err) {
    return isTransientPgError(record.cause);
  }

  return false;
}

/**
 * Executes an async database operation with bounded exponential backoff + full jitter
 * on transient PostgreSQL / network errors.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 50;
  const maxDelayMs = options.maxDelayMs ?? 2_000;
  const shouldRetry = options.shouldRetry ?? isTransientPgError;

  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    throw new RangeError("Invalid maxRetries: expected integer between 0 and 10");
  }
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new RangeError("Invalid baseDelayMs: expected non-negative finite number");
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new RangeError("Invalid maxDelayMs: expected finite number >= baseDelayMs");
  }

  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (err) {
      if (attempt >= maxRetries || !shouldRetry(err, attempt)) {
        throw err;
      }
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delayMs = Math.floor(Math.random() * (cap + 1));
      attempt += 1;
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
}

/**
 * Performs a lightweight `SELECT 1` liveness probe against a pool or client.
 */
export async function checkDataDbHealth(
  poolOrClient: { query: (sql: string) => Promise<unknown> },
  timeoutMs = 3_000
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const queryPromise = poolOrClient.query("SELECT 1");
    // Prevent unhandled rejection if the timeout wins the race and the query rejects later.
    queryPromise.catch(() => {});
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Health check timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });
    await Promise.race([queryPromise, timeoutPromise]);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
