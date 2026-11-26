import { referenceMatchJsonPath } from "./referenced-by.js";
/**
 * @vellum/storage - Transaction Context Helper for PostgreSQL & Neon
 * Enforces transaction-scoped Row-Level Security (RLS) and 5000ms statement timeout.
 *
 * V2 round-trip compression (the original 4 sequential awaits are gone):
 *  - pg (`preparedStatements: true`, the default for PgStorageAdapter): ONE
 *    simple-query round trip issues `BEGIN; SET LOCAL statement_timeout ...;
 *    SET LOCAL search_path = public; SELECT set_config(...)`. Because the simple
 *    query protocol cannot carry bind parameters, the project id is interpolated
 *    ONLY after a strict anchored UUID validation, so no injection is possible.
 *  - Neon / `{ preparedStatements: false }`: multi-statement + params is not a
 *    valid combination, so we use `BEGIN` + ONE parameterized SELECT that sets
 *    the project id, statement timeout and search_path via `set_config(..., true)`.
 *    Two round trips max (down from four), still fail-closed and parameterized.
 *
 * Tenant == project: RLS is keyed on `app.current_project_id` only. No other
 * tenant GUC is set anywhere in this module.
 *
 * Hardening additions:
 *  - Nested/re-entrant transaction handling via AsyncLocalStorage + PostgreSQL
 *    SAVEPOINTs (same pool & tenant) with fail-closed cross-tenant rejection.
 *  - Automatic bounded retry with jitter on transient PostgreSQL serialization
 *    failures (`40001`) and deadlocks (`40P01`) for top-level transactions.
 *  - Broken-socket destruction (`client.release(err)`) when ROLLBACK fails, and
 *    use-after-close protection on transaction handles.
 *  - Batched UNNEST outbox insertion (`appendOutboxEvents`) to avoid N+1 writes.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { VellumError, encodeCompositeSortKey } from "@vellum/core";
import { computeIndexDefinitionHash, type CompiledQuery, type WhereClause } from "@vellum/query-engine";
import {
  compileAggregateSql,
  normalizeAggregateRows,
  executeDeleteWhereInTx,
  type AggregateRequest,
  type AggregateRow,
  type DeleteWhereOptions,
} from "./aggregates.js";
import type {
  TenantContext,
  DocumentRecord,
  OutboxEvent,
  OutboxMutation,
  IndexFieldItem,
  CompositeIndexRecord,
  TxHandle,
  QueriedDocument,
  SqlQueriedRow,
  IdempotencyResult,
} from "./types.js";

/** A named prepared statement config accepted by `pg`/`pg.Pool` clients. */
export interface PreparedQueryConfig {
  readonly name: string;
  readonly text: string;
  readonly values?: readonly unknown[];
}

export type PgQueryArg = string | PreparedQueryConfig;

/** Minimal raw-SQL capability of a pooled PostgreSQL client. */
export interface PgClientLike {
  query: (sql: PgQueryArg, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
  release: (err?: Error | boolean) => void;
}

/** Anything that can execute raw SQL (pool clients and dedicated workers). */
export type SqlQueryLike = Pick<PgClientLike, "query">;

export interface PreparedStatementOptions {
  /** Enable named prepared statements. Defaults to `false` (Neon-safe). */
  preparedStatements?: boolean;
  /** Optional stable identity object for nested/re-entrant SAVEPOINT reuse. */
  poolKey?: object;
  /** Max retries for transient 40001/40P01 errors on top-level transactions. Defaults to 3. */
  maxRetries?: number;
  /** Base backoff delay (ms) between retries. Defaults to 15ms. */
  retryBaseDelayMs?: number;
}

/** Minimal raw-SQL capability exposed by the SQL transaction handle. */
export interface SqlQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount?: number | null;
}

export interface SqlQueryClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<SqlQueryResult<T>>;
}

/** Structural interface for a raw pg/Neon pool client adaptable to `PgClientLike`. */
export interface RawPoolClientLike {
  query(
    queryTextOrConfig: string | { name: string; text: string; values?: unknown[] },
    values?: unknown[]
  ): Promise<{ rows: unknown[]; rowCount?: number | null }>;
  release(err?: Error | boolean): void;
}

/** Structural interface for a raw pg/Neon pool adaptable to `SqlQueryClient`. */
export interface RawQueryPoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

/** Adapts a raw pg/Neon PoolClient to `PgClientLike` without double-casts. */
export function toPgClientLike(client: RawPoolClientLike): PgClientLike {
  return {
    query: (sql, params) =>
      typeof sql === "string"
        ? client.query(sql, params)
        : client.query({
            name: sql.name,
            text: sql.text,
            ...(sql.values === undefined ? {} : { values: [...sql.values] }),
          }),
    release: (err) => client.release(err),
  };
}

/** Adapts a raw pg/Neon Pool to `SqlQueryClient` without double-casts. */
export function toSqlQueryClient(pool: RawQueryPoolLike): SqlQueryClient {
  return {
    query: async <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[]
    ): Promise<SqlQueryResult<T>> => {
      const res = await pool.query(sql, params);
      const result: SqlQueryResult<T> = { rows: res.rows as T[] };
      if (res.rowCount !== undefined) result.rowCount = res.rowCount;
      return result;
    },
  };
}

/** TxHandle + raw SQL. Extra methods are structural-only (storage/types.ts is untouched). */
export type SqlTxHandle = TxHandle & SqlQueryClient;

/** SqlTxHandle + batched document/index/outbox upsert. */
export interface SqlBatchTxHandle extends SqlTxHandle {
  putDocumentRows(rows: DocumentRecord[]): Promise<void>;
  appendOutboxEvents?(events: OutboxMutation[]): Promise<OutboxEvent[]>;
}

interface CachedIndexDefinition {
  id: string;
  fields: IndexFieldItem[];
}

interface ActiveTxFrame {
  readonly scopeKey: object;
  readonly projectId: string;
  readonly client: PgClientLike;
  readonly prepared: boolean;
  savepointCounter: number;
}

const activeTxStorage = new AsyncLocalStorage<ActiveTxFrame>();

/** PostgreSQL SQLSTATE codes that are safe to retry at the transaction boundary. */
const RETRYABLE_PG_CODES: ReadonlySet<string> = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
]);

function getPgErrorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/* -------------------------------------------------------------------------- */
/* named statements for the hot recurring queries                    */
/* -------------------------------------------------------------------------- */

export const SQL_SET_STATEMENT_TIMEOUT = `SET LOCAL statement_timeout = '5000ms'`;
export const SQL_SET_PROJECT = `SELECT set_config('app.current_project_id', $1, true)`;

