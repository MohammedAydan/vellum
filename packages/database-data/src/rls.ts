/**
 * @vellum/database-data - RLS, Tenant Isolation & Schema Idempotent Initialization
 *
 * Provides:
 *  1. `INIT_DATA_PLANE_SQL` & `ensureRlsPolicies` for idempotent schema/RLS setup.
 *     Tenant == project: policies use `app.current_project_id` only.
 *  2. Hardened runtime tenant-context helpers (`withTenantContext`, `applyTenantContext`,
 *     `buildTenantContextQuery`, `resetTenantContext`) that:
 *     - Strictly validate UUID `projectId`, timeout bounds, PG role identifiers, and claims.
 *     - Batch all transaction-local GUCs into a single parameterized `SELECT set_config(..., true)`
 *       round-trip (zero SQL interpolation, strictly transaction-scoped, Neon/PgBouncer safe).
 *     - Enforce `statement_timeout`, `lock_timeout`, and `idle_in_transaction_session_timeout`.
 *     - Prevent tenant cross-talk on error/rollback by rolling back and destroying tainted
 *       pooled connections when rollback fails.
 */

export const RLS_GUC_PROJECT_ID = "app.current_project_id" as const;
export const RLS_GUC_USER_ID = "app.current_user_id" as const;
export const RLS_GUC_ROLE = "app.current_role" as const;
export const RLS_GUC_CLAIMS = "app.current_claims" as const;

export const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;
export const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000;
export const MAX_TIMEOUT_MS = 300_000;

export const DEFAULT_MAX_CLAIMS_BYTES = 4_096;
export const DEFAULT_MAX_CLAIMS_KEYS = 32;
export const DEFAULT_MAX_CLAIMS_DEPTH = 3;

/** All tenant-scoped tables in the data plane (migration 0011 shape). */
export const RLS_TENANT_TABLES = [
  "documents",
  "document_indexes",
  "document_index_entries",
  "realtime_outbox",
  "project_collections",
  "project_auth_users",
  "project_auth_identities",
  "project_auth_sessions",
  "project_auth_mfa",
  "project_auth_tokens",
  "transactions",
  "batch_idempotency_keys",
] as const;

export type RlsTenantTable = (typeof RLS_TENANT_TABLES)[number];

/** Pre-compiled hot-path validation regexes (zero per-call compilation overhead). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const PG_ROLE_IDENTIFIER_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const SAFE_USER_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

/** Privileged PostgreSQL roles that must never be assumed by tenant traffic. */
const FORBIDDEN_ROLES = new Set<string>([
  "postgres",
  "superuser",
  "admin",
  "root",
  "neon_superuser",
  "rdsadmin",
  "rds_superuser",
  "cloudsqlsuperuser",
  "cloudsqladmin",
  "azure_pg_admin",
]);

const FORBIDDEN_CLAIM_KEYS = new Set<string>(["__proto__", "constructor", "prototype"]);

const ALLOWED_ISOLATION_LEVELS = new Set<TransactionIsolationLevel>([
  "READ COMMITTED",
  "REPEATABLE READ",
  "SERIALIZABLE",
]);

export type RlsValidationErrorCode =
  | "INVALID_PROJECT_ID"
  | "INVALID_USER_ID"
  | "INVALID_ROLE"
  | "INVALID_CLAIMS"
  | "INVALID_TIMEOUT"
  | "INVALID_ISOLATION_LEVEL"
  | "INVALID_CLIENT";

export class RlsValidationError extends Error {
  public readonly code: RlsValidationErrorCode;

