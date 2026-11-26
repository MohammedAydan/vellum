import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

void main() {
  test('a network failure surfaces as a typed NETWORK_ERROR with status 0', () async {
    final mock = MockClient((_) async => throw http.ClientException('Failed host lookup'));
    final db = VellumClient(
      projectId: 'p',
      apiKey: 'pk_t',
      httpClient: mock,
      maxRetries: 0,
    );
    Object? caught;
    try {
      await db.doc('a/b').set(<String, Object?>{'x': 1});
    } catch (e) {
      caught = e;
    }
    expect(caught, isA<VellumException>());
    final err = caught as VellumException;
    expect(err.code, 'NETWORK_ERROR');
    expect(err.statusCode, 0);
  });
}
