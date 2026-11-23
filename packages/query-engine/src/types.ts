/**
 * @vellum/query-engine - Query Engine Type Definitions
 */

export type QueryOperator =
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "in"
  | "not-in"
  | "array-contains"
  | "array-contains-any"
  /** Case-insensitive substring match (SQL `ILIKE '%…%'`, wildcards escaped). */
  | "contains_ci"
  /** Case-insensitive prefix match (SQL `ILIKE '…%'`, wildcards escaped). */
  | "starts_with_ci"
  /** Full-text match across the serialized document (SQL `to_tsvector @@ plainto_tsquery`). */
  | "text_search";

export interface QuerySpec extends Record<string, unknown> {
  collection?: string | undefined;
  collectionPath?: string | undefined;
  /** Literal substring across document ID and serialized data, before pagination. */
  search?: string | undefined;
  where?: WhereClause[] | undefined;
  /** Disjunctive groups: each group is ANDed internally, groups are ORed together. */
  or?: WhereClause[][] | undefined;
  orderBy?: OrderByClause[] | undefined;
  limit?: number | undefined;
  select?: string[] | undefined;
  startAt?: string | unknown[] | null | undefined;
  startAfter?: string | unknown[] | null | undefined;
}

export interface WhereClause {
  field: string;
  op: QueryOperator;
  value: unknown;
}

export interface OrderByClause {
  field: string;
  dir: "asc" | "desc";
}

export interface NormalizedQuery {
  search?: string | undefined;
  collectionPath: string;
  where: WhereClause[];
  /** Normalized disjunctive groups (always an array; empty when none were supplied). */
  or: WhereClause[][];
  orderBy: OrderByClause[];
  limit: number;
  select: string[] | null;
  startAt: unknown[] | null;
  startAfter: unknown[] | null;
}

export interface CursorPayload {
  qHash: string;
  vals: unknown[];
  docId: string;
  /** Hex-encoded composite-index sort key for the cursor row (opaque, HMAC-signed). */
  sortKey?: string | undefined;
  sig?: string | undefined;
}

/** Single secret or ordered list of secrets (primary first) for zero-downtime key rotation. */
export type CursorSecretInput = string | readonly string[];

/** How the keyset predicate must treat the cursor row itself. */
export type CursorMode = "startAt" | "startAfter" | null;

export interface CompiledQuery {
  sql: string;
  params: unknown[];
  indexUsed?: string | undefined;
  /** Normalized query retained so the in-memory adapter can execute the identical plan. */
  normalizedQuery: NormalizedQuery;
  /** Decoded + verified cursor used for SQL keyset pagination. */
  cursor: CursorPayload | null;
  cursorMode: CursorMode;
  /** Rows requested from the database: limit + 1, capped for unindexed scans. */
  fetchLimit: number;
  /** Non-null safety cap for unindexed fallback scans. */
  maxScanRows: number | null;
  /** Selected field paths (full dot paths, used as projected keys). */
  projectionFields: string[] | null;
  /** Matched composite index id, when the plan is index-backed. */
  compositeIndexId: string | null;
}

export interface CompositeIndexMetadata {
  id: string;
  collectionPath: string;
  fields: Array<{ path: string; dir: "asc" | "desc" }>;
  status: "building" | "ready" | "failed";
}

/** Structural shape of a document record evaluated in memory. */
export interface EvaluatableDocumentRecord {
  documentId: string;
  createdAt: string;
  updatedAt: string;
  data: Record<string, unknown>;
}

/** Structural shape of a collection document record evaluated against a full NormalizedQuery. */
export interface QueryableDocumentRecord extends EvaluatableDocumentRecord {
  collectionPath: string;
  deletedAt?: string | null | undefined;
  expiresAt?: string | null | undefined;
}

/** Pre-compiled in-memory predicate function for high-throughput batch evaluation. */
export type CompiledQueryEvaluator = (docRecord: QueryableDocumentRecord) => boolean;
