import { documentReferencesPath, compareReferencePaths } from "./referenced-by.js";
/**
 * @vellum/storage - In-Memory Storage Adapter & DataPlaneStore
 * Provides 100% in-memory implementation of StorageAdapter for testing and local execution
 * with full RLS tenant isolation, transaction rollback, and sort key indexing.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import {
  BoundedLruCache,
  VellumError,
  encodeCompositeSortKey,
  getFieldByPath,
  compareWireValues,
  validateCollectionName,
  indexCollectionPathCovers,
} from "@vellum/core";
import {
  computeIndexDefinitionHash,
  documentMatchesQuery,
  extractDocFieldValue,
} from "@vellum/query-engine";
import type { CompiledQuery, WhereClause } from "@vellum/query-engine";
import {
  aggregateRowsInMemory,
  filterDocumentsForAggregate,
  executeDeleteWhereInTx,
  type AggregateRequest,
  type AggregateRow,
  type DeleteWhereOptions,
} from "./aggregates.js";
import {
  AuthMethodDelegates,
  createAuthMemoryState,
  createMemoryAuthOperations,
} from "./auth-store.js";
import { unwrapCtxArgs } from "./tx-context.js";
import type {
  TenantContext,
  DocumentRecord,
  OutboxEvent,
  OutboxMutation,
  IndexFieldItem,
  CompositeIndexRecord,
  IndexBuilderOptions,
  CompositeIndexEntry,
  TxHandle,
  StorageAdapter,
  QueriedDocument,
  IdempotencyResult,
  CollectionConfig,
  CollectionRecord,
  CollectionWithStats,
  CreateCollectionInput,
  UpdateCollectionInput,
  ListCollectionsOptions,
} from "./types.js";

const FORBIDDEN_PROP_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const MAX_RLS_HISTORY_ENTRIES = 1_000;
const MAX_MEMORY_IDEMPOTENCY_ENTRIES = 10_000;

interface MemoryTxFrame {
  readonly store: DataPlaneStore;
  readonly projectId: string;
}

const memoryTxStorage = new AsyncLocalStorage<MemoryTxFrame>();

/**
 * V2 live-row predicate: mirrors the SQL `(deleted_at IS NULL AND
 * (expires_at IS NULL OR expires_at > now()))` used by getDocumentStatement,
 * SQL_LIST_ACTIVE_DOCUMENTS and SQL_BATCH_GET_DOCUMENTS. A malformed timestamp
 * is treated as "no expiry" so a bad fixture can never silently delete data.
 */