/**
 * Anchored RFC-4122-shaped UUID. It intentionally accepts any version/variant
 * nibble (the control plane issues v4, but tests and fixtures use other shapes)
 * while rejecting everything else — including quotes, dashes in odd places,
 * whitespace and SQL comment markers. This is what makes the single-statement
 * interpolation below injection-proof.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string, field: "projectId"): void {
  if (!UUID_RE.test(value)) {
    throw new VellumError(
      "PERMISSION_DENIED",
      `RLS Violation: ${field} must be a UUID before it can bind tenant context`,
      { field }
    );
  }
}

function isTenantLike(value: unknown): value is TenantContext {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { projectId?: unknown };
  return typeof candidate.projectId === "string";
}

/**
 * Normalizes the two call shapes accepted by the optional `TxHandle`
 * capabilities: `(...args)` and `(ctxOrTx, ...args)`. The leading context is
 * never trusted to switch tenants — it is only checked against the tenant
 * already bound to this transaction, so a mismatch fails closed.
 */
export function unwrapCtxArgs<Args extends unknown[]>(
  args: Args | [TenantContext, ...Args],
  expected: TenantContext
): Args {
  const first: unknown = args[0];
  if (!isTenantLike(first)) return args as Args;
  if (first.projectId !== expected.projectId) {
    throw new VellumError(
      "PERMISSION_DENIED",
      "RLS Violation: context passed to a transaction capability does not match the active transaction tenant",
      {
        expectedProjectId: expected.projectId,
        suppliedProjectId: first.projectId,
      }
    );
  }
  return args.slice(1) as Args;
}

/**
 * Dev-only guard for the single REAL tenant GUC. The `pg` driver is
 * asynchronous, so this returns a Promise callers must await (the contract's
 * `void` shape is not achievable without blocking the event loop). Production
 * is a no-op. Never reads `app.project_id` — RLS binds `app.current_project_id`
 * only.
 */
export async function assertTenantGuc(
  tx: SqlQueryClient,
  expectedProjectId: string
): Promise<void> {
  if (process.env["NODE_ENV"] === "production") return;
  const { rows } = await tx.query<{ projectId: string | null }>(
    `SELECT current_setting('app.current_project_id', true) AS "projectId"`
  );
  const actual = rows[0];
  if (actual?.projectId !== expectedProjectId) {
    throw new VellumError("PERMISSION_DENIED", "RLS Violation: tenant GUC context does not match the transaction", {
      expectedProjectId,
      actualProjectId: actual?.projectId ?? null,
    });
  }
}

/** Multi-statement, interpolation-based setup — pg/simple-query path only. */
export function buildPgTenantSetupSql(projectId: string): string {
  requireUuid(projectId, "projectId");
  // Neon's pooler can hand out a backend whose search_path was left empty by a
  // previous `SET search_path` (pooled connections are reused). Pin it locally
  // so every tenant table resolves unqualified — fail closed, never leak.
  return `BEGIN; SET LOCAL statement_timeout = '5000ms'; SET LOCAL search_path = public; ` +
    `SELECT set_config('app.current_project_id', '${projectId}', true)`;
}

/** Parameterized setup for Neon (or any `{ preparedStatements: false }` caller). */
export const SQL_SET_TENANT_CONTEXT_PARAMETERIZED =
  `SELECT set_config('app.current_project_id', $1, true), ` +
  `set_config('statement_timeout', '5000ms', true), ` +
  `set_config('search_path', 'public', true)`;

const DOCUMENT_COLUMNS = `project_id AS "projectId", path,
       collection_path AS "collectionPath", collection_group AS "collectionGroup",
       document_id AS "documentId", path_depth AS "pathDepth", data,
       size_bytes AS "sizeBytes", version::int AS "version",
       created_at::text AS "createdAt", updated_at::text AS "updatedAt", deleted_at::text AS "deletedAt",
       expires_at::text AS "expiresAt"`;

/** Live-read predicate shared by every find/list statement (soft delete + TTL). */
const LIVE_DOCUMENT_PREDICATE = `deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())`;

export function getDocumentStatement(includeSoftDeleted: boolean, forUpdate: boolean): PreparedQueryConfig {
  const suffix = `${includeSoftDeleted ? "All" : "Live"}${forUpdate ? "Locked" : ""}`;
  // "Include soft deleted" is the admin/GC view: it deliberately bypasses both
  // the tombstone filter and the TTL filter so expired/tombstoned rows can be
  // inspected. Every normal read filters both with LIVE_DOCUMENT_PREDICATE.
  const liveClause = includeSoftDeleted ? "" : ` AND ${LIVE_DOCUMENT_PREDICATE}`;
  const lockClause = forUpdate ? " FOR UPDATE" : "";
  return {
    name: `vellum_get_document_${suffix}`,
    text: `SELECT ${DOCUMENT_COLUMNS}
             FROM documents
            WHERE project_id = $1::uuid AND path = $2${liveClause}${lockClause}`,
  };
}

export const SQL_GET_INDEXES = `SELECT id, fields FROM document_indexes
  WHERE project_id = $1::uuid AND collection_path = $2`;

/** UNNEST batch upsert — V2 adds the 12th (expires_at) array. */
export const SQL_INSERT_DOCUMENTS_UNNEST = `INSERT INTO documents (
   project_id, path, collection_path, collection_group,
   document_id, path_depth, data, size_bytes, version, created_at, updated_at, deleted_at,
   expires_at
 )
 SELECT $1::uuid,
        u.path, u.collection_path, u.collection_group, u.document_id,
        u.path_depth, u.data::jsonb, u.size_bytes, u.version,
        u.created_at::timestamptz, u.updated_at::timestamptz, u.deleted_at::timestamptz,
        u.expires_at::timestamptz
   FROM unnest(
     $2::text[],  $3::text[],  $4::text[],  $5::text[],  $6::int[],
     $7::text[],  $8::int[],   $9::bigint[], $10::text[], $11::text[], $12::text[],
     $13::text[]
   ) AS u(path, collection_path, collection_group, document_id,
          path_depth, data, size_bytes, version, created_at, updated_at, deleted_at, expires_at)
 ON CONFLICT (project_id, path)
 DO UPDATE SET
   data = EXCLUDED.data,
   size_bytes = EXCLUDED.size_bytes,
   version = EXCLUDED.version,
   updated_at = EXCLUDED.updated_at,
   deleted_at = EXCLUDED.deleted_at,
   expires_at = EXCLUDED.expires_at`;

/**
 * Batched compare-and-swap flush (Decision 2). One statement handles BOTH
 * create races (expected_version IS NULL -> INSERT ... ON CONFLICT DO NOTHING)
 * and version races (UPDATE ... WHERE version = expected AND deleted_at IS NULL
 * AND (expires_at IS NULL OR expires_at > now())).
 * RETURNING identifies which rows actually applied; the engine maps missing
 * paths to ALREADY_EXISTS / ABORTED_CONFLICT. Preserves the one-round-trip
 * UNNEST invariant that a per-row conditionalPutDocument would break.
 */
