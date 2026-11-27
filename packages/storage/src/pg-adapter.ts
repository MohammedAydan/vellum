/**
 * @vellum/storage - PostgreSQL Storage Adapter
 * Implements StorageAdapter backed by pg.Pool with RLS enforcement.
 */

import crypto from "node:crypto";
import pg from "pg";
import {
  BoundedLruCache,
  VellumError,
  encodeCompositeSortKey,
  validateCollectionName,
} from "@vellum/core";
import type { CompiledQuery, WhereClause } from "@vellum/query-engine";
import type { AggregateRequest, AggregateRow, DeleteWhereOptions } from "./aggregates.js";
import {
  batchInsertIndexEntries,
  runIdempotencyCleanup,
  runInTenantTransactionAsync,
  toPgClientLike,
  toSqlQueryClient,
  type SqlQueryClient,
  type SqlTxHandle,
} from "./tx-context.js";
import { AuthMethodDelegates, createSqlAuthOperations, type SqlAuthTx } from "./auth-store.js";
import type {
  TenantContext,
  DocumentRecord,
  OutboxEvent,
  OutboxMutation,
  IndexFieldItem,
  CompositeIndexRecord,
  IndexBuilderOptions,
  TxHandle,
  StorageAdapter,
  QueriedDocument,
  CollectionSchemaValidation,
  CollectionConfig,
  CollectionRecord,
  CollectionWithStats,
  CreateCollectionInput,
  UpdateCollectionInput,
  ListCollectionsOptions,
  IdempotencyResult,
} from "./types.js";

/**
 * Pool caps. The data plane is allowed 50 connections; the control
 * plane cap (10) is enforced in `@vellum/database-control` and mirrored here as
 * a documented constant for operations/tests. Never raise these without a
 * measured SLO review (CRUD p95 < 15ms local / < 50ms Neon).
 */
export const DATA_POOL_MAX = 50;
export const CONTROL_POOL_MAX = 10;

function clampPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(Math.floor(n), max);
}

