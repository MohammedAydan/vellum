/**
 * @vellum/document-engine - Types and Interfaces
 * Specification Sections 6.2, 6.3, 8.1, 8.2, 8.3, 8.4, 8.5
 */

import type { StorageAdapter } from "@vellum/storage";
import type { WhereClause } from "@vellum/query-engine";
import type { IncludeSpec } from "./relations.js";

/* -------------------------------------------------------------------------- */
/* Collection lifecycle re-exports (docs/COLLECTIONS-CONTRACT.md §2.2/§2.4)     */
/* -------------------------------------------------------------------------- */

export type {
  CollectionConfig,
  CollectionRecord,
  CollectionSchemaValidation,
  CollectionWithStats,
  CreateCollectionInput,
  ListCollectionsOptions,
  UpdateCollectionInput,
} from "@vellum/storage";

export type MutationType = "create" | "set" | "update" | "delete";

export interface BatchMutationBase {
  path: string;
  ifVersion?: number | null | undefined;
  exists?: boolean | undefined;
}

export interface CreateMutation extends BatchMutationBase {
  type: "create";
  data: Record<string, unknown>;
}

export interface SetMutation extends BatchMutationBase {
  type: "set";
  data: Record<string, unknown>;
  merge?: boolean | undefined;
}

export interface UpdateMutation extends BatchMutationBase {
  type: "update";
  data: Record<string, unknown>;
}

export interface DeleteMutation extends BatchMutationBase {
  type: "delete";
}

export type BatchMutation = CreateMutation | SetMutation | UpdateMutation | DeleteMutation;

export interface PublicDocument {
  path: string;
  collectionPath: string;
  collectionGroup: string;
  documentId: string;
  data: Record<string, unknown>;
  sizeBytes: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Resolved relation targets, keyed by `IncludeSpec.as` (or `field`). */
  _included?: Record<string, unknown> | undefined;
  /** Attachment keys whose target was hidden by Security Rules `get`. */
  _redactedRefs?: string[] | undefined;
  /** Dot-paths of cycle/redaction stubs emitted while resolving `_included` targets. */
  _redactedRefPaths?: string[] | undefined;
  /** Discriminator: a successfully read document (vs. `DeleteResult.status === "deleted"`). */
  status: "ok";
  /** Absolute expiry as an ISO string, or `null` when the document never expires. */
  expiresAt: string | null;
}

/** Referential-integrity rule evaluated on delete inside `batchWrite`. */
export interface RelationRule {
  collection: string;
  field: string;
  onDelete: "cascade" | "set_null" | "restrict";
  /**
   * Optional guard: when set, the rule only fires for deletes in this target
   * collection. Omit to apply the rule to references pointing at any collection.
   */
  targetCollection?: string;
}

export interface DeleteResult {
  path: string;
  status: "deleted";
  version: number;
  updatedAt: string;
}

export type MutationResult = PublicDocument | DeleteResult;

export interface BatchWriteResult {
  results: MutationResult[];
  committedAt: string;
}

export interface TransactionBeginResult {
  transactionId: string;
  transactionToken: string;
  expiresAt: string;
}

export interface QueryResult {
  documents: PublicDocument[];
  nextCursor: string | null;
  meta: {
    count: number;
    indexUsed: string;
    executionTimeMs: number;
    /** Only populated when `ctx.debug === true`; omitted otherwise. */
    compiledSql?: string | undefined;
  };
}

/** Native aggregation request (structurally shared with `@vellum/storage`). */
export interface AggregateRequest {
  collectionPath: string;
  where?: WhereClause[] | undefined;
  or?: WhereClause[][] | undefined;
  groupBy?: string[] | undefined;
  metrics: Record<
    string,
    { op: "count" | "sum" | "avg" | "min" | "max"; field?: string | undefined }
  >;
}

export interface AggregateRow {
  [key: string]: unknown;
}

export interface AggregateResult {
  rows: AggregateRow[];
  executionTimeMs: number;
}

export interface ControlStoreLike {
  getActiveRuleset(projectId: string): unknown;
  incrementUsage(
    projectId: string,
    usage: {
      documentReads?: number;
      documentWrites?: number;
      documentDeletes?: number;
      storageBytesDelta?: number;
      egressBytes?: number;
    }
  ): void;
}

export interface RealtimeHubLike {
  notifyCommittedEvents(projectId: string, events: unknown[]): Promise<void> | void;
}

