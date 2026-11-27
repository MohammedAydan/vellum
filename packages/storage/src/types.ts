import type { ReferencedByPageRequest } from "./referenced-by.js";
/**
 * @vellum/storage - Types and Interfaces for Data Plane Storage
 * Specification Sections 3.1, 6.3, 6.4, 7.1, 7.2, 8.2, and 15.
 */

import type { IndexFieldSpec, DocumentRecordForIndex } from "@vellum/core";
import type { CompiledQuery, WhereClause } from "@vellum/query-engine";
import type { AuthOperations } from "./auth-store.js";
import type { AggregateRequest, AggregateRow, DeleteWhereOptions } from "./aggregates.js";

// Re-exported here so the package barrel (`export * from "./types.js"`) exposes
// the V2 aggregate/delete contracts without editing the shared barrel file.
export type {
  AggregateMetric,
  AggregateMetricOp,
  AggregateRequest,
  AggregateRow,
  DeleteWhereOptions,
} from "./aggregates.js";

export interface TenantContext {
  readonly projectId: string;
}

/**
 * Cached result of an idempotent batch/document mutation. `responsePayload` is
 * the exact JSON payload that was returned on the first successful execution;
 * it is persisted as JSONB by the SQL adapters and cloned by the memory adapter.
 */
export interface IdempotencyResult {
  responseHash: string;
  responsePayload: unknown;
}

/**
 * Capability methods on `TxHandle` already know their tenant from the enclosing
 * transaction. The ENGINE-HARDENING-CONTRACT spells some of them with a leading
 * `ctx` argument; to keep both call shapes valid we accept either the bare
 * arguments or a leading `TenantContext`/`TxHandle`. A leading context is
 * validated against the transaction's tenant and used to fail closed on a
 * mismatch (it is never used to *replace* the transaction's RLS context).
 */
export type TxCapability<Args extends unknown[], Result> = (
  ...args: Args | [ctx: TenantContext, ...args: Args]
) => Result;

export type DocumentData = Record<string, unknown>;

export interface DocumentRecord extends DocumentRecordForIndex {
  projectId: string;
  path: string;
  collectionPath: string;
  collectionGroup: string;
  documentId: string;
  pathDepth: number;
  data: DocumentData;
  sizeBytes: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** V2 optional TTL (migration 0007). NULL/undefined = never expires. */
  expiresAt?: string | null | undefined;
}

export interface OutboxEvent {
  seqId: string;
  projectId: string;
  collectionPath: string;
  path: string;
  documentId: string;
  opType: "created" | "updated" | "deleted";
  version: number;
  beforeData: DocumentData | null;
  afterData: DocumentData | null;
  committedAt: string;
}

export type OutboxMutation = Omit<OutboxEvent, "seqId" | "committedAt" | "projectId">;

export type IndexFieldItem = IndexFieldSpec;

export interface IndexBuilderOptions {
  /** Only build indexes of this project. */
  projectId?: string | undefined;
  /** Only build this index. */
  indexId?: string | undefined;
  /** Stop (leaving the index `building`, resumable) after this many ms. */
  deadlineMs?: number | undefined;
}

