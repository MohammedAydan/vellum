/// Document and collection path validation and URL-safe encoding.
part of '../../vellum_flutter_core.dart';

/// Validates a single VELLUM path segment against path traversal, URL injection,
/// and control-character attacks.
///
/// Rejects empty segments, `.`, `..`, percent-encoded traversal sequences
/// (`%2e%2e`, `%2e`, `%2f`, `%5c`, `%00`, `%3f`, `%23`), backslashes (`\`),
/// query/fragment delimiters (`?`, `#`), NUL, and ASCII control characters.
String validateVellumSegment(
  String segment, {
  String context = 'path segment',
  bool allowSlash = false,
}) {
  if (segment.isEmpty) {
    throw VellumException(
      code: 'INVALID_DOCUMENT_PATH',
      message: 'Invalid $context: segment must not be empty',
      statusCode: 400,
    );
  }
  if (segment == '.' || segment == '..') {
    throw VellumException(
      code: 'INVALID_DOCUMENT_PATH',
      message: 'Invalid $context: dot traversal segment is not allowed',
      statusCode: 400,
    );
  }
  for (var i = 0; i < segment.length; i++) {
    final unit = segment.codeUnitAt(i);
    if (unit <= 0x1F || unit == 0x7F) {
      throw VellumException(
        code: 'INVALID_DOCUMENT_PATH',
        message: 'Invalid $context: control characters are not allowed',
        statusCode: 400,
      );
    }
    if (unit == 0x5C /* \ */ || unit == 0x3F /* ? */ || unit == 0x23 /* # */) {
      throw VellumException(
        code: 'INVALID_DOCUMENT_PATH',
        message: 'Invalid $context: forbidden character in path',
        statusCode: 400,
      );
    }
    if (!allowSlash && unit == 0x2F /* / */) {
      throw VellumException(
        code: 'INVALID_DOCUMENT_PATH',
        message: 'Invalid $context: slash is not allowed in a single segment',
        statusCode: 400,
      );
    }
  }

  final lower = segment.toLowerCase();
  if (lower == '%2e' ||
      lower == '%2e%2e' ||
      lower == '.%2e' ||
      lower == '%2e.' ||
      lower.contains('%2e%2e') ||
      lower.contains('%00') ||
      lower.contains('%5c') ||
      lower.contains('%3f') ||
      lower.contains('%23') ||
      lower.contains('%0a') ||
      lower.contains('%0d') ||
      (!allowSlash && lower.contains('%2f'))) {
    throw VellumException(
      code: 'INVALID_DOCUMENT_PATH',
      message:
          'Invalid $context: encoded traversal or control sequence is not allowed',
      statusCode: 400,
    );
  }

  // Decode once (when valid percent-encoding) to catch obfuscated control chars
  // or dot segments.
  if (segment.contains('%')) {
    try {
      final decoded = Uri.decodeComponent(segment);
      if (decoded == '.' || decoded == '..') {
        throw VellumException(
          code: 'INVALID_DOCUMENT_PATH',
          message: 'Invalid $context: encoded dot traversal is not allowed',
          statusCode: 400,
        );
      }
      for (var i = 0; i < decoded.length; i++) {
        final unit = decoded.codeUnitAt(i);
        if (unit <= 0x1F ||
            unit == 0x7F ||
            unit == 0x5C ||
            unit == 0x3F ||
            unit == 0x23 ||
            (!allowSlash && unit == 0x2F)) {
          throw VellumException(
            code: 'INVALID_DOCUMENT_PATH',
            message:
                'Invalid $context: encoded forbidden character is not allowed',
            statusCode: 400,
          );
        }
      }
    } on ArgumentError {
      // Malformed percent sequence is handled safely by Uri.encodeComponent.
    }
  }
  return segment;
}

/// Validates every segment of a slash-delimited VELLUM path and returns the
/// canonical slash-joined path (without leading/trailing slashes).
String validateVellumPath(String path, {bool requireEvenSegments = false}) {
  // Check raw path first so trailing `?query` or `#fragment` cannot slip past.
  for (var i = 0; i < path.length; i++) {
    final unit = path.codeUnitAt(i);
    if (unit <= 0x1F ||
        unit == 0x7F ||
        unit == 0x5C ||
        unit == 0x3F ||
        unit == 0x23) {
      throw const VellumException(
        code: 'INVALID_DOCUMENT_PATH',
        message: 'Invalid path: forbidden or control character in path',
        statusCode: 400,
      );
    }
  }
  final clean = path.replaceAll(RegExp(r'^/+|/+$'), '');
  if (clean.isEmpty) {
    throw const VellumException(
      code: 'INVALID_DOCUMENT_PATH',
      message: 'Path must not be empty',
      statusCode: 400,
    );
  }
  final segments = clean.split('/');
  for (final seg in segments) {
    validateVellumSegment(seg, context: 'path');
  }
  if (requireEvenSegments && segments.length % 2 != 0) {
    throw VellumException(
      code: 'INVALID_DOCUMENT_PATH',
      message: 'A document path must have an even number of segments: $path',
      statusCode: 400,
    );
  }
  return segments.join('/');
}

/// Validates and URI-encodes every segment of a VELLUM document/collection path.
String encodeVellumPath(String path) {
  final validated = validateVellumPath(path);
  return validated.split('/').map(Uri.encodeComponent).join('/');
}

const String _autoIdAlphabet =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
final Random _autoIdRandom = Random.secure();

/// Generates a 20 character document ID without any network request: 8 time
/// characters (base62, ASCII ordered so IDs sort by creation time) followed by
/// 12 random characters. Matches the TypeScript SDK.
String generateVellumAutoId([DateTime? now]) {
  var time = (now ?? DateTime.now()).millisecondsSinceEpoch;
  final prefix = List<String>.filled(8, '0');
  for (var i = 7; i >= 0; i--) {
    prefix[i] = _autoIdAlphabet[time % 62];
    time ~/= 62;
  }
  final suffix = StringBuffer();
  while (suffix.length < 12) {
    final byte = _autoIdRandom.nextInt(256);
    if (byte < 248) {
      suffix.write(_autoIdAlphabet[byte % 62]);
    }
  }
  return prefix.join() + suffix.toString();
}
