/**
 * @vellum/core - Error Hierarchy & Status Mapping
 * Matches Specification Section 11.2 exactly.
 */

export const ERROR_HTTP_STATUS = {
  INVALID_ARGUMENT: 400,
  INVALID_DOCUMENT_PATH: 400,
  INVALID_FIELD_NAME: 400,
  MAX_NESTING_EXCEEDED: 400,
  BATCH_SIZE_EXCEEDED: 400,
  INVALID_CURSOR: 400,
  QUERY_TOO_COMPLEX: 400,
  LIMIT_EXCEEDED: 400,
  SUBSCRIPTION_LIMIT_EXCEEDED: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  TRANSACTION_TIMEOUT: 408,
  ALREADY_EXISTS: 409,
  ABORTED: 409,
  ABORTED_CONFLICT: 409,
  ALREADY_COMMITTED: 409,
  ALREADY_ROLLED_BACK: 409,
  FAILED_PRECONDITION: 412,
  RELATION_RESTRICT_VIOLATION: 412,
  DOCUMENT_TOO_LARGE: 413,
  PAYLOAD_TOO_LARGE: 413,
  RESPONSE_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  TOO_MANY_REQUESTS: 429,
  QUOTA_EXCEEDED: 429,
  RESOURCE_EXHAUSTED: 429,
  SLOW_CONSUMER_DISCONNECT: 429,
  INTERNAL: 500,
  INTERNAL_ERROR: 500,
  UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
  QUERY_DEADLINE_EXCEEDED: 504,
} as const;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;

export interface ErrorDetails {
  [key: string]: unknown;
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details: ErrorDetails;
  };
}

export class VellumError extends Error {
  public readonly code: ErrorCode;
  public readonly status: number;
  public readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = "VellumError";
    this.code = code;
    this.status = ERROR_HTTP_STATUS[code] ?? 500;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public toEnvelope(requestId = "req_unknown"): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        details: this.details,
      },
    };
  }
}
export type VellumErrorCode = ErrorCode;
