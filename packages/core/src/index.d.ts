export declare const SYSTEM_LIMITS: {
  readonly MAX_DOCUMENT_BYTES: 1048576;
  readonly MAX_PATH_DEPTH: 10;
  readonly MAX_PATH_SEGMENT_BYTES: 1500;
  readonly MAX_OBJECT_NESTING_DEPTH: 20;
  readonly MAX_FIELD_NAME_LENGTH: 256;
  readonly MAX_BATCH_OPERATIONS: 100;
  readonly MAX_BATCH_PAYLOAD_BYTES: 5242880;
  readonly MAX_TRANSACTION_DURATION_MS: 5000;
  readonly MAX_WHERE_CLAUSES: 10;
  readonly MAX_DISJUNCTIVE_VALUES: 30;
  readonly MAX_ORDER_BY_FIELDS: 3;
  readonly DEFAULT_QUERY_LIMIT: 50;
  readonly MAX_QUERY_LIMIT: 500;
  readonly MAX_QUERY_RESPONSE_BYTES: 4194304;
  readonly MAX_QUERY_EXECUTION_MS: 5000;
  readonly MAX_COMPOSITE_INDEXES_FREE: 50;
  readonly MAX_COMPOSITE_INDEXES_PRO: 200;
  readonly MAX_WS_SUBSCRIPTIONS_PER_CONN: 25;
  readonly MAX_WS_OUTBOUND_BUFFER_BYTES: 1048576;
  readonly TOMBSTONE_RETENTION_DAYS_DEFAULT: 7;
  readonly OUTBOX_RETENTION_HOURS: 24;
  readonly RULES_AST_MAX_DEPTH: 10;
  readonly RULES_AST_MAX_NODES: 100;
};

export declare const ERROR_HTTP_STATUS: {
  readonly INVALID_ARGUMENT: 400;
  readonly INVALID_DOCUMENT_PATH: 400;
  readonly INVALID_FIELD_NAME: 400;
  readonly MAX_NESTING_EXCEEDED: 400;
  readonly BATCH_SIZE_EXCEEDED: 400;
  readonly INVALID_CURSOR: 400;
  readonly QUERY_TOO_COMPLEX: 400;
  readonly LIMIT_EXCEEDED: 400;
  readonly SUBSCRIPTION_LIMIT_EXCEEDED: 400;
  readonly UNAUTHENTICATED: 401;
  readonly TOKEN_EXPIRED: 401;
  readonly PERMISSION_DENIED: 403;
  readonly NOT_FOUND: 404;
  readonly TRANSACTION_TIMEOUT: 408;
  readonly ALREADY_EXISTS: 409;
  readonly ABORTED: 409;
  readonly ABORTED_CONFLICT: 409;
  readonly ALREADY_COMMITTED: 409;
  readonly ALREADY_ROLLED_BACK: 409;
  readonly FAILED_PRECONDITION: 412;
  readonly RELATION_RESTRICT_VIOLATION: 412;
  readonly DOCUMENT_TOO_LARGE: 413;
  readonly PAYLOAD_TOO_LARGE: 413;
  readonly RESPONSE_TOO_LARGE: 413;
  readonly RATE_LIMITED: 429;
  readonly TOO_MANY_REQUESTS: 429;
  readonly QUOTA_EXCEEDED: 429;
  readonly RESOURCE_EXHAUSTED: 429;
  readonly SLOW_CONSUMER_DISCONNECT: 429;
  readonly INTERNAL: 500;
  readonly INTERNAL_ERROR: 500;
  readonly UNAVAILABLE: 503;
  readonly SERVICE_UNAVAILABLE: 503;
  readonly DEADLINE_EXCEEDED: 504;
  readonly QUERY_DEADLINE_EXCEEDED: 504;
};

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;
export type VellumErrorCode = ErrorCode;

export declare class VellumError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>);
  toEnvelope(requestId?: string): {
    error: {
      code: ErrorCode;
      message: string;
      requestId: string;
      details: Record<string, unknown>;
    };
  };
}

/** Deprecated alias. `VellumError` is canonical. */
export { VellumError };

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonArray = JsonValue[];

export declare function isJsonValue(value: unknown, maxDepth?: number): value is JsonValue;
export declare function isJsonObject(value: unknown, maxDepth?: number): value is JsonObject;

export interface ParsedDocumentPath {
  path: string;
  collectionPath: string;
  collectionGroup: string;
  documentId: string;
  pathDepth: number;
  segments: string[];
}

export interface ParsedCollectionPath {
  collectionPath: string;
  collectionGroup: string;
  depth: number;
  segments: string[];
}

export declare function parseDocumentPath(rawPath: string): ParsedDocumentPath;
export declare function parseCollectionPath(rawCollectionPath: string): ParsedCollectionPath;
export declare function validateFieldName(fieldName: string): void;
export declare function validateWireValue(value: unknown, depth?: number, allowFieldOps?: boolean): void;
export declare function normalizeAndValidateDocumentData(
  data: Record<string, unknown>,
  allowFieldOps?: boolean
): { data: Record<string, unknown>; sizeBytes: number };

export declare function encodeSortableFloat64(num: number): Buffer;
export declare function encodeSortableInt64(bigIntVal: bigint | number | string): Buffer;
export declare function encodeSingleSortKeyValue(value: unknown, direction?: "asc" | "desc"): Buffer;
export declare function encodeCompositeSortKey(
  docRecord: { documentId: string; createdAt: string; updatedAt: string; data: Record<string, unknown> },
  indexFields: Array<{ path: string; dir: "asc" | "desc" }>
): Buffer;
export declare function getFieldByPath(data: Record<string, unknown>, fieldPath: string): unknown;
export declare function compareWireValues(a: unknown, b: unknown, dir?: "asc" | "desc"): number;
export declare function wireValuesEqual(a: unknown, b: unknown): boolean;
