import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

void main() {
  group('realtime URL sanitizer', () {
    for (final input in <String>[
      'https://api.example.com',
      'https://api.example.com/',
      'wss://api.example.com/v1/realtime',
      'wss://api.example.com:0/v1/realtime#',
      'https://api.example.com:0/v1/realtime#',
      'ws://localhost:8080/v1/realtime',
    ]) {
      test('ws url for $input has no :0 or #', () {
        final uri = vellumSanitizeRealtimeUri(input);
        final text = uri.toString();
        expect(text, isNot(contains(':0/')));
        expect(text, isNot(contains('#')));
        expect(text, endsWith('/v1/realtime'));
        expect(uri.scheme, anyOf('ws', 'wss'));
      });
      test('sse url for $input has no :0 or #', () {
        final text = vellumRealtimeSseUri(input).toString();
        expect(text, isNot(contains(':0/')));
        expect(text, isNot(contains('#')));
        expect(text, endsWith('/v1/realtime/stream'));
      });
    }

    test('keeps explicit non-default ports', () {
      expect(vellumSanitizeRealtimeUri('http://localhost:8080').toString(),
          'ws://localhost:8080/v1/realtime');
      expect(vellumRealtimeSseUri('ws://localhost:8080/v1/realtime').toString(),
          'http://localhost:8080/v1/realtime/stream');
    });
  });

  group('SseWebSocketChannel', () {
    late HttpServer server;
    final bodies = <Map<String, Object?>>[];
    late void Function(HttpRequest request, Map<String, Object?> body) handler;

    setUp(() async {
      bodies.clear();
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((request) async {
        final body = jsonDecode(await utf8.decoder.bind(request).join())
            as Map<String, Object?>;
        bodies.add(body);
        handler(request, body);
      });
    });
    tearDown(() => server.close(force: true));

    Uri streamUrl() =>
        Uri.parse('http://127.0.0.1:${server.port}/v1/realtime/stream');

    test(
        'forwards frames, answers ping locally, resumes from the last seqId and hides internal acks',
        () async {
      handler = (request, body) {
        request.response.bufferOutput = false;
        request.response.headers.contentType =
            ContentType('text', 'event-stream');
        request.response.write(
            'data: {"type":"auth_ack","status":"authenticated","connectionId":"c"}\n\n');
        final frames = (body['frames'] as List).cast<Map<String, Object?>>();
        if (frames.length > 1) {
          request.response.write(
              'id: 7\ndata: {"type":"mutation","subId":"s1","seqId":7,"operation":"create","document":{}}\n\n');
        }
        request.response.flush();
      };
      final channel = SseWebSocketChannel(streamUrl());
      final received = <Map<String, Object?>>[];
      channel.stream.listen((data) =>
          received.add(jsonDecode(data as String) as Map<String, Object?>));
      await channel.ready;
      channel.sink
          .add(jsonEncode({'type': 'auth', 'projectId': 'p', 'apiKey': 'k'}));
      await Future<void>.delayed(const Duration(milliseconds: 200));
      expect(received.map((f) => f['type']), ['auth_ack']);

      channel.sink.add(jsonEncode({'type': 'ping', 'ts': 5}));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(received.last['type'], 'pong');

      channel.sink.add(
          jsonEncode({'type': 'subscribe', 'subId': 's1', 'path': 'items/a'}));
      await Future<void>.delayed(const Duration(milliseconds: 250));
      expect(received.where((f) => f['type'] == 'auth_ack').length, 1);
      expect(received.any((f) => f['type'] == 'mutation' && f['seqId'] == 7),
          isTrue);

      channel.sink.add(
          jsonEncode({'type': 'subscribe', 'subId': 's2', 'path': 'items/b'}));
      await Future<void>.delayed(const Duration(milliseconds: 250));
      final last = (bodies.last['frames'] as List).cast<Map<String, Object?>>();
      expect(last.firstWhere((f) => f['subId'] == 's1')['resumeSeqId'], 7);
      await channel.sink.close();
    });

    test('HTTP errors become an error frame and close the stream', () async {
      handler = (request, body) {
        request.response.statusCode = 401;
        request.response.headers.contentType = ContentType.json;
        request.response.write(jsonEncode({
          'error': {'code': 'UNAUTHENTICATED', 'message': 'bad key'}
        }));
        request.response.close();
      };
      final channel = SseWebSocketChannel(streamUrl());
      final received = <Map<String, Object?>>[];
      final done = Completer<void>();
      channel.stream.listen(
        (data) =>
            received.add(jsonDecode(data as String) as Map<String, Object?>),
        onDone: done.complete,
      );
      channel.sink
          .add(jsonEncode({'type': 'auth', 'projectId': 'p', 'apiKey': 'k'}));
      await done.future.timeout(const Duration(seconds: 3));
      expect(received.first['code'], 'UNAUTHENTICATED');
      expect(channel.closeCode, 1008);
    });

    test('renews the stream on a reconnect event without closing', () async {
      handler = (request, body) {
        request.response.bufferOutput = false;
        request.response.headers.contentType =
            ContentType('text', 'event-stream');
        request.response.write(
            'data: {"type":"auth_ack","status":"authenticated","connectionId":"c"}\n\n');
        if (bodies.length == 1) {
          request.response.write('event: reconnect\ndata: {}\n\n');
          request.response.close();
        } else {
          request.response.flush();
        }
      };
      final channel = SseWebSocketChannel(streamUrl());
      var closed = false;
      channel.stream.listen((_) {}, onDone: () => closed = true);
      channel.sink
          .add(jsonEncode({'type': 'auth', 'projectId': 'p', 'apiKey': 'k'}));
      await Future<void>.delayed(const Duration(milliseconds: 300));
      expect(bodies.length, 2);
      expect(closed, isFalse);
      await channel.sink.close();
    });
  });

  group('FallbackWebSocketChannel', () {
    late HttpServer server;
    final bodies = <Map<String, Object?>>[];

    setUp(() async {
      FallbackWebSocketChannel.resetStickyFallback();
      bodies.clear();
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((request) async {
        if (request.headers.value('upgrade') != null) {
          // Hosts such as Vercel refuse the WebSocket upgrade.
          request.response.statusCode = 400;
          await request.response.close();
          return;
        }
        final body = jsonDecode(await utf8.decoder.bind(request).join())
            as Map<String, Object?>;
        bodies.add(body);
        request.response.bufferOutput = false;
        request.response.headers.contentType =
            ContentType('text', 'event-stream');
        request.response.write(
            'data: {"type":"auth_ack","status":"authenticated","connectionId":"c"}\n\n');
        await request.response.flush();
      });
    });
    tearDown(() => server.close(force: true));

    test('falls back to SSE when the server refuses the WebSocket upgrade',
        () async {
      var fellBack = false;
      final channel = FallbackWebSocketChannel(
        Uri.parse('ws://127.0.0.1:${server.port}/v1/realtime'),
        onFallback: (_) => fellBack = true,
      );
      final received = <Map<String, Object?>>[];
      channel.stream.listen((data) =>
          received.add(jsonDecode(data as String) as Map<String, Object?>));
      await channel.ready.timeout(const Duration(seconds: 5));
      channel.sink
          .add(jsonEncode({'type': 'auth', 'projectId': 'p', 'apiKey': 'k'}));
      await Future<void>.delayed(const Duration(milliseconds: 300));
      expect(fellBack, isTrue);
      expect(bodies, isNotEmpty);
      expect(received.first['type'], 'auth_ack');
      await channel.sink.close();
    });

    test('falls back when the WebSocket factory throws and remembers the host',
        () async {
      var primaryCalls = 0;
      WebSocketChannel primary(Uri url) {
        primaryCalls++;
        throw StateError('no WebSocket support');
      }

      final url = Uri.parse('ws://127.0.0.1:${server.port}/v1/realtime');
      for (var i = 0; i < 2; i++) {
        final channel = FallbackWebSocketChannel(url, primaryFactory: primary);
        await channel.ready.timeout(const Duration(seconds: 5));
        await channel.sink.close();
      }
      expect(primaryCalls, 1);
    });
  });
}
