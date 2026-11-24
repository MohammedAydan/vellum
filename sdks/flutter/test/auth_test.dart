import 'dart:convert';
import 'dart:io';

import 'package:vellum_flutter/vellum_flutter.dart';
import 'package:flutter_test/flutter_test.dart';

String _jwt(Map<String, dynamic> payload) {
  final header = base64Url.encode(utf8.encode(jsonEncode(<String, dynamic>{'alg': 'EdDSA'})));
  final body = base64Url.encode(utf8.encode(jsonEncode(payload)));
  return '$header.$body.signature';
}

final String _futureToken = _jwt(<String, dynamic>{
  'sub': 'usr_1',
  'exp': DateTime.now().add(const Duration(hours: 1)).millisecondsSinceEpoch ~/ 1000,
});

Map<String, dynamic> _user() => <String, dynamic>{
      'id': 'usr_1',
      'email': 'alice@example.com',
      'emailVerified': false,
      'displayName': 'Alice',
      'photoUrl': null,
      'phoneNumber': null,
      'phoneVerified': false,
      'isDisabled': false,
      'isAnonymous': false,
      'customClaims': <String, dynamic>{},
      'metadata': <String, dynamic>{},
      'createdAt': '2026-11-17T00:00:00.000Z',
      'updatedAt': '2026-11-17T00:00:00.000Z',
      'lastSignInAt': null,
    };

Map<String, dynamic> _session(String token, {String refreshToken = 'refresh_1'}) =>
    <String, dynamic>{
      'user': _user(),
      'accessToken': token,
      'refreshToken': refreshToken,
      'tokenType': 'Bearer',
      'sessionId': 'sess_1',
      'expiresAt': '2026-11-17T01:00:00.000Z',
    };

