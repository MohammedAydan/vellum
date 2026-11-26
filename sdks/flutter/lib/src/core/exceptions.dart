/// Canonical API exceptions and secret redaction helpers.
part of '../../vellum_flutter_core.dart';

/// Structured exception thrown on canonical API error responses.
class VellumException implements Exception {
  final String code;
  final String message;
  final int statusCode;
  final String? requestId;
  final JsonMap details;

  /// Seconds to wait before retrying a throttled request (429), when the server says.
  int? get retryAfter {
    final header = details['retryAfter'];
    final fromHeader = header is String ? int.tryParse(header.trim()) : null;
    if (fromHeader != null && fromHeader > 0) return fromHeader;
    final value = details['retryAfterSeconds'];
    return value is num && value > 0 ? value.ceil() : null;
  }

  const VellumException({
    required this.code,
    required this.message,
    required this.statusCode,
    this.requestId,
    this.details = const <String, Object?>{},
  });

  @override
  String toString() => 'VellumException($code [$statusCode]): ${_redactSecrets(message)}';
}

/// Defense-in-depth: never let a token or API key leak into printed output.
String _redactSecrets(String value) {
  var text = value;
  text = text.replaceAllMapped(
    RegExp(r'\bBearer\s+\S+', caseSensitive: false),
    (Match match) => 'Bearer <redacted>',
  );
  text = text.replaceAllMapped(
    RegExp(r'\b(?:pk|sk)_[A-Za-z0-9_-]{4,}'),
    (Match match) => '<redacted>',
  );
  text = text.replaceAllMapped(
    RegExp(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'),
    (Match match) => '<redacted>',
  );
  return text;
}
