/**
 * @vellum/storage - Neon Serverless Storage Adapter
 * Implements StorageAdapter backed by NeonPool with RLS enforcement.
 */

import crypto from "node:crypto";
import { Pool as NeonPool } from "@neondatabase/serverless";
import {
  BoundedLruCache,
  VellumError,
  encodeCompositeSortKey,
  validateCollectionName,
} from "@vellum/core";
import type { WhereClause } from "@vellum/query-engine";
import type { AggregateRequest, AggregateRow, DeleteWhereOptions } from "./aggregates.js";
import {
  batchInsertIndexEntries,
  runIdempotencyCleanup,
  runInTenantTransactionAsync,
  toPgClientLike,
  toSqlQueryClient,
  type SqlTxHandle,
} from "./tx-context.js";
import { AuthMethodDelegates, createSqlAuthOperations, type SqlAuthTx } from "./auth-store.js";
import {
  DATA_POOL_MAX,
  collectionConfigFromRow,
  mapCollectionRow,
  mapCollectionWithStats,
  normalizeCollectionListLimit,
  sqlClearCollectionDocuments,
  sqlDeleteCollection,
  sqlEnsureCollection,
  sqlGetCollection,
  sqlGetCollectionDirect,
  sqlInsertCollection,
  sqlListCollections,
  sqlSelectCollectionRow,
  sqlUpdateCollection,
} from "./pg-adapter.js";
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
  CollectionConfig,
  CollectionRecord,
  CollectionWithStats,
  CreateCollectionInput,
  UpdateCollectionInput,
  ListCollectionsOptions,
  IdempotencyResult,
} from "./types.js";

function clampPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(Math.floor(n), max);
}

export class NeonStorageAdapter extends AuthMethodDelegates implements StorageAdapter {
  public readonly pool: NeonPool;

  /** Bounded FIFO set of registered collection cache keys (tenant-scoped). */
  private readonly knownCollections = new Set<string>();
  /** Short-lived config cache: auto-registration is O(1) after first use. */
  private readonly collectionConfigCache = new BoundedLruCache<string, CollectionConfig>({
    maxEntries: 2_000,
    ttlMs: 10_000,
  });

  constructor(options?: { connectionString?: string; maxConnections?: number }) {
    super();
    this.authOps = createSqlAuthOperations(
      <T>(ctx: TenantContext, callback: (tx: SqlAuthTx) => Promise<T>): Promise<T> =>
        this.withTransaction(ctx, (tx) => callback(tx as SqlTxHandle))
    );
    const connectionString =
      options?.connectionString ??
      process.env["DATA_DATABASE_URL"] ??
      process.env["DATABASE_URL"] ??
      "postgresql://vellum_data:data_secret@localhost:5433/data_db";
    const poolMax =
      options?.maxConnections !== undefined
        ? clampPositiveInt(options.maxConnections, DATA_POOL_MAX, 1, DATA_POOL_MAX)
        : undefined;
    // NeonPool forwards standard pg pool options. Keep the same 30s idle /
    // connect budgets as the pg adapter; `maxLifetimeSeconds` is not part of
    // Neon's PoolConfig, so it is intentionally omitted here. The pool cap
    // stays at the data-plane default (50) for both drivers.
    this.pool = new NeonPool({
      connectionString,
      ...(poolMax !== undefined ? { max: poolMax } : {}),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 30_000,
    });
    // Prevent unhandled 'error' events on idle sockets from crashing Node.js.
    this.pool.on("error", () => {
      /* NeonPool automatically evicts and replaces errored idle clients */
    });
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
      { preparedStatements: false, poolKey: this.pool }
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
   * V2: one parameterized statement for the whole relationship fan-out.
   * Same dedupe/1,000-cap contract as the pg adapter (see types.ts).
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
    const client = await this.pool.connect();
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

            // one UNNEST INSERT per page (no per-document N+1).
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
    const { rowCount } = await this.pool.query(
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
    const { rowCount } = await this.pool.query(
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
    const { rowCount } = await this.pool.query(
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
    return runIdempotencyCleanup(toSqlQueryClient(this.pool));
  }

  /* Collections lifecycle — same SQL helpers as PgStorageAdapter.            */
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