function isLiveDocument(row: DocumentRecord, at = Date.now()): boolean {
  if (row.deletedAt !== null) return false;
  if (row.expiresAt == null) return true;
  const expiresAtMs = Date.parse(row.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs > at;
}

function normalizeCollectionLimit(limit?: number): number {
  const value = Number(limit);
  if (!Number.isFinite(value) || value < 1) return 50;
  return Math.min(Math.floor(value), 500);
}

/** 24h TTL matching the SQL adapters' `batch_idempotency_keys` ledger. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

interface MemoryIdempotencyEntry extends IdempotencyResult {
  expiresAt: number;
}

/**
 * `listDependentsByReference` is an O(n) scan in the memory adapter. Warn once
 * per process (never under `NODE_ENV=test`) so it is not mistaken for the
 * index-backed SQL implementation when used against a large fixture.
 */
let warnedAboutMemoryDependentScan = false;
function warnAboutMemoryDependentScan(): void {
  if (warnedAboutMemoryDependentScan || process.env["NODE_ENV"] === "test") return;
  warnedAboutMemoryDependentScan = true;
  console.warn(
    "[vellum] DataPlaneStore.listDependentsByReference is an in-memory scan (no JSONB index); use the pg/neon adapter for production-scale data."
  );
}

function requireMemoryTenant(ctx: TenantContext): void {
  if (!ctx || typeof ctx.projectId !== "string" || ctx.projectId.length === 0) {
    throw new VellumError(
      "PERMISSION_DENIED",
      "RLS Violation: Missing tenant context (app.current_project_id)"
    );
  }
}

export class DataPlaneStore extends AuthMethodDelegates implements StorageAdapter {
  private transactionTail: Promise<void> = Promise.resolve();
  /** Exposed for test assertions and debug inspection. */
  public readonly authMemory = createAuthMemoryState();

  public constructor() {
    super();
    this.authOps = createMemoryAuthOperations(this.authMemory);
  }

  public documents = new Map<string, DocumentRecord>();
  public indexes = new Map<string, CompositeIndexRecord>();
  public indexEntries = new Map<string, Map<string, CompositeIndexEntry>>();
  /** Durable collection registry, keyed `${projectId.length}:${projectId}:${name}`. */
  public collections = new Map<string, CollectionRecord>();
  /** In-process idempotency ledger with a 24h TTL (mirrors migration 0010). */
  public idempotency = new Map<string, MemoryIdempotencyEntry>();

  /** Bounded FIFO set of registered collection cache keys (tenant-scoped). */
  private readonly knownCollections = new Set<string>();
  /** Short-lived config cache: auto-registration is O(1) after first use. */
  private readonly collectionConfigCache = new BoundedLruCache<string, CollectionConfig>({
    maxEntries: 2_000,
    ttlMs: 10_000,
  });
  public outboxSeq = 0n;
  public outbox: OutboxEvent[] = [];
  public rlsContextHistory: Array<{
    projectId: string;
    statementTimeoutMs: number;
    startedAt: number;
  }> = [];

  private tenantPrefix(ctx: TenantContext): string {
    requireMemoryTenant(ctx);
    return `${ctx.projectId.length}:${ctx.projectId}:`;
  }

  private docKey(ctx: TenantContext, path: string): string {
    return `${this.tenantPrefix(ctx)}${path}`;
  }

  private collectionKey(ctx: TenantContext, name: string): string {
    return `${this.tenantPrefix(ctx)}${name}`;
  }

  private idempotencyKey(ctx: TenantContext, key: string): string {
    return `${this.tenantPrefix(ctx)}${key}`;
  }

  /** Lazy TTL expiry on read; mirrors `expires_at > now()` in SQL. */
  private readIdempotency(storageKey: string): IdempotencyResult | null {
    const entry = this.idempotency.get(storageKey);
    if (entry === undefined) return null;
    if (entry.expiresAt <= Date.now()) {
      this.idempotency.delete(storageKey);
      return null;
    }
    return {
      responseHash: entry.responseHash,
      responsePayload: structuredClone(entry.responsePayload),
    };
  }

  private pruneIdempotencyIfNeeded(): void {
    if (this.idempotency.size < 1_000) return;
    const now = Date.now();
    for (const [k, v] of this.idempotency.entries()) {
      if (v.expiresAt <= now) this.idempotency.delete(k);
    }
    while (this.idempotency.size >= MAX_MEMORY_IDEMPOTENCY_ENTRIES) {
      const oldest = this.idempotency.keys().next();
      if (oldest.done === true) break;
      this.idempotency.delete(oldest.value);
    }
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

  private configOf(record: CollectionRecord): CollectionConfig {
    return {
      schemaValidation: record.schemaValidation === null ? null : structuredClone(record.schemaValidation),
      defaultTtlSeconds: record.defaultTtlSeconds,
    };
  }

  /** Live-document statistics mirroring the SQL LEFT JOIN aggregate. */
  private collectionStats(
    ctx: TenantContext,
    name: string
  ): { documentCount: number; storageBytes: number; lastDocumentAt: string | null } {
    const prefix = this.tenantPrefix(ctx);
    let documentCount = 0;
    let storageBytes = 0;
    let lastDocumentAt: string | null = null;
    for (const [key, row] of this.documents.entries()) {
      if (!key.startsWith(prefix) || row.projectId !== ctx.projectId) continue;
      if (row.collectionPath !== name || !isLiveDocument(row)) continue;
      documentCount += 1;
      storageBytes += row.sizeBytes;
      if (lastDocumentAt === null || row.updatedAt > lastDocumentAt) lastDocumentAt = row.updatedAt;
    }
    return { documentCount, storageBytes, lastDocumentAt };
  }

  private withStats(record: CollectionRecord, ctx: TenantContext): CollectionWithStats {
    return { ...structuredClone(record), ...this.collectionStats(ctx, record.name) };
  }

  public runInTenantTransaction<T>(
    projectId: string,
    fn: (tx: TxHandle) => T | Promise<T>
  ): Promise<T> | T {
    if (!projectId) {
      throw new VellumError(
        "PERMISSION_DENIED",
        "RLS Violation: Missing tenant context (app.current_project_id)"
      );
    }

    const activeFrame = memoryTxStorage.getStore();
    if (activeFrame !== undefined && activeFrame.store === this && activeFrame.projectId !== projectId) {
      throw new VellumError(
        "PERMISSION_DENIED",
        "RLS Violation: cannot nest a transaction for a different tenant",
        { expectedProjectId: activeFrame.projectId, suppliedProjectId: projectId }
      );
    }

    if (activeFrame?.store === this) return this.executeMemoryTransaction(projectId, fn);
    // Snapshots cover the whole in-memory store. Serialize top-level work so
    // rollback cannot restore over another tenant's successful commit.
    const run = this.transactionTail.then(() => this.executeMemoryTransaction(projectId, fn));
    this.transactionTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private executeMemoryTransaction<T>(projectId: string, fn: (tx: TxHandle) => T | Promise<T>): T | Promise<T> {
    const ctx: TenantContext = { projectId };
    const rlsContext = Object.freeze({
      projectId,
      statementTimeoutMs: 5000,
      startedAt: Date.now(),
    });
    this.rlsContextHistory.push(rlsContext);
    if (this.rlsContextHistory.length > MAX_RLS_HISTORY_ENTRIES) {
      this.rlsContextHistory.splice(0, this.rlsContextHistory.length - MAX_RLS_HISTORY_ENTRIES);
    }

    const docsSnapshot = new Map<string, DocumentRecord>();
    for (const [k, v] of this.documents.entries()) {
      docsSnapshot.set(k, structuredClone(v));
    }

    const indexesSnapshot = new Map<string, CompositeIndexRecord>();
    for (const [idxId, rec] of this.indexes.entries()) {
      indexesSnapshot.set(idxId, structuredClone(rec));
    }

    const indexEntriesSnapshot = new Map<string, Map<string, CompositeIndexEntry>>();
    for (const [idxId, map] of this.indexEntries.entries()) {
      indexEntriesSnapshot.set(idxId, new Map(map));
    }
    // Idempotency writes participate in the transaction like any other row.
    const idempotencySnapshot = new Map<string, MemoryIdempotencyEntry>();
    for (const [key, entry] of this.idempotency.entries()) {
      idempotencySnapshot.set(key, { ...entry, responsePayload: structuredClone(entry.responsePayload) });
    }

    const outboxLenBefore = this.outbox.length;
    const seqBefore = this.outboxSeq;
    const collectionsSnapshot = structuredClone(this.collections);
    const restoreMetadata = (): void => {
      this.collections = collectionsSnapshot;
      this.knownCollections.clear();
      this.collectionConfigCache.clear();
    };

    const txHandle = this.createTxHandle(ctx);

    try {
      const result = memoryTxStorage.run({ store: this, projectId }, () => fn(txHandle));
      if (result instanceof Promise) {
        return result.catch((err: unknown) => {
          restoreMetadata();
          this.rollback(
            docsSnapshot,
            indexesSnapshot,
            indexEntriesSnapshot,
            idempotencySnapshot,
            outboxLenBefore,
            seqBefore
          );
          throw err;
        });
      }
      return result;
    } catch (err: unknown) {
      restoreMetadata();
      this.rollback(
        docsSnapshot,
        indexesSnapshot,
        indexEntriesSnapshot,
        idempotencySnapshot,
        outboxLenBefore,
        seqBefore
      );
      throw err;
    }
  }

  private rollback(
    docsSnapshot: Map<string, DocumentRecord>,
    indexesSnapshot: Map<string, CompositeIndexRecord>,
    indexEntriesSnapshot: Map<string, Map<string, CompositeIndexEntry>>,
    idempotencySnapshot: Map<string, MemoryIdempotencyEntry>,
    outboxLenBefore: number,
    seqBefore: bigint
  ): void {
    this.documents = docsSnapshot;
    this.indexes = indexesSnapshot;
    this.indexEntries = indexEntriesSnapshot;
    this.idempotency = idempotencySnapshot;
    this.outbox.length = outboxLenBefore;
    this.outboxSeq = seqBefore;
  }

  public async withTransaction<T>(ctx: TenantContext, callback: (tx: TxHandle) => Promise<T>): Promise<T> {
    return Promise.resolve(this.runInTenantTransaction(ctx.projectId, callback));
  }

  public createTxHandle(ctx: TenantContext): TxHandle {
    const handle: TxHandle = {
      projectId: ctx.projectId,

      getDocument: async (path: string, includeSoftDeleted = false): Promise<DocumentRecord | null> => {
        const row = this.documents.get(this.docKey(ctx, path));
        if (!row) return null;
        if (row.projectId !== ctx.projectId) {
          return null;
        }
        if (!includeSoftDeleted && !isLiveDocument(row)) {
          return null;
        }
        return structuredClone(row);
      },

      batchGetDocuments: async (paths: string[], includeDeleted = false): Promise<DocumentRecord[]> => {
        const uniquePaths = Array.from(new Set(paths));
        const results: DocumentRecord[] = [];
        for (const path of uniquePaths) {
          const row = this.documents.get(this.docKey(ctx, path));
          if (!row) continue;
          if (row.projectId !== ctx.projectId) continue;
          // Mirrors SQL `includeDeleted`: tombstones and expired rows are visible.
          if (!includeDeleted && !isLiveDocument(row)) continue;
          results.push(structuredClone(row));
        }
        return results;
      },

      /**
       * In-memory CAS. Returns `{ applied: false }` on a create/version race;
       * the engine (not storage) maps that to ALREADY_EXISTS / ABORTED_CONFLICT.
       * A version-0 tombstone still occupies the unique key, so a null-expected
       * create is not applied — restoring it is an explicit `putDocumentRow`.
       */
      conditionalPutDocument: async (
        row: DocumentRecord,
        expectedVersion: number | null
      ): Promise<{ applied: boolean }> => {
        if (row.projectId !== ctx.projectId) {
          throw new VellumError("PERMISSION_DENIED", "RLS policy violation on documents conditional write");
        }
        if (expectedVersion !== null && (!Number.isInteger(expectedVersion) || expectedVersion < 0)) {
          throw new VellumError("INVALID_ARGUMENT", "expectedVersion must be null or a non-negative integer");
        }
        const key = this.docKey(ctx, row.path);
        const existing = this.documents.get(key);
        let applied: boolean;
        if (expectedVersion === null) {
          applied = existing === undefined;
        } else {
          applied =
            existing !== undefined &&
            existing.version === expectedVersion &&
            isLiveDocument(existing);
        }
        if (!applied) return { applied: false };
        this.documents.set(key, structuredClone(row));
        this.syncDocumentCompositeIndexes(ctx, row);
        return { applied: true };
      },

      /** Batched in-memory CAS: returns the paths whose precondition held. */
      conditionalPutDocumentRows: async (
        rowsArg: DocumentRecord[],
        expectedVersions: ReadonlyArray<number | null>
      ): Promise<string[]> => {
        if (expectedVersions.length !== rowsArg.length) {
          throw new VellumError(
            "INVALID_ARGUMENT",
            `conditionalPutDocumentRows expectedVersions length (${expectedVersions.length}) must match rows length (${rowsArg.length})`
          );
        }
        for (let i = 0; i < rowsArg.length; i++) {
          if (rowsArg[i]!.projectId !== ctx.projectId) {
            throw new VellumError("PERMISSION_DENIED", "RLS policy violation on documents conditional batch write");
          }
          const ev = expectedVersions[i] ?? null;
          if (ev !== null && (!Number.isInteger(ev) || ev < 0)) {
            throw new VellumError("INVALID_ARGUMENT", "expectedVersion must be null or a non-negative integer");
          }
        }
        const appliedPaths: string[] = [];
        rowsArg.forEach((row, index) => {
          const key = this.docKey(ctx, row.path);
          const existing = this.documents.get(key);
          const expected = expectedVersions[index] ?? null;
          const applied =
            expected === null
              ? existing === undefined
              : existing !== undefined &&
                existing.version === expected &&
                isLiveDocument(existing);
          if (!applied) return;
          this.documents.set(key, structuredClone(row));
          this.syncDocumentCompositeIndexes(ctx, row);
          appliedPaths.push(row.path);
        });
        return appliedPaths;
      },

      putDocumentRow: async (row: DocumentRecord): Promise<void> => {
        if (row.projectId !== ctx.projectId) {
          throw new VellumError("PERMISSION_DENIED", "RLS policy violation on documents write");
        }
        this.documents.set(this.docKey(ctx, row.path), structuredClone(row));
        this.syncDocumentCompositeIndexes(ctx, row);
      },

      appendOutboxEvent: async (event: OutboxMutation): Promise<OutboxEvent> => {
        this.outboxSeq += 1n;
        const outboxEvent: OutboxEvent = {
          seqId: this.outboxSeq.toString(),
          projectId: ctx.projectId,
          collectionPath: event.collectionPath,
          path: event.path,
          documentId: event.documentId,
          opType: event.opType,
          version: event.version,
          beforeData: event.beforeData ? structuredClone(event.beforeData) : null,
          afterData: event.afterData ? structuredClone(event.afterData) : null,
          committedAt: new Date().toISOString(),
        };
        this.outbox.push(outboxEvent);
        return outboxEvent;
      },

      createIndex: async ({ collectionPath, fields }: { collectionPath: string; fields: IndexFieldItem[] }): Promise<CompositeIndexRecord> => {
        const definitionHash = computeIndexDefinitionHash(collectionPath, fields);
        for (const existing of this.indexes.values()) {
          if (
            existing.projectId === ctx.projectId &&
            existing.collectionPath === collectionPath &&
            existing.definitionHash === definitionHash
          ) {
            throw new VellumError("ALREADY_EXISTS", `Composite index already exists for '${collectionPath}'`, {
              indexId: existing.id,
            });
          }
        }
        const now = new Date().toISOString();
        const idxRecord: CompositeIndexRecord = {
          id: crypto.randomUUID(),
          projectId: ctx.projectId,
          collectionPath,
          fields,
          definitionHash,
          status: "building",
          errorMessage: null,
          createdAt: now,
          updatedAt: now,
        };
        this.indexes.set(idxRecord.id, idxRecord);
        this.indexEntries.set(idxRecord.id, new Map());
        return structuredClone(idxRecord);
      },

      queryDocuments: async (compiled: CompiledQuery): Promise<QueriedDocument[]> => {
        const q = compiled.normalizedQuery;
        const indexId = compiled.compositeIndexId;
        const candidates = indexId
          ? ((await handle.listDocumentsViaCompositeIndex?.(indexId)) ?? [])
          : ((await handle.listActiveDocumentsInCollection?.(q.collectionPath)) ?? []);

        let matched = candidates.filter((doc) => documentMatchesQuery(doc, q));

        matched.sort((a, b) => {
          for (const o of q.orderBy) {
            const cmp = compareWireValues(
              extractDocFieldValue(a, o.field),
              extractDocFieldValue(b, o.field),
              o.dir
            );
            if (cmp !== 0) return cmp;
          }
          return 0;
        });

        const entriesByPath = new Map<string, CompositeIndexEntry>();
        if (indexId) {
          for (const entry of this.indexEntries.get(indexId)?.values() ?? []) {
            entriesByPath.set(entry.path, entry);
          }
        }

        const cursor = compiled.cursor;
        if (cursor && compiled.cursorMode) {
          const inclusive = compiled.cursorMode === "startAt";
          if (indexId) {
            if (!cursor.sortKey) {
              throw new VellumError(
                "INVALID_CURSOR",
                "Composite-index cursor is missing its signed sort key; cannot resume an indexed query"
              );
            }
            const keyBuf = Buffer.from(cursor.sortKey, "hex");
            matched = matched.filter((doc) => {
              const entry = entriesByPath.get(doc.path);
              if (!entry) return false;
              const cmp = Buffer.compare(entry.sortKey, keyBuf);
              if (cmp !== 0) return inclusive ? cmp >= 0 : cmp > 0;
              return inclusive
                ? doc.documentId >= cursor.docId
                : doc.documentId > cursor.docId;
            });
          } else {
            matched = matched.filter((doc) => {
              let cmpAll = 0;
              for (let i = 0; i < q.orderBy.length; i++) {
                const o = q.orderBy[i]!;
                const cur = cursor.vals[i];
                if (cur === undefined) {
                  cmpAll = 1;
                  break;
                }
                const cmp = compareWireValues(extractDocFieldValue(doc, o.field), cur, o.dir);
                if (cmp !== 0) {
                  cmpAll = cmp;
                  break;
                }
              }
              if (cmpAll === 0) return inclusive;
              return inclusive ? cmpAll >= 0 : cmpAll > 0;
            });
          }
        }

        const cap = compiled.maxScanRows;
        if (cap !== null) {
          if (matched.length > cap) {
            throw new VellumError(
              "FAILED_PRECONDITION",
              `Unindexed query on '${q.collectionPath}' scanned more than ${cap} rows; create a composite index for this filter/sort shape.`,
              { collectionPath: q.collectionPath, maxScanRows: cap, scannedRows: matched.length }
            );
          }
          if (matched.length === cap) {
            process.emitWarning(
              `[vellum] Unindexed query on '${q.collectionPath}' reached the ${cap}-row safety cap; add a composite index.`
            );
          }
        }

        return matched.slice(0, compiled.fetchLimit).map((doc) => {
          let data: Record<string, unknown> = structuredClone(doc.data);
          if (compiled.projectionFields) {
            const projected: Record<string, unknown> = {};
            for (const field of compiled.projectionFields) {
              if (FORBIDDEN_PROP_NAMES.has(field)) continue;
              const value = Object.prototype.hasOwnProperty.call(data, field)
                ? data[field]
                : getFieldByPath(data, field);
              if (value !== undefined) {
                Object.defineProperty(projected, field, {
                  value: structuredClone(value),
                  enumerable: true,
                  writable: true,
                  configurable: true,
                });
              }
            }
            data = projected;
          }
          const sortKeyHex = indexId ? entriesByPath.get(doc.path)?.sortKey.toString("hex") : undefined;
          return {
            ...doc,
            data,
            ...(sortKeyHex === undefined ? {} : { sortKeyHex }),
          } as QueriedDocument;
        });
      },

      countLiveDocumentsUpTo: async (collectionPath: string, cap: number): Promise<number> => {
        let n = 0;
        const prefix = this.tenantPrefix(ctx);
        for (const [key, row] of this.documents.entries()) {
          if (!key.startsWith(prefix) || row.projectId !== ctx.projectId) continue;
          if (row.collectionPath === collectionPath && isLiveDocument(row)) {
            n += 1;
            if (n >= cap) break;
          }
        }
        return n;
      },

      listActiveDocumentsInCollection: async (collectionPath: string): Promise<DocumentRecord[]> => {
        const results: DocumentRecord[] = [];
        const prefix = this.tenantPrefix(ctx);
        for (const [key, row] of this.documents.entries()) {
          if (!key.startsWith(prefix) || row.projectId !== ctx.projectId) continue;
          if (row.collectionPath === collectionPath && isLiveDocument(row)) {
            results.push(structuredClone(row));
          }
        }
        results.sort((a, b) => (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0));
        return results;
      },

      /**
       * O(n) tenant scan with the same reference arms as SQL.
       * One-time non-test warning keeps production-scale misuse visible.
       */
      listDependentsByReference: async (
        ...args: [collectionPath: string, field: string, targetPath: string, limit: number]
          | [TenantContext, collectionPath: string, field: string, targetPath: string, limit: number]
      ): Promise<DocumentRecord[]> => {
        const [collectionPath, field, targetPath, limit] = unwrapCtxArgs<
          [collectionPath: string, field: string, targetPath: string, limit: number]
        >(args, { projectId: ctx.projectId });
        if (FORBIDDEN_PROP_NAMES.has(field)) return [];
        warnAboutMemoryDependentScan();
        const prefix = this.tenantPrefix(ctx);
        const boundedLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 50), 501));
        const results: DocumentRecord[] = [];
        for (const [key, row] of this.documents.entries()) {
          if (!key.startsWith(prefix) || row.projectId !== ctx.projectId) continue;
          if (row.collectionPath !== collectionPath || !isLiveDocument(row)) continue;
          if (documentReferencesPath(row.data, targetPath, field) ||
              documentReferencesPath(row.data, targetPath.split("/").at(-1)!, field)) {
            results.push(structuredClone(row));
          }
        }
        // SQL orders by path FIRST, then applies LIMIT — sort before slicing.
        results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        return results.slice(0, boundedLimit);
      },

      referencedByPage: async (request): Promise<DocumentRecord[]> => {
        const prefix = this.tenantPrefix(ctx);
        const result: DocumentRecord[] = [];
        for (const [key, row] of this.documents.entries()) {
          if (!key.startsWith(prefix) || row.projectId !== ctx.projectId || !isLiveDocument(row)) continue;
          if (request.collection && row.collectionPath !== request.collection) continue;
          if (request.afterPath && Buffer.compare(Buffer.from(row.path), Buffer.from(request.afterPath)) <= 0) continue;
          if (documentReferencesPath(row.data, request.targetPath, request.field)) result.push(structuredClone(row));
        }
        result.sort(compareReferencePaths);
        return result.slice(0, Math.max(1, Math.min(100, Math.floor(request.limit) || 100)));
      },

      /** Cursor-only page mirroring SQL_LIST_DOCUMENTS_IN_COLLECTION_PAGE. */
      listDocumentsInCollectionPage: async (
        ...args: [collectionName: string, opts: { afterDocumentId?: string | null; limit: number }]
          | [TenantContext, collectionName: string, opts: { afterDocumentId?: string | null; limit: number }]
      ): Promise<DocumentRecord[]> => {
        const [collectionName, opts] = unwrapCtxArgs<
          [collectionName: string, opts: { afterDocumentId?: string | null; limit: number }]
        >(args, { projectId: ctx.projectId });
        const prefix = this.tenantPrefix(ctx);
        const after = opts?.afterDocumentId ?? null;
        const boundedLimit = Math.max(1, Math.min(Math.floor(Number(opts?.limit) || 50), 500));
        const results: DocumentRecord[] = [];
        for (const [key, row] of this.documents.entries()) {
          if (!key.startsWith(prefix) || row.projectId !== ctx.projectId) continue;
          if (row.collectionPath !== collectionName || !isLiveDocument(row)) continue;
          if (after !== null && row.documentId <= after) continue;
          results.push(structuredClone(row));
        }
        results.sort((a, b) => (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0));
        return results.slice(0, boundedLimit);
      },

      listDocumentsViaCompositeIndex: async (indexId: string): Promise<DocumentRecord[]> => {
        const idx = this.indexes.get(indexId);
        if (!idx || idx.projectId !== ctx.projectId) {
          return [];
        }
        const entriesMap = this.indexEntries.get(indexId);
        if (!entriesMap) return [];
        const sortedEntries = Array.from(entriesMap.values()).sort((a, b) => {
          const cmp = Buffer.compare(a.sortKey, b.sortKey);
          if (cmp !== 0) return cmp;
          return a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0;
        });
        const docs: DocumentRecord[] = [];
        for (const entry of sortedEntries) {
          const doc = await handle.getDocument(entry.path, false);
          if (doc) docs.push(doc);
        }
        return docs;
      },

      listIndexes: async (): Promise<CompositeIndexRecord[]> => {
        const list: CompositeIndexRecord[] = [];
        for (const idx of this.indexes.values()) {
          if (idx.projectId === ctx.projectId) {
            list.push(structuredClone(idx));
          }
        }
        return list;
      },

      deleteIndex: async (indexId: string): Promise<boolean> => {
        const idx = this.indexes.get(indexId);
        if (!idx || idx.projectId !== ctx.projectId) {
          throw new VellumError("NOT_FOUND", `Composite index '${indexId}' not found`);
        }
        this.indexes.delete(indexId);
        this.indexEntries.delete(indexId);
        return true;
      },

      /** V2 native aggregation over this tenant's live documents. */
      aggregateDocuments: async (req: AggregateRequest): Promise<AggregateRow[]> => {
        const candidates = (await handle.listActiveDocumentsInCollection?.(req.collectionPath)) ?? [];
        return aggregateRowsInMemory(filterDocumentsForAggregate(candidates, req), req);
      },

      /** V2 bulk delete — selection + tombstones + outbox in one logical tx. */
      deleteWhere: async (
        collectionPath: string,
        where: WhereClause[],
        options: DeleteWhereOptions
      ): Promise<number> => {
        const staged = await executeDeleteWhereInTx(
          handle,
          ctx,
          collectionPath,
          where,
          options,
          new Date().toISOString()
        );
        return staged.deletedCount;
      },

      getIdempotencyResult: async (
        ...args: [key: string] | [TenantContext, key: string]
      ): Promise<IdempotencyResult | null> => {
        const [key] = unwrapCtxArgs<[key: string]>(args, {
          projectId: ctx.projectId,
        });
        return this.readIdempotency(this.idempotencyKey(ctx, key));
      },

      saveIdempotencyResult: async (
        ...args: [key: string, responseHash: string, responsePayload: unknown]
          | [TenantContext, key: string, responseHash: string, responsePayload: unknown]
      ): Promise<void> => {
        const [key, responseHash, responsePayload] = unwrapCtxArgs<
          [key: string, responseHash: string, responsePayload: unknown]
        >(args, { projectId: ctx.projectId });
        this.pruneIdempotencyIfNeeded();
        this.idempotency.set(this.idempotencyKey(ctx, key), {
          responseHash,
          responsePayload: structuredClone(responsePayload),
          expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
        });
      },
    };
    return handle;
  }

  private syncDocumentCompositeIndexes(ctx: TenantContext, docRow: DocumentRecord): void {
    for (const idx of this.indexes.values()) {
      if (
        idx.projectId !== ctx.projectId ||
        !indexCollectionPathCovers(idx.collectionPath, docRow.collectionPath)
      ) {
        continue;
      }
      const entriesMap = this.indexEntries.get(idx.id);
      if (!entriesMap) continue;

      for (const [k, entry] of entriesMap.entries()) {
        if (entry.projectId === ctx.projectId && entry.path === docRow.path) {
          entriesMap.delete(k);
        }
      }

      if (docRow.deletedAt === null) {
        const sortKey = encodeCompositeSortKey(docRow, idx.fields);
        const entryKey = `${sortKey.toString("hex")}:${docRow.documentId}`;
        entriesMap.set(entryKey, {
          indexId: idx.id,
          projectId: ctx.projectId,
          collectionPath: docRow.collectionPath,
          sortKey,
          documentId: docRow.documentId,
          path: docRow.path,
        });
      }
    }
  }

  public async getDocument(
    ctx: TenantContext,
    path: string,
    opts?: { includeSoftDeleted?: boolean; forUpdate?: boolean }
  ): Promise<DocumentRecord | null> {
    return this.withTransaction(ctx, (tx) => tx.getDocument(path, opts?.includeSoftDeleted, opts?.forUpdate));
  }

  /**
   * V2: single logical batch over the in-memory map, with the same TTL,
   * soft-delete, tenant-isolation and requested-order guarantees as SQL.
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

  public async queryOutboxSince(ctx: TenantContext, afterSeqId = "0", upToSeqId?: string): Promise<OutboxEvent[]> {
    requireMemoryTenant(ctx);
    let minSeq: bigint;
    let maxSeq: bigint | null = null;
    try {
      minSeq = BigInt(afterSeqId || "0");
      if (upToSeqId !== undefined) maxSeq = BigInt(upToSeqId);
    } catch {
      throw new VellumError("INVALID_ARGUMENT", `Invalid outbox sequence range '${afterSeqId}'..'${upToSeqId ?? ""}'`);
    }
    return this.outbox.filter(
      (ev) =>
        ev.projectId === ctx.projectId &&
        BigInt(ev.seqId) > minSeq &&
        (maxSeq === null || BigInt(ev.seqId) <= maxSeq)
    );
  }

  /** In-memory writes are visible the moment they are appended, so the safe watermark is the max. */
  public async queryOutboxSafeWatermark(ctx: TenantContext): Promise<string> {
    requireMemoryTenant(ctx);
    let max = 0n;
    for (const ev of this.outbox) {
      if (ev.projectId !== ctx.projectId) continue;
      const seq = BigInt(ev.seqId);
      if (seq > max) max = seq;
    }
    return max.toString();
  }

  public async runIndexBuilderWorker(
    options: IndexBuilderOptions = {}
  ): Promise<{ builtCount: number; pendingCount: number }> {
    let builtCount = 0;
    for (const idx of this.indexes.values()) {
      if (idx.status !== "building") continue;
      if (options.projectId !== undefined && idx.projectId !== options.projectId) continue;
      if (options.indexId !== undefined && idx.id !== options.indexId) continue;
      try {
        await this.runInTenantTransaction(idx.projectId, async (tx) => {
          const docs = (await tx.listActiveDocumentsInCollection?.(idx.collectionPath)) ?? [];
          const entriesMap = this.indexEntries.get(idx.id) ?? new Map<string, CompositeIndexEntry>();
          for (const doc of docs) {
            const sortKey = encodeCompositeSortKey(doc, idx.fields);
            const entryKey = `${sortKey.toString("hex")}:${doc.documentId}`;
            entriesMap.set(entryKey, {
              indexId: idx.id,
              projectId: idx.projectId,
              collectionPath: doc.collectionPath,
              sortKey,
              documentId: doc.documentId,
              path: doc.path,
            });
          }
          this.indexEntries.set(idx.id, entriesMap);
          idx.status = "ready";
          idx.updatedAt = new Date().toISOString();
          builtCount += 1;
        });
      } catch (err: unknown) {
        idx.status = "failed";
        idx.errorMessage = err instanceof Error ? err.message : String(err);
        idx.updatedAt = new Date().toISOString();
      }
    }
    return { builtCount, pendingCount: 0 };
  }

  public async runOutboxCompactionWorker(cutoffEpochMs = Date.now() - 24 * 3600 * 1000): Promise<{ purgedCount: number }> {
    const beforeLen = this.outbox.length;
    this.outbox = this.outbox.filter((ev) => {
      const ms = Date.parse(ev.committedAt);
      return ms >= cutoffEpochMs;
    });
    return { purgedCount: beforeLen - this.outbox.length };
  }

  public async runTombstonePurgeWorker(cutoffEpochMs = Date.now() - 7 * 24 * 3600 * 1000): Promise<{ purgedCount: number }> {
    let purgedCount = 0;
    for (const [key, row] of this.documents.entries()) {
      if (row.deletedAt !== null) {
        const ms = Date.parse(row.deletedAt);
        if (ms < cutoffEpochMs) {
          this.documents.delete(key);
          purgedCount += 1;
        }
      }
    }
    return { purgedCount };
  }

  /**
   * V2 TTL sweeper: physically removes expired LIVE rows in bounded batches.
   * Tombstones are left to `runTombstonePurgeWorker`. Derived composite-index
   * entries for swept paths are removed atomically with the row (strictly
   * scoped by `projectId` to prevent cross-tenant index deletion).
   */
  public async runTtlSweeperWorker(limit = 500): Promise<{ purgedCount: number }> {
    const batchSize = Math.max(1, Math.min(Number(limit) || 500, 5000));
    const now = Date.now();
    let purgedCount = 0;
    for (const [key, row] of this.documents.entries()) {
      if (purgedCount >= batchSize) break;
      if (row.deletedAt !== null || row.expiresAt == null) continue;
      const expiresAtMs = Date.parse(row.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs > now) continue;
      this.documents.delete(key);
      for (const entries of this.indexEntries.values()) {
        for (const [entryKey, entry] of entries.entries()) {
          if (entry.projectId === row.projectId && entry.path === row.path) {
            entries.delete(entryKey);
          }
        }
      }
      purgedCount += 1;
    }
    return { purgedCount };
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
    return this.withTransaction(ctx, async (tx) => (await tx.getIdempotencyResult?.(key)) ?? null);
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
    let purgedCount = 0;
    const now = Date.now();
    const prefix = ctx === undefined ? "" : this.tenantPrefix(ctx);
    for (const [key, entry] of this.idempotency.entries()) {
      if (!key.startsWith(prefix)) continue;
      if (entry.expiresAt < now) {
        this.idempotency.delete(key);
        purgedCount += 1;
      }
    }
    return { purgedCount };
  }

  /* ------------------------------------------------------------------------ */
  /* Collections lifecycle (docs/COLLECTIONS-CONTRACT.md §2.2)                 */
  /* ------------------------------------------------------------------------ */

  /** Mirror the SQL registry fallback: register any legacy collection in documents. */
  private syncCollectionsFromDocuments(ctx: TenantContext): void {
    const prefix = this.tenantPrefix(ctx);
    for (const [key, row] of this.documents.entries()) {
      if (!key.startsWith(prefix) || row.projectId !== ctx.projectId || !row.collectionPath) continue;
      const colKey = this.collectionKey(ctx, row.collectionPath);
      if (this.collections.has(colKey)) continue;
      this.collections.set(colKey, {
        id: crypto.randomUUID(),
        projectId: ctx.projectId,
        name: row.collectionPath,
        description: null,
        defaultTtlSeconds: null,
        schemaValidation: null,
        isSystem: false,
        metadata: {},
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
  }

  public async createCollection(ctx: TenantContext, input: CreateCollectionInput): Promise<CollectionRecord> {
    requireMemoryTenant(ctx);
    const name = validateCollectionName(input.name);
    const key = this.collectionKey(ctx, name);
    const existing = this.collections.get(key);
    if (existing !== undefined) {
      if (input.ifNotExists !== true) {
        throw new VellumError("ALREADY_EXISTS", `Collection '${name}' already exists`, { name });
      }
      const record = structuredClone(existing);
      this.rememberCollection(key);
      this.collectionConfigCache.set(key, this.configOf(record));
      return record;
    }

    const now = new Date().toISOString();
    const record: CollectionRecord = {
      id: crypto.randomUUID(),
      projectId: ctx.projectId,
      name,
      description: input.description ?? null,
      defaultTtlSeconds: input.defaultTtlSeconds ?? null,
      schemaValidation: input.schemaValidation === undefined ? null : structuredClone(input.schemaValidation),
      isSystem: false,
      metadata: structuredClone(input.metadata ?? {}),
      createdAt: now,
      updatedAt: now,
    };
    this.collections.set(key, structuredClone(record));
    this.rememberCollection(key);
    this.collectionConfigCache.set(key, this.configOf(record));
    return record;
  }

  public async ensureCollectionExists(ctx: TenantContext, name: string): Promise<void> {
    requireMemoryTenant(ctx);
    const key = this.collectionKey(ctx, name);
    if (this.knownCollections.has(key)) return;
    let record = this.collections.get(key);
    if (record === undefined) {
      const now = new Date().toISOString();
      record = {
        id: crypto.randomUUID(),
        projectId: ctx.projectId,
        name,
        description: null,
        defaultTtlSeconds: null,
        schemaValidation: null,
        isSystem: false,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      };
      this.collections.set(key, structuredClone(record));
    }
    this.rememberCollection(key);
    this.collectionConfigCache.set(key, this.configOf(record));
  }

  public async listCollections(
    ctx: TenantContext,
    opts?: ListCollectionsOptions
  ): Promise<{ collections: CollectionWithStats[]; nextCursor: string | null }> {
    requireMemoryTenant(ctx);
    this.syncCollectionsFromDocuments(ctx);
    const prefix = this.tenantPrefix(ctx);
    const search = opts?.search?.trim().toLowerCase() ?? "";
    const cursor = opts?.cursor ?? null;
    const limit = normalizeCollectionLimit(opts?.limit);

    const matches: CollectionRecord[] = [];
    for (const [key, record] of this.collections.entries()) {
      if (!key.startsWith(prefix) || record.projectId !== ctx.projectId) continue;
      if (search.length > 0 && !record.name.toLowerCase().includes(search)) continue;
      if (cursor !== null && record.name <= cursor) continue;
      matches.push(record);
    }
    matches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const page = matches.slice(0, limit);
    const last = page[page.length - 1];
    return {
      collections: page.map((record) => this.withStats(record, ctx)),
      nextCursor: matches.length > limit && last !== undefined ? last.name : null,
    };
  }

  public async getCollection(ctx: TenantContext, name: string): Promise<CollectionWithStats | null> {
    requireMemoryTenant(ctx);
    this.syncCollectionsFromDocuments(ctx);
    const record = this.collections.get(this.collectionKey(ctx, name));
    if (record === undefined || record.projectId !== ctx.projectId) return null;
    return this.withStats(record, ctx);
  }

  public async updateCollection(
    ctx: TenantContext,
    name: string,
    patch: UpdateCollectionInput
  ): Promise<CollectionWithStats> {
    requireMemoryTenant(ctx);
    const key = this.collectionKey(ctx, name);
    const existing = this.collections.get(key);
    if (existing === undefined || existing.projectId !== ctx.projectId) {
      throw new VellumError("NOT_FOUND", `Collection '${name}' not found`, { name });
    }
    const updated: CollectionRecord = {
      ...existing,
      description: patch.description !== undefined ? patch.description : existing.description,
      defaultTtlSeconds:
        patch.defaultTtlSeconds !== undefined ? patch.defaultTtlSeconds : existing.defaultTtlSeconds,
      schemaValidation:
        patch.schemaValidation !== undefined
          ? patch.schemaValidation === null
            ? null
            : structuredClone(patch.schemaValidation)
          : existing.schemaValidation,
      metadata: patch.metadata !== undefined ? structuredClone(patch.metadata) : existing.metadata,
      updatedAt: new Date().toISOString(),
    };
    this.collections.set(key, structuredClone(updated));
    this.rememberCollection(key);
    this.collectionConfigCache.set(key, this.configOf(updated));
    return this.withStats(updated, ctx);
  }

  public async clearCollectionDocuments(
    ctx: TenantContext,
    name: string
  ): Promise<{ deletedCount: number; freedBytes: number }> {
    requireMemoryTenant(ctx);
    const prefix = this.tenantPrefix(ctx);
    let deletedCount = 0;
    let freedBytes = 0;
    for (const [key, row] of this.documents.entries()) {
      if (!key.startsWith(prefix) || row.projectId !== ctx.projectId) continue;
      if (row.collectionPath !== name || row.deletedAt !== null) continue;
      deletedCount += 1;
      freedBytes += row.sizeBytes;
      this.documents.delete(key);
    }
    for (const [indexId, entries] of this.indexEntries.entries()) {
      for (const [entryKey, entry] of entries.entries()) {
        if (
          entry.projectId === ctx.projectId &&
          entry.collectionPath === name
        ) {
          entries.delete(entryKey);
        }
      }
      this.indexEntries.set(indexId, entries);
    }
    return { deletedCount, freedBytes };
  }

  public async deleteCollection(
    ctx: TenantContext,
    name: string
  ): Promise<{ deletedCollection: boolean; deletedDocuments: number; freedBytes: number }> {
    requireMemoryTenant(ctx);
    const prefix = this.tenantPrefix(ctx);
    let deletedDocuments = 0;
    let freedBytes = 0;
    for (const [key, row] of this.documents.entries()) {
      if (!key.startsWith(prefix) || row.projectId !== ctx.projectId) continue;
      if (row.collectionPath !== name) continue;
      deletedDocuments += 1;
      freedBytes += row.sizeBytes;
      this.documents.delete(key);
    }
    const key = this.collectionKey(ctx, name);
    const deletedCollection = this.collections.has(key);

    for (const [indexId, idx] of this.indexes.entries()) {
      if (
        idx.projectId === ctx.projectId &&
        idx.collectionPath === name
      ) {
        this.indexes.delete(indexId);
        this.indexEntries.delete(indexId);
      }
    }
    for (const [indexId, entries] of this.indexEntries.entries()) {
      for (const [entryKey, entry] of entries.entries()) {
        if (
          entry.projectId === ctx.projectId &&
          entry.collectionPath === name
        ) {
          entries.delete(entryKey);
        }
      }
      this.indexEntries.set(indexId, entries);
    }

    this.collections.delete(key);
    this.forgetCollection(key);
    return { deletedCollection, deletedDocuments, freedBytes };
  }

  public async getCollectionConfig(ctx: TenantContext, name: string): Promise<CollectionConfig | null> {
    requireMemoryTenant(ctx);
    const key = this.collectionKey(ctx, name);
    const cached = this.collectionConfigCache.get(key);
    if (cached !== undefined) return cached;
    const record = this.collections.get(key);
    if (record === undefined || record.projectId !== ctx.projectId) return null;
    const config = this.configOf(record);
    this.collectionConfigCache.set(key, config);
    return config;
  }

  public async close(): Promise<void> {
    this.collectionConfigCache.dispose();
    // In-memory has nothing else to disconnect.
  }
}