/** Escape LIKE/ILIKE metacharacters (`\`, `%`, `_`) so user search input is literal. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export class PgStorageAdapter extends AuthMethodDelegates implements StorageAdapter {
  public readonly pool: pg.Pool;
  public readonly directPool: pg.Pool;

  /** Bounded FIFO set of registered collection cache keys (tenant-scoped). */
  private readonly knownCollections = new Set<string>();
  /** Short-lived config cache: auto-registration is O(1) after first use. */
  private readonly collectionConfigCache = new BoundedLruCache<string, CollectionConfig>({
    maxEntries: 2_000,
    ttlMs: 10_000,
  });

  constructor(options?: { pool?: pg.Pool; connectionString?: string; maxConnections?: number }) {
    super();
    this.authOps = createSqlAuthOperations(
      <T>(ctx: TenantContext, callback: (tx: SqlAuthTx) => Promise<T>): Promise<T> =>
        this.withTransaction(ctx, (tx) => callback(tx as SqlTxHandle))
    );
    if (options?.pool) {
      this.pool = options.pool;
      this.directPool = options.pool;
    } else {
      const connectionString =
        options?.connectionString ??
        process.env["DATA_DATABASE_URL"] ??
        process.env["DATABASE_URL"] ??
        "postgresql://vellum_data:data_secret@localhost:5433/data_db";
      const poolMax =
        options?.maxConnections !== undefined
          ? clampPositiveInt(options.maxConnections, DATA_POOL_MAX, 1, DATA_POOL_MAX)
          : clampPositiveInt(process.env["DATA_POOL_MAX"], DATA_POOL_MAX, 1, DATA_POOL_MAX);
      // V2 pool tuning: idle sockets are reaped after 30s so a burst of
      // tenant traffic cannot leave hundreds of dormant server connections;
      // a connect that cannot be established within 30s fails fast rather than
      // queueing behind a dead endpoint; maxLifetimeSeconds rotates physically
      // aged connections to avoid leaking session state across long lives.
      const connectTimeoutMs = clampPositiveInt(
        process.env["DATA_POOL_CONNECT_TIMEOUT_MS"],
        5_000,
        1_000,
        120_000
      );
      this.pool = new pg.Pool({
        connectionString,
        max: poolMax,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: connectTimeoutMs,
        maxLifetimeSeconds: 30 * 60,
      });
      // Prevent unhandled 'error' events on idle clients from crashing Node.js.
      this.pool.on("error", () => {
        /* pg.Pool automatically evicts and replaces errored idle clients */
      });
      this.directPool = this.pool;
    }
  }

  private collectionCacheKey(ctx: TenantContext, name: string): string {
    return `${ctx.projectId.length}:${ctx.projectId}:${name}`;
  }

  private rememberCollection(key: string): void {
    if (this.knownCollections.has(key)) return;
    this.knownCollections.add(key);
    if (this.knownCollections.size > 5_000) {
      const oldest = this.knownCollections.values().next();
      if (oldest.done !== true) this.knownCollections.delete(oldest.value);
    }
  }

  private forgetCollection(key: string): void {
    this.knownCollections.delete(key);
    this.collectionConfigCache.delete(key);
  }

  public async withTransaction<T>(ctx: TenantContext, callback: (tx: TxHandle) => Promise<T>): Promise<T> {
    return runInTenantTransactionAsync(
      {
        connect: async () => {
          const client = await this.pool.connect();
          return toPgClientLike(client);
        },
      },
      ctx,
      callback,
      // pg.Pool keeps physical connections alive, so named prepared statements
      // are reused across requests on the same connection.
      { preparedStatements: true, poolKey: this.pool }
    );
  }

  public async getDocument(
    ctx: TenantContext,
    path: string,
    opts?: { includeSoftDeleted?: boolean; forUpdate?: boolean }
  ): Promise<DocumentRecord | null> {
    return this.withTransaction(ctx, (tx) => tx.getDocument(path, opts?.includeSoftDeleted, opts?.forUpdate));
  }

  /**
   * V2: one SQL statement for a whole set of paths (relationship fan-out).
   * Paths are trimmed/deduplicated and capped at 1,000 to bound the bind array;
   * `SqlTxHandle.batchGetDocuments` restores the caller's requested order.
   */
  public async batchGetDocuments(
    ctx: TenantContext,
    paths: string[],
    includeDeleted = false
  ): Promise<DocumentRecord[]> {
    const unique = Array.from(
      new Set(paths.filter((path) => typeof path === "string" && path.length > 0))
    ).slice(0, 1_000);
    if (unique.length === 0) return [];
    return this.withTransaction(
      ctx,
      async (tx) => (await tx.batchGetDocuments?.(unique, includeDeleted)) ?? []
    );
  }

  /** Compare-and-swap create/update; see `TxHandle.conditionalPutDocument`. */
  public async conditionalPutDocument(
    ctx: TenantContext,
    row: DocumentRecord,
    expectedVersion: number | null
  ): Promise<{ applied: boolean }> {
    return this.withTransaction(
      ctx,
      async (tx) => (await tx.conditionalPutDocument?.(row, expectedVersion)) ?? { applied: false }
    );
  }

  public async putDocument(ctx: TenantContext, row: DocumentRecord): Promise<void> {
    return this.withTransaction(ctx, (tx) => tx.putDocumentRow(row));
  }

  /**
   * Executes a compiled query inside a tenant transaction (RLS + 5000ms timeout).
   * Neon uses the identical code path via `NeonStorageAdapter.withTransaction`.
   */
  public async queryDocuments(ctx: TenantContext, compiled: CompiledQuery): Promise<QueriedDocument[]> {
    return this.withTransaction(ctx, (tx) => tx.queryDocuments(compiled));
  }

  public async listDocumentsInCollection(ctx: TenantContext, collectionPath: string): Promise<DocumentRecord[]> {
    return this.withTransaction(ctx, async (tx) => {
      if (tx.listActiveDocumentsInCollection) {
        return tx.listActiveDocumentsInCollection(collectionPath);
      }
      return [];
    });
  }

  public async listDocumentsViaIndex(ctx: TenantContext, indexId: string): Promise<DocumentRecord[]> {
    return this.withTransaction(ctx, async (tx) => {
      if (tx.listDocumentsViaCompositeIndex) {
        return tx.listDocumentsViaCompositeIndex(indexId);
      }
      return [];
    });
  }

  public async appendOutbox(
    ctx: TenantContext,
    event: OutboxMutation
  ): Promise<OutboxEvent> {
    return this.withTransaction(ctx, (tx) => tx.appendOutboxEvent(event));
  }

  public async createCompositeIndex(
    ctx: TenantContext,
    collectionPath: string,
    fields: IndexFieldItem[]
  ): Promise<CompositeIndexRecord> {
    return this.withTransaction(ctx, (tx) => tx.createIndex({ collectionPath, fields }));
  }

  public async listCompositeIndexes(ctx: TenantContext): Promise<CompositeIndexRecord[]> {
    return this.withTransaction(ctx, async (tx) => {
      if (tx.listIndexes) {
        return tx.listIndexes();
      }
      return [];
    });
  }

  public async deleteCompositeIndex(ctx: TenantContext, indexId: string): Promise<boolean> {
    return this.withTransaction(ctx, async (tx) => {
      if (tx.deleteIndex) {
        return tx.deleteIndex(indexId);
      }
      return false;
    });
  }

  public async queryOutboxSince(ctx: TenantContext, afterSeqId = "0"): Promise<OutboxEvent[]> {
    return this.withTransaction(ctx, async (tx) =>
      (await tx.queryOutboxSince?.(afterSeqId)) ?? []
    );
  }

  public async queryOutboxMaxSeq(ctx: TenantContext): Promise<string> {
    return this.withTransaction(ctx, async (tx) => (await tx.queryOutboxMaxSeq?.()) ?? "0");
  }

  public async runIndexBuilderWorker(
    options: IndexBuilderOptions = {}
  ): Promise<{ builtCount: number; pendingCount: number }> {
    const deadline = options.deadlineMs !== undefined ? Date.now() + options.deadlineMs : Infinity;
    let pendingCount = 0;
    const client = await this.directPool.connect();
    let builtCount = 0;
    let fatalError: Error | undefined;
    try {
      const { rows: buildingIndexes } = await client.query(
        `SELECT id, project_id AS "projectId",
                collection_path AS "collectionPath", fields
           FROM document_indexes
          WHERE status = 'building'
            AND ($1::uuid IS NULL OR project_id = $1::uuid)
            AND ($2::uuid IS NULL OR id = $2::uuid)
          ORDER BY created_at ASC
          LIMIT 10`,
        [options.projectId ?? null, options.indexId ?? null]
      );

      for (const rawIdx of buildingIndexes) {
        const idx = rawIdx as {
          id: string;
          projectId: string;
          collectionPath: string;
          fields: IndexFieldItem[];
        };
        try {
          // Resume where a previous (time-boxed or interrupted) run stopped:
          // entries are written in ascending document_id order.
          const { rows: resumeRows } = await client.query(
            `SELECT max(document_id) AS last FROM document_index_entries WHERE index_id = $1::uuid`,
            [idx.id]
          );
          let lastDocId = (resumeRows[0] as { last: string | null } | undefined)?.last ?? "";
          let timedOut = false;
          while (true) {
            if (Date.now() >= deadline) {
              timedOut = true;
              break;
            }
            const { rows: batchDocs } = await client.query(
              `SELECT path, collection_path AS "collectionPath", document_id AS "documentId",
                      data, created_at::text AS "createdAt", updated_at::text AS "updatedAt"
                 FROM documents
                WHERE project_id = $1::uuid
                  AND collection_path = $2 AND deleted_at IS NULL
                  AND (expires_at IS NULL OR expires_at > now())
                  AND document_id > $3
                ORDER BY document_id ASC
                LIMIT 500`,
              [idx.projectId, idx.collectionPath, lastDocId]
            );
            if (batchDocs.length === 0) break;

            // one UNNEST INSERT per 500-document page instead of one
            // INSERT per document (the old N+1 in the index-builder worker).
            const entries = batchDocs.map((rawDoc) => {
              const doc = rawDoc as DocumentRecord;
              return {
                indexId: idx.id,
                collectionPath: idx.collectionPath,
                sortKey: encodeCompositeSortKey(doc, idx.fields),
                documentId: doc.documentId,
                path: doc.path,
              };
            });
            await batchInsertIndexEntries(
              toPgClientLike(client),
              false,
              idx.projectId,
              entries
            );
            const lastEntry = entries[entries.length - 1];
            if (lastEntry === undefined) break;
            lastDocId = lastEntry.documentId;
          }

          if (timedOut) {
            pendingCount += 1;
            continue;
          }
          await client.query(
            `UPDATE document_indexes SET status = 'ready', updated_at = now() WHERE id = $1::uuid`,
            [idx.id]
          );
          builtCount += 1;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          try {
            await client.query(
              `UPDATE document_indexes SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1::uuid`,
              [idx.id, message]
            );
          } catch (secondaryErr: unknown) {
            fatalError = secondaryErr instanceof Error ? secondaryErr : new Error(String(secondaryErr));
            throw fatalError;
          }
        }
      }
      return { builtCount, pendingCount };
    } catch (err: unknown) {
      if (fatalError === undefined) {
        fatalError = err instanceof Error ? err : new Error(String(err));
      }
      throw err;
    } finally {
      if (fatalError !== undefined) {
        client.release(fatalError);
      } else {
        client.release();
      }
    }
  }

  public async runOutboxCompactionWorker(retentionHours = 24): Promise<{ purgedCount: number }> {
    const hours = clampPositiveInt(retentionHours, 24, 1, 8_760);
    const { rowCount } = await this.directPool.query(
      `DELETE FROM realtime_outbox
        WHERE seq_id IN (
          SELECT seq_id FROM realtime_outbox
           WHERE committed_at < now() - make_interval(hours => $1::int)
           LIMIT 10000
        )`,
      [hours]
    );
    return { purgedCount: rowCount ?? 0 };
  }

  public async runTombstonePurgeWorker(retentionDays = 7): Promise<{ purgedCount: number }> {
    const days = clampPositiveInt(retentionDays, 7, 1, 3_650);
    const { rowCount } = await this.directPool.query(
      `DELETE FROM documents
        WHERE (project_id, path) IN (
          SELECT project_id, path
            FROM documents
           WHERE deleted_at IS NOT NULL
             AND deleted_at < now() - make_interval(days => $1::int)
           LIMIT 5000
        )`,
      [days]
    );
    return { purgedCount: rowCount ?? 0 };
  }

  /** V2: bounded physical purge of expired live rows (maintenance pool owner). */
  public async runTtlSweeperWorker(limit = 500): Promise<{ purgedCount: number }> {
    const batchSize = clampPositiveInt(limit, 500, 1, 5_000);
    const { rowCount } = await this.directPool.query(
      `DELETE FROM documents
        WHERE (project_id, path) IN (
          SELECT project_id, path
            FROM documents
           WHERE expires_at IS NOT NULL
             AND expires_at <= now()
             AND deleted_at IS NULL
           LIMIT $1
        )`,
      [batchSize]
    );
    return { purgedCount: rowCount ?? 0 };
  }

  public async aggregateDocuments(
    ctx: TenantContext,
    request: AggregateRequest
  ): Promise<AggregateRow[]> {
    return this.withTransaction(ctx, async (tx) => (await tx.aggregateDocuments?.(request)) ?? []);
  }

  public async deleteWhere(
    ctx: TenantContext,
    collectionPath: string,
    where: WhereClause[],
    options: DeleteWhereOptions
  ): Promise<number> {
    return this.withTransaction(
      ctx,
      async (tx) => (await tx.deleteWhere?.(collectionPath, where, options)) ?? 0
    );
  }

  /* ------------------------------------------------------------------------ */
  /* ENGINE-HARDENING capability methods                                       */
  /* ------------------------------------------------------------------------ */

  public async listDependentsByReference(
    ctx: TenantContext,
    collectionPath: string,
    field: string,
    targetPath: string,
    limit: number
  ): Promise<DocumentRecord[]> {
    return this.withTransaction(
      ctx,
      async (tx) =>
        (await tx.listDependentsByReference?.(collectionPath, field, targetPath, limit)) ?? []
    );
  }

  public async listDocumentsInCollectionPage(
    ctx: TenantContext,
    collectionName: string,
    opts: { afterDocumentId?: string | null; limit: number }
  ): Promise<DocumentRecord[]> {
    return this.withTransaction(
      ctx,
      async (tx) => (await tx.listDocumentsInCollectionPage?.(collectionName, opts)) ?? []
    );
  }

  public async getIdempotencyResult(ctx: TenantContext, key: string): Promise<IdempotencyResult | null> {
    return this.withTransaction(
      ctx,
      async (tx) => (await tx.getIdempotencyResult?.(key)) ?? null
    );
  }

  public async saveIdempotencyResult(
    ctx: TenantContext,
    key: string,
    responseHash: string,
    responsePayload: unknown
  ): Promise<void> {
    await this.withTransaction(ctx, async (tx) => {
      await tx.saveIdempotencyResult?.(key, responseHash, responsePayload);
    });
  }

  public async runIdempotencyCleanupWorker(ctx?: TenantContext): Promise<{ purgedCount: number }> {
    if (ctx !== undefined) {
      return this.withTransaction(ctx, (tx) => runIdempotencyCleanup(tx as SqlTxHandle, ctx));
    }
    // Global reaper: needs a BYPASSRLS/superuser maintenance role (FORCE RLS).
    return runIdempotencyCleanup(toSqlQueryClient(this.directPool));
  }

  /* ------------------------------------------------------------------------ */
  /* Collections lifecycle (docs/COLLECTIONS-CONTRACT.md §2.2)                 */
  /* ------------------------------------------------------------------------ */

  public async createCollection(ctx: TenantContext, input: CreateCollectionInput): Promise<CollectionRecord> {
    const name = validateCollectionName(input.name);
    const key = this.collectionCacheKey(ctx, name);
    const record = await this.withTransaction(ctx, async (tx) => {
      const client = tx as SqlTxHandle;
      const row = await sqlInsertCollection(client, ctx, input, name, crypto.randomUUID(), new Date().toISOString());
      if (row !== null) return mapCollectionRow(row);
      if (input.ifNotExists !== true) {
        throw new VellumError("ALREADY_EXISTS", `Collection '${name}' already exists`, { name });
      }
      const existing = await sqlSelectCollectionRow(client, ctx, name);
      if (existing === null) {
        throw new VellumError("NOT_FOUND", `Collection '${name}' could not be reloaded after a conflict`, { name });
      }
      return mapCollectionRow(existing);
    });

    this.rememberCollection(key);
    this.collectionConfigCache.set(key, {
      schemaValidation: record.schemaValidation,
      defaultTtlSeconds: record.defaultTtlSeconds,
    });
    return record;
  }

  public async ensureCollectionExists(ctx: TenantContext, name: string): Promise<void> {
    const key = this.collectionCacheKey(ctx, name);
    if (this.knownCollections.has(key)) return;

    const config = await this.withTransaction(ctx, async (tx) => {
      const client = tx as SqlTxHandle;
      await sqlEnsureCollection(client, ctx, name);
      const row = await sqlSelectCollectionRow(client, ctx, name);
      return row === null ? null : collectionConfigFromRow(row);
    });

    this.rememberCollection(key);
    if (config !== null) this.collectionConfigCache.set(key, config);
  }

  public async listCollections(
    ctx: TenantContext,
    opts?: ListCollectionsOptions
  ): Promise<{ collections: CollectionWithStats[]; nextCursor: string | null }> {
    const rows = await this.withTransaction(ctx, async (tx) =>
      sqlListCollections(tx as SqlTxHandle, ctx, opts)
    );
    const limit = normalizeCollectionListLimit(opts?.limit);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      collections: page.map(mapCollectionWithStats),
      nextCursor: rows.length > limit && last !== undefined ? last.name : null,
    };
  }

  public async getCollection(ctx: TenantContext, name: string): Promise<CollectionWithStats | null> {
    const row = await this.withTransaction(ctx, async (tx) =>
      sqlGetCollection(tx as SqlTxHandle, ctx, name)
    );
    return row === null ? null : mapCollectionWithStats(row);
  }

  public async updateCollection(
    ctx: TenantContext,
    name: string,
    patch: UpdateCollectionInput
  ): Promise<CollectionWithStats> {
    const key = this.collectionCacheKey(ctx, name);
    const { row, statsRow } = await this.withTransaction(ctx, async (tx) => {
      const client = tx as SqlTxHandle;
      const updatedRow = await sqlUpdateCollection(client, ctx, name, patch);
      if (updatedRow === null) {
        throw new VellumError("NOT_FOUND", `Collection '${name}' not found`, { name });
      }
      const withStats = await sqlGetCollectionDirect(client, ctx, name);
      return { row: updatedRow, statsRow: withStats };
    });
    this.rememberCollection(key);
    this.collectionConfigCache.set(key, collectionConfigFromRow(row));

    if (statsRow === null) {
      throw new VellumError("NOT_FOUND", `Collection '${name}' not found after update`, { name });
    }
    return mapCollectionWithStats(statsRow);
  }

  public async clearCollectionDocuments(
    ctx: TenantContext,
    name: string
  ): Promise<{ deletedCount: number; freedBytes: number }> {
    return this.withTransaction(ctx, async (tx) =>
      sqlClearCollectionDocuments(tx as SqlTxHandle, ctx, name)
    );
  }

  public async deleteCollection(
    ctx: TenantContext,
    name: string
  ): Promise<{ deletedCollection: boolean; deletedDocuments: number; freedBytes: number }> {
    const result = await this.withTransaction(ctx, async (tx) =>
      sqlDeleteCollection(tx as SqlTxHandle, ctx, name)
    );
    this.forgetCollection(this.collectionCacheKey(ctx, name));
    return result;
  }

  public async getCollectionConfig(ctx: TenantContext, name: string): Promise<CollectionConfig | null> {
    const key = this.collectionCacheKey(ctx, name);
    const cached = this.collectionConfigCache.get(key);
    if (cached !== undefined) return cached;

    const config = await this.withTransaction(ctx, async (tx) => {
      const row = await sqlSelectCollectionRow(tx as SqlTxHandle, ctx, name);
      return row === null ? null : collectionConfigFromRow(row);
    });
    if (config !== null) this.collectionConfigCache.set(key, config);
    return config;
  }

  public async close(): Promise<void> {
    this.collectionConfigCache.dispose();
    await this.pool.end();
  }
}