export const SQL_CONDITIONAL_PUT_DOCUMENTS_UNNEST = `WITH incoming AS (
    SELECT u.path, u.collection_path, u.collection_group, u.document_id,
           u.path_depth, u.data::jsonb AS data, u.size_bytes, u.version,
           u.created_at::timestamptz AS created_at, u.updated_at::timestamptz AS updated_at,
           u.deleted_at::timestamptz AS deleted_at, u.expires_at::timestamptz AS expires_at,
           u.expected_version
      FROM unnest(
        $2::text[], $3::text[], $4::text[], $5::text[], $6::int[],
        $7::text[], $8::int[], $9::bigint[], $10::text[], $11::text[], $12::text[],
        $13::text[], $14::bigint[]
      ) AS u(path, collection_path, collection_group, document_id,
             path_depth, data, size_bytes, version, created_at, updated_at, deleted_at,
             expires_at, expected_version)
  ),
  created AS (
    INSERT INTO documents (
      project_id, path, collection_path, collection_group,
      document_id, path_depth, data, size_bytes, version, created_at, updated_at, deleted_at,
      expires_at
    )
    SELECT $1::uuid, i.path, i.collection_path, i.collection_group, i.document_id,
           i.path_depth, i.data, i.size_bytes, i.version, i.created_at, i.updated_at,
           i.deleted_at, i.expires_at
      FROM incoming i
     WHERE i.expected_version IS NULL
    ON CONFLICT (project_id, path) DO NOTHING
    RETURNING path
  ),
  updated AS (
    UPDATE documents d
       SET data = i.data, size_bytes = i.size_bytes, version = i.version,
           updated_at = i.updated_at, deleted_at = i.deleted_at, expires_at = i.expires_at
      FROM incoming i
     WHERE i.expected_version IS NOT NULL
       AND d.project_id = $1::uuid AND d.path = i.path
       AND d.version = i.expected_version AND d.deleted_at IS NULL
       AND (d.expires_at IS NULL OR d.expires_at > now())
    RETURNING d.path
  )
  SELECT path FROM created
  UNION ALL
  SELECT path FROM updated`;

export const SQL_DELETE_INDEX_ENTRIES = `DELETE FROM document_index_entries
  WHERE project_id = $1::uuid AND path = ANY($2::text[])`;

/** Shared UNNEST insert for all tenant composite-index entry writes. */
export const SQL_INSERT_INDEX_ENTRIES = `INSERT INTO document_index_entries (
   index_id, project_id, collection_path, sort_key, document_id, path
 )
 SELECT u.index_id::uuid, $1::uuid,
        u.collection_path, u.sort_key, u.document_id, u.path
   FROM unnest($2::uuid[], $3::text[], $4::bytea[], $5::text[], $6::text[])
     AS u(index_id, collection_path, sort_key, document_id, path)
 ON CONFLICT (index_id, sort_key, document_id) DO NOTHING`;

export const SQL_INSERT_OUTBOX = `INSERT INTO realtime_outbox (
   project_id, collection_path, path, document_id,
   op_type, version, before_data, after_data
 ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
 RETURNING seq_id::text AS "seqId", committed_at::text AS "committedAt"`;

/** Batched UNNEST outbox insert for bulk deletes and multi-doc transactions. */
export const SQL_INSERT_OUTBOX_UNNEST = `INSERT INTO realtime_outbox (
   project_id, collection_path, path, document_id,
   op_type, version, before_data, after_data
 )
 SELECT $1::uuid, u.collection_path, u.path, u.document_id,
        u.op_type, u.version, u.before_data::jsonb, u.after_data::jsonb
   FROM unnest(
     $2::text[], $3::text[], $4::text[], $5::text[],
     $6::bigint[], $7::text[], $8::text[]
   ) AS u(collection_path, path, document_id, op_type, version, before_data, after_data)
 RETURNING seq_id::text AS "seqId", committed_at::text AS "committedAt"`;

export const SQL_QUERY_OUTBOX = `SELECT seq_id::text AS "seqId", project_id AS "projectId",
        collection_path AS "collectionPath", path, document_id AS "documentId",
        op_type AS "opType", version::int AS "version",
        before_data AS "beforeData", after_data AS "afterData",
        committed_at::text AS "committedAt"
   FROM realtime_outbox
  WHERE project_id = $1::uuid AND seq_id > $2::bigint
  ORDER BY seq_id ASC
  LIMIT 500`;

export const SQL_CREATE_INDEX = `INSERT INTO document_indexes (
   id, project_id, collection_path, fields, definition_hash, status
 ) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, 'building')
 RETURNING id, project_id AS "projectId",
           collection_path AS "collectionPath", fields, definition_hash AS "definitionHash",
           status, created_at::text AS "createdAt", updated_at::text AS "updatedAt"`;

export const SQL_LIST_ACTIVE_DOCUMENTS = `SELECT ${DOCUMENT_COLUMNS}
  FROM documents
 WHERE project_id = $1::uuid
   AND collection_path = $2 AND ${LIVE_DOCUMENT_PREDICATE}
 ORDER BY document_id ASC`;

/**
 * V2 single-roundtrip batched getter for relationship fan-out (agent 1C).
 * `path = ANY($2::text[])` returns every requested path in one statement;
 * duplicates are collapsed by the caller and results are reordered in JS to
 * match the requested order. TTL + soft-delete semantics match getDocument().
 */
export const SQL_BATCH_GET_DOCUMENTS = `SELECT ${DOCUMENT_COLUMNS}
 FROM documents
 WHERE project_id = $1::uuid
   AND path = ANY($2::text[]) AND ${LIVE_DOCUMENT_PREDICATE}
 ORDER BY path ASC`;

/** `includeDeleted = true`: tombstones and expired rows are visible (admin/GC view). */
export const SQL_BATCH_GET_DOCUMENTS_ALL = `SELECT ${DOCUMENT_COLUMNS}
 FROM documents
 WHERE project_id = $1::uuid
   AND path = ANY($2::text[])
 ORDER BY path ASC`;

/**
 * Compare-and-swap create. A version-0 tombstone still occupies the unique key
 * so this insert is NOT applied in that case; restoring it is an explicit
 * `putDocumentRow` upsert (or a dedicated restore flow), never an implicit
 * overwrite here. Storage returns `{ applied: false }` — the engine decides
 * ALREADY_EXISTS vs ABORTED_CONFLICT.
 */
export const SQL_CONDITIONAL_INSERT_DOCUMENT = `INSERT INTO documents (
    project_id, path, collection_path, collection_group,
    document_id, path_depth, data, size_bytes, version, created_at, updated_at, deleted_at,
    expires_at
  ) VALUES (
    $1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::timestamptz,
    $11::timestamptz, $12::timestamptz, $13::timestamptz
  )
  ON CONFLICT (project_id, path) DO NOTHING`;

/** Version-guarded CAS update of a live (non-tombstoned, unexpired) row. */
export const SQL_CONDITIONAL_UPDATE_DOCUMENT = `UPDATE documents
     SET data = $3::jsonb,
         size_bytes = $4,
         version = $5,
         updated_at = $6::timestamptz,
         deleted_at = $7::timestamptz,
         expires_at = $8::timestamptz
   WHERE project_id = $1::uuid AND path = $2
     AND version = $9 AND deleted_at IS NULL
     AND (expires_at IS NULL OR expires_at > now())`;

