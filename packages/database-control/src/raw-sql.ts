/**
 * `packages/database-control/src/raw-sql.ts`
 * Minimal, typed escape hatch for raw `pg` access.
 *
 * Exists so that migration tooling and integration/E2E tests can open real PostgreSQL
 * connections (including with a *different*, non-owner role for RLS proofs) without
 * duplicating `pg` dependency plumbing in packages that do not depend on it.
 *
 * Nothing here is used on the request hot path.
 */

import pg from "pg";

export const PgPool = pg.Pool;
export const PgClient = pg.Client;
export type RawPgPool = pg.Pool;
export type RawPgClient = pg.Client;
export type RawPgQueryResult<T extends pg.QueryResultRow = pg.QueryResultRow> = pg.QueryResult<T>;

export interface RawPoolOptions {
  connectionString: string;
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  /** Per-connection statement timeout applied via `options`. */
  statementTimeoutMs?: number;
  applicationName?: string;
}

const MAX_PG_IDENTIFIER_LEN = 63;
const MAX_POOL_CONNECTIONS = 1_000;
const MAX_TIMEOUT_MS = 3_600_000;

function validateBoundedInt(
  name: string,
  value: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`Invalid ${name}: must be a finite number`);
  }
  const int = Math.floor(value);
  if (int < min || int > max) {
    throw new RangeError(`Invalid ${name}: must be between ${min} and ${max}`);
  }
  return int;
}

function sanitizeApplicationName(name: string): string {
  // PostgreSQL truncates application_name at 63 bytes and rejects NUL bytes.
  const cleaned = name.replace(/[\0\r\n]/g, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, MAX_PG_IDENTIFIER_LEN) : "vellum-raw";
}

function validateConnectionString(connectionString: string): string {
  if (typeof connectionString !== "string" || connectionString.trim().length === 0) {
    throw new Error("connectionString must be a non-empty string");
  }
  return connectionString;
}

/**
 * Creates a raw `pg.Pool`. Callers own the pool and must `end()` it.
 */
export function createRawPgPool({
  connectionString,
  max = 4,
  connectionTimeoutMillis = 20_000,
  idleTimeoutMillis = 30_000,
  statementTimeoutMs,
  applicationName = "vellum-raw",
}: RawPoolOptions): pg.Pool {
  const safeConnStr = validateConnectionString(connectionString);
  const safeMax = validateBoundedInt("max", max, 1, MAX_POOL_CONNECTIONS);
  const safeConnTimeout = validateBoundedInt(
    "connectionTimeoutMillis",
    connectionTimeoutMillis,
    0,
    MAX_TIMEOUT_MS
  );
  const safeIdleTimeout = validateBoundedInt(
    "idleTimeoutMillis",
    idleTimeoutMillis,
    0,
    MAX_TIMEOUT_MS
  );
  const safeStatementTimeout =
    statementTimeoutMs !== undefined
      ? validateBoundedInt("statementTimeoutMs", statementTimeoutMs, 0, MAX_TIMEOUT_MS)
      : undefined;
  const safeAppName = sanitizeApplicationName(applicationName);

  const pool = new pg.Pool({
    connectionString: safeConnStr,
    max: safeMax,
    connectionTimeoutMillis: safeConnTimeout,
    idleTimeoutMillis: safeIdleTimeout,
    application_name: safeAppName,
    ...(safeStatementTimeout !== undefined
      ? { options: `-c statement_timeout=${safeStatementTimeout}` }
      : {}),
  });
  // Guard against unhandled 'error' events from idle backend disconnects.
  pool.on("error", () => undefined);
  // Neon's pooler reuses backend connections; a previous session may have left
  // `search_path` empty. Pin it on every freshly opened connection. The query
  // is queued synchronously on that client, so it runs before caller queries.
  pool.on("connect", (client) => {
    void client.query("SET search_path = public").catch(() => undefined);
  });
  return pool;
}

/**
 * Creates a single dedicated `pg.Client` (required for DDL + `SET ROLE` workflows that
 * must run on one physical connection). Callers own the client and must `end()` it.
 */
export function createRawPgClient({
  connectionString,
  connectionTimeoutMillis = 20_000,
  applicationName = "vellum-raw-client",
}: Omit<RawPoolOptions, "max" | "idleTimeoutMillis" | "statementTimeoutMs">): pg.Client {
  const safeConnStr = validateConnectionString(connectionString);
  const safeConnTimeout = validateBoundedInt(
    "connectionTimeoutMillis",
    connectionTimeoutMillis,
    0,
    MAX_TIMEOUT_MS
  );
  const safeAppName = sanitizeApplicationName(applicationName);

  const client = new pg.Client({
    connectionString: safeConnStr,
    connectionTimeoutMillis: safeConnTimeout,
    application_name: safeAppName,
  });
  // Same pooler hazard as createRawPgPool: pin the schema immediately after
  // connecting so unqualified tenant tables always resolve.
  const baseConnect = client.connect.bind(client);
  // Mirrors pg.Client#connect overloads: the promise form resolves to the
  // connected client, and the callback form accepts either pg callback shape.
  function connectWithPinnedSearchPath(): Promise<pg.Client>;
  function connectWithPinnedSearchPath(
    callback: ((err: Error) => void) | ((err: null, c: pg.Client) => void)
  ): void;
  function connectWithPinnedSearchPath(
    callback?: ((err: Error) => void) | ((err: null, c: pg.Client) => void)
  ): Promise<pg.Client> | void {
    const run = async (): Promise<pg.Client> => {
      await baseConnect();
      try {
        await client.query("SET search_path = public");
      } catch (err: unknown) {
        try {
          await client.end();
        } catch {
          // Ignore teardown failures; propagate the original search_path error.
        }
        throw err;
      }
      return client;
    };
    if (typeof callback === "function") {
      // BOUNDARY-ADAPTER: both pg callback shapes take the error as arg 0;
      // the success shape additionally receives the connected client as arg 1.
      const invoke = callback as (err: Error | null, c?: pg.Client) => void;
      run().then(
        (connected) => {
          invoke(null, connected);
        },
        (err: unknown) => {
          invoke(err instanceof Error ? err : new Error(String(err)));
        }
      );
      return;
    }
    return run();
  }
  client.connect = connectWithPinnedSearchPath;
  return client;
}

/** Quotes a PostgreSQL identifier safely (used for generated test role names). */
export function quotePgIdentifier(identifier: string): string {
  if (
    typeof identifier !== "string" ||
    identifier.length === 0 ||
    identifier.length > MAX_PG_IDENTIFIER_LEN ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(identifier)
  ) {
    const preview =
      typeof identifier === "string"
        ? identifier.replace(/[\r\n\0]/g, "").slice(0, 64)
        : String(typeof identifier);
    throw new Error(`Unsafe PostgreSQL identifier: ${preview}`);
  }
  return `"${identifier}"`;
}