/* -------------------------------------------------------------------------- */
/* Collection registry SQL — shared with NeonStorageAdapter so both drivers    */
/* execute byte-identical, fully parameterized, tenant-scoped statements.      */
/* -------------------------------------------------------------------------- */

const COLLECTION_RETURNING_COLUMNS = `
       id, project_id AS "projectId", name,
       description, default_ttl_seconds AS "defaultTtlSeconds",
       schema_validation AS "schemaValidation", is_system AS "isSystem",
       metadata, created_at::text AS "createdAt", updated_at::text AS "updatedAt"`;

/** Registry rows LEFT JOINed with live-document stats (soft-delete + TTL aware). */
const COLLECTION_STATS_SELECT = `
SELECT c.id, c.project_id AS "projectId", c.name,
       c.description, c.default_ttl_seconds AS "defaultTtlSeconds",
       c.schema_validation AS "schemaValidation", c.is_system AS "isSystem",
       c.metadata, c.created_at::text AS "createdAt", c.updated_at::text AS "updatedAt",
       COALESCE(s.document_count, 0)::int AS "documentCount",
       COALESCE(s.storage_bytes, 0)::bigint AS "storageBytes",
       s.last_document_at AS "lastDocumentAt"
  FROM project_collections c
  LEFT JOIN (
    SELECT collection_path,
           COUNT(*)::int AS document_count,
           COALESCE(SUM(size_bytes), 0)::bigint AS storage_bytes,
           MAX(updated_at)::text AS last_document_at
      FROM documents
     WHERE project_id = $1::uuid
       AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())
     GROUP BY collection_path
  ) s ON s.collection_path = c.name
 WHERE c.project_id = $1::uuid`;

