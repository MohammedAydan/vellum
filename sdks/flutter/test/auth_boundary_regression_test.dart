import 'dart:async';

import 'package:test/test.dart';
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
  group('strict session responses', () {
    for (final field in [
      'user',
      'accessToken',
      'refreshToken',
      'sessionId',
      'expiresAt'
    ]) {
      test('rejects absent $field without changing auth state', () async {
        final payload = session()..remove(field);
        final client = VellumClient(
            endpoint: 'https://example.test',
            projectId: 'p',
            apiKey: 'k',
            httpTransport: (m, u, h, b) async => payload);
        await expectLater(
            client.auth.signUpWithEmailAndPassword(
                email: 'a@b.test', password: 'password'),
            invalid('INVALID_AUTH_RESPONSE'));
        expect(client.auth.currentUser, isNull);
        client.dispose();
      });
    }
    test('rejects empty identity and malformed expiry', () {
      for (final payload in [
        session()..['user'] = <String, Object?>{},
        session()..['expiresAt'] = 'tomorrow',
        session()..['accessToken'] = ' ',
        session()..['tokenType'] = 'Basic'
      ]) {
        expect(() => VellumUser.fromSession(payload),
            invalid('INVALID_AUTH_RESPONSE'));
      }
    });
    test('profile read and update cannot mask a missing user using local state',
        () async {
      final client = VellumClient(
          endpoint: 'https://example.test',
          projectId: 'p',
          apiKey: 'k',
          httpTransport: (m, u, h, b) async =>
              u.endsWith('/sign-up/email') ? session() : <String, Object?>{});
      await client.auth
          .signUpWithEmailAndPassword(email: 'a@b.test', password: 'password');
      await expectLater(
          client.auth.getUser(), invalid('INVALID_AUTH_RESPONSE'));
      await expectLater(client.auth.updateProfile(displayName: 'Valid'),
          invalid('INVALID_AUTH_RESPONSE'));
      expect(client.auth.currentUser?.id, 'user_1');
      client.dispose();
    });
  });
  group('auth response race protection', () {
    test('a delayed signup cannot restore a session after signout', () async {
      final response = Completer<JsonMap>();
      final client = VellumClient(
          endpoint: 'https://example.test',
          projectId: 'p',
          apiKey: 'k',
          httpTransport: (m, u, h, b) async => u.endsWith('/sign-up/email')
              ? response.future
              : <String, Object?>{});
      final pending = client.auth
          .signUpWithEmailAndPassword(email: 'a@b.test', password: 'password');
      final rejected = expectLater(pending, invalid('AUTH_STATE_CHANGED'));
      await client.auth.signOut();
      response.complete(session());
      await rejected;
      expect(client.auth.currentUser, isNull);
      client.dispose();
    });
    test('a delayed profile response cannot restore a signed-out user',
        () async {
      final response = Completer<JsonMap>();
      final client = VellumClient(
          endpoint: 'https://example.test',
          projectId: 'p',
          apiKey: 'k',
          httpTransport: (m, u, h, b) async => u.endsWith('/sign-up/email')
              ? session()
              : u.endsWith('/user')
                  ? response.future
                  : <String, Object?>{});
      await client.auth
          .signUpWithEmailAndPassword(email: 'a@b.test', password: 'password');
      final pending = client.auth.getUser();
      final rejected = expectLater(pending, invalid('AUTH_STATE_CHANGED'));
      await client.auth.signOut();
      response.complete({
        'user': {'id': 'user_1'}
      });
      await rejected;
      expect(client.auth.currentUser, isNull);
      client.dispose();
    });
  });
  group('auth-scoped cached snapshots', () {
    test('signout clears snapshots immediately, before its HTTP request ends',
        () async {
      final signout = Completer<JsonMap>();
      final client = VellumClient(
          endpoint: 'https://example.test',
          projectId: 'p',
          apiKey: 'k',
          httpTransport: (m, u, h, b) async =>
              u.endsWith('/sign-out') ? signout.future : session());
      await client.auth
          .signUpWithEmailAndPassword(email: 'a@b.test', password: 'password');
      client.setCachedDocument(
          'things/a',
          const DocumentSnapshot<JsonMap>(
              id: 'a', path: 'things/a', version: 1, data: {}));
      final pending = client.auth.signOut();
      expect(client.getCachedDocument('things/a'), isNull);
      signout.complete({});
      await pending;
      client.dispose();
    });
    test('a document read from an old epoch cannot repopulate cleared cache',
        () async {
      final read = Completer<JsonMap>();
      final client = VellumClient(
          endpoint: 'https://example.test',
          projectId: 'p',
          apiKey: 'k',
          httpTransport: (m, u, h, b) async =>
              u.contains('/documents/') ? read.future : <String, Object?>{});
      final pending = client.doc('things/a').get();
      await Future<void>.delayed(Duration.zero);
      await client.auth.signOut();
      read.complete({
        'documentId': 'a',
        'path': 'things/a',
        'version': 1,
        'data': <String, Object?>{}
      });
      await pending;
      expect(client.getCachedDocument('things/a'), isNull);
      client.dispose();
    });
  });
}