  constructor(code: RlsValidationErrorCode, message: string) {
    super(message);
    this.name = "RlsValidationError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type TransactionIsolationLevel = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

export interface SanitizeClaimsOptions {
  maxBytes?: number;
  maxKeys?: number;
  maxDepth?: number;
}

export interface TenantContextOptions {
  /** Mandatory tenant UUID mapped to `app.current_project_id`. */
  projectId: string;
  /** Optional end-user identifier mapped to `app.current_user_id`. */
  userId?: string;
  /** Optional application-level role string mapped to `app.current_role`. */
  appRole?: string;
  /** Optional PostgreSQL database role assumed via transaction-local `set_config('role', $n, true)`. */
  dbRole?: string;
  /** Optional allowlist of permitted PostgreSQL roles when `dbRole` is specified. */
  allowedDbRoles?: readonly string[];
  /** Optional custom claims object mapped to `app.current_claims` as sanitized JSON. */
  claims?: Record<string, unknown>;
  /** Claim sanitization limits. */
  claimsOptions?: SanitizeClaimsOptions;
  /** Transaction-local `statement_timeout` in milliseconds (default: 5000, max: 300000). */
  statementTimeoutMs?: number;
  /** Transaction-local `lock_timeout` in milliseconds (default: 2000, max: 300000). */
  lockTimeoutMs?: number;
  /** Transaction-local `idle_in_transaction_session_timeout` in milliseconds (default: 15000, max: 300000). */
  idleInTransactionTimeoutMs?: number;
  /** Optional SQL transaction isolation level (defaults to PostgreSQL default). */
  isolationLevel?: TransactionIsolationLevel;
  /** Optional read-only transaction mode (`BEGIN READ ONLY`). */
  readOnly?: boolean;
  /** Allow the all-zero nil UUID as a projectId (default: false). */
  allowNilUuid?: boolean;
}

export interface ParameterizedQuery {
  text: string;
  values: string[];
}

export const INIT_DATA_PLANE_SQL = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS documents (
  project_id UUID NOT NULL,
  path TEXT NOT NULL,
  collection_path TEXT NOT NULL,
  collection_group TEXT NOT NULL,
  document_id TEXT NOT NULL,
  path_depth SMALLINT NOT NULL CHECK (path_depth >= 2 AND path_depth <= 10 AND path_depth % 2 = 0),
  data JSONB NOT NULL,
  size_bytes INT NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 1048576),
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, path)
);

