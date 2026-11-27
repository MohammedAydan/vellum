/**
 * @vellum/core - System Limits & Quotas
 * Matches Specification Section 2.3 exactly.
 */

export const SYSTEM_LIMITS = {
  MAX_DOCUMENT_BYTES: 1_048_576, // 1 MiB
  MAX_PATH_DEPTH: 10, // 5 nested collections (c1/d1..c5/d5)
  MAX_PATH_SEGMENT_BYTES: 1_500, // 1,500 UTF-8 bytes per segment
  MAX_OBJECT_NESTING_DEPTH: 20, // 20 levels inside document data
  MAX_FIELD_NAME_LENGTH: 256, // 256 chars per field key
  MAX_BATCH_OPERATIONS: 100, // 100 operations per atomic batch / tx
  MAX_BATCH_PAYLOAD_BYTES: 5_242_880, // 5 MiB
  MAX_TRANSACTION_DURATION_MS: 15_000, // 15,000 ms OCC interactive window (a remote client needs several round trips)
  MAX_WHERE_CLAUSES: 10, // 10 filters per query
  MAX_DISJUNCTIVE_VALUES: 30, // 30 values in `in` / `not-in` / `array-contains-any`
  MAX_ORDER_BY_FIELDS: 3, // 3 orderBy fields per query
  DEFAULT_QUERY_LIMIT: 50, // Default 50 docs per query page
  MAX_QUERY_LIMIT: 500, // Max 500 docs per query page
  MAX_QUERY_RESPONSE_BYTES: 4_194_304, // 4 MiB
  MAX_QUERY_EXECUTION_MS: 5_000, // 5,000 ms statement_timeout
  MAX_COMPOSITE_INDEXES_FREE: 50,
  MAX_COMPOSITE_INDEXES_PRO: 200,
  MAX_WS_SUBSCRIPTIONS_PER_CONN: 25,
  MAX_WS_OUTBOUND_BUFFER_BYTES: 1_048_576, // 1 MiB
  TOMBSTONE_RETENTION_DAYS_DEFAULT: 7,
  OUTBOX_RETENTION_HOURS: 24,
  RULES_AST_MAX_DEPTH: 10,
  RULES_AST_MAX_NODES: 100,
  // A single document (or a single write inside a batch/transaction/import)
  // has its own payload key budget, far above the 500-key default request
  // cap: realistic documents legitimately carry thousands of nested fields.
  // The 1 MiB document byte cap above stays the hard size bound.
  DOCUMENT_MAX_OBJECT_KEYS: 10_000,
  // Publishing a security/relation ruleset has its own payload key budget,
  // far above the 500-key per-document cap: a realistic ruleset for tens of
  // collections legitimately exceeds it. The per-rule AST limits above stay.
  RULESET_MAX_OBJECT_KEYS: 25_000,
} as const;

export type SystemLimits = typeof SYSTEM_LIMITS;
