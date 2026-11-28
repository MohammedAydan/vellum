import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:vellum_flutter/vellum_flutter.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

String _jwt(Duration ttl, {String sub = 'usr_1'}) {
  final header = base64Url.encode(
    utf8.encode(jsonEncode(<String, dynamic>{'alg': 'EdDSA'})),
  );
  final payload = base64Url.encode(
    utf8.encode(jsonEncode(<String, dynamic>{
      'sub': sub,
      'exp': DateTime.now().add(ttl).millisecondsSinceEpoch ~/ 1000,
    })),
  );
  return '$header.$payload.signature';
}

Map<String, dynamic> _sessionPayload(
  String accessToken, {
  String refreshToken = 'refresh_secret_1',
}) =>
    <String, dynamic>{
      'user': <String, dynamic>{
        'id': 'usr_1',
        'email': 'alice@example.com',
        'displayName': 'Alice',
      },
      'accessToken': accessToken,
      'refreshToken': refreshToken,
      'tokenType': 'Bearer',
      'sessionId': 'sess_1',
      'expiresAt': '2026-11-21T02:00:00.000Z',
    };

class _FakeWebSocketSink implements WebSocketSink {
  final List<String> sent = <String>[];
  final Completer<void> _done = Completer<void>();
  bool closed = false;

  @override
  void add(dynamic data) {
    sent.add(data.toString());
  }

  @override
  void addError(Object error, [StackTrace? stackTrace]) {}

  @override
  Future<dynamic> addStream(Stream<dynamic> stream) async {
    await for (final dynamic item in stream) {
      add(item);
    }
  }

  @override
  Future<dynamic> close([int? closeCode, String? closeReason]) async {
    closed = true;
    if (!_done.isCompleted) _done.complete();
  }

  @override
  Future<dynamic> get done => _done.future;
}

class _FakeWebSocketChannel implements WebSocketChannel {
  final StreamController<dynamic> incoming =
      StreamController<dynamic>.broadcast();
  final _FakeWebSocketSink fakeSink = _FakeWebSocketSink();
  final Completer<void> readyCompleter = Completer<void>()..complete();

  void pushFrame(Map<String, dynamic> frame) {
    if (!incoming.isClosed) {
      incoming.add(RealtimeFrames.encode(frame));
    }
  }

  Future<void> disconnect() async {
    if (!incoming.isClosed) {
      await incoming.close();
    }
  }

  @override
  Stream<dynamic> get stream => incoming.stream;

  @override
  WebSocketSink get sink => fakeSink;

  @override
  Future<void> get ready => readyCompleter.future;

  @override
  int? get closeCode => null;

  @override
  String? get closeReason => null;

  @override
  String? get protocol => null;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  group('Security: path traversal & URL injection protection', () {
    late VellumClient client;
    late List<String> capturedUrls;

    setUp(() {
      capturedUrls = <String>[];
      client = VellumClient(
        baseUrl: 'https://api.example.test/v1/projects/proj_1',
        projectId: 'proj_1',
        apiKey: 'pk_live_supersecret_999',
        maxRetries: 0,
        httpTransport: (method, url, headers, body) async {
          capturedUrls.add('$method $url');
          return <String, dynamic>{
            'documentId': 'doc 1',
            'path': 'users/doc 1',
            'version': 1,
            'data': <String, dynamic>{'ok': true},
          };
        },
      );
    });

    tearDown(() => client.dispose());

    test(
        'rejects traversal, encoded traversal, query/fragment, and control chars',
        () {
      const dangerousPaths = <String>[
        '.',
        '..',
        'users/..',
        'users/../secrets/s1',
        'users/%2e%2e/secrets/s1',
        'users/%2E%2E/secrets/s1',
        'users/u1?admin=true',
        'users/u1#fragment',
        r'users\u1',
        'users/u1\x00evil',
        'users/u1\r\nX-Injected: 1',
        'users//u1',
        '',
      ];

      for (final bad in dangerousPaths) {
        expect(
          () => client.doc(bad),
          throwsA(isA<VellumException>().having(
            (e) => e.code,
            'code',
            equals('INVALID_DOCUMENT_PATH'),
          )),
          reason: 'doc($bad) should be rejected',
        );
      }

      expect(
        () => client.collection('users').doc('../admin'),
        throwsA(isA<VellumException>()),
      );
      expect(
        () => client.collection('users').doc('a/b'),
        throwsA(isA<VellumException>()),
      );
      expect(
        () => client.doc('users/u1').collection('../secrets'),
        throwsA(isA<VellumException>()),
      );
      expect(
        () => client.collection('users/%2e%2e'),
        throwsA(isA<VellumException>()),
      );
    });

    test('URI-encodes safe special characters in document path segments',
        () async {
      await client.collection('users').doc('alice smith+1').get();
      expect(
        capturedUrls.single,
        equals(
            'GET https://api.example.test/v1/projects/proj_1/documents/users/alice%20smith%2B1'),
      );
    });
  });

