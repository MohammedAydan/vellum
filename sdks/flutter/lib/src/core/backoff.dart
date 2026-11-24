/// Reconnect/retry backoff strategies and Retry-After header parsing.
part of '../../vellum_flutter_core.dart';

/// Exponential backoff with full jitter per Specification Section 9.3:
/// `t_sleep = random(0, min(30000, 500 * 2^attempt))`
int computeReconnectBackoffMs(int attempt, {Random? random}) {
  final rng = random ?? Random();
  final safeAttempt = attempt < 0 ? 0 : min(attempt, 20);
  final cap = min(30000, 500 * (1 << safeAttempt));
  return rng.nextInt(cap + 1);
}

/// Decorrelated jitter reconnect backoff for WebSocket reconnection:
/// `next = min(maxMs, random(baseMs, max(baseMs, previousDelayMs * 3)))`.
int computeDecorrelatedJitterBackoffMs(
  int previousDelayMs, {
  int baseMs = 500,
  int maxMs = 30000,
  Random? random,
}) {
  final rng = random ?? Random();
  final low = max(0, baseMs);
  final upper = max(low, previousDelayMs * 3);
  final span = upper - low;
  final candidate = span <= 0 ? low : low + rng.nextInt(span + 1);
  return min(maxMs, candidate);
}

/// Exponential backoff with full jitter for transient HTTP retries:
/// `t_sleep = random(0, min(maxMs, baseMs * 2^attempt))`.
int computeRetryBackoffMs(
  int attempt, {
  int baseMs = 250,
  int maxMs = 15000,
  Random? random,
}) {
  final rng = random ?? Random();
  final safeAttempt = attempt < 0 ? 0 : min(attempt, 20);
  final cap = min(maxMs, baseMs * (1 << safeAttempt));
  if (cap <= 0) return 0;
  return rng.nextInt(cap + 1);
}

const Map<String, int> _httpMonths = <String, int>{
  'jan': 1,
  'feb': 2,
  'mar': 3,
  'apr': 4,
  'may': 5,
  'jun': 6,
  'jul': 7,
  'aug': 8,
  'sep': 9,
  'oct': 10,
  'nov': 11,
  'dec': 12,
};

/// Parses an HTTP `Retry-After` header value (delta-seconds or IMF-fixdate)
/// into a non-negative [Duration] without requiring `dart:io`.
Duration? parseRetryAfterHeader(String? value, {DateTime? now}) {
  if (value == null) return null;
  final trimmed = value.trim();
  if (trimmed.isEmpty) return null;

  final seconds = num.tryParse(trimmed);
  if (seconds != null) {
    if (seconds <= 0) return Duration.zero;
    return Duration(milliseconds: (seconds * 1000).round());
  }

  // RFC 7231 IMF-fixdate: e.g. "Wed, 21 Oct 2026 07:28:00 GMT"
  final match = RegExp(
    r'^[A-Za-z]{3},\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+GMT$',
  ).firstMatch(trimmed);
  if (match != null) {
    final day = int.tryParse(match.group(1)!);
    final month = _httpMonths[match.group(2)!.toLowerCase()];
    final year = int.tryParse(match.group(3)!);
    final hour = int.tryParse(match.group(4)!);
    final minute = int.tryParse(match.group(5)!);
    final second = int.tryParse(match.group(6)!);
    if (day != null &&
        month != null &&
        year != null &&
        hour != null &&
        minute != null &&
        second != null) {
      final target = DateTime.utc(year, month, day, hour, minute, second);
      final diff = target.difference((now ?? DateTime.now()).toUtc());
      return diff.isNegative ? Duration.zero : diff;
    }
  }
  return null;
}