/**
 * JSONB-index-backed dependent lookup. Every value is a bind parameter; covers
 * nested fields, scalar paths/bare IDs, tagged references and arrays. This is
 * a candidate lookup; the engine verifies exact reference semantics. Tenant isolation comes from both the
 * explicit predicate and the transaction's RLS GUC.
 */
export const SQL_LIST_DEPENDENTS_BY_REFERENCE = `SELECT ${DOCUMENT_COLUMNS}
 FROM documents
 WHERE project_id = $1::uuid
   AND collection_path = $2 AND ${LIVE_DOCUMENT_PREDICATE}
   AND (data @? $3::jsonpath OR data @? $4::jsonpath)
 ORDER BY path ASC
 LIMIT $5`;

/** Cursor-only page — no SQL OFFSET, `document_id ASC` with a null-safe cursor. */
export const SQL_LIST_DOCUMENTS_IN_COLLECTION_PAGE = `SELECT ${DOCUMENT_COLUMNS}
 FROM documents
 WHERE project_id = $1::uuid
   AND collection_path = $2 AND deleted_at IS NULL
   AND (expires_at IS NULL OR expires_at > now())
   AND ($3::text IS NULL OR document_id > $3)
 ORDER BY document_id ASC
 LIMIT $4`;

/* -------------------------------------------------------------------------- */
/* Idempotency ledger (migration 0010 `batch_idempotency_keys`)               */
/* -------------------------------------------------------------------------- */

/** Migration 0010: (project_id, idempotency_key, response_hash, response_payload, expires_at). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export const SQL_GET_IDEMPOTENCY_RESULT = `SELECT response_hash AS "responseHash",
          response_payload AS "responsePayload"
     FROM batch_idempotency_keys
    WHERE project_id = $1::uuid AND idempotency_key = $2
      AND (expires_at IS NULL OR expires_at > now())`;

export const SQL_SAVE_IDEMPOTENCY_RESULT = `INSERT INTO batch_idempotency_keys (
    project_id, idempotency_key, response_hash, response_payload, expires_at
  ) VALUES ($1::uuid, $2, $3, $4::jsonb, $5::timestamptz)
  ON CONFLICT (project_id, idempotency_key)
  DO UPDATE SET
    response_hash = EXCLUDED.response_hash,
    response_payload = EXCLUDED.response_payload,
    expires_at = EXCLUDED.expires_at`;

/** Bounded cleanup — one DELETE, callable from a maintenance worker. */
export const SQL_CLEANUP_IDEMPOTENCY = `DELETE FROM batch_idempotency_keys WHERE expires_at < now()`;

/**
 * Cleanup helper for a worker/cron task. The table has FORCE RLS (migration
 * 0010), so a tenant-scoped call must supply `ctx`; the GUCs are set with
 * `is_local = true` and are safe inside `withTransaction`. A context-free call
 * is a global reaper and requires a BYPASSRLS/superuser maintenance role,
 * otherwise RLS makes it a no-op.
 */
export async function runIdempotencyCleanup(
  client: SqlQueryClient,
  ctx?: TenantContext
): Promise<{ purgedCount: number }> {
  if (ctx !== undefined) {
    requireUuid(ctx.projectId, "projectId");
    await client.query(SQL_SET_TENANT_CONTEXT_PARAMETERIZED, [ctx.projectId]);
  }
  const { rowCount } = await client.query(SQL_CLEANUP_IDEMPOTENCY);
  return { purgedCount: rowCount ?? 0 };
}

export const SQL_LIST_DOCS_VIA_INDEX = `SELECT d.project_id AS "projectId", d.path,
        d.collection_path AS "collectionPath", d.collection_group AS "collectionGroup",
        d.document_id AS "documentId", d.path_depth AS "pathDepth", d.data,
        d.size_bytes AS "sizeBytes", d.version::int AS "version",
        d.created_at::text AS "createdAt", d.updated_at::text AS "updatedAt", d.deleted_at::text AS "deletedAt",
        d.expires_at::text AS "expiresAt"
   FROM document_index_entries e
   JOIN documents d ON d.project_id = e.project_id AND d.path = e.path
  WHERE e.index_id = $1::uuid AND e.project_id = $2::uuid
    AND d.deleted_at IS NULL AND (d.expires_at IS NULL OR d.expires_at > now())
  ORDER BY e.sort_key ASC, e.document_id ASC`;

export const SQL_LIST_INDEXES = `SELECT id, project_id AS "projectId",
        collection_path AS "collectionPath", fields, definition_hash AS "definitionHash",
        status, created_at::text AS "createdAt", updated_at::text AS "updatedAt"
   FROM document_indexes
  WHERE project_id = $1::uuid`;

export const SQL_DELETE_INDEX = `DELETE FROM document_indexes
  WHERE id = $1::uuid AND project_id = $2::uuid`;

/**
 * Execute a statement either as a named prepared statement (pg) or as plain
 * parameterized SQL (Neon/memory-compatible clients).
 */
export async function runPrepared<T = Record<string, unknown>>(
  client: SqlQueryLike,
  prepared: boolean,
  name: string,
  text: string,
  params: unknown[] = []
): Promise<SqlQueryResult<T>> {
  const result = prepared
    ? await client.query({ name, text, values: params })
    : await client.query(text, params);
  const mapped: SqlQueryResult<T> = { rows: result.rows as T[] };
  if (result.rowCount !== undefined) mapped.rowCount = result.rowCount;
  return mapped;
}

/** One row of the shared composite-index entry insert. */
export interface IndexEntryInsert {
  indexId: string;
  collectionPath: string;
  sortKey: Buffer;
  documentId: string;
  path: string;
}

/**
 * Single round-trip UNNEST insert of composite index entries. Shared by
 * `putDocumentRows` and the index-builder worker (the latter previously issued
 * one INSERT per document — an N+1 that this helper removes).
 */
