import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

JsonMap session() => <String, Object?>{
      'user': <String, Object?>{'id': 'user_1', 'displayName': 'محمد'},
      'accessToken': 'access',
      'refreshToken': 'refresh',
      'sessionId': 'session',
      'expiresAt': '2099-01-01T00:00:00Z',
      'tokenType': 'Bearer',
    };

Matcher invalid(String code) =>
    throwsA(isA<VellumException>().having((e) => e.code, 'code', code));

void main() {
  group('project URL validation', () {
    for (final base in [
      'https://example.test',
      'https://example.test/',
      'https://example.test/v1',
      '/v1',
      ''
    ]) {
      test('rejects unscoped baseUrl $base', () {
        expect(
            () =>
                VellumClient(baseUrl: base, projectId: 'p', apiKey: 'pk_test'),
            invalid('INVALID_ARGUMENT'));
      });
    }
    test('rejects conflicting arguments and prefixed endpoints', () {
      expect(
          () => VellumClient(
              endpoint: 'https://example.test',
              baseUrl: 'https://example.test/v1/projects/p',
              projectId: 'p',
              apiKey: 'k'),
          invalid('INVALID_ARGUMENT'));
      for (final value in [
        'https://example.test/v1/',
        'https://example.test/v1/projects/p',
        'ftp://example.test',
        'https://example.test?key=secret',
        'https://user:password@example.test'
      ]) {
        expect(() => VellumClient(endpoint: value, projectId: 'p', apiKey: 'k'),
            invalid('INVALID_ARGUMENT'));
      }
    });
    test('rejects missing or mismatched project', () {
      expect(
          () => VellumClient(
              endpoint: 'https://example.test', projectId: ' ', apiKey: 'k'),
          invalid('INVALID_ARGUMENT'));
      expect(
          () => VellumClient(
              baseUrl: 'https://example.test/v1/projects/other',
              projectId: 'p',
              apiKey: 'k'),
          invalid('INVALID_ARGUMENT'));
    });
    test('normalizes explicit slash and preserves custom proxy prefix', () {
      final client = VellumClient(
          baseUrl: 'https://example.test/proxy/project-api///',
          projectId: 'p',
          apiKey: 'k');
      expect(client.baseUrl, 'https://example.test/proxy/project-api');
      client.dispose();
      final relative = VellumClient(projectId: 'p', apiKey: 'k');
      expect(relative.baseUrl, '/v1/projects/p');
      relative.dispose();
    });
    for (final displayName in ['Mohammed Aydan', 'محمد عيدان']) {
      test('default transport sends exact project signup URL and $displayName',
          () async {
        final client = VellumClient(
            endpoint: 'https://example.test///',
            projectId: 'p',
            apiKey: 'pk_test',
            httpClient: MockClient((request) async {
              expect(request.url.toString(),
                  'https://example.test/v1/projects/p/auth/sign-up/email');
              expect(request.headers['x-vellum-api-key'], 'pk_test');
              final body = jsonDecode(request.body) as Map;
              expect(body['displayName'], displayName);
              expect(body.containsKey('name'), isFalse);
              return http.Response(jsonEncode(session()), 201,
                  headers: {'content-type': 'application/json; charset=utf-8'});
            }));
        final user = await client.auth.signUpWithEmailAndPassword(
            email: 'a@example.test',
            password: 'password',
            displayName: displayName);
        expect(user.id, 'user_1');
        client.dispose();
      });
    }
    test('clearCollection sends an empty JSON object', () async {
      final client = VellumClient(
          endpoint: 'https://example.test',
          projectId: 'p',
          apiKey: 'k',
          httpClient: MockClient((request) async {
            expect(request.url.path, '/v1/projects/p/collections/things/clear');
            expect(jsonDecode(request.body), isEmpty);
            return http.Response('{"deletedCount":0}', 200);
          }));
      await client.clearCollection('things');
      client.dispose();
    });
    test('non-JSON 405 has useful safe configuration advice', () async {
      final client = VellumClient(
          endpoint: 'https://example.test',
          projectId: 'p',
          apiKey: 'sk_private',
          httpClient: MockClient((request) async => http.Response('', 405)));
      await expectLater(
          client.auth.signUpWithEmailAndPassword(
              email: 'a@b.test', password: 'secret'),
          throwsA(isA<VellumException>()
              .having((e) => e.message, 'advice', contains('endpoint/baseUrl'))
              .having(
                  (e) => e.message, 'no key', isNot(contains('sk_private')))));
      client.dispose();
    });
  });
}