export interface CompositeIndexRecord {
  id: string;
  projectId: string;
  collectionPath: string;
  fields: IndexFieldItem[];
  definitionHash: string;
  status: "building" | "ready" | "failed" | "deleting";
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompositeIndexEntry {
  indexId: string;
  projectId: string;
  collectionPath: string;
  sortKey: Buffer;
  documentId: string;
  path: string;
}

/** A document row returned by a compiled query, optionally carrying its keyset sort key. */
export interface QueriedDocument extends DocumentRecord {
  sortKeyHex?: string | undefined;
}

export interface TxHandle {
  readonly projectId: string;
  /**
   * `nowait` (P1-4): fail fast with ABORTED_CONFLICT instead of queueing on a
   * contended row lock; only meaningful with `forUpdate: true`.
   */
  getDocument(path: string, includeSoftDeleted?: boolean, forUpdate?: boolean, nowait?: boolean): Promise<DocumentRecord | null>;
  /**
   * V2: one SQL statement for an entire set of paths (relationship fan-out, zero N+1).
   * `includeDeleted` mirrors `getDocument(path, true)`: tombstones AND expired
   * rows are visible when true. Requested path order is preserved and duplicates
   * are fetched once. Callers passing only `paths` keep the live-only behavior.
   */
  /** `forUpdate` takes row locks in path order, so writers to the same document queue instead of racing. */
  batchGetDocuments?(paths: string[], includeDeleted?: boolean, forUpdate?: boolean): Promise<DocumentRecord[]>;
  /**
   * Compare-and-swap write. `expectedVersion === null` performs an insert-only
   * create (`ON CONFLICT DO NOTHING`); `expectedVersion >= 1` performs a
   * version-guarded update of a live row. Returns `{ applied: false }` on a
   * race — deliberately NO error code is thrown here so the storage layer stays
   * dumb and the engine can map a loss to ALREADY_EXISTS vs ABORTED_CONFLICT.
   * A soft-deleted tombstone at version 0 still occupies the unique key, so a
   * `null`-expected create is not applied; restoring/overwriting it must use the
   * explicit `putDocumentRow` upsert path (or a dedicated restore flow).
   */
  conditionalPutDocument?(row: DocumentRecord, expectedVersion: number | null): Promise<{ applied: boolean }>;
  /**
   * Batched CAS flush: one SQL statement for the whole batch (UNNEST + RETURNING).
   * Returns paths whose precondition was met; missing paths are races.
   */
  conditionalPutDocumentRows?(
    rows: DocumentRecord[],
    expectedVersions: ReadonlyArray<number | null>
  ): Promise<string[]>;
  putDocumentRow(row: DocumentRecord): Promise<void>;
  appendOutboxEvent(event: OutboxMutation): Promise<OutboxEvent>;
  createIndex(params: { collectionPath: string; fields: IndexFieldItem[] }): Promise<CompositeIndexRecord>;
  /**
   * Executes a query fully in SQL (Postgres/Neon) or via the equivalent in-memory
   * evaluator (memory adapter). Always runs inside the tenant transaction so RLS
   * fails closed if tenant context is ever omitted.
   */
  queryDocuments(compiled: CompiledQuery): Promise<QueriedDocument[]>;
  queryOutboxSince?(afterSeqId?: string, upToSeqId?: string): Promise<OutboxEvent[]>;
  /** Highest outbox seq_id of this project ("0" when none). */
  queryOutboxMaxSeq?(): Promise<string>;
  /**
   * P0-2 commit-order-safe watermark: the highest seq_id whose writing
   * transaction is known resolved (committed or aborted) at this snapshot.
   * Every row with seq_id at or below it is final and visible; a row above it
   * may still be in flight. Read inside the same transaction as an
   * `initial_sync` snapshot so the snapshot reflects everything the watermark
   * claims. Defaults to `queryOutboxMaxSeq` on adapters without xid8 gating.
   */
  outboxSafeWatermark?(): Promise<string>;
  listActiveDocumentsInCollection?(collectionPath: string): Promise<DocumentRecord[]>;
  /** Live documents in a collection, counted up to `cap` (index-only, stops reading at the cap). */
  countLiveDocumentsUpTo?(collectionPath: string, cap: number): Promise<number>;
  listDocumentsViaCompositeIndex?(indexId: string): Promise<DocumentRecord[]>;
  listIndexes?(): Promise<CompositeIndexRecord[]>;
  deleteIndex?(indexId: string): Promise<boolean>;
  /** V2: native aggregation over live documents in this tenant transaction. */
  aggregateDocuments?(req: AggregateRequest): Promise<AggregateRow[]>;
  /** V2: select matching live docs, stage tombstones + outbox events atomically. */
  deleteWhere?(
    collectionPath: string,
    where: WhereClause[],
    options: DeleteWhereOptions
  ): Promise<number>;

  /* ---------------------------------------------------------------------- */
  /* ENGINE-HARDENING capabilities (all optional so no caller breaks)       */
  /* ---------------------------------------------------------------------- */

