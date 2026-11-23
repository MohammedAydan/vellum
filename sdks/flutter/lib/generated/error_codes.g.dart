// GENERATED CODE - DO NOT MODIFY BY HAND.
// Source of truth: packages/core/src/errors.ts (ERROR_HTTP_STATUS).
// Regenerate with: pnpm codegen:dart-errors

/// Canonical Document Database SaaS API error codes and HTTP status mappings.
abstract final class VellumErrorCodes {
  static const String invalidArgument = 'INVALID_ARGUMENT';
  static const String invalidDocumentPath = 'INVALID_DOCUMENT_PATH';
  static const String invalidFieldName = 'INVALID_FIELD_NAME';
  static const String maxNestingExceeded = 'MAX_NESTING_EXCEEDED';
  static const String batchSizeExceeded = 'BATCH_SIZE_EXCEEDED';
  static const String invalidCursor = 'INVALID_CURSOR';
  static const String queryTooComplex = 'QUERY_TOO_COMPLEX';
  static const String limitExceeded = 'LIMIT_EXCEEDED';
  static const String subscriptionLimitExceeded = 'SUBSCRIPTION_LIMIT_EXCEEDED';
  static const String unauthenticated = 'UNAUTHENTICATED';
  static const String tokenExpired = 'TOKEN_EXPIRED';
  static const String permissionDenied = 'PERMISSION_DENIED';
  static const String notFound = 'NOT_FOUND';
  static const String transactionTimeout = 'TRANSACTION_TIMEOUT';
  static const String alreadyExists = 'ALREADY_EXISTS';
  static const String aborted = 'ABORTED';
  static const String abortedConflict = 'ABORTED_CONFLICT';
  static const String alreadyCommitted = 'ALREADY_COMMITTED';
  static const String alreadyRolledBack = 'ALREADY_ROLLED_BACK';
  static const String failedPrecondition = 'FAILED_PRECONDITION';
  static const String relationRestrictViolation = 'RELATION_RESTRICT_VIOLATION';
  static const String documentTooLarge = 'DOCUMENT_TOO_LARGE';
  static const String payloadTooLarge = 'PAYLOAD_TOO_LARGE';
  static const String responseTooLarge = 'RESPONSE_TOO_LARGE';
  static const String rateLimited = 'RATE_LIMITED';
  static const String tooManyRequests = 'TOO_MANY_REQUESTS';
  static const String quotaExceeded = 'QUOTA_EXCEEDED';
  static const String resourceExhausted = 'RESOURCE_EXHAUSTED';
  static const String slowConsumerDisconnect = 'SLOW_CONSUMER_DISCONNECT';
  static const String internal = 'INTERNAL';
  static const String internalError = 'INTERNAL_ERROR';
  static const String unavailable = 'UNAVAILABLE';
  static const String serviceUnavailable = 'SERVICE_UNAVAILABLE';
  static const String deadlineExceeded = 'DEADLINE_EXCEEDED';
  static const String queryDeadlineExceeded = 'QUERY_DEADLINE_EXCEEDED';

  /// Canonical HTTP status code for each error code.
  static const Map<String, int> httpStatusByCode = <String, int>{
    invalidArgument: 400,
    invalidDocumentPath: 400,
    invalidFieldName: 400,
    maxNestingExceeded: 400,
    batchSizeExceeded: 400,
    invalidCursor: 400,
    queryTooComplex: 400,
    limitExceeded: 400,
    subscriptionLimitExceeded: 400,
    unauthenticated: 401,
    tokenExpired: 401,
    permissionDenied: 403,
    notFound: 404,
    transactionTimeout: 408,
    alreadyExists: 409,
    aborted: 409,
    abortedConflict: 409,
    alreadyCommitted: 409,
    alreadyRolledBack: 409,
    failedPrecondition: 412,
    relationRestrictViolation: 412,
    documentTooLarge: 413,
    payloadTooLarge: 413,
    responseTooLarge: 413,
    rateLimited: 429,
    tooManyRequests: 429,
    quotaExceeded: 429,
    resourceExhausted: 429,
    slowConsumerDisconnect: 429,
    internal: 500,
    internalError: 500,
    unavailable: 503,
    serviceUnavailable: 503,
    deadlineExceeded: 504,
    queryDeadlineExceeded: 504,
  };

  /// Complete set of canonical API error codes.
  static const Set<String> all = <String>{
    invalidArgument,
    invalidDocumentPath,
    invalidFieldName,
    maxNestingExceeded,
    batchSizeExceeded,
    invalidCursor,
    queryTooComplex,
    limitExceeded,
    subscriptionLimitExceeded,
    unauthenticated,
    tokenExpired,
    permissionDenied,
    notFound,
    transactionTimeout,
    alreadyExists,
    aborted,
    abortedConflict,
    alreadyCommitted,
    alreadyRolledBack,
    failedPrecondition,
    relationRestrictViolation,
    documentTooLarge,
    payloadTooLarge,
    responseTooLarge,
    rateLimited,
    tooManyRequests,
    quotaExceeded,
    resourceExhausted,
    slowConsumerDisconnect,
    internal,
    internalError,
    unavailable,
    serviceUnavailable,
    deadlineExceeded,
    queryDeadlineExceeded,
  };

  /// Returns `true` if [code] is a canonical Document Database error code.
  static bool isKnown(String code) => httpStatusByCode.containsKey(code);

  /// Returns the canonical HTTP status code for [code], or `null` if unknown.
  static int? httpStatusFor(String code) => httpStatusByCode[code];
}
