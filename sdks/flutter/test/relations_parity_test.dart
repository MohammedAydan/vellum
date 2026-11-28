import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// Captures the exact request the SDK sends for `documents:referencedBy`.
class _CapturedRequest {
  String? method;
  String? url;
  Map<String, dynamic>? body;
}

VellumClient _clientWithHandler(
  _CapturedRequest captured,
  JsonMap Function() response,
) {
  return VellumClient(
    baseUrl: 'http://localhost:8080/v1/projects/p',
    projectId: 'p',
    apiKey: 'pk_test_secret_123',
    httpTransport: (String method, String url, Map<String, String> headers,
        Map<String, dynamic>? body) async {
      captured.method = method;
      captured.url = url;
      captured.body = body;
      return response();
    },
  );
}

JsonMap _wireDoc(String path, Map<String, Object?> data,
        {JsonMap? included, List<String>? redactedRefs}) =>
    <String, Object?>{
      'path': path,
      'documentId': path.split('/').last,
      'version': 3,
      'data': data,
      if (included != null) '_included': included,
      if (redactedRefs != null) '_redactedRefs': redactedRefs,
    };

class _FakeWebSocketSink implements WebSocketSink {
  final List<String> sent = <String>[];
  final Completer<void> _done = Completer<void>();

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
    if (!incoming.isClosed) incoming.add(RealtimeFrames.encode(frame));
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

List<JsonMap> _subscribeFrames(_FakeWebSocketChannel channel) =>
    channel.fakeSink.sent
        .map((String raw) => RealtimeFrames.decode(raw))
        .whereType<Map<String, dynamic>>()
        .where((Map<String, dynamic> f) => f['type'] == 'subscribe')
        .map((Map<String, dynamic> f) => f.cast<String, Object?>())
        .toList();

void main() {
  group('referencedBy (reverse lookup parity)', () {
    test('sends the full wire contract and parses a page', () async {
      final captured = _CapturedRequest();
      final client = _clientWithHandler(
        captured,
        () => <String, Object?>{
          'documents': <Object?>[
            _wireDoc('orders/o1', <String, Object?>{'total': 42}),
            _wireDoc(
              'orders/o2',
              <String, Object?>{'total': 7},
              included: <String, Object?>{
                'customer': <String, Object?>{'path': 'users/u9'},
              },
              redactedRefs: <String>['users/hidden'],
            ),
          ],
          'nextCursor': 'cursor-abc',
        },
      );

      final page = await client.collection('users').doc('u1').referencedBy(
        collection: 'orders',
        field: 'customerId',
        limit: 25,
        cursor: 'cursor-prev',
        select: <String>['total'],
        include: <Object>[
          'customer',
          const VellumInclude(field: 'items', select: <String>['sku']),
        ],
      );

      expect(captured.method, equals('POST'));
      expect(captured.url, endsWith('/documents:referencedBy'));
      expect(
        captured.body,
        equals(<String, Object?>{
          'targetPath': 'users/u1',
          'collection': 'orders',
          'field': 'customerId',
          'limit': 25,
          'cursor': 'cursor-prev',
          'select': <String>['total'],
          'include': <Object?>[
            <String, Object?>{'field': 'customer'},
            <String, Object?>{
              'field': 'items',
              'select': <String>['sku'],
            },
          ],
        }),
      );

      expect(page.nextCursor, equals('cursor-abc'));
      expect(page.documents, hasLength(2));
      expect(page.documents[0].path, equals('orders/o1'));
      expect(page.documents[0].data(), equals(<String, Object?>{'total': 42}));
      expect(page.documents[1].included, contains('customer'));
      expect(page.documents[1].redactedRefs, equals(<String>['users/hidden']));
    });

    test('decodes dependents with a caller-supplied converter', () async {
      final captured = _CapturedRequest();
      final client = _clientWithHandler(
        captured,
        () => <String, Object?>{
          'documents': <Object?>[
            _wireDoc('orders/o1', <String, Object?>{'total': 42}),
          ],
          'nextCursor': null,
        },
      );

      final page =
          await client.collection('users').doc('u1').referencedByAs<int>(
                fromVellum: (JsonMap data, String id) => data['total'] as int,
              );

      expect(page.documents.single.data(), equals(42));
      expect(page.nextCursor, isNull);
      expect(
          captured.body, equals(<String, Object?>{'targetPath': 'users/u1'}));
    });

    test('tolerates an empty page that still carries a cursor', () async {
      final captured = _CapturedRequest();
      final client = _clientWithHandler(
        captured,
        () => <String, Object?>{
          'documents': <Object?>[],
          'nextCursor': 'cursor-more',
        },
      );

      final page = await client.collection('users').doc('u1').referencedBy();
      expect(page.documents, isEmpty);
      expect(page.nextCursor, equals('cursor-more'));
    });
  });

  group('realtime opt-in includes parity', () {
    test('document snapshots send resolveIncludes and serialized specs',
        () async {
      final channel = _FakeWebSocketChannel();
      final client = VellumClient(
        baseUrl: 'http://localhost:8080/v1/projects/p',
        projectId: 'p',
        apiKey: 'pk_test_secret_123',
        realtimeUrlOverride: 'wss://api.example.test/v1/realtime',
        webSocketChannelFactory: (Uri uri) => channel,
        realtimeBackoff: (_) => 5,
      );

      final sub = client.collection('users').doc('u1').snapshots(
        resolveIncludes: true,
        include: <Object>['author'],
      ).listen((_) {});
      await Future<void>.delayed(Duration.zero);
      channel.pushFrame(<String, dynamic>{'type': 'auth_ack'});
      await Future<void>.delayed(Duration.zero);

      final frames = _subscribeFrames(channel);
      expect(frames, hasLength(1));
      expect(frames.single['path'], equals('users/u1'));
      expect(frames.single['resolveIncludes'], isTrue);
      expect(
        frames.single['include'],
        equals(<Object?>[
          <String, Object?>{'field': 'author'},
        ]),
      );

      await sub.cancel();
      client.realtime.dispose();
    });

    test('query snapshots send resolveIncludes inside the subscribe target',
        () async {
      final channel = _FakeWebSocketChannel();
      final client = VellumClient(
        baseUrl: 'http://localhost:8080/v1/projects/p',
        projectId: 'p',
        apiKey: 'pk_test_secret_123',
        realtimeUrlOverride: 'wss://api.example.test/v1/realtime',
        webSocketChannelFactory: (Uri uri) => channel,
        realtimeBackoff: (_) => 5,
      );

      final sub =
          client.collection('orders').where('status', '==', 'open').snapshots(
        resolveIncludes: true,
        include: <Object>[
          const VellumInclude(field: 'customer', as: 'buyer'),
        ],
      ).listen((_) {});
      await Future<void>.delayed(Duration.zero);
      channel.pushFrame(<String, dynamic>{'type': 'auth_ack'});
      await Future<void>.delayed(Duration.zero);

      final frames = _subscribeFrames(channel);
      expect(frames, hasLength(1));
      expect(frames.single['resolveIncludes'], isTrue);
      expect(
        frames.single['include'],
        equals(<Object?>[
          <String, Object?>{'field': 'customer', 'as': 'buyer'},
        ]),
      );
      final query = (frames.single['query'] as Map).cast<String, Object?>();
      expect(query['collectionPath'], equals('orders'));

      await sub.cancel();
      client.realtime.dispose();
    });

    test('resolved realtime payloads surface _included and _redactedRefs',
        () async {
      final channel = _FakeWebSocketChannel();
      final client = VellumClient(
        baseUrl: 'http://localhost:8080/v1/projects/p',
        projectId: 'p',
        apiKey: 'pk_test_secret_123',
        realtimeUrlOverride: 'wss://api.example.test/v1/realtime',
        webSocketChannelFactory: (Uri uri) => channel,
        realtimeBackoff: (_) => 5,
      );

      final snapshots = <DocumentSnapshot<JsonMap>>[];
      final sub = client.collection('orders').doc('o1').snapshots(
          resolveIncludes: true,
          include: <Object>['customer']).listen(snapshots.add);
      await Future<void>.delayed(Duration.zero);
      channel.pushFrame(<String, dynamic>{'type': 'auth_ack'});
      await Future<void>.delayed(Duration.zero);

      // The manager keys handlers by generated subId; route the mutation to it.
      final frames = _subscribeFrames(channel);
      final subId = frames.single['subId'] as String;
      channel.pushFrame(<String, dynamic>{
        'type': 'mutation',
        'subId': subId,
        'seqId': '10',
        'operation': 'update',
        'document': <String, dynamic>{
          'path': 'orders/o1',
          'documentId': 'o1',
          'version': 5,
          'data': <String, dynamic>{'customerId': 'users/u1'},
          '_included': <String, dynamic>{
            'customer': <String, dynamic>{'path': 'users/u1'},
          },
          '_redactedRefs': <dynamic>['users/u2'],
        },
      });
      await Future<void>.delayed(Duration.zero);

      expect(snapshots, isNotEmpty);
      final snap = snapshots.last;
      expect(snap.version, equals(5));
      expect(snap.included, contains('customer'));
      expect(snap.redactedRefs, equals(<String>['users/u2']));

      await sub.cancel();
      client.realtime.dispose();
    });
  });

  group('relation error parsing parity', () {
    test('RELATION_RESTRICT_VIOLATION decodes into a structured exception',
        () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((HttpRequest request) {
        request.response.statusCode = 412;
        request.response.headers.contentType = ContentType.json;
        request.response.headers.set('x-request-id', 'req-relation-1');
        request.response.write(jsonEncode(<String, Object?>{
          'error': <String, Object?>{
            'code': 'RELATION_RESTRICT_VIOLATION',
            'message': 'Delete blocked by 3 dependent documents',
            'requestId': 'req-relation-1',
            'details': <String, Object?>{'dependents': 3},
          },
        }));
        request.response.close();
      });

      final client = VellumClient(
        baseUrl: 'http://127.0.0.1:${server.port}/v1/projects/p',
        projectId: 'p',
        apiKey: 'pk_test_secret_123',
        maxRetries: 0,
      );

      try {
        await client.collection('users').doc('u1').delete();
        fail('expected VellumException');
      } on VellumException catch (err) {
        expect(err.code, equals('RELATION_RESTRICT_VIOLATION'));
        expect(err.statusCode, equals(412));
        expect(err.message, contains('dependent'));
        expect(err.requestId, equals('req-relation-1'));
        expect(err.details['dependents'], equals(3));
      } finally {
        await server.close(force: true);
      }
    });
  });
}
