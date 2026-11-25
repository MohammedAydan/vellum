import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/src/oauth_launcher/loopback_io.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

VellumClient _client(
  Future<Map<String, dynamic>> Function(String method, String url, Map<String, Object?>? body) handler, {
  DocumentCacheStore? cacheStore,
}) =>
    VellumClient(
      endpoint: 'http://localhost:8080',
      projectId: 'p',
      apiKey: 'pk_test',
      cacheStore: cacheStore,
      httpTransport: (method, url, headers, body) => handler(method, url, body),
    );

void main() {
  group('signInWithOAuth', () {
    test('returns VellumMfaRequired and stores no session', () async {
      final client = _client((m, url, body) async {
        if (url.endsWith('/auth/sign-in/provider')) {
          return <String, dynamic>{
            'mfaRequired': true,
            'mfaTicket': 'mfa_1',
            'factors': <String>['totp'],
            'expiresAt': '2026-11-17T00:05:00.000Z',
          };
        }
        return <String, dynamic>{};
      });
      final result = await client.auth.signInWithOAuth(provider: 'google', idToken: 'x');
      expect(result, isA<VellumMfaRequired>());
      expect((result as VellumMfaRequired).mfaTicket, 'mfa_1');
      expect(result.factors, <String>['totp']);
      expect(client.auth.currentUser, isNull);
      expect(await client.auth.getIdToken(), isNull);
      client.auth.dispose();
    });
  });

  group('transactions', () {
    test('get on a missing document is an exists:false snapshot, create stages a create write', () async {
      Map<String, Object?>? commitBody;
      final client = _client((m, url, body) async {
        if (url.endsWith('/transactions:begin')) return <String, dynamic>{'transactionToken': 'tok'};
        if (url.endsWith('/transactions:commit')) {
          commitBody = body;
          return <String, dynamic>{'status': 'committed'};
        }
        if (m == 'GET') {
          throw const VellumException(code: 'NOT_FOUND', message: 'nope', statusCode: 404);
        }
        return <String, dynamic>{};
      });
      final created = await client.runTransaction((tx) async {
        final ref = client.collection('users').doc('u1');
        final snap = await tx.get(ref);
        expect(snap.exists, isFalse);
        expect(snap.data(), isNull);
        expect(snap.id, 'u1');
        expect(snap.path, 'users/u1');
        expect(snap.version, 0);
        tx.create(ref, <String, Object?>{'name': 'A'});
        return true;
      });
      expect(created, isTrue);
      final writes = commitBody?['writes'] as List;
      expect(writes.single, <String, Object?>{
        'type': 'create',
        'path': 'users/u1',
        'data': <String, Object?>{'name': 'A'},
      });
    });

    test('other read errors still throw', () async {
      final client = _client((m, url, body) async {
        if (url.endsWith('/transactions:begin')) return <String, dynamic>{'transactionToken': 'tok'};
        if (m == 'GET') {
          throw const VellumException(code: 'PERMISSION_DENIED', message: 'no', statusCode: 403);
        }
        return <String, dynamic>{};
      });
      await expectLater(
        client.runTransaction((tx) => tx.get(client.collection('users').doc('u1'))),
        throwsA(isA<VellumException>().having((e) => e.code, 'code', 'PERMISSION_DENIED')),
      );
    });

    test('the cache is empty as soon as runTransaction returns', () async {
      final store = MemoryDocumentCacheStore();
      await store.set(
        'users/u1',
        CachedDocument(path: 'users/u1', value: <String, Object?>{'a': 1}, storedAt: DateTime.now()),
      );
      final client = _client((m, url, body) async {
        if (url.endsWith('/transactions:begin')) return <String, dynamic>{'transactionToken': 'tok'};
        return <String, dynamic>{'status': 'committed'};
      }, cacheStore: store);
      await client.runTransaction((tx) async {
        tx.set(client.collection('users').doc('u1'), <String, Object?>{'a': 2});
      });
      expect(await store.get('users/u1'), isNull);
    });
  });

  group('loopback with port 0', () {
    test('binds a free port and reports it in the redirect', () async {
      final listener = await bindLoopbackListener(Uri.parse('http://127.0.0.1:0/callback'));
      try {
        expect(listener.redirect.port, greaterThan(0));
        final port = listener.redirect.port;
        final result = listener.wait(() async {
          final c = HttpClient();
          final req = await c.getUrl(Uri.parse('http://127.0.0.1:$port/callback?vellum_code=abc&state=s'));
          await (await req.close()).drain<void>();
          c.close();
        }, const Duration(seconds: 10));
        final returned = Uri.parse(await result);
        expect(returned.port, port);
        expect(returned.queryParameters['vellum_code'], 'abc');
      } finally {
        await listener.close();
      }
    });

    test('VellumOAuth sends the real port to the API and closes the listener', () async {
      String? sentRedirect;
      late VellumClient client;
      client = _client((m, url, body) async {
        if (url.endsWith('/auth/oauth/google/start')) {
          sentRedirect = body?['redirectUri'] as String?;
          return <String, dynamic>{'authorizeUrl': 'https://accounts.google.com/auth'};
        }
        return <String, dynamic>{};
      });
      VellumOAuthSession? made;
      var closed = false;
      final oauth = VellumOAuth(
        auth: client.auth,
        redirectUri: 'http://127.0.0.1:0/callback',
        launcher: (u, s) => Future<String>.error(StateError('unused')),
        sessionFactory: () async {
          final listener = await bindLoopbackListener(Uri.parse('http://127.0.0.1:0/callback'));
          return made = VellumOAuthSession(
            redirectUri: listener.redirect.toString(),
            launcher: (u, s) async => 'http://127.0.0.1/callback?error=access_denied',
            close: () async {
              closed = true;
              await listener.close();
            },
          );
        },
      );
      await expectLater(
        oauth.signIn('google'),
        throwsA(isA<VellumException>().having((e) => e.code, 'code', 'PERMISSION_DENIED')),
      );
      expect(Uri.parse(sentRedirect!).port, greaterThan(0));
      expect(sentRedirect, made!.redirectUri);
      expect(closed, isTrue);
      client.auth.dispose();
    });

    test('systemBrowserLauncher refuses port 0 and createVellumOAuth accepts it', () {
      expect(() => systemBrowserLauncher(redirectUri: 'http://127.0.0.1:0/callback'), throwsArgumentError);
      final client = _client((m, url, body) async => <String, dynamic>{});
      final oauth = createVellumOAuth(auth: client.auth, redirectUri: 'http://127.0.0.1:0/callback');
      expect(oauth.sessionFactory, isNotNull);
      client.auth.dispose();
    });
  });
}