export interface CollectionRow {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  defaultTtlSeconds: number | null;
  schemaValidation: unknown;
  isSystem: boolean;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionStatsRow extends CollectionRow {
  documentCount: number | string;
  storageBytes: number | string;
  lastDocumentAt: string | null;
}

function asJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asJsonRecord(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseSchemaValidation(value: unknown): CollectionSchemaValidation | null {
  const obj = asJsonRecord(value);
  if (obj === null) return null;
  const result: CollectionSchemaValidation = {};
  if (Array.isArray(obj["requiredFields"])) {
    result.requiredFields = obj["requiredFields"].filter((field: unknown): field is string => typeof field === "string");
  }
  if (typeof obj["strict"] === "boolean") result.strict = obj["strict"];
  return result;
}

export function collectionConfigFromRow(row: CollectionRow): CollectionConfig {
  return {
    schemaValidation: parseSchemaValidation(row.schemaValidation),
    defaultTtlSeconds: row.defaultTtlSeconds ?? null,
  };
}

export function mapCollectionRow(row: CollectionRow): CollectionRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description ?? null,
    defaultTtlSeconds: row.defaultTtlSeconds ?? null,
    schemaValidation: parseSchemaValidation(row.schemaValidation),
    isSystem: Boolean(row.isSystem),
    metadata: asJsonRecord(row.metadata) ?? {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function mapCollectionWithStats(row: CollectionStatsRow): CollectionWithStats {
  return {
    ...mapCollectionRow(row),
    documentCount: Number(row.documentCount ?? 0),
    storageBytes: Number(row.storageBytes ?? 0),
    lastDocumentAt: row.lastDocumentAt ?? null,
  };
}

export function normalizeCollectionListLimit(limit?: number): number {
  const value = Number(limit);
  if (!Number.isFinite(value) || value < 1) return 50;
  return Math.min(Math.floor(value), 500);
}

/** Idempotent registration hook — no row is inserted on a duplicate name. */
export async function sqlEnsureCollection(
  client: SqlQueryClient,
  ctx: TenantContext,
  name: string
): Promise<void> {
  await client.query(
    `INSERT INTO project_collections (project_id, name)
     VALUES ($1::uuid, $2)
     ON CONFLICT (project_id, name) DO NOTHING`,
    [ctx.projectId, name]
  );
}

/**
 * Registry fallback: register any `documents.collection_path` that predates the
 * migration (or was written before auto-registration was wired up). Runs inside
 * the same tenant transaction, so RLS still fails closed.
 */
export async function sqlSyncCollectionsFromDocuments(
  client: SqlQueryClient,
  ctx: TenantContext
): Promise<void> {
  await client.query(
    `INSERT INTO project_collections (project_id, name, created_at, updated_at)
     SELECT project_id, collection_path, MIN(created_at), MAX(updated_at)
       FROM documents
      WHERE project_id = $1::uuid
        AND collection_path IS NOT NULL AND collection_path <> ''
      GROUP BY project_id, collection_path
     ON CONFLICT (project_id, name) DO NOTHING`,
    [ctx.projectId]
  );
}

export async function sqlInsertCollection(
  client: SqlQueryClient,
  ctx: TenantContext,
  input: CreateCollectionInput,
  name: string,
  id: string,
  now: string
): Promise<CollectionRow | null> {
  const { rows } = await client.query<CollectionRow>(
    `INSERT INTO project_collections (
       id, project_id, name, description, default_ttl_seconds,
       schema_validation, is_system, metadata, created_at, updated_at
     ) VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, FALSE, $7::jsonb, $8::timestamptz, $9::timestamptz)
     ON CONFLICT (project_id, name) DO NOTHING
     RETURNING ${COLLECTION_RETURNING_COLUMNS}`,
    [
      id,
      ctx.projectId,
      name,
      input.description ?? null,
      input.defaultTtlSeconds ?? null,
      input.schemaValidation === undefined ? null : JSON.stringify(input.schemaValidation),
      JSON.stringify(input.metadata ?? {}),
      now,
      now,
    ]
  );
  return rows[0] ?? null;
}

export async function sqlSelectCollectionRow(
  client: SqlQueryClient,
  ctx: TenantContext,
  name: string
): Promise<CollectionRow | null> {
  const { rows } = await client.query<CollectionRow>(
    `SELECT ${COLLECTION_RETURNING_COLUMNS}
       FROM project_collections
      WHERE project_id = $1::uuid AND name = $2`,
    [ctx.projectId, name]
  );
  return rows[0] ?? null;
}

export async function sqlListCollections(
  client: SqlQueryClient,
  ctx: TenantContext,
  opts?: ListCollectionsOptions
): Promise<CollectionStatsRow[]> {
  await sqlSyncCollectionsFromDocuments(client, ctx);
  const params: unknown[] = [ctx.projectId];
  let index = 2;
  let extra = "";
  const search = opts?.search?.trim();
  if (search !== undefined && search.length > 0) {
    extra += ` AND c.name ILIKE '%' || $${index} || '%' ESCAPE '\\'`;
    params.push(escapeLikePattern(search));
    index += 1;
  }
  if (opts?.cursor) {
    extra += ` AND c.name > $${index}`;
    params.push(opts.cursor);
    index += 1;
  }
  params.push(normalizeCollectionListLimit(opts?.limit) + 1);
  const { rows } = await client.query<CollectionStatsRow>(
    `${COLLECTION_STATS_SELECT}${extra} ORDER BY c.name ASC LIMIT $${index}`,
    params
  );
  return rows;
}

/** Fast-path single-collection stats lookup without a full documents-table sync. */
export async function sqlGetCollectionDirect(
  client: SqlQueryClient,
  ctx: TenantContext,
  name: string
): Promise<CollectionStatsRow | null> {
  const { rows } = await client.query<CollectionStatsRow>(
    `${COLLECTION_STATS_SELECT} AND c.name = $2 ORDER BY c.name ASC LIMIT 1`,
    [ctx.projectId, name]
  );
  return rows[0] ?? null;
}

export async function sqlGetCollection(
  client: SqlQueryClient,
  ctx: TenantContext,
  name: string
): Promise<CollectionStatsRow | null> {
  const direct = await sqlGetCollectionDirect(client, ctx, name);
  if (direct !== null) return direct;
  // Fallback only on miss: sync any legacy collections from `documents` and retry.
  await sqlSyncCollectionsFromDocuments(client, ctx);
  return sqlGetCollectionDirect(client, ctx, name);
}

export async function sqlUpdateCollection(
  client: SqlQueryClient,
  ctx: TenantContext,
  name: string,
  patch: UpdateCollectionInput
): Promise<CollectionRow | null> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [ctx.projectId, name];
  let index = 3;
  // Build the SET clause from explicitly-present keys so `null` can CLEAR a
  // field (description/ttl/schema) rather than being swallowed by COALESCE.
  if (patch.description !== undefined) {
    sets.push(`description = $${index}`);
    params.push(patch.description);
    index += 1;
  }
  if (patch.defaultTtlSeconds !== undefined) {
    sets.push(`default_ttl_seconds = $${index}`);
    params.push(patch.defaultTtlSeconds);
    index += 1;
  }
  if (patch.schemaValidation !== undefined) {
    sets.push(`schema_validation = $${index}::jsonb`);
    params.push(patch.schemaValidation === null ? null : JSON.stringify(patch.schemaValidation));
    index += 1;
  }
  if (patch.metadata !== undefined) {
    sets.push(`metadata = $${index}::jsonb`);
    params.push(JSON.stringify(patch.metadata));
    index += 1;
  }
  const { rows } = await client.query<CollectionRow>(
    `UPDATE project_collections SET ${sets.join(", ")}
      WHERE project_id = $1::uuid AND name = $2
     RETURNING ${COLLECTION_RETURNING_COLUMNS}`,
    params
  );
  return rows[0] ?? null;
}

export async function sqlClearCollectionDocuments(
  client: SqlQueryClient,
  ctx: TenantContext,
  name: string
): Promise<{ deletedCount: number; freedBytes: number }> {
  const params = [ctx.projectId, name];
  // Atomic single-statement CTE eliminates the SELECT/DELETE race and saves a table scan.
  const { rows } = await client.query<{ deletedCount: number | string; freedBytes: number | string }>(
    `WITH deleted AS (
       DELETE FROM documents
        WHERE project_id = $1::uuid
          AND collection_path = $2 AND deleted_at IS NULL
        RETURNING size_bytes
     )
     SELECT COUNT(*)::int AS "deletedCount", COALESCE(SUM(size_bytes), 0)::bigint AS "freedBytes"
       FROM deleted`,
    params
  );
  // Derived index entries must not outlive the documents they describe.
  await client.query(
    `DELETE FROM document_index_entries
      WHERE project_id = $1::uuid AND collection_path = $2`,
    params
  );
  const stats = rows[0];
  return {
    deletedCount: Number(stats?.deletedCount ?? 0),
    freedBytes: Number(stats?.freedBytes ?? 0),
  };
}

export async function sqlDeleteCollection(
  client: SqlQueryClient,
  ctx: TenantContext,
  name: string
): Promise<{ deletedCollection: boolean; deletedDocuments: number; freedBytes: number }> {
  const params = [ctx.projectId, name];
  const { rows } = await client.query<{ deletedCount: number | string; freedBytes: number | string }>(
    `WITH deleted AS (
       DELETE FROM documents
        WHERE project_id = $1::uuid AND collection_path = $2
        RETURNING size_bytes
     )
     SELECT COUNT(*)::int AS "deletedCount", COALESCE(SUM(size_bytes), 0)::bigint AS "freedBytes"
       FROM deleted`,
    params
  );
  // Deleting the index definitions cascades to document_index_entries.
  await client.query(
    `DELETE FROM document_indexes
      WHERE project_id = $1::uuid AND collection_path = $2`,
    params
  );
  const { rowCount } = await client.query(
    `DELETE FROM project_collections
      WHERE project_id = $1::uuid AND name = $2`,
    params
  );
  const stats = rows[0];
  return {
    deletedCollection: (rowCount ?? 0) > 0,
    deletedDocuments: Number(stats?.deletedCount ?? 0),
    freedBytes: Number(stats?.freedBytes ?? 0),
  };
}