void main() {
  defaultStorageHookTests();
  group('VellumAuth state', () {
    test('sign-up emits a user and sets currentUser', () async {
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'pk_test',
        httpTransport: (method, url, headers, body) async {
          if (url.endsWith('/auth/sign-up/email')) return _session(_futureToken);
          return <String, dynamic>{};
        },
      );
      final states = <VellumUser?>[];
      final subscription = client.auth.authStateChanges.listen(states.add);

      final user = await client.auth.signUpWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );

      expect(user.id, equals('usr_1'));
      expect(user.accessToken, equals(_futureToken));
      expect(client.auth.currentUser?.id, equals('usr_1'));
      // authStateChanges emits the current state immediately on listen (null
      // here), then every transition — including this sign-in.
      expect(states, hasLength(2));
      expect(states.first, isNull);
      expect(states.last?.id, equals('usr_1'));

      await subscription.cancel();
      client.auth.dispose();
    });

    test('MFA-required sign-in does not set currentUser', () async {
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'pk_test',
        httpTransport: (method, url, headers, body) async {
          if (url.endsWith('/auth/sign-in/email')) {
            return <String, dynamic>{
              'mfaRequired': true,
              'mfaTicket': 'mfa_ticket_1',
              'factors': <String>['totp'],
              'expiresAt': '2026-11-17T00:05:00.000Z',
            };
          }
          return <String, dynamic>{};
        },
      );

      final result = await client.auth.signInWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );

      expect(result, isA<VellumMfaRequired>());
      expect((result as VellumMfaRequired).mfaTicket, equals('mfa_ticket_1'));
      expect(client.auth.currentUser, isNull);
      expect(await client.auth.getIdToken(), isNull);
      client.auth.dispose();
    });

    test('concurrent forced refreshes share one in-flight request', () async {
      var refreshCalls = 0;
      final refreshed = _jwt(<String, dynamic>{
        'sub': 'usr_1',
        'exp': DateTime.now().add(const Duration(hours: 2)).millisecondsSinceEpoch ~/ 1000,
      });
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'pk_test',
        httpTransport: (method, url, headers, body) async {
          if (url.endsWith('/auth/sign-up/email')) return _session(_futureToken);
          if (url.endsWith('/auth/token/refresh')) {
            refreshCalls++;
            return <String, dynamic>{
              'accessToken': refreshed,
              'refreshToken': 'refresh_2',
              'tokenType': 'Bearer',
              'sessionId': 'sess_2',
              'expiresAt': '2026-11-17T02:00:00.000Z',
            };
          }
          return <String, dynamic>{};
        },
      );
      await client.auth.signUpWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );

      final tokens = await Future.wait<String?>([
        client.auth.getIdToken(forceRefresh: true),
        client.auth.getIdToken(forceRefresh: true),
        client.auth.getIdToken(forceRefresh: true),
      ]);

      expect(refreshCalls, equals(1));
      expect(tokens, everyElement(equals(refreshed)));
      client.auth.dispose();
    });
  });

  group('Automatic bearer injection', () {
    test('document requests carry the signed-in bearer token and both API key headers', () async {
      final captured = <Map<String, String>>[];
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'pk_test',
        httpTransport: (method, url, headers, body) async {
          captured.add(Map<String, String>.from(headers));
          if (url.endsWith('/auth/sign-up/email')) return _session(_futureToken);
          if (url.contains('/documents/')) {
            return <String, dynamic>{
              'documentId': 'u1',
              'path': 'users/u1',
              'version': 1,
              'data': <String, dynamic>{'name': 'Ada'},
            };
          }
          return <String, dynamic>{};
        },
      );
      await client.auth.signUpWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );
      await client.collection('users').doc('u1').get();

      final documentHeaders = captured.last;
      expect(documentHeaders['Authorization'], equals('Bearer $_futureToken'));
      expect(documentHeaders['x-vellum-api-key'], equals('pk_test'));
      expect(documentHeaders['X-Project-Key'], equals('pk_test'));
      client.auth.dispose();
    });
  });

  group('Silent session refresh', () {
    test('pre-flight refreshes a token expiring within 60 s before a REST call', () async {
      final expiring = _jwt(<String, dynamic>{
        'sub': 'usr_1',
        'exp': DateTime.now().add(const Duration(seconds: 20)).millisecondsSinceEpoch ~/ 1000,
      });
      final refreshed = _jwt(<String, dynamic>{
        'sub': 'usr_1',
        'exp': DateTime.now().add(const Duration(hours: 2)).millisecondsSinceEpoch ~/ 1000,
      });
      var refreshCalls = 0;
      final documentHeaders = <Map<String, String>>[];
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'pk_test',
        httpTransport: (method, url, headers, body) async {
          if (url.endsWith('/auth/sign-up/email')) return _session(expiring);
          if (url.endsWith('/auth/token/refresh')) {
            refreshCalls++;
            return _session(refreshed, refreshToken: 'refresh_2');
          }
          if (url.contains('/documents/')) {
            documentHeaders.add(Map<String, String>.from(headers));
            return <String, dynamic>{
              'documentId': 'u1',
              'path': 'users/u1',
              'version': 1,
              'data': <String, dynamic>{'name': 'Ada'},
            };
          }
          return <String, dynamic>{};
        },
      );
      await client.auth.signUpWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );
      await client.collection('users').doc('u1').get();

      expect(refreshCalls, greaterThanOrEqualTo(1));
      expect(documentHeaders, hasLength(1));
      expect(documentHeaders.single['Authorization'], equals('Bearer $refreshed'));
      client.auth.dispose();
    });

    test('a 401 forces exactly one refresh and replays the request once', () async {
      final refreshed = _jwt(<String, dynamic>{
        'sub': 'usr_1',
        'exp': DateTime.now().add(const Duration(hours: 2)).millisecondsSinceEpoch ~/ 1000,
      });
      var refreshCalls = 0;
      var documentAttempts = 0;
      final documentHeaders = <Map<String, String>>[];
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'pk_test',
        httpTransport: (method, url, headers, body) async {
          if (url.endsWith('/auth/sign-up/email')) return _session(_futureToken);
          if (url.endsWith('/auth/token/refresh')) {
            refreshCalls++;
            return _session(refreshed, refreshToken: 'refresh_2');
          }
          if (url.contains('/documents/')) {
            documentAttempts++;
            documentHeaders.add(Map<String, String>.from(headers));
            if (documentAttempts == 1) {
              throw const VellumException(
                code: 'TOKEN_EXPIRED',
                message: 'Invalid, expired, or revoked session token',
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
        },
      );
      await client.auth.signUpWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );

      final snap = await client.collection('users').doc('u1').get();

      expect(snap.data()?['name'], equals('Ada'));
      expect(refreshCalls, equals(1));
      expect(documentAttempts, equals(2));
      expect(documentHeaders[0]['Authorization'], equals('Bearer $_futureToken'));
      expect(documentHeaders[1]['Authorization'], equals('Bearer $refreshed'));
      client.auth.dispose();
    });
  });

  group('defaultHttpTransport JSON shapes', () {
    late HttpServer server;

    setUpAll(() async {
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((request) {
        final path = request.uri.path;
        if (path == '/array') {
          request.response
            ..headers.contentType = ContentType.json
            ..write(jsonEncode(<Map<String, dynamic>>[
              {'id': 'key_1'},
              {'id': 'key_2'},
            ]));
        } else if (path == '/scalar') {
          request.response
            ..headers.contentType = ContentType.json
            ..write('42');
        } else if (path == '/error') {
          request.response
            ..statusCode = 400
            ..headers.contentType = ContentType.json
            ..write(jsonEncode(<String, dynamic>{
              'error': <String, dynamic>{'code': 'INVALID_ARGUMENT', 'message': 'bad request'},
            }));
        }
        // '/empty' intentionally writes no body.
        request.response.close();
      });
    });

    tearDownAll(() async {
      await server.close();
    });

    String urlFor(String path) =>
        'http://${server.address.host}:${server.port}$path';

    test('returns arrays without throwing and coerces them to an empty map', () async {
      final decoded = await defaultHttpTransport('GET', urlFor('/array'), <String, String>{}, null);
      expect(decoded, isA<List<Object?>>());
      expect((decoded as List<Object?>).length, equals(2));
      expect(asStringDynamicMap(decoded), isEmpty);
    });

    test('handles scalar and empty bodies', () async {
      final scalar = await defaultHttpTransport('GET', urlFor('/scalar'), <String, String>{}, null);
      expect(scalar, equals(42));
      expect(asStringDynamicMap(scalar), isEmpty);

      final empty = await defaultHttpTransport('GET', urlFor('/empty'), <String, String>{}, null);
      expect(empty, isNull);
      expect(asStringDynamicMap(empty), isEmpty);
    });

    test('maps error payloads into VellumException', () async {
      expect(
        defaultHttpTransport('GET', urlFor('/error'), <String, String>{}, null),
        throwsA(isA<VellumException>().having((error) => error.code, 'code', equals('INVALID_ARGUMENT'))),
      );
    });
  });
}

void defaultStorageHookTests() {
  group('VellumDefaults.authStorageFactory', () {
    tearDown(() => VellumDefaults.authStorageFactory = null);

    test('is used when no storage is passed', () {
      final custom = InMemoryAuthTokenStorage();
      VellumDefaults.authStorageFactory = () => custom;
      final client = VellumClient(
          baseUrl: 'http://localhost:8080/v1/projects/p',
          projectId: 'p',
          apiKey: 'k');
      expect(identical(client.authTokenStorage, custom), isTrue);
    });

    test('an explicit storage wins and a throwing factory falls back', () {
      final explicit = InMemoryAuthTokenStorage();
      VellumDefaults.authStorageFactory = () => throw StateError('boom');
      final fallback = VellumClient(
          baseUrl: 'http://localhost:8080/v1/projects/p',
          projectId: 'p',
          apiKey: 'k');
      expect(fallback.authTokenStorage, isA<InMemoryAuthTokenStorage>());
      final withExplicit = VellumClient(
          baseUrl: 'http://localhost:8080/v1/projects/p',
          projectId: 'p',
          apiKey: 'k',
          authStorage: explicit);
      expect(identical(withExplicit.authTokenStorage, explicit), isTrue);
    });
  });
}
