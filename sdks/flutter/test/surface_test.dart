import 'dart:async';
import 'dart:convert';

import 'package:vellum_flutter/vellum_flutter.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:flutter_test/flutter_test.dart';

/// Builds a minimal EdDSA-shaped JWT so the SDK's `exp` reader can parse it.
String _jwt(Duration ttl) {
  final header = base64Url.encode(utf8.encode(jsonEncode(<String, dynamic>{
    'alg': 'EdDSA',
  })));
  final payload = base64Url.encode(utf8.encode(jsonEncode(<String, dynamic>{
    'sub': 'usr_1',
    'exp': DateTime.now().add(ttl).millisecondsSinceEpoch ~/ 1000,
  })));
  return '$header.$payload.signature';
}

// A getter regenerating from DateTime.now() flaked across second boundaries
// when a test compared a captured token against a fresh call. A lazy top-level
// final is computed once and shared by every test in the file.
final String _token = _jwt(const Duration(hours: 1));

Map<String, dynamic> _user({
  String displayName = 'Alice',
  bool emailVerified = false,
}) =>
    <String, dynamic>{
      'id': 'usr_1',
      'email': 'alice@example.com',
      'emailVerified': emailVerified,
      'displayName': displayName,
      'createdAt': '2026-11-17T00:00:00.000Z',
      'updatedAt': '2026-11-17T00:00:00.000Z',
    };

Map<String, dynamic> _session(String token) => <String, dynamic>{
      'user': _user(),
      'accessToken': token,
      'refreshToken': 'refresh_1',
      'tokenType': 'Bearer',
      'sessionId': 'sess_1',
      'expiresAt': '2026-11-17T01:00:00.000Z',
    };

Future<void> _pump() => Future<void>.delayed(Duration.zero);

HttpTransport _transport(
  Future<Object?> Function(String method, String url,
          Map<String, String> headers, Map<String, dynamic>? body)
      handler,
) =>
    handler;