  group('Security: safe token redaction in toString()', () {
    test('auth, session, client, and exception toString() never leak secrets',
        () {
      const secretAccess =
          'eyJhbGciOiJIUzI1' 'NiJ9.eyJzdWIiOiJ1MSJ9.secret_access_sig';
      const secretRefresh = 'rt_super_secret_refresh_token_123';
      const secretApiKey = 'pk_live_super_secret_api_key_456';
      const secretMfa = 'mfa_secret_ticket_789';
      const secretTotp = 'JBSWY3DPEHPK3PXP';
      const secretDevToken = 'dev_reset_token_abc';
      const secretTxToken = 'tx_secret_token_xyz';

      const user = VellumUser(
        id: 'usr_1',
        email: 'alice@example.com',
        accessToken: secretAccess,
        refreshToken: secretRefresh,
      );
      const session = VellumSession(user);
      const mfa = VellumMfaRequired(
        mfaTicket: secretMfa,
        factors: <String>['totp'],
        expiresAt: '2026-11-21T02:00:00.000Z',
      );
      const totp = TotpEnrollment(
        secret: secretTotp,
        otpauthUri: 'otpauth://totp/VELLUM:alice?secret=$secretTotp',
        recoveryCodes: <String>['CODE-1111', 'CODE-2222'],
      );
      const action = AuthActionResult(
        success: true,
        devToken: secretDevToken,
        expiresAt: '2026-11-21T02:00:00.000Z',
      );
      final storage = InMemoryAuthTokenStorage();
      final client = VellumClient(
        endpoint: 'https://api.example.test',
        projectId: 'proj_1',
        apiKey: secretApiKey,
        authStorage: storage,
      );
      final tx =
          TransactionContext(client: client, transactionToken: secretTxToken);
      const err = VellumException(
        code: 'UNAUTHORIZED',
        message: 'Rejected Bearer $secretAccess for key $secretApiKey',
        statusCode: 401,
      );

      expect(user.toString(), isNot(contains(secretAccess)));
      expect(user.toString(), isNot(contains(secretRefresh)));
      expect(session.toString(), isNot(contains(secretAccess)));
      expect(mfa.toString(), isNot(contains(secretMfa)));
      expect(totp.toString(), isNot(contains(secretTotp)));
      expect(totp.toString(), isNot(contains('CODE-1111')));
      expect(action.toString(), isNot(contains(secretDevToken)));
      expect(storage.toString(), isNot(contains(secretAccess)));
      expect(client.auth.toString(), isNot(contains(secretAccess)));
      expect(client.toString(), isNot(contains(secretApiKey)));
      expect(tx.toString(), isNot(contains(secretTxToken)));
      expect(err.toString(), isNot(contains(secretAccess)));
      expect(err.toString(), isNot(contains(secretApiKey)));

      client.dispose();
    });
  });