/** Optional metering sink. Implementations are wired by Phase 2B (`platform`). */
export interface MeteringLike {
  recordDeletes(
    orgId: string,
    projectId: string,
    count: number,
    storageDeltaBytes: number
  ): Promise<void> | void;
}

/** Optional tamper-evident audit sink. Implementations are wired by Phase 2B. */
export interface AuditLike {
  log(
    action: string,
    input: {
      organizationId?: string | null;
      projectId?: string | null;
      targetId?: string | null;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> | void;
}

/** Result of `importCollectionDocuments` (no secrets ever surfaced in errors). */
export interface ImportCollectionDocumentsResult {
  importedCount: number;
  skippedCount: number;
  errors: Array<{ index: number; message: string }>;
}

export interface ImportCollectionDocumentsOptions {
  /** `upsert` (default) overwrites existing ids; `insert_only` rejects duplicates. */
  mode?: "upsert" | "insert_only" | undefined;
}

export interface ExportCollectionDocumentsOptions {
  /** Maximum number of documents to return (clamped to MAX_QUERY_LIMIT). */
  limit?: number | undefined;
  /** Opaque documentId cursor (exclusive). */
  cursor?: string | null | undefined;
}

export interface ExportedCollectionDocument {
  id: string;
  path: string;
  data: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExportCollectionDocumentsResult {
  documents: ExportedCollectionDocument[];
  nextCursor: string | null;
}

/** Zero-dependency telemetry sink. Implementations are wired by Phase 4B. */
export interface TelemetryLike {
  span<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  counter(name: string, value?: number, tags?: Record<string, string>): void;
  histogram(name: string, value: number, tags?: Record<string, string>): void;
}

/** Zero-dependency rate-limit probe. Implementations are wired by Phase 4B. */
export interface RateLimiterLike {
  check(key: string): Promise<boolean> | boolean;
}

export interface DocumentEngineOptions {
  controlStore: ControlStoreLike;
  dataStore: StorageAdapter;
  realtimeHub?: RealtimeHubLike | null | undefined;
  cursorSecret?: string | undefined;
  txSecret?: string | undefined;
  /** Previous transaction-signing secret, accepted during key rotation. */
  txSecretPrev?: string | undefined;
  /** Optional telemetry sink — failures are swallowed, never block requests. */
  telemetry?: TelemetryLike | undefined;
  /** Optional rate-limit probe — failures fail open unless the engine decides otherwise. */
  rateLimiter?: RateLimiterLike | undefined;
  /** Optional metering sink — failures are swallowed, never block requests. */
  metering?: MeteringLike | undefined;
  /** Optional audit sink — failures are swallowed, never block requests. */
  audit?: AuditLike | undefined;
}

export interface EngineContext {
  projectId: string;
  /** Emits SQL/debug metadata in query results. Never set from a public request. */
  debug?: boolean | undefined;
  /** Stable idempotency key for retry-safe mutations. */
  idempotencyKey?: string | undefined;
  /** Caller-supplied rate-limit bucket key. */
  rateLimitKey?: string | undefined;
  /** Owning organization id, used by metering/audit hooks when present. */
  orgId?: string | undefined;
  apiKeyRecord?: unknown;
  authContext?: unknown;
  transactionToken?: string | null | undefined;
  /** Relation targets to resolve after the parent read (getDocument / executeQuery). */
  include?: IncludeSpec[] | undefined;
  /** Referential-integrity rules evaluated for delete mutations in `batchWrite`. */
  relationRules?: RelationRule[] | undefined;
  /** Dot-path field projection for getDocument / executeQuery (rebuilds nested objects). */
  select?: string[] | undefined;
  /** Relative TTL in seconds (positive finite, <= 2^31). Applied on writes. */
  ttlSeconds?: number | undefined;
  /** Absolute expiry as an ISO date string (or null). Applied on writes. */
  expiresAt?: string | null | undefined;
  /** When true, a `create` mutation on an existing path uses the upserting `set` path. */
  upsert?: boolean | undefined;
}

/**
 * Internal-only context for trusted system components (e.g. the auth
 * `DocumentProjector`). `internal: true` marks the caller as privileged;
 * `bypassRules` is deliberately absent from the public {@link EngineContext}
 * so public request handlers can never forward it from an untrusted body.
 */
export interface InternalEngineContext extends EngineContext {
  internal: true;
  bypassRules?: boolean | undefined;
}