  /**
   * Find live documents in `collectionPath` whose `field` references
   * `targetPath`. Covers plain scalar refs, tagged `{ _ref }` objects and
   * arrays of either. SQL implementations use one parameterized, JSONB-index
   * backed statement ordered by `path ASC`; never a full collection load.
   */
  listDependentsByReference?: TxCapability<
    [collectionPath: string, field: string, targetPath: string, limit: number],
    Promise<DocumentRecord[]>
  >;
  /** Bounded tenant-scoped reverse-reference candidates. Caller must authorize each row. */
  referencedByPage?(request: ReferencedByPageRequest): Promise<DocumentRecord[]>;
  /** Cursor-only (`document_id ASC`) page of live docs in a collection. */
  listDocumentsInCollectionPage?: TxCapability<
    [collectionName: string, opts: { afterDocumentId?: string | null; limit: number }],
    Promise<DocumentRecord[]>
  >;
  /** Read a cached idempotent response, if it has not expired. */
  getIdempotencyResult?: TxCapability<[key: string], Promise<IdempotencyResult | null>>;
  /** Upsert a cached idempotent response (24h TTL). */
  saveIdempotencyResult?: TxCapability<
    [key: string, responseHash: string, responsePayload: unknown],
    Promise<void>
  >;
}

/** Shape of a `queryDocuments` row as returned by the SQL adapters. */
export interface SqlQueriedRow extends DocumentRecord {
  projectedData?: Record<string, unknown> | null | undefined;
  sortKeyHex?: string | undefined;
}

/* -------------------------------------------------------------------------- */
/* Collections lifecycle (Phase 1 — docs/COLLECTIONS-CONTRACT.md §2.2)         */
/* -------------------------------------------------------------------------- */

/** Optional schema enforcement metadata persisted on a collection. */
export interface CollectionSchemaValidation {
  requiredFields?: string[];
  strict?: boolean;
}

/** A row of the durable `data_db.project_collections` registry. */
export interface CollectionRecord {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  defaultTtlSeconds: number | null;
  schemaValidation: CollectionSchemaValidation | null;
  isSystem: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** A registry row joined with live-document statistics. */
export interface CollectionWithStats extends CollectionRecord {
  documentCount: number;
  storageBytes: number;
  lastDocumentAt: string | null;
}

export interface CreateCollectionInput {
  name: string;
  description?: string;
  defaultTtlSeconds?: number;
  schemaValidation?: CollectionSchemaValidation;
  metadata?: Record<string, unknown>;
  ifNotExists?: boolean;
}

export interface UpdateCollectionInput {
  description?: string | null;
  defaultTtlSeconds?: number | null;
  schemaValidation?: CollectionSchemaValidation | null;
  metadata?: Record<string, unknown>;
}

/** Options for cursor-only collection listing (no SQL OFFSET). */
export interface ListCollectionsOptions {
  search?: string;
  limit?: number;
  cursor?: string | null;
}

/** Cached per-collection config used by the engine's auto-registration path. */
export interface CollectionConfig {
  schemaValidation: CollectionSchemaValidation | null;
  defaultTtlSeconds: number | null;
}

export interface StorageAdapter extends AuthOperations {
  withTransaction<T>(ctx: TenantContext, callback: (tx: TxHandle) => Promise<T>): Promise<T>;
  getDocument(ctx: TenantContext, path: string, opts?: { includeSoftDeleted?: boolean; forUpdate?: boolean }): Promise<DocumentRecord | null>;
  /** V2: batched, TTL-aware, tenant-scoped lookup in requested path order. */
  batchGetDocuments(ctx: TenantContext, paths: string[], includeDeleted?: boolean): Promise<DocumentRecord[]>;
  /** Compare-and-swap write; see `TxHandle.conditionalPutDocument` for semantics. */
  conditionalPutDocument?(
    ctx: TenantContext,
    row: DocumentRecord,
    expectedVersion: number | null
  ): Promise<{ applied: boolean }>;
  putDocument(ctx: TenantContext, row: DocumentRecord): Promise<void>;
  listDocumentsInCollection(ctx: TenantContext, collectionPath: string): Promise<DocumentRecord[]>;
  listDocumentsViaIndex(ctx: TenantContext, indexId: string): Promise<DocumentRecord[]>;
  appendOutbox(ctx: TenantContext, event: OutboxMutation): Promise<OutboxEvent>;
  createCompositeIndex(ctx: TenantContext, collectionPath: string, fields: IndexFieldItem[]): Promise<CompositeIndexRecord>;
  listCompositeIndexes(ctx: TenantContext): Promise<CompositeIndexRecord[]>;
  deleteCompositeIndex(ctx: TenantContext, indexId: string): Promise<boolean>;
  queryOutboxSince(ctx: TenantContext, afterSeqId?: string, upToSeqId?: string): Promise<OutboxEvent[]>;
  /** Highest outbox seq_id of the tenant's project ("0" when none). Optional: adapters without a durable outbox omit it. */
  queryOutboxMaxSeq?(ctx: TenantContext): Promise<string>;
  /**
   * P0-2 commit-order-safe watermark (see {@link TxHandle.outboxSafeWatermark}).
   * Optional: adapters without xid8 gating omit it and callers fall back to
   * `queryOutboxMaxSeq`.
   */
  queryOutboxSafeWatermark?(ctx: TenantContext): Promise<string>;
  /**
   * Builds `building` composite indexes. Resumable and time-boxable so it can
   * run inside a serverless request (`deadlineMs`) and be retried until done.
   */
  runIndexBuilderWorker(options?: IndexBuilderOptions): Promise<{ builtCount: number; pendingCount: number }>;
  runOutboxCompactionWorker(retentionHours?: number): Promise<{ purgedCount: number }>;
  runTombstonePurgeWorker(retentionDays?: number): Promise<{ purgedCount: number }>;
  /** V2: batched physical purge of expired live rows (default batch size 500). */
  runTtlSweeperWorker?(limit?: number): Promise<{ purgedCount: number }>;
  /** V2: native aggregation (optional — implemented by all shipped adapters). */
  aggregateDocuments?(ctx: TenantContext, request: AggregateRequest): Promise<AggregateRow[]>;
  /** V2: bulk delete (optional — implemented by all shipped adapters). */
  deleteWhere?(
    ctx: TenantContext,
    collectionPath: string,
    where: WhereClause[],
    options: DeleteWhereOptions
  ): Promise<number>;