void main() {
  group('Client configuration aliases', () {
    test(
        'baseUrl is used verbatim and realtimeEndpoint falls back to its origin',
        () async {
      final captured = <String>[];
      final client = VellumClient(
        baseUrl: 'https://api.example.test/v1/projects/p',
        projectId: 'p',
        apiKey: 'pk_test',
        httpClient: MockClient((http.Request request) async {
          captured.add(request.url.toString());
          return http.Response(
            jsonEncode(<String, dynamic>{'ok': true}),
            200,
            headers: <String, String>{'content-type': 'application/json'},
          );
        }),
      );

      expect(client.baseUrl, equals('https://api.example.test/v1/projects/p'));
      expect(client.realtimeEndpoint, equals('https://api.example.test'));

      final result = await client.request('GET', '/documents/users/u1');
      expect(result['ok'], isTrue);
      expect(
        captured.single,
        equals('https://api.example.test/v1/projects/p/documents/users/u1'),
      );
    });

    test('authStorage alias restores a persisted session', () async {
      final storage = InMemoryAuthTokenStorage();
      await storage.writeAccessToken(_token);
      await storage.writeRefreshToken('refresh_1');
      await storage.writeUser(_user());

      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'pk_test',
        authStorage: storage,
      );
      await client.auth.restore();

      expect(client.auth.currentUser?.id, equals('usr_1'));
      expect(client.auth.currentUser?.accessToken, equals(_token));
      client.auth.dispose();
    });

    test('endpoint still derives the canonical baseUrl', () {
      final client = VellumClient(
        endpoint: 'http://localhost:8080/',
        projectId: 'proj test',
        apiKey: 'k',
        httpTransport: _transport((m, u, h, b) async => <String, dynamic>{}),
      );
      expect(
        client.baseUrl,
        equals('http://localhost:8080/v1/projects/proj%20test'),
      );
    });
  });

  group('authStateChanges immediate emission', () {
    test('emits null to a new listener when signed out', () async {
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: _transport((m, u, h, b) async => <String, dynamic>{}),
      );
      final states = <VellumUser?>[];
      final sub = client.auth.authStateChanges.listen(states.add);
      // The initial event is delivered before `.listen()` returns.
      expect(states, hasLength(1));
      expect(states.single, isNull);
      await sub.cancel();
      client.auth.dispose();
    });

    test('emits the current user to a new listener after sign-in', () async {
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: _transport((m, u, h, b) async {
          if (u.endsWith('/auth/sign-up/email')) return _session(_token);
          return <String, dynamic>{};
        }),
      );
      await client.auth.signUpWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );

      final states = <VellumUser?>[];
      final sub = client.auth.authStateChanges.listen(states.add);
      expect(states.single?.id, equals('usr_1'));
      await sub.cancel();
      client.auth.dispose();
    });

    test('broadcasts each transition to every listener', () async {
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: _transport((m, u, h, b) async {
          if (u.endsWith('/auth/sign-up/email')) return _session(_token);
          return <String, dynamic>{};
        }),
      );
      final a = <VellumUser?>[];
      final b = <VellumUser?>[];
      final subA = client.auth.authStateChanges.listen(a.add);
      final subB = client.auth.authStateChanges.listen(b.add);
      await _pump();

      await client.auth.signUpWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );

      expect(a.map((u) => u?.id).toList(), equals(<String?>[null, 'usr_1']));
      expect(b.map((u) => u?.id).toList(), equals(<String?>[null, 'usr_1']));
      await subA.cancel();
      await subB.cancel();
      client.auth.dispose();
    });

    test('token refresh emits an updated auth state', () async {
      final refreshed = _jwt(const Duration(hours: 2));
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: _transport((m, u, h, b) async {
          if (u.endsWith('/auth/sign-up/email')) return _session(_token);
          if (u.endsWith('/auth/token/refresh')) {
            return <String, dynamic>{
              'accessToken': refreshed,
              'refreshToken': 'refresh_2',
              'tokenType': 'Bearer',
              'sessionId': 'sess_2',
              'expiresAt': '2026-11-17T02:00:00.000Z',
            };
          }
          return <String, dynamic>{};
        }),
      );
      await client.auth.signUpWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );

      final states = <VellumUser?>[];
      final sub = client.auth.authStateChanges.listen(states.add);
      await _pump();
      await client.auth.getIdToken(forceRefresh: true);

      expect(states, hasLength(2));
      expect(states[0]?.accessToken, equals(_token));
      expect(states[1]?.accessToken, equals(refreshed));
      await sub.cancel();
      client.auth.dispose();
    });
  });

  group('Sign-out modes', () {
    test(
        'signOut(allSessions: true) omits the refresh token and uses the bearer',
        () async {
      final bodies = <Map<String, dynamic>?>[];
      final headers = <Map<String, String>>[];
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: _transport((m, u, h, b) async {
          if (u.endsWith('/auth/sign-up/email')) return _session(_token);
          if (u.endsWith('/auth/sign-out')) {
            bodies.add(b);
            headers.add(Map<String, String>.from(h));
            return <String, dynamic>{'success': true};
          }
          return <String, dynamic>{};
        }),
      );
      await client.auth.signUpWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );

      final states = <VellumUser?>[];
      final sub = client.auth.authStateChanges.listen(states.add);
      await _pump();
      await client.auth.signOut(allSessions: true);

      expect(bodies.single, isEmpty);
      expect(headers.single['Authorization'], equals('Bearer $_token'));
      expect(client.auth.currentUser, isNull);
      expect(states.last, isNull);
      await sub.cancel();
      client.auth.dispose();
    });

    test('default signOut revokes only the current session without a bearer',
        () async {
      final bodies = <Map<String, dynamic>?>[];
      final headers = <Map<String, String>>[];
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: _transport((m, u, h, b) async {
          if (u.endsWith('/auth/sign-up/email')) return _session(_token);
          if (u.endsWith('/auth/sign-out')) {
            bodies.add(b);
            headers.add(Map<String, String>.from(h));
            return <String, dynamic>{'success': true};
          }
          return <String, dynamic>{};
        }),
      );
      await client.auth.signUpWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );
      await client.auth.signOut();

      expect(bodies.single?['refreshToken'], equals('refresh_1'));
      expect(headers.single.containsKey('Authorization'), isFalse);
      expect(client.auth.currentUser, isNull);
      client.auth.dispose();
    });
  });

  group('Profile and token endpoints', () {
    test('getUser fetches GET /auth/user and preserves token material',
        () async {
      final urls = <String>[];
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: _transport((m, u, h, b) async {
          if (u.endsWith('/auth/sign-up/email')) return _session(_token);
          if (u.endsWith('/auth/user')) {
            urls.add('$m $u');
            return <String, dynamic>{
              'user': _user(displayName: 'Grace', emailVerified: true),
            };
          }
          return <String, dynamic>{};
        }),
      );
      await client.auth.signUpWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );

      final user = await client.auth.getUser();
      expect(user.displayName, equals('Grace'));
      expect(user.emailVerified, isTrue);
      expect(user.accessToken, equals(_token));
      expect(user.refreshToken, equals('refresh_1'));
      expect(client.auth.currentUser?.displayName, equals('Grace'));
      expect(urls.single, endsWith('/auth/user'));
      client.auth.dispose();
    });

    test('confirmEmailVerification(token) updates the signed-in user',
        () async {
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: _transport((m, u, h, b) async {
          if (u.endsWith('/auth/sign-up/email')) return _session(_token);
          if (u.endsWith('/auth/email/verify/confirm')) {
            expect(b?['token'], equals('tok_1'));
            return <String, dynamic>{
              'success': true,
              'user': _user(emailVerified: true),
            };
          }
          return <String, dynamic>{};
        }),
      );
      await client.auth.signUpWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );

      await client.auth.confirmEmailVerification('tok_1');
      expect(client.auth.currentUser?.emailVerified, isTrue);
      client.auth.dispose();
    });

    test('sendPasswordResetEmail(email) posts the email positionally',
        () async {
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: _transport((m, u, h, b) async {
          if (u.endsWith('/auth/password/reset')) {
            expect(b?['email'], equals('alice@example.com'));
            return <String, dynamic>{'success': true, 'sent': true};
          }
          return <String, dynamic>{};
        }),
      );
      final result =
          await client.auth.sendPasswordResetEmail('alice@example.com');
      expect(result.success, isTrue);
      client.auth.dispose();
    });

    test(
        'updateProfile(password:) never forwards password to the v1 patch endpoint',
        () async {
      Map<String, dynamic>? capturedBody;
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: _transport((m, u, h, b) async {
          if (u.endsWith('/auth/sign-up/email')) return _session(_token);
          if (u.endsWith('/auth/user')) {
            capturedBody = b;
            return <String, dynamic>{
              'user': _user(displayName: 'Grace'),
            };
          }
          return <String, dynamic>{};
        }),
      );
      await client.auth.signUpWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );
      await client.auth
          .updateProfile(displayName: 'Grace', password: 'new-secret');

      expect(capturedBody?['displayName'], equals('Grace'));
      expect(capturedBody?.containsKey('password'), isFalse);
      expect(client.auth.currentUser?.displayName, equals('Grace'));
      client.auth.dispose();
    });
  });

  group('Reactive 401 replay', () {
    test('forces exactly one refresh and replays the request once', () async {
      final issued = _token;
      final refreshed = _jwt(const Duration(hours: 2));
      var refreshCalls = 0;
      var documentAttempts = 0;
      final headers = <Map<String, String>>[];
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: _transport((m, u, h, b) async {
          if (u.endsWith('/auth/sign-up/email')) return _session(issued);
          if (u.endsWith('/auth/token/refresh')) {
            refreshCalls++;
            return <String, dynamic>{
              'accessToken': refreshed,
              'refreshToken': 'refresh_2',
              'tokenType': 'Bearer',
              'sessionId': 'sess_2',
              'expiresAt': '2026-11-17T02:00:00.000Z',
            };
          }
          if (u.contains('/documents/')) {
            documentAttempts++;
            headers.add(Map<String, String>.from(h));
            if (documentAttempts == 1) {
              throw const VellumException(
                code: 'TOKEN_EXPIRED',
                message: 'Session token expired',
                statusCode: 401,
              );
            }
            return <String, dynamic>{
              'documentId': 'u1',
              'path': 'users/u1',
              'version': 1,
              'data': <String, dynamic>{'name': 'Ada'},
            };
          }
          return <String, dynamic>{};
        }),
      );
      await client.auth.signUpWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );

      final snap = await client.getDoc('users/u1');
      expect(snap.data()?['name'], equals('Ada'));
      expect(refreshCalls, equals(1));
      expect(documentAttempts, equals(2));
      expect(headers[0]['Authorization'], equals('Bearer $issued'));
      expect(headers[1]['Authorization'], equals('Bearer $refreshed'));
      client.auth.dispose();
    });
  });

  group('Document operation aliases', () {
    test('setDoc/getDoc/updateDoc/deleteDoc hit the canonical endpoints',
        () async {
      final calls = <String>[];
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: _transport((m, u, h, b) async {
          calls.add('$m ${u.split('/v1/projects/p').last}');
          if (m == 'GET') {
            return <String, dynamic>{
              'documentId': 'u1',
              'path': 'users/u1',
              'version': 1,
              'data': <String, dynamic>{'name': 'Ada'},
            };
          }
          return <String, dynamic>{};
        }),
      );

      await client.setDoc('users/u1', <String, dynamic>{'name': 'Ada'},
          merge: true);
      final snap = await client.getDoc('users/u1');
      await client.updateDoc('users/u1', <String, dynamic>{'name': 'Grace'});
      await client.deleteDoc('users/u1');

      expect(
          calls,
          equals(<String>[
            'PUT /documents/users/u1',
            'GET /documents/users/u1',
            'PATCH /documents/users/u1',
            'DELETE /documents/users/u1',
          ]));
      expect(snap.data()?['name'], equals('Ada'));
    });

    test('batchWrite posts the writes array', () async {
      Map<String, dynamic>? captured;
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: _transport((m, u, h, b) async {
          if (u.endsWith('/batchWrite')) {
            captured = b;
            return <String, dynamic>{'writeResults': <dynamic>[]};
          }
          return <String, dynamic>{};
        }),
      );
      final writes = <Map<String, dynamic>>[
        <String, dynamic>{
          'type': 'set',
          'path': 'users/u1',
          'data': <String, dynamic>{'name': 'Ada'},
        },
      ];
      await client.batchWrite(writes);
      expect(captured?['writes'], equals(writes));
    });

    test('watch accessors expose typed realtime streams', () {
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: _transport((m, u, h, b) async => <String, dynamic>{}),
      );
      expect(client.watchDocument('users/u1'), isA<Stream<Object>>());
      expect(client.watchCollection('users'), isA<Stream<Object>>());
    });
  });

  group('query() argument normalization', () {
    final client = VellumClient(
      endpoint: 'http://localhost:8080',
      projectId: 'p',
      apiKey: 'k',
      httpTransport: _transport((m, u, h, b) async => <String, dynamic>{}),
    );

    test('accepts structured where/orderBy clauses plus limit and cursor', () {
      final spec = client
          .query(
            'orders',
            where: <Object?>[
              <String, dynamic>{'field': 'status', 'op': '==', 'value': 'open'},
              <String, dynamic>{'field': 'amount', 'op': '>=', 'value': 50},
            ],
            orderBy: <Object?>[
              <String, dynamic>{'field': 'createdAt', 'dir': 'desc'},
            ],
            limit: 25,
            cursor: 'cur_abc',
          )
          .toQuerySpec();

      expect(spec['collectionPath'], equals('orders'));
      expect(
          spec['where'],
          equals(<Map<String, dynamic>>[
            <String, dynamic>{'field': 'status', 'op': '==', 'value': 'open'},
            <String, dynamic>{'field': 'amount', 'op': '>=', 'value': 50},
          ]));
      expect(
          spec['orderBy'],
          equals(<Map<String, String>>[
            <String, String>{'field': 'createdAt', 'dir': 'desc'},
          ]));
      expect(spec['limit'], equals(25));
      expect(spec['startAfter'], equals('cur_abc'));
    });

    test('accepts equality-map and bare-field shorthand', () {
      final spec = client
          .query(
            'users',
            where: <String, dynamic>{'status': 'active'},
            orderBy: 'createdAt',
          )
          .toQuerySpec();

      expect(
          spec['where'],
          equals(<Map<String, dynamic>>[
            <String, dynamic>{'field': 'status', 'op': '==', 'value': 'active'},
          ]));
      expect(
          spec['orderBy'],
          equals(<Map<String, String>>[
            <String, String>{'field': 'createdAt', 'dir': 'asc'},
          ]));
      expect(spec.containsKey('startAfter'), isFalse);
    });
  });
}