export async function batchInsertIndexEntries(
  client: SqlQueryLike,
  prepared: boolean,
  projectId: string,
  entries: IndexEntryInsert[]
): Promise<void> {
  if (entries.length === 0) return;
  await runPrepared(client, prepared, "vellum_insert_index_entries", SQL_INSERT_INDEX_ENTRIES, [
    projectId,
    entries.map((entry) => entry.indexId),
    entries.map((entry) => entry.collectionPath),
    entries.map((entry) => entry.sortKey),
    entries.map((entry) => entry.documentId),
    entries.map((entry) => entry.path),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Transaction handle                                                         */
/* -------------------------------------------------------------------------- */

interface InternalTxHandleOptions extends PreparedStatementOptions {
  /** Optional liveness check so escaped handles cannot use a released client. */
  isClosed?: () => boolean;
}

export function createSqlTransactionHandle(
  client: PgClientLike,
  ctx: TenantContext,
  options: InternalTxHandleOptions = {}
): SqlBatchTxHandle {
  const { projectId } = ctx;
  const prepared = options.preparedStatements === true;
  const isClosed = options.isClosed;

  function assertOpen(): void {
    if (isClosed?.()) {
      throw new VellumError(
        "FAILED_PRECONDITION",
        "Transaction handle is no longer active (transaction already committed or rolled back)"
      );
    }
  }

  // one composite-index-definition query per collection per tenant
  // transaction instead of one query per document write (the original N+1).
  const indexesByCollection = new Map<string, CachedIndexDefinition[]>();

  async function getIndexesForCollection(collectionPath: string): Promise<CachedIndexDefinition[]> {
    const cached = indexesByCollection.get(collectionPath);
    if (cached) return cached;
    const { rows } = await runPrepared<CachedIndexDefinition>(
      client,
      prepared,
      "vellum_get_indexes",
      SQL_GET_INDEXES,
      [projectId, collectionPath]
    );
    const defs = rows;
    indexesByCollection.set(collectionPath, defs);
    return defs;
  }

  /** Rebuild derived index entries for the affected paths after a write. */
  async function syncIndexEntries(rows: DocumentRecord[]): Promise<void> {
    if (rows.length === 0) return;
    const paths = rows.map((r) => r.path);
    await runPrepared(client, prepared, "vellum_delete_index_entries", SQL_DELETE_INDEX_ENTRIES, [
      projectId,
      paths,
    ]);

    const entries: IndexEntryInsert[] = [];
    for (const row of rows.filter((r) => r.deletedAt === null)) {
      const defs = await getIndexesForCollection(row.collectionPath);
      for (const idx of defs) {
        entries.push({
          indexId: idx.id,
          collectionPath: row.collectionPath,
          sortKey: encodeCompositeSortKey(row, idx.fields),
          documentId: row.documentId,
          path: row.path,
        });
      }
    }
    await batchInsertIndexEntries(client, prepared, projectId, entries);
  }

  return {
    projectId,

    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<SqlQueryResult<T>> => {
      assertOpen();
      const result = await client.query(sql, params);
      const mapped: SqlQueryResult<T> = { rows: result.rows as T[] };
      if (result.rowCount !== undefined) mapped.rowCount = result.rowCount;
      return mapped;
    },

    async getDocument(path: string, includeSoftDeleted = false, forUpdate = false): Promise<DocumentRecord | null> {
      assertOpen();
      const statement = getDocumentStatement(includeSoftDeleted, forUpdate);
      const { rows } = await runPrepared<DocumentRecord>(
        client,
        prepared,
        statement.name,
        statement.text,
        [projectId, path]
      );
      return rows[0] ?? null;
    },

    /**
     * V2: fetch an entire relationship fan-out in ONE statement instead of one
     * `getDocument` per path. Paths are deduplicated (Set preserves first-seen
     * order) and the SQL result is reordered to match that requested order.
     * By default only live, unexpired rows are returned — identical semantics
     * to `getDocument(path, false, false)`. `includeDeleted = true` uses a
     * separate statement with no tombstone/TTL filter (admin/GC view).
     */
    async batchGetDocuments(paths: string[], includeDeleted = false, forUpdate = false): Promise<DocumentRecord[]> {
      assertOpen();
      const uniquePaths = Array.from(new Set(paths));
      if (uniquePaths.length === 0) return [];
      if (forUpdate) {
        // FOR UPDATE cannot lock a row that does not exist yet, so concurrent blind creates of one path
        // would all read "absent" and race to write version 1. A per-path advisory lock, taken in sorted
        // order, serialises them (and cannot deadlock against another batch that sorts the same way).
        await runPrepared(
          client,
          prepared,
          "vellum_batch_path_locks",
          `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || s.p, 0))
             FROM (SELECT p FROM unnest($2::text[]) AS p ORDER BY p) s`,
          [projectId, uniquePaths]
        );
      }
      const { rows } = await runPrepared<DocumentRecord>(
        client,
        prepared,
        (includeDeleted ? "vellum_batch_get_documents_all" : "vellum_batch_get_documents") + (forUpdate ? "_lock" : ""),
        (includeDeleted ? SQL_BATCH_GET_DOCUMENTS_ALL : SQL_BATCH_GET_DOCUMENTS) + (forUpdate ? " FOR UPDATE" : ""),
        [projectId, uniquePaths]
      );
      const byPath = new Map(rows.map((row) => [row.path, row]));
      const ordered: DocumentRecord[] = [];
      for (const path of uniquePaths) {
        const row = byPath.get(path);
        if (row !== undefined) ordered.push(row);
      }
      return ordered;
    },

    /**
     * Compare-and-swap write. Returns `{ applied: false }` on a create/version
     * race rather than throwing: the storage layer stays dumb and the engine
     * maps the loss to ALREADY_EXISTS (create) or ABORTED_CONFLICT (version).
     * A version-0 tombstone still occupies the unique key, so a null-expected
     * create is not applied here; restoring it is an explicit upsert/restore.
     */
    async conditionalPutDocument(row: DocumentRecord, expectedVersion: number | null): Promise<{ applied: boolean }> {
      assertOpen();
      if (row.projectId !== projectId) {
        throw new VellumError("PERMISSION_DENIED", "RLS policy violation on documents conditional write");
      }
      if (expectedVersion !== null && (!Number.isInteger(expectedVersion) || expectedVersion < 0)) {
        throw new VellumError("INVALID_ARGUMENT", "expectedVersion must be null or a non-negative integer");
      }
      const baseParams = [
        projectId,
        row.path,
        row.collectionPath,
        row.collectionGroup,
        row.documentId,
        row.pathDepth,
        JSON.stringify(row.data),
        row.sizeBytes,
        row.version,
        row.createdAt,
        row.updatedAt,
        row.deletedAt,
        row.expiresAt ?? null,
      ];
      let rowCount: number | null;
      if (expectedVersion === null) {
        const result = await runPrepared(
          client,
          prepared,
          "vellum_conditional_insert_document",
          SQL_CONDITIONAL_INSERT_DOCUMENT,
          baseParams
        );
        rowCount = result.rowCount ?? 0;
      } else {
        // INSERT params 1..13 are reused; the UPDATE statement reads the same
        // values in a different order, so rebuild the bind vector explicitly.
        const result = await runPrepared(
          client,
          prepared,
          "vellum_conditional_update_document",
          SQL_CONDITIONAL_UPDATE_DOCUMENT,
          [
            projectId,
            row.path,
            JSON.stringify(row.data),
            row.sizeBytes,
            row.version,
            row.updatedAt,
            row.deletedAt,
            row.expiresAt ?? null,
            expectedVersion,
          ]
        );
        rowCount = result.rowCount ?? 0;
      }
      const applied = rowCount === 1;
      if (applied) await syncIndexEntries([row]);
      return { applied };
    },

    async putDocumentRow(row: DocumentRecord): Promise<void> {
      // Kept as a one-row convenience wrapper; batchWrite uses putDocumentRows.
      await this.putDocumentRows([row]);
    },

    /**
     * multi-row upsert of documents + all derived composite index
     * entries in a single round trip per statement (PostgreSQL UNNEST). Index
     * definitions are fetched once per collection via getIndexesForCollection.
     * Every statement runs on `client`, i.e. inside the same tenant transaction
     * so document writes and the realtime outbox commit atomically.
     */
    async putDocumentRows(rows: DocumentRecord[]): Promise<void> {
      assertOpen();
      if (rows.length === 0) return;
      for (const row of rows) {
        if (row.projectId !== projectId) {
          throw new VellumError("PERMISSION_DENIED", "RLS policy violation on documents batch write");
        }
      }

      // UNNEST batch upsert preserved verbatim (now as a named prepared statement).
      await runPrepared(client, prepared, "vellum_insert_documents", SQL_INSERT_DOCUMENTS_UNNEST, [
        projectId,
        rows.map((r) => r.path),
        rows.map((r) => r.collectionPath),
        rows.map((r) => r.collectionGroup),
        rows.map((r) => r.documentId),
        rows.map((r) => r.pathDepth),
        rows.map((r) => JSON.stringify(r.data)),
        rows.map((r) => r.sizeBytes),
        rows.map((r) => r.version),
        rows.map((r) => r.createdAt),
        rows.map((r) => r.updatedAt),
        rows.map((r) => r.deletedAt),
        rows.map((r) => r.expiresAt ?? null),
      ]);

      // Composite index entries are derived rows: rebuild them for the
      // affected paths in the same transaction as the document upsert.
      await syncIndexEntries(rows);
    },

    /**
     * Batched CAS flush. Returns the paths whose precondition was met; missing
     * paths are the races the engine maps to ALREADY_EXISTS / ABORTED_CONFLICT.
     */
    async conditionalPutDocumentRows(
      rows: DocumentRecord[],
      expectedVersions: ReadonlyArray<number | null>
    ): Promise<string[]> {
      assertOpen();
      if (rows.length === 0) return [];
      if (expectedVersions.length !== rows.length) {
        throw new VellumError(
          "INVALID_ARGUMENT",
          `conditionalPutDocumentRows expectedVersions length (${expectedVersions.length}) must match rows length (${rows.length})`
        );
      }
      for (let i = 0; i < rows.length; i++) {
        if (rows[i]!.projectId !== projectId) {
          throw new VellumError("PERMISSION_DENIED", "RLS policy violation on documents conditional batch write");
        }
        const ev = expectedVersions[i] ?? null;
        if (ev !== null && (!Number.isInteger(ev) || ev < 0)) {
          throw new VellumError("INVALID_ARGUMENT", "expectedVersion must be null or a non-negative integer");
        }
      }
      const { rows: applied } = await runPrepared<{ path: string }>(
        client,
        prepared,
        "vellum_conditional_put_documents",
        SQL_CONDITIONAL_PUT_DOCUMENTS_UNNEST,
        [
          projectId,
          rows.map((r) => r.path),
          rows.map((r) => r.collectionPath),
          rows.map((r) => r.collectionGroup),
          rows.map((r) => r.documentId),
          rows.map((r) => r.pathDepth),
          rows.map((r) => JSON.stringify(r.data)),
          rows.map((r) => r.sizeBytes),
          rows.map((r) => r.version),
          rows.map((r) => r.createdAt),
          rows.map((r) => r.updatedAt),
          rows.map((r) => r.deletedAt),
          rows.map((r) => r.expiresAt ?? null),
          rows.map((_r, i) => expectedVersions[i] ?? null),
        ]
      );
      const appliedPaths = applied.map((row) => row.path);
      const appliedSet = new Set(appliedPaths);
      await syncIndexEntries(rows.filter((r) => appliedSet.has(r.path)));
      return appliedPaths;
    },

    async appendOutboxEvent({
      collectionPath,
      path,
      documentId,
      opType,
      version,
      beforeData,
      afterData,
    }: OutboxMutation): Promise<OutboxEvent> {
      assertOpen();
      const { rows } = await runPrepared<{ seqId: string; committedAt: string }>(
        client,
        prepared,
        "vellum_insert_outbox",
        SQL_INSERT_OUTBOX,
        [
          projectId,
          collectionPath,
          path,
          documentId,
          opType,
          version,
          beforeData ? JSON.stringify(beforeData) : null,
          afterData ? JSON.stringify(afterData) : null,
        ]
      );
      const inserted = rows[0];
      if (inserted === undefined) throw new Error("realtime_outbox INSERT returned no row");
      return {
        seqId: inserted.seqId,
        projectId,
        collectionPath,
        path,
        documentId,
        opType,
        version,
        beforeData,
        afterData,
        committedAt: inserted.committedAt,
      };
    },

    async appendOutboxEvents(events: OutboxMutation[]): Promise<OutboxEvent[]> {
      assertOpen();
      if (events.length === 0) return [];
      if (events.length === 1) {
        return [await this.appendOutboxEvent(events[0]!)];
      }
      const { rows } = await runPrepared<{ seqId: string; committedAt: string }>(
        client,
        prepared,
        "vellum_insert_outbox_unnest",
        SQL_INSERT_OUTBOX_UNNEST,
        [
          projectId,
          events.map((e) => e.collectionPath),
          events.map((e) => e.path),
          events.map((e) => e.documentId),
          events.map((e) => e.opType),
          events.map((e) => e.version),
          events.map((e) => (e.beforeData ? JSON.stringify(e.beforeData) : null)),
          events.map((e) => (e.afterData ? JSON.stringify(e.afterData) : null)),
        ]
      );
      if (rows.length !== events.length) {
        throw new Error("realtime_outbox batch INSERT returned unexpected row count");
      }
      return events.map((ev, i) => ({
        seqId: rows[i]!.seqId,
        projectId,
        collectionPath: ev.collectionPath,
        path: ev.path,
        documentId: ev.documentId,
        opType: ev.opType,
        version: ev.version,
        beforeData: ev.beforeData,
        afterData: ev.afterData,
        committedAt: rows[i]!.committedAt,
      }));
    },

    async createIndex({ collectionPath, fields }: { collectionPath: string; fields: IndexFieldItem[] }): Promise<CompositeIndexRecord> {
      assertOpen();
      const definitionHash = computeIndexDefinitionHash(collectionPath, fields);
      const id = crypto.randomUUID();
      try {
        const { rows } = await runPrepared<CompositeIndexRecord>(
          client,
          prepared,
          "vellum_create_index",
          SQL_CREATE_INDEX,
          [id, projectId, collectionPath, JSON.stringify(fields), definitionHash]
        );
        const created = rows[0];
        if (created === undefined) throw new Error("document_indexes INSERT returned no row");
        indexesByCollection.delete(collectionPath);
        return created;
      } catch (error: unknown) {
        // The (project, definition_hash) unique constraint makes a repeated
        // "create" a client-visible conflict (409), not a 500.
        if (
          typeof error === "object" && error !== null &&
          (error as { code?: unknown }).code === "23505"
        ) {
          throw new VellumError(
            "ALREADY_EXISTS",
            `A composite index with this definition already exists on '${collectionPath}'`,
            { collectionPath, definitionHash }
          );
        }
        throw error;
      }
    },

    async queryOutboxSince(afterSeqId = "0"): Promise<OutboxEvent[]> {
      assertOpen();
      // Runs inside the tenant transaction so RLS is enforced (never a raw pool query).
      const { rows } = await runPrepared<OutboxEvent>(
        client,
        prepared,
        "vellum_query_outbox",
        SQL_QUERY_OUTBOX,
        [projectId, afterSeqId]
      );
      return rows;
    },

    async queryDocuments(compiled: CompiledQuery): Promise<QueriedDocument[]> {
      assertOpen();
      // Compiled SQL is dynamic (operator/index shape), so it is intentionally
      // not a named prepared statement; it is still fully parameterized by the compiler.
      const { rows } = await client.query(compiled.sql, compiled.params);
      const cap = compiled.maxScanRows;
      if (cap !== null) {
        if (rows.length > cap) {
          throw new VellumError(
            "FAILED_PRECONDITION",
            `Unindexed query on '${compiled.normalizedQuery.collectionPath}' scanned more than ${cap} rows; create a composite index for this filter/sort shape.`,
            {
              collectionPath: compiled.normalizedQuery.collectionPath,
              maxScanRows: cap,
              scannedRows: rows.length,
              suggestedIndex: compiled.normalizedQuery.orderBy
                .filter((o) => o.field !== "documentId" && o.field !== "__name__")
                .map((o) => ({ path: o.field, dir: o.dir })),
            }
          );
        }
        if (rows.length === cap) {
          process.emitWarning(
            `[vellum] Unindexed query on '${compiled.normalizedQuery.collectionPath}' reached the ${cap}-row safety cap; add a composite index.`
          );
        }
      }

      return rows.map((raw) => {
        const row = raw as SqlQueriedRow;
        const data = row.projectedData != null ? row.projectedData : row.data;
        const sortKeyHex = row.sortKeyHex;
        const { projectedData: _projectedData, sortKeyHex: _sortKeyHex, ...rest } = row;
        return {
          ...rest,
          data,
          ...(sortKeyHex === undefined ? {} : { sortKeyHex }),
        } as QueriedDocument;
      });
    },

    async countLiveDocumentsUpTo(collectionPath: string, cap: number): Promise<number> {
      assertOpen();
      const bounded = Math.max(1, Math.min(Math.floor(cap), 10_000_000));
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM (
           SELECT 1 FROM documents
            WHERE project_id = $1::uuid AND collection_path = $2 AND deleted_at IS NULL
            LIMIT $3) s`,
        [projectId, collectionPath, bounded]
      );
      return Number((rows[0] as { n?: number } | undefined)?.n ?? 0);
    },

    async listActiveDocumentsInCollection(collectionPath: string): Promise<DocumentRecord[]> {
      assertOpen();
      const { rows } = await runPrepared<DocumentRecord>(
        client,
        prepared,
        "vellum_list_active_documents",
        SQL_LIST_ACTIVE_DOCUMENTS,
        [projectId, collectionPath]
      );
      return rows;
    },

    /**
     * JSONB-index-backed dependent lookup. `(ctx, ...)` is accepted for
     * compatibility with the hardening contract but is validated against the
     * transaction's own tenant and never used to alter RLS context.
     */
    async listDependentsByReference(
      ...args: [collectionPath: string, field: string, targetPath: string, limit: number]
        | [TenantContext, collectionPath: string, field: string, targetPath: string, limit: number]
    ): Promise<DocumentRecord[]> {
      assertOpen();
      const [collectionPath, field, targetPath, limit] = unwrapCtxArgs<
        [collectionPath: string, field: string, targetPath: string, limit: number]
      >(args, { projectId });
      const boundedLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 50), 501));
      const { rows } = await runPrepared<DocumentRecord>(
        client,
        prepared,
        "vellum_list_dependents_by_reference_v2",
        SQL_LIST_DEPENDENTS_BY_REFERENCE,
        [projectId, collectionPath, referenceMatchJsonPath(targetPath, field),
          referenceMatchJsonPath(targetPath.split("/").at(-1)!, field), boundedLimit]
      );
      return rows;
    },

    async referencedByPage(request) {
      assertOpen();
      const { rows } = await runPrepared<DocumentRecord>(client, prepared,
        "vellum_referenced_by_page_v1",
        `SELECT ${DOCUMENT_COLUMNS} FROM documents
          WHERE project_id=$1::uuid AND ${LIVE_DOCUMENT_PREDICATE}
            AND ($3::text IS NULL OR collection_path=$3)
            AND ($4::text IS NULL OR path COLLATE "C" > $4 COLLATE "C")
            AND data @? $2::jsonpath
          ORDER BY path COLLATE "C" ASC LIMIT $5`,
        [projectId, referenceMatchJsonPath(request.targetPath, request.field),
          request.collection ?? null, request.afterPath ?? null,
          Math.max(1, Math.min(100, Math.floor(request.limit) || 100))]);
      return rows;
    },

    /** Cursor-only page (no OFFSET) of live docs, ordered by `document_id ASC`. */
    async listDocumentsInCollectionPage(
      ...args: [collectionName: string, opts: { afterDocumentId?: string | null; limit: number }]
        | [TenantContext, collectionName: string, opts: { afterDocumentId?: string | null; limit: number }]
    ): Promise<DocumentRecord[]> {
      assertOpen();
      const [collectionName, opts] = unwrapCtxArgs<
        [collectionName: string, opts: { afterDocumentId?: string | null; limit: number }]
      >(args, { projectId });
      const boundedLimit = Math.max(1, Math.min(Math.floor(Number(opts?.limit) || 50), 500));
      const { rows } = await runPrepared<DocumentRecord>(
        client,
        prepared,
        "vellum_list_documents_in_collection_page",
        SQL_LIST_DOCUMENTS_IN_COLLECTION_PAGE,
        [projectId, collectionName, opts?.afterDocumentId ?? null, boundedLimit]
      );
      return rows;
    },

    async listDocumentsViaCompositeIndex(indexId: string): Promise<DocumentRecord[]> {
      assertOpen();
      const { rows } = await runPrepared<DocumentRecord>(
        client,
        prepared,
        "vellum_list_docs_via_index",
        SQL_LIST_DOCS_VIA_INDEX,
        [indexId, projectId]
      );
      return rows;
    },

    async listIndexes(): Promise<CompositeIndexRecord[]> {
      assertOpen();
      const { rows } = await runPrepared<CompositeIndexRecord>(
        client,
        prepared,
        "vellum_list_indexes",
        SQL_LIST_INDEXES,
        [projectId]
      );
      return rows;
    },

    async deleteIndex(indexId: string): Promise<boolean> {
      assertOpen();
      const { rowCount } = await runPrepared(
        client,
        prepared,
        "vellum_delete_index",
        SQL_DELETE_INDEX,
        [indexId, projectId]
      );
      indexesByCollection.clear();
      return (rowCount ?? 0) > 0;
    },

    /** V2 native aggregation — parameterized SQL, executed inside the tenant tx. */
    async aggregateDocuments(req: AggregateRequest): Promise<AggregateRow[]> {
      assertOpen();
      const { sql, params } = compileAggregateSql({ projectId }, req);
      // Dynamic SQL (group/metric shape), so it is not a named prepared
      // statement — but every value is a bind parameter and RLS is active.
      const { rows } = await client.query(sql, params);
      return normalizeAggregateRows(rows as AggregateRow[], req);
    },

    /** V2 bulk delete — selection + tombstones + outbox in this one transaction. */
    async deleteWhere(
      collectionPath: string,
      where: WhereClause[],
      options: DeleteWhereOptions
    ): Promise<number> {
      assertOpen();
      const staged = await executeDeleteWhereInTx(
        this,
        { projectId },
        collectionPath,
        where,
        options,
        new Date().toISOString()
      );
      return staged.deletedCount;
    },

    /** Cached idempotent response (table `batch_idempotency_keys`, 24h TTL). */
    async getIdempotencyResult(
      ...args: [key: string] | [TenantContext, key: string]
    ): Promise<IdempotencyResult | null> {
      assertOpen();
      const [key] = unwrapCtxArgs<[key: string]>(args, { projectId });
      // Serialize the absent-ledger-row case too. Row locking alone cannot
      // lock a key that does not exist yet, so racing retries could both write.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [JSON.stringify([projectId, key])]
      );
      const { rows } = await runPrepared<IdempotencyResult>(
        client,
        prepared,
        "vellum_get_idempotency_result",
        SQL_GET_IDEMPOTENCY_RESULT,
        [projectId, key]
      );
      return rows[0] ?? null;
    },

    /** Safe upsert of a cached idempotent response (24h TTL). */
    async saveIdempotencyResult(
      ...args: [key: string, responseHash: string, responsePayload: unknown]
        | [TenantContext, key: string, responseHash: string, responsePayload: unknown]
    ): Promise<void> {
      assertOpen();
      const [key, responseHash, responsePayload] = unwrapCtxArgs<
        [key: string, responseHash: string, responsePayload: unknown]
      >(args, { projectId });
      await runPrepared(
        client,
        prepared,
        "vellum_save_idempotency_result",
        SQL_SAVE_IDEMPOTENCY_RESULT,
        [
          projectId,
          key,
          responseHash,
          JSON.stringify(responsePayload ?? null),
          new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString(),
        ]
      );
    },
  };
}

export async function runInTenantTransactionAsync<T>(
  pool: { connect: () => Promise<PgClientLike> },
  ctx: TenantContext,
  asyncCallback: (tx: TxHandle) => Promise<T>,
  options: PreparedStatementOptions = {}
): Promise<T> {
  const { projectId } = ctx;
  if (!projectId) {
    throw new VellumError(
      "PERMISSION_DENIED",
      "RLS Violation: Missing tenant context (app.current_project_id)"
    );
  }

  // Strict validation MUST happen before interpolation: the pg path sends one
  // multi-statement simple query with the id inlined, so an unvalidated id
  // would be an injection vector. Anchored UUID only; no quotes can survive.
  requireUuid(projectId, "projectId");

  const scopeKey = options.poolKey ?? pool;
  const activeFrame = activeTxStorage.getStore();
  if (activeFrame !== undefined && activeFrame.scopeKey === scopeKey) {
    if (activeFrame.projectId !== projectId) {
      throw new VellumError(
        "PERMISSION_DENIED",
        "RLS Violation: cannot nest a transaction for a different tenant",
        { expectedProjectId: activeFrame.projectId, suppliedProjectId: projectId }
      );
    }
    // Re-entrant transaction on the same pool & tenant: use a SAVEPOINT to
    // avoid pool starvation and row-lock self-deadlocks while preserving atomic
    // partial rollback on inner failure.
    activeFrame.savepointCounter += 1;
    const spName = `vellum_sp_${activeFrame.savepointCounter}`;
    let closed = false;
    const nestedHandle = createSqlTransactionHandle(activeFrame.client, ctx, {
      ...options,
      preparedStatements: activeFrame.prepared,
      isClosed: () => closed,
    });
    await activeFrame.client.query(`SAVEPOINT ${spName}`);
    try {
      const result = await asyncCallback(nestedHandle);
      await activeFrame.client.query(`RELEASE SAVEPOINT ${spName}`);
      return result;
    } catch (err: unknown) {
      try {
        await activeFrame.client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
      } catch {
        // Outer transaction rollback will clean up if the connection broke.
      }
      if (getPgErrorCode(err) === "57014") {
        throw new VellumError("QUERY_DEADLINE_EXCEEDED", "Database query exceeded 5000ms statement_timeout");
      }
      throw err;
    } finally {
      closed = true;
    }
  }

  const prepared = options.preparedStatements === true;
  const maxRetries = Math.max(0, Math.min(Math.floor(options.maxRetries ?? 3), 10));
  const retryBaseDelayMs = Math.max(1, Math.min(Math.floor(options.retryBaseDelayMs ?? 15), 1_000));

  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    let closed = false;
    let releaseError: Error | boolean | undefined;
    try {
      if (prepared) {
        // PostgreSQL pg.Pool: one network round trip. Simple-query protocol
        // (no bind params) accepts the BEGIN/SET/set_config sequence in a single
        // command string; all settings remain transaction-local (`true`).
        await client.query(buildPgTenantSetupSql(projectId));
      } else {
        // Neon (and any preparedStatements:false caller): a multi-statement query
        // cannot carry $1 parameters, so we use two round trips: BEGIN, then
        // one parameterized SELECT that sets the project id, timeout and search_path.
        await client.query("BEGIN");
        await client.query(SQL_SET_TENANT_CONTEXT_PARAMETERIZED, [projectId]);
      }

      const frame: ActiveTxFrame = {
        scopeKey,
        projectId,
        client,
        prepared,
        savepointCounter: 0,
      };
      const txHandle = createSqlTransactionHandle(client, ctx, {
        ...options,
        isClosed: () => closed,
      });
      const result = await activeTxStorage.run(frame, () => asyncCallback(txHandle));

      await client.query("COMMIT");
      return result;
    } catch (err: unknown) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr: unknown) {
        // Destroy the broken/poisoned client instead of returning it to the pool.
        releaseError = rollbackErr instanceof Error ? rollbackErr : true;
      }
      const code = getPgErrorCode(err);
      if (code === "57014") {
        throw new VellumError("QUERY_DEADLINE_EXCEEDED", "Database query exceeded 5000ms statement_timeout");
      }
      if (code !== null && RETRYABLE_PG_CODES.has(code) && attempt < maxRetries) {
        const jitter = Math.floor(Math.random() * retryBaseDelayMs);
        await sleepMs(retryBaseDelayMs * (1 << attempt) + jitter);
        continue;
      }
      throw err;
    } finally {
      closed = true;
      if (releaseError !== undefined) {
        client.release(releaseError);
      } else {
        client.release();
      }
    }
  }
}