  group('Security: monotonic sessionEpoch guard', () {
    test('in-flight refresh cannot resurrect a session after signOut()',
        () async {
      final refreshGate = Completer<Map<String, dynamic>>();
      final token1 = _jwt(const Duration(hours: 1));
      final token2 = _jwt(const Duration(hours: 2));

      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'pk_test',
        maxRetries: 0,
        httpTransport: (method, url, headers, body) async {
          if (url.endsWith('/auth/sign-up/email')) {
            return _sessionPayload(token1);
          }
          if (url.endsWith('/auth/token/refresh')) {
            return refreshGate.future;
          }
          if (url.endsWith('/auth/sign-out')) {
            return <String, dynamic>{'success': true};
          }
          return <String, dynamic>{};
        },
      );

      await client.auth.signUpWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );
      final epochAfterSignIn = client.auth.sessionEpoch;

      // Start an in-flight refresh, then sign out before it resolves.
      final refreshFuture = client.auth.getIdToken(forceRefresh: true);
      await client.auth.signOut();
      expect(client.auth.sessionEpoch, greaterThan(epochAfterSignIn));
      expect(client.auth.currentUser, isNull);

      // Now let the stale refresh response arrive.
      refreshGate.complete(_sessionPayload(token2, refreshToken: 'refresh_2'));
      final tokenResult = await refreshFuture;

      expect(tokenResult, isNull);
      expect(client.auth.currentUser, isNull);
      expect(await client.auth.storage.readAccessToken(), isNull);
      client.dispose();
    });

    test('in-flight refresh cannot resurrect a session after dispose()',
        () async {
      final refreshGate = Completer<Map<String, dynamic>>();
      final token1 = _jwt(const Duration(hours: 1));
      final token2 = _jwt(const Duration(hours: 2));

      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'pk_test',
        maxRetries: 0,
        httpTransport: (method, url, headers, body) async {
          if (url.endsWith('/auth/sign-up/email')) {
            return _sessionPayload(token1);
          }
          if (url.endsWith('/auth/token/refresh')) {
            return refreshGate.future;
          }
          return <String, dynamic>{};
        },
      );

      await client.auth.signUpWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );

      final refreshFuture = client.auth.getIdToken(forceRefresh: true);
      client.dispose();