ALTER TABLE documents ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_docs_collection_id_active
  ON documents (project_id, collection_path, document_id ASC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_docs_collection_updated_active
  ON documents (project_id, collection_path, updated_at DESC, document_id ASC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_docs_collection_created_active
  ON documents (project_id, collection_path, created_at DESC, document_id ASC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_docs_data_gin_active
  ON documents USING GIN (data jsonb_path_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_docs_tombstones
  ON documents (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_docs_expires_at
  ON documents (project_id, expires_at)
  WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS document_indexes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  collection_path TEXT NOT NULL,
  fields JSONB NOT NULL,
  definition_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'building'
    CHECK (status IN ('building', 'ready', 'failed', 'deleting')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, collection_path, definition_hash)
);

CREATE TABLE IF NOT EXISTS document_index_entries (
  index_id UUID NOT NULL REFERENCES document_indexes(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  collection_path TEXT NOT NULL,
  sort_key BYTEA NOT NULL,
  document_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (index_id, sort_key, document_id)
);

CREATE INDEX IF NOT EXISTS idx_index_entries_doc_cleanup
  ON document_index_entries (project_id, path);

CREATE TABLE IF NOT EXISTS realtime_outbox (
  seq_id BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL,
  collection_path TEXT NOT NULL,
  path TEXT NOT NULL,
  document_id TEXT NOT NULL,
  op_type TEXT NOT NULL CHECK (op_type IN ('created', 'updated', 'deleted')),
  version BIGINT NOT NULL,
  before_data JSONB,
  after_data JSONB,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_project_seq
  ON realtime_outbox (project_id, seq_id ASC);

CREATE INDEX IF NOT EXISTS idx_outbox_cleanup
  ON realtime_outbox (committed_at);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
ALTER TABLE document_indexes ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_indexes FORCE ROW LEVEL SECURITY;
ALTER TABLE document_index_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_index_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE realtime_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime_outbox FORCE ROW LEVEL SECURITY;

-- Fail closed: a missing/empty GUC makes current_setting(..., true) return NULL,
-- so the comparison evaluates to NULL and every command is denied.
DROP POLICY IF EXISTS tenant_isolation_documents ON documents;
DROP POLICY IF EXISTS tenant_rls_documents ON documents;
CREATE POLICY tenant_rls_documents ON documents FOR ALL
  USING (project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid)
  WITH CHECK (project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_indexes ON document_indexes;
DROP POLICY IF EXISTS tenant_rls_document_indexes ON document_indexes;
CREATE POLICY tenant_rls_document_indexes ON document_indexes FOR ALL
  USING (project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid)
  WITH CHECK (project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_index_entries ON document_index_entries;
DROP POLICY IF EXISTS tenant_rls_document_index_entries ON document_index_entries;
CREATE POLICY tenant_rls_document_index_entries ON document_index_entries FOR ALL
  USING (project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid)
  WITH CHECK (project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_outbox ON realtime_outbox;
DROP POLICY IF EXISTS tenant_rls_realtime_outbox ON realtime_outbox;
CREATE POLICY tenant_rls_realtime_outbox ON realtime_outbox FOR ALL
  USING (project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid)
  WITH CHECK (project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid);

-- Guarded fail-closed RLS enforcement for extended tenant tables when present,
-- plus least-privilege grants to vellum_app if that role exists.
DO $rls_extended$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'project_collections',
    'project_auth_users',
    'project_auth_identities',
    'project_auth_sessions',
    'project_auth_mfa',
    'project_auth_tokens',
    'transactions',
    'batch_idempotency_keys'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'tenant_rls_' || t, t);
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL ' ||
        'USING (project_id = NULLIF(current_setting(''app.current_project_id'', true), '''')::uuid) ' ||
        'WITH CHECK (project_id = NULLIF(current_setting(''app.current_project_id'', true), '''')::uuid)',
        'tenant_rls_' || t, t
      );
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vellum_app') THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO vellum_app', t);
      END IF;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vellum_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      documents, document_indexes, document_index_entries, realtime_outbox
      TO vellum_app;
  END IF;
END
$rls_extended$;
`;

export interface QueryableClient {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

export interface ReleasableClient extends QueryableClient {
  release: (err?: Error | boolean) => void;
}

export interface ConnectablePool {
  connect: () => Promise<ReleasableClient>;
}

/**
 * Fast-path UUID format check (length pre-check + pre-compiled regex).
 * Rejects non-strings, whitespace, null bytes, and malformed identifiers.
 */
export function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && UUID_RE.test(value);
}

/**
 * Strictly validates and normalizes (lowercases) a tenant `projectId`.
 * Throws `RlsValidationError("INVALID_PROJECT_ID")` on any malformed input.
 */
export function assertValidProjectId(
  projectId: unknown,
  options?: { allowNilUuid?: boolean }
): string {
  if (!isValidUuid(projectId)) {
    throw new RlsValidationError(
      "INVALID_PROJECT_ID",
      "Invalid projectId: expected a canonical 36-character UUID string"
    );
  }
  const normalized = projectId.toLowerCase();
  if (!options?.allowNilUuid && normalized === NIL_UUID) {
    throw new RlsValidationError(
      "INVALID_PROJECT_ID",
      "Invalid projectId: nil UUID (00000000-0000-0000-0000-000000000000) is not permitted"
    );
  }
  return normalized;
}

/**
 * Strictly validates an optional end-user identifier for `app.current_user_id`.
 */
export function assertValidUserId(userId: unknown): string {
  if (typeof userId !== "string" || userId.length === 0 || userId.length > 128) {
    throw new RlsValidationError(
      "INVALID_USER_ID",
      "Invalid userId: expected a non-empty string up to 128 characters"
    );
  }
  if (!SAFE_USER_ID_RE.test(userId)) {
    throw new RlsValidationError(
      "INVALID_USER_ID",
      "Invalid userId: contains disallowed characters"
    );
  }
  return userId;
}

/**
 * Validates and sanitizes a PostgreSQL or application role identifier.
 * Enforces strict unquoted PG identifier syntax and blocks privileged roles.
 */
export function sanitizeRoleName(role: unknown, allowedRoles?: readonly string[]): string {
  if (typeof role !== "string" || !PG_ROLE_IDENTIFIER_RE.test(role)) {
    throw new RlsValidationError(
      "INVALID_ROLE",
      "Invalid role name: must match /^[a-z_][a-z0-9_]{0,62}$/"
    );
  }
  if (FORBIDDEN_ROLES.has(role) || role.startsWith("pg_")) {
    throw new RlsValidationError(
      "INVALID_ROLE",
      `Role "${role}" is forbidden for tenant-scoped execution`
    );
  }
  if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(role)) {
    throw new RlsValidationError(
      "INVALID_ROLE",
      `Role "${role}" is not in the configured allowedRoles list`
    );
  }
  return role;
}

function sanitizeClaimValue(
  value: unknown,
  depth: number,
  maxDepth: number,
  maxKeys: number
): unknown {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RlsValidationError("INVALID_CLAIMS", "Claim numbers must be finite");
    }
    return value;
  }
  if (typeof value === "string") {
    if (CONTROL_CHAR_RE.test(value)) {
      throw new RlsValidationError(
        "INVALID_CLAIMS",
        "Claim string values must not contain control characters"
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= maxDepth) {
      throw new RlsValidationError(
        "INVALID_CLAIMS",
        `Claims exceed maximum nesting depth of ${maxDepth}`
      );
    }
    if (value.length > maxKeys) {
      throw new RlsValidationError(
        "INVALID_CLAIMS",
        `Claim array exceeds maximum length of ${maxKeys}`
      );
    }
    return value.map((item) => sanitizeClaimValue(item, depth + 1, maxDepth, maxKeys));
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new RlsValidationError(
        "INVALID_CLAIMS",
        "Claims must be plain JSON-compatible objects"
      );
    }
    if (depth >= maxDepth) {
      throw new RlsValidationError(
        "INVALID_CLAIMS",
        `Claims exceed maximum nesting depth of ${maxDepth}`
      );
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > maxKeys) {
      throw new RlsValidationError(
        "INVALID_CLAIMS",
        `Claims object exceeds maximum key count of ${maxKeys}`
      );
    }
    const clean: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      if (FORBIDDEN_CLAIM_KEYS.has(k) || k.length === 0 || k.length > 64 || CONTROL_CHAR_RE.test(k)) {
        throw new RlsValidationError(
          "INVALID_CLAIMS",
          `Disallowed or malformed claim key: "${k.slice(0, 32)}"`
        );
      }
      if (v === undefined) continue;
      clean[k] = sanitizeClaimValue(v, depth + 1, maxDepth, maxKeys);
    }
    return clean;
  }
  throw new RlsValidationError(
    "INVALID_CLAIMS",
    `Unsupported claim value type: ${typeof value}`
  );
}

/**
 * Sanitizes a custom claims object for safe storage in a transaction-local GUC.
 * Strips prototype-pollution keys, rejects control chars, and enforces depth, key,
 * and UTF-8 byte-size limits.
 */
export function sanitizeClaims(
  claims: unknown,
  options?: SanitizeClaimsOptions
): Record<string, unknown> {
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) {
    throw new RlsValidationError("INVALID_CLAIMS", "Claims must be a plain object");
  }
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_CLAIMS_BYTES;
  const maxKeys = options?.maxKeys ?? DEFAULT_MAX_CLAIMS_KEYS;
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_CLAIMS_DEPTH;

  const clean = sanitizeClaimValue(claims, 0, maxDepth, maxKeys) as Record<string, unknown>;
  const serialized = JSON.stringify(clean);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new RlsValidationError(
      "INVALID_CLAIMS",
      `Serialized claims exceed maximum size of ${maxBytes} bytes`
    );
  }
  return clean;
}

function assertValidTimeoutMs(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new RlsValidationError(
      "INVALID_TIMEOUT",
      `Invalid ${label}: expected an integer between 1 and ${MAX_TIMEOUT_MS} ms`
    );
  }
  return value;
}

/**
 * Builds a single parameterized `SELECT set_config(..., true)` query that sets
 * all transaction-local tenant isolation GUCs and timeouts in one round-trip.
 *
 * Guarantees:
 * - Zero string interpolation of user-supplied values (100% bound parameters).
 * - `is_local` is ALWAYS literal `true` — settings NEVER leak across pooled sessions.
 * - Enforces `statement_timeout`, `lock_timeout`, and `idle_in_transaction_session_timeout`.
 */
export function buildTenantContextQuery(context: TenantContextOptions): ParameterizedQuery {
  if (!context || typeof context !== "object") {
    throw new RlsValidationError("INVALID_PROJECT_ID", "Tenant context options are required");
  }

  const projectId = context.allowNilUuid === undefined
    ? assertValidProjectId(context.projectId)
    : assertValidProjectId(context.projectId, { allowNilUuid: context.allowNilUuid });
  const statementTimeoutMs = assertValidTimeoutMs(
    context.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    "statementTimeoutMs"
  );
  const lockTimeoutMs = assertValidTimeoutMs(
    context.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    "lockTimeoutMs"
  );
  const idleInTxTimeoutMs = assertValidTimeoutMs(
    context.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    "idleInTransactionTimeoutMs"
  );

  const calls: string[] = [];
  const values: string[] = [];

  const pushConfig = (guc: string, value: string): void => {
    values.push(value);
    calls.push(`set_config('${guc}', $${values.length}, true)`);
  };

  pushConfig(RLS_GUC_PROJECT_ID, projectId);
  pushConfig("statement_timeout", `${statementTimeoutMs}ms`);
  pushConfig("lock_timeout", `${lockTimeoutMs}ms`);
  pushConfig("idle_in_transaction_session_timeout", `${idleInTxTimeoutMs}ms`);

  if (context.userId !== undefined) {
    pushConfig(RLS_GUC_USER_ID, assertValidUserId(context.userId));
  }
  if (context.appRole !== undefined) {
    pushConfig(RLS_GUC_ROLE, sanitizeRoleName(context.appRole));
  }
  if (context.claims !== undefined) {
    const cleanClaims = sanitizeClaims(context.claims, context.claimsOptions);
    pushConfig(RLS_GUC_CLAIMS, JSON.stringify(cleanClaims));
  }
  if (context.dbRole !== undefined) {
    pushConfig("role", sanitizeRoleName(context.dbRole, context.allowedDbRoles));
  }

  return {
    text: `SELECT ${calls.join(", ")}`,
    values,
  };
}

/**
 * Applies transaction-local tenant context GUCs on an active transaction client
 * in a single parameterized round-trip. Must be called inside an open transaction (`BEGIN`).
 */
export async function applyTenantContext(
  client: QueryableClient,
  context: TenantContextOptions
): Promise<void> {
  if (!client || typeof client.query !== "function") {
    throw new RlsValidationError("INVALID_CLIENT", "A queryable database client is required");
  }
  const { text, values } = buildTenantContextQuery(context);
  await client.query(text, values);
}

/**
 * Defense-in-depth helper to explicitly clear transaction-local tenant GUCs
 * to empty strings (causing fail-closed RLS evaluation).
 */
export async function resetTenantContext(client: QueryableClient): Promise<void> {
  if (!client || typeof client.query !== "function") {
    throw new RlsValidationError("INVALID_CLIENT", "A queryable database client is required");
  }
  await client.query(
    `SELECT set_config('${RLS_GUC_PROJECT_ID}', '', true), ` +
      `set_config('${RLS_GUC_USER_ID}', '', true), ` +
      `set_config('${RLS_GUC_ROLE}', '', true), ` +
      `set_config('${RLS_GUC_CLAIMS}', '', true)`
  );
}

function buildBeginSql(context: TenantContextOptions): string {
  const parts: string[] = ["BEGIN"];
  if (context.isolationLevel !== undefined) {
    if (!ALLOWED_ISOLATION_LEVELS.has(context.isolationLevel)) {
      throw new RlsValidationError(
        "INVALID_ISOLATION_LEVEL",
        `Invalid isolationLevel: "${String(context.isolationLevel)}"`
      );
    }
    parts.push(`ISOLATION LEVEL ${context.isolationLevel}`);
  }
  if (context.readOnly === true) {
    parts.push("READ ONLY");
  }
  return parts.join(" ");
}

function isConnectablePool(target: unknown): target is ConnectablePool {
  return (
    target !== null &&
    typeof target === "object" &&
    typeof (target as ConnectablePool).connect === "function"
  );
}

/**
 * Executes `fn` inside a PostgreSQL transaction with strictly validated,
 * transaction-local (`set_config(..., true)`) RLS tenant isolation and timeouts.
 *
 * Concurrency & safety guarantees:
 * - Validates all inputs BEFORE acquiring a pooled connection (fail-fast).
 * - Never leaks session-level GUCs across pooled connections (Neon/PgBouncer safe).
 * - Always rolls back on error; if `ROLLBACK` fails on a pooled client, passes the
 *   error to `client.release(err)` so the pool destroys the tainted connection
 *   instead of returning it to another tenant.
 */
export async function withTenantContext<T>(
  poolOrClient: ConnectablePool | QueryableClient,
  context: TenantContextOptions,
  fn: (client: QueryableClient) => Promise<T>
): Promise<T> {
  if (!poolOrClient || typeof poolOrClient !== "object") {
    throw new RlsValidationError("INVALID_CLIENT", "A database pool or client is required");
  }
  if (typeof fn !== "function") {
    throw new RlsValidationError("INVALID_CLIENT", "A callback function is required");
  }

  // Validate and pre-build SQL before checking out any connection from the pool.
  const beginSql = buildBeginSql(context);
  const contextQuery = buildTenantContextQuery(context);

  const fromPool = isConnectablePool(poolOrClient);
  const client: QueryableClient | ReleasableClient = fromPool
    ? await poolOrClient.connect()
    : poolOrClient;

  if (!client || typeof client.query !== "function") {
    throw new RlsValidationError("INVALID_CLIENT", "Database client does not implement query()");
  }

  let inTransaction = false;
  let destroyError: Error | undefined;

  try {
    await client.query(beginSql);
    inTransaction = true;
    await client.query(contextQuery.text, contextQuery.values);

    const result = await fn(client);

    await client.query("COMMIT");
    inTransaction = false;
    return result;
  } catch (err) {
    if (inTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        destroyError =
          rollbackErr instanceof Error
            ? rollbackErr
            : new Error("Failed to ROLLBACK transaction; destroying pooled connection");
      }
    }
    throw err;
  } finally {
    if (fromPool && typeof (client as ReleasableClient).release === "function") {
      if (destroyError) {
        (client as ReleasableClient).release(destroyError);
      } else {
        (client as ReleasableClient).release();
      }
    }
  }
}

export async function ensureRlsPolicies(clientOrPool: {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
}): Promise<void> {
  if (!clientOrPool || typeof clientOrPool.query !== "function") {
    throw new RlsValidationError("INVALID_CLIENT", "A queryable client or pool is required");
  }
  await clientOrPool.query(INIT_DATA_PLANE_SQL);
}
