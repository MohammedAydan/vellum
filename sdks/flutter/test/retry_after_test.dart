import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

void main() {
  test(
      'VellumException.retryAfter reads the Retry-After header or retryAfterSeconds',
      () {
    const fromHeader = VellumException(
      code: 'TOO_MANY_REQUESTS',
      message: 'slow down',
      statusCode: 429,
      details: <String, Object?>{'retryAfter': '900'},
    );
    expect(fromHeader.retryAfter, 900);
    const fromDetails = VellumException(
      code: 'TOO_MANY_REQUESTS',
      message: 'slow down',
      statusCode: 429,
      details: <String, Object?>{'retryAfterSeconds': 120},
    );
    expect(fromDetails.retryAfter, 120);
    const none = VellumException(code: 'X', message: 'm', statusCode: 400);
    expect(none.retryAfter, isNull);
  });
}