      refreshGate.complete(_sessionPayload(token2, refreshToken: 'refresh_2'));
      expect(await refreshFuture, isNull);
      expect(client.auth.currentUser?.accessToken, isNot(equals(token2)));
    });
  });

  group('Resilience: timeout, retries, Retry-After, and write safety', () {
    test('throws structured REQUEST_TIMEOUT VellumException on timeout',
        () async {
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'pk_test',
        requestTimeout: const Duration(milliseconds: 25),
        maxRetries: 0,
        httpTransport: (method, url, headers, body) async {
          await Future<void>.delayed(const Duration(milliseconds: 200));
          return <String, dynamic>{};
        },
      );

      await expectLater(
        client.getDoc('users/u1'),
        throwsA(isA<VellumException>()
            .having((e) => e.code, 'code', equals('REQUEST_TIMEOUT'))
            .having((e) => e.statusCode, 'statusCode', equals(408))),
      );
      client.dispose();
    });

    test(
        'retries safe reads (GET, POST /query, POST /documents:aggregate) on 429/5xx',
        () async {
      var getAttempts = 0;
      var queryAttempts = 0;
      var aggAttempts = 0;

      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'pk_test',
        maxRetries: 3,
        retryBaseDelay: const Duration(milliseconds: 1),
        retryMaxDelay: const Duration(milliseconds: 10),
        random: Random(7),
        httpTransport: (method, url, headers, body) async {
          if (method == 'GET' && url.endsWith('/documents/users/u1')) {
            getAttempts++;
            if (getAttempts < 3) {
              throw const VellumException(
                code: 'RATE_LIMITED',
                message: 'Too many requests',
                statusCode: 429,
                details: <String, dynamic>{'retryAfter': '0'},
              );
            }
            return <String, dynamic>{
              'documentId': 'u1',
              'path': 'users/u1',
              'version': 1,
              'data': <String, dynamic>{'name': 'Ada'},
            };
          }
          if (method == 'POST' && url.endsWith('/query')) {
            queryAttempts++;
            if (queryAttempts == 1) {
              throw const VellumException(
                code: 'UNAVAILABLE',
                message: 'Transient 503',
                statusCode: 503,
              );
            }
            return <String, dynamic>{'documents': <dynamic>[]};
          }
          if (method == 'POST' && url.endsWith('/documents:aggregate')) {
            aggAttempts++;
            if (aggAttempts == 1) {
              throw http.ClientException('connection reset');
            }
            return <String, dynamic>{
              'rows': <Map<String, dynamic>>[
                <String, dynamic>{'count': 5}
              ],
            };
          }
          return <String, dynamic>{};
        },
      );

      final snap = await client.getDoc('users/u1');
      final page = await client.collection('users').get();
      final count = await client.collection('users').count();

      expect(snap.data()?['name'], equals('Ada'));
      expect(getAttempts, equals(3));
      expect(page.docs, isEmpty);
      expect(queryAttempts, equals(2));
      expect(count, equals(5));
      expect(aggAttempts, equals(2));
      client.dispose();
    });

    test(
        'never retries writes without idempotencyKey, but retries writes with idempotencyKey',
        () async {
      var unsafePutAttempts = 0;
      var safePutAttempts = 0;
      String? capturedKey;

      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'pk_test',
        maxRetries: 2,
        retryBaseDelay: const Duration(milliseconds: 1),
        retryMaxDelay: const Duration(milliseconds: 5),
        httpTransport: (method, url, headers, body) async {
          if (url.endsWith('/documents/users/unsafe')) {
            unsafePutAttempts++;
            throw const VellumException(
              code: 'INTERNAL_ERROR',
              message: '500 boom',
              statusCode: 500,
            );
          }
          if (url.endsWith('/documents/users/safe')) {
            safePutAttempts++;
            capturedKey = headers['Idempotency-Key'];
            if (safePutAttempts == 1) {
              throw const VellumException(
                code: 'UNAVAILABLE',
                message: '503 boom',
                statusCode: 503,
              );
            }
            return <String, dynamic>{'ok': true};
          }
          return <String, dynamic>{};
        },
      );

      await expectLater(
        client.setDoc('users/unsafe', <String, dynamic>{'a': 1}),
        throwsA(isA<VellumException>()),
      );
      expect(unsafePutAttempts, equals(1));

      await client.setDoc(
        'users/safe',
        <String, dynamic>{'a': 1},
        idempotencyKey: 'idem-write-001',
      );
      expect(safePutAttempts, equals(2));
      expect(capturedKey, equals('idem-write-001'));
      client.dispose();
    });

    test('parseRetryAfterHeader handles delta-seconds and HTTP-date', () {
      expect(parseRetryAfterHeader('3'), equals(const Duration(seconds: 3)));
      expect(parseRetryAfterHeader('0'), equals(Duration.zero));
      expect(parseRetryAfterHeader('invalid'), isNull);

      final now = DateTime.utc(2026, 11, 21, 10, 0, 0);
      final parsed = parseRetryAfterHeader(
        'Sat, 21 Nov 2026 10:00:05 GMT',
        now: now,
      );
      expect(parsed, equals(const Duration(seconds: 5)));
    });

    test('httpClientTransport preserves Retry-After on 429 and retries cleanly',
        () async {
      var calls = 0;
      final client = VellumClient(
        baseUrl: 'https://api.example.test/v1/projects/p',
        projectId: 'p',
        apiKey: 'pk_test',
        maxRetries: 2,
        retryBaseDelay: const Duration(milliseconds: 1),
        retryMaxDelay: const Duration(milliseconds: 5),
        httpClient: MockClient((http.Request request) async {
          calls++;
          if (calls == 1) {
            return http.Response(
              jsonEncode(<String, dynamic>{
                'error': <String, dynamic>{
                  'code': 'RATE_LIMITED',
                  'message': 'Slow down',
                },
              }),
              429,
              headers: <String, String>{'retry-after': '0'},
            );
          }
          return http.Response(
            jsonEncode(<String, dynamic>{
              'documentId': 'u1',
              'path': 'users/u1',
              'version': 1,
              'data': <String, dynamic>{'name': 'Grace'},
            }),
            200,
          );
        }),
      );

      final snap = await client.getDoc('users/u1');
      expect(calls, equals(2));
      expect(snap.data()?['name'], equals('Grace'));
      client.dispose();
    });
  });

  group('Resilience: single-flight 401 refresh coalescing', () {
    test(
        'parallel 401 storm triggers exactly one refresh and replays all requests',
        () async {
      final token1 = _jwt(const Duration(hours: 1));
      final token2 = _jwt(const Duration(hours: 2));
      var refreshCalls = 0;
      final refreshGate = Completer<Map<String, dynamic>>();

      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'pk_test',
        maxRetries: 0,
        coalesceInFlightGets: false,
        httpTransport: (method, url, headers, body) async {
          if (url.endsWith('/auth/sign-up/email')) {
            return _sessionPayload(token1);
          }
          if (url.endsWith('/auth/token/refresh')) {
            refreshCalls++;
            return refreshGate.future;
          }
          if (headers['Authorization'] == 'Bearer $token1') {
            throw const VellumException(
              code: 'TOKEN_EXPIRED',
              message: 'Expired',
              statusCode: 401,
            );
          }
          final id = url.split('/').last;
          return <String, dynamic>{
            'documentId': id,
            'path': 'users/$id',
            'version': 1,
            'data': <String, dynamic>{'id': id},
          };
        },
      );

      await client.auth.signUpWithEmailAndPassword(
        email: 'alice@example.com',
        password: 'password123',
      );

      final futures = <Future<DocumentSnapshot<Map<String, dynamic>>>>[
        client.getDoc('users/u1'),
        client.getDoc('users/u2'),
        client.getDoc('users/u3'),
        client.getDoc('users/u4'),
        client.getDoc('users/u5'),
      ];

      await Future<void>.delayed(Duration.zero);
      refreshGate.complete(_sessionPayload(token2, refreshToken: 'refresh_2'));

      final snaps = await Future.wait(futures);
      expect(refreshCalls, equals(1));
      expect(snaps.map((s) => s.id).toList(),
          equals(<String>['u1', 'u2', 'u3', 'u4', 'u5']));
      client.dispose();
    });
  });

  group('Resilience: realtime WebSocket transport', () {
    test('decorrelated jitter stays within configured bounds', () {
      var prev = 500;
      final rng = Random(42);
      for (var i = 0; i < 20; i++) {
        final next = computeDecorrelatedJitterBackoffMs(
          prev,
          baseMs: 500,
          maxMs: 30000,
          random: rng,
        );
        expect(next, greaterThanOrEqualTo(500));
        expect(next, lessThanOrEqualTo(30000));
        prev = next;
      }
    });

    test(
        'tracks resumeSeqId across reconnects and bounds offline outbound queue',
        () async {
      final channels = <_FakeWebSocketChannel>[];
      final received = <Map<String, dynamic>>[];

      final transport = VellumRealtimeTransport(
        url: Uri.parse('wss://api.example.test/v1/realtime'),
        auth: () async => <String, dynamic>{'type': 'auth', 'projectId': 'p'},
        onFrame: received.add,
        channelFactory: (uri) {
          final ch = _FakeWebSocketChannel();
          channels.add(ch);
          return ch;
        },
        backoffMs: (_) => 5,
        maxOutboundQueueSize: 3,
      );

      // Enqueue more unsubscribes than maxOutboundQueueSize while offline.
      for (var i = 0; i < 6; i++) {
        transport.unsubscribe('stale_$i');
      }
      expect(transport.outboundQueueLength, equals(3));

      transport.subscribe('sub_1', <String, dynamic>{'path': 'users/u1'});
      await Future<void>.delayed(Duration.zero);
      expect(channels, hasLength(1));

      // Authenticate and deliver a mutation with string seqId.
      channels.first.pushFrame(<String, dynamic>{'type': 'auth_ack'});
      channels.first.pushFrame(<String, dynamic>{
        'type': 'mutation',
        'subId': 'sub_1',
        'seqId': '42',
        'document': <String, dynamic>{
          'path': 'users/u1',
          'documentId': 'u1',
          'version': 2,
          'data': <String, dynamic>{'name': 'Ada'},
        },
      });
      await Future<void>.delayed(Duration.zero);
      expect(transport.lastSeqIdFor('sub_1'), equals(42));
      expect(received, hasLength(1));

      // Simulate socket drop and verify reconnect sends resumeSeqId: 42.
      await channels.first.disconnect();
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(channels.length, greaterThanOrEqualTo(2));

      channels[1].pushFrame(<String, dynamic>{'type': 'auth_ack'});
      await Future<void>.delayed(Duration.zero);

      final resubFrames = channels[1]
          .fakeSink
          .sent
          .map((raw) => RealtimeFrames.decode(raw))
          .whereType<Map<String, dynamic>>()
          .where((f) => f['type'] == 'subscribe')
          .toList();
      expect(resubFrames, isNotEmpty);
      expect(resubFrames.last['resumeSeqId'], equals(42));

      transport.close();
      expect(transport.outboundQueueLength, equals(0));
    });

    test('any inbound frame counts as liveness, a silent socket does not',
        () async {
      final channels = <_FakeWebSocketChannel>[];
      final errors = <Object>[];
      final transport = VellumRealtimeTransport(
        url: Uri.parse('wss://api.example.test/v1/realtime'),
        auth: () async => <String, dynamic>{'type': 'auth', 'projectId': 'p'},
        onFrame: (_) {},
        onError: errors.add,
        channelFactory: (uri) {
          final ch = _FakeWebSocketChannel();
          channels.add(ch);
          return ch;
        },
        heartbeatInterval: const Duration(milliseconds: 15),
        pongTimeout: const Duration(milliseconds: 40),
        backoffMs: (_) => 10,
      );
      final connectFuture = transport.connect();
      await Future<void>.delayed(Duration.zero);
      channels.first.pushFrame(<String, dynamic>{'type': 'auth_ack'});
      await connectFuture;
      // Data frames (no pongs) every 10 ms for 120 ms: no reconnect.
      for (var i = 0; i < 12; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
        channels.first
            .pushFrame(<String, dynamic>{'type': 'mutation', 'subId': 'x'});
      }
      expect(channels, hasLength(1));
      expect(errors, isEmpty);
      // Then silence: detected and reconnected.
      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(errors.whereType<TimeoutException>(), isNotEmpty);
      expect(channels.length, greaterThanOrEqualTo(2));
      transport.close();
    });

    test('default heartbeat detects a dead socket within about 50 seconds', () {
      final t = VellumRealtimeTransport(
        url: Uri.parse('wss://api.example.test/v1/realtime'),
        auth: () async => <String, dynamic>{},
        onFrame: (_) {},
      );
      expect(t.heartbeatInterval + t.pongTimeout,
          lessThanOrEqualTo(const Duration(seconds: 50)));
    });

    test('heartbeat detects dead socket on pong timeout and triggers reconnect',
        () async {
      final channels = <_FakeWebSocketChannel>[];
      final errors = <Object>[];

      final transport = VellumRealtimeTransport(
        url: Uri.parse('wss://api.example.test/v1/realtime'),
        auth: () async => <String, dynamic>{'type': 'auth', 'projectId': 'p'},
        onFrame: (_) {},
        onError: errors.add,
        channelFactory: (uri) {
          final ch = _FakeWebSocketChannel();
          channels.add(ch);
          return ch;
        },
        heartbeatInterval: const Duration(milliseconds: 15),
        pongTimeout: const Duration(milliseconds: 20),
        backoffMs: (_) => 10,
      );

      final connectFuture = transport.connect();
      await Future<void>.delayed(Duration.zero);
      channels.first.pushFrame(<String, dynamic>{'type': 'auth_ack'});
      await connectFuture;

      // Do not send any pong frames; wait for dead-socket detection + reconnect.
      await Future<void>.delayed(const Duration(milliseconds: 80));
      expect(errors.whereType<TimeoutException>(), isNotEmpty);
      expect(channels.length, greaterThanOrEqualTo(2));

      transport.close();
    });
  });

  group(
      'Enterprise DX: pagination streams, chunked batches, and GET coalescing',
      () {
    test('streamPages() and streamDocuments() lazily iterate cursor pages',
        () async {
      final seenCursors = <String?>[];
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'pk_test',
        httpTransport: (method, url, headers, body) async {
          final cursor = body?['startAfter'] as String?;
          seenCursors.add(cursor);
          if (cursor == null) {
            return <String, dynamic>{
              'documents': <Map<String, dynamic>>[
                <String, dynamic>{
                  'documentId': 'd1',
                  'path': 'items/d1',
                  'version': 1,
                  'data': <String, dynamic>{'n': 1},
                },
                <String, dynamic>{
                  'documentId': 'd2',
                  'path': 'items/d2',
                  'version': 1,
                  'data': <String, dynamic>{'n': 2},
                },
              ],
              'nextCursor': 'cur_2',
            };
          }
          return <String, dynamic>{
            'documents': <Map<String, dynamic>>[
              <String, dynamic>{
                'documentId': 'd3',
                'path': 'items/d3',
                'version': 1,
                'data': <String, dynamic>{'n': 3},
              },
            ],
            'nextCursor': null,
          };
        },
      );

      final docs = await client
          .collection('items')
          .streamDocuments(pageSize: 2)
          .toList();
      expect(
          docs.map((d) => d.id).toList(), equals(<String>['d1', 'd2', 'd3']));
      expect(seenCursors, equals(<String?>[null, 'cur_2']));
      client.dispose();
    });

    test(
        'writeBatchChunked and VellumWriteBatch.commitChunked split into chunks with idempotency keys',
        () async {
      final chunkSizes = <int>[];
      final idempotencyKeys = <String?>[];

      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'pk_test',
        httpTransport: (method, url, headers, body) async {
          final writes = body?['writes'] as List<dynamic>;
          chunkSizes.add(writes.length);
          idempotencyKeys.add(headers['Idempotency-Key']);
          return <String, dynamic>{'committed': writes.length};
        },
      );

      final batch = client.batch();
      for (var i = 0; i < 5; i++) {
        batch.set(client.doc('items/i$i'), <String, dynamic>{'idx': i});
      }
      final results = await batch.commitChunked(
        chunkSize: 2,
        idempotencyKeyPrefix: 'bulk-import',
      );

      expect(results, hasLength(3));
      expect(chunkSizes, equals(<int>[2, 2, 1]));
      expect(
        idempotencyKeys,
        equals(<String?>['bulk-import-0', 'bulk-import-1', 'bulk-import-2']),
      );
      client.dispose();
    });

    test(
        'chunked writes default to the server limit of 100 and never exceed it',
        () async {
      final sizes = <int>[];
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'pk_test',
        httpTransport: (method, url, headers, body) async {
          sizes.add((body?['writes'] as List<dynamic>).length);
          return <String, dynamic>{};
        },
      );
      final writes = <Map<String, Object?>>[
        for (var i = 0; i < 250; i++)
          <String, Object?>{
            'type': 'set',
            'path': 'items/i$i',
            'data': <String, Object?>{'i': i}
          },
      ];
      await client.writeBatchChunked(writes);
      expect(sizes, equals(<int>[100, 100, 50]));
      sizes.clear();
      await client.writeBatchChunked(writes, chunkSize: 500);
      expect(sizes, equals(<int>[100, 100, 50]));
      client.dispose();
    });

    test('single-flight GET coalescing dedupes concurrent identical GETs',
        () async {
      var networkCalls = 0;
      final gate = Completer<Map<String, dynamic>>();

      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'pk_test',
        httpTransport: (method, url, headers, body) async {
          networkCalls++;
          if (networkCalls == 1) {
            return gate.future;
          }
          return <String, dynamic>{
            'documentId': 'u1',
            'path': 'users/u1',
            'version': 2,
            'data': <String, dynamic>{'name': 'Fresh'},
          };
        },
      );

      final f1 = client.getDoc('users/u1');
      final f2 = client.getDoc('users/u1');
      final f3 = client.getDoc('users/u1');

      gate.complete(<String, dynamic>{
        'documentId': 'u1',
        'path': 'users/u1',
        'version': 1,
        'data': <String, dynamic>{'name': 'Coalesced'},
      });

      final results = await Future.wait([f1, f2, f3]);
      expect(networkCalls, equals(1));
      expect(results.every((s) => s.data()?['name'] == 'Coalesced'), isTrue);

      // A subsequent sequential GET must hit the network fresh.
      final fresh = await client.getDoc('users/u1');
      expect(networkCalls, equals(2));
      expect(fresh.data()?['name'], equals('Fresh'));
      client.dispose();
    });
  });
}