  /* ---------------------------------------------------------------------- */
  /* ENGINE-HARDENING capabilities (all optional so no caller breaks)       */
  /* ---------------------------------------------------------------------- */

  /** Index-backed reference-dependent lookup (one parameterized statement). */
  listDependentsByReference?(
    ctx: TenantContext,
    collectionPath: string,
    field: string,
    targetPath: string,
    limit: number
  ): Promise<DocumentRecord[]>;
  /** Cursor-only page of live docs in a collection (`document_id ASC`). */
  listDocumentsInCollectionPage?(
    ctx: TenantContext,
    collectionName: string,
    opts: { afterDocumentId?: string | null; limit: number }
  ): Promise<DocumentRecord[]>;
  /** Read a cached idempotent response (24h TTL), if still valid. */
  getIdempotencyResult?(ctx: TenantContext, key: string): Promise<IdempotencyResult | null>;
  /** Upsert a cached idempotent response (24h TTL). */
  saveIdempotencyResult?(
    ctx: TenantContext,
    key: string,
    responseHash: string,
    responsePayload: unknown
  ): Promise<void>;
  /**
   * Delete expired idempotency rows. Passing `ctx` scopes the reaper to one
   * tenant (required under FORCE RLS); omitting it is a global reaper that
   * needs a BYPASSRLS maintenance role.
   */
  runIdempotencyCleanupWorker?(ctx?: TenantContext): Promise<{ purgedCount: number }>;

  /* Collections lifecycle (implemented by all shipped adapters). */
  createCollection(ctx: TenantContext, input: CreateCollectionInput): Promise<CollectionRecord>;
  /** Idempotent, O(1)-after-first-call registration hook for document writes. */
  ensureCollectionExists(ctx: TenantContext, name: string): Promise<void>;
  listCollections(
    ctx: TenantContext,
    opts?: ListCollectionsOptions
  ): Promise<{ collections: CollectionWithStats[]; nextCursor: string | null }>;
  getCollection(ctx: TenantContext, name: string): Promise<CollectionWithStats | null>;
  updateCollection(
    ctx: TenantContext,
    name: string,
    patch: UpdateCollectionInput
  ): Promise<CollectionWithStats>;
  /** Hard-deletes active documents in a collection while keeping the registry row. */
  clearCollectionDocuments(
    ctx: TenantContext,
    name: string
  ): Promise<{ deletedCount: number; freedBytes: number }>;
  /** Deletes documents, derived indexes and the registry row in one transaction. */
  deleteCollection(
    ctx: TenantContext,
    name: string
  ): Promise<{ deletedCollection: boolean; deletedDocuments: number; freedBytes: number }>;
  /** Optional cached config lookup used by Phase 2 auto-registration. */
  getCollectionConfig?(ctx: TenantContext, name: string): Promise<CollectionConfig | null>;

  close(): Promise<void>;
}

export interface StorageAdapterOptions {
  connectionString?: string;
  driver?: "memory" | "pg" | "neon";
  directConnectionString?: string;
  maxConnections?: number;
}
