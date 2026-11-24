@TestOn('browser')
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

/// Runs in a real browser (`dart test -p chrome`). A VM-side mock host streams
/// two SSE frames 1.5s apart; the browser must receive the first frame well
/// before the second is sent, i.e. the response is streamed, not buffered.
const _serverCode = r'''
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:stream_channel/stream_channel.dart';

Future<void> hybridMain(StreamChannel channel) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  channel.sink.add(server.port);
  await for (final request in server) {
    request.response.headers.set('access-control-allow-origin', '*');
    request.response.headers.set('access-control-allow-headers', '*');
    request.response.headers.set('access-control-allow-methods', 'POST, OPTIONS');
    if (request.method == 'OPTIONS') {
      request.response.statusCode = 204;
      await request.response.close();
      continue;
    }
    await utf8.decoder.bind(request).join();
    request.response.headers.contentType = ContentType('text', 'event-stream');
    request.response.headers.set('cache-control', 'no-cache, no-transform');
    request.response.bufferOutput = false;
    request.response.write(': stream-open\n\ndata: {"type":"auth_ack","status":"authenticated","connectionId":"c1"}\n\n');
    await request.response.flush();
    Timer(const Duration(milliseconds: 1500), () async {
      try {
        request.response.write('id: 1\ndata: {"type":"mutation","subId":"s1","seqId":1,"operation":"create","document":{}}\n\n');
        await request.response.flush();
        await request.response.close();
      } catch (_) {}
    });
  }
}
''';

void main() {
  test('SSE realtime streams incrementally in a real browser', () async {
    final host = spawnHybridCode(_serverCode);
    final port = await host.stream.first as int;
    final channel =
        SseWebSocketChannel(Uri.parse('http://127.0.0.1:$port/v1/realtime/stream'));
    final watch = Stopwatch()..start();
    final seen = <String, int>{};
    final done = Completer<void>();
    final sub = channel.stream.listen((Object? data) {
      final frame = jsonDecode(data as String) as Map<String, Object?>;
      seen.putIfAbsent(frame['type']! as String, () => watch.elapsedMilliseconds);
      if (seen.containsKey('auth_ack') && seen.containsKey('mutation') && !done.isCompleted) {
        done.complete();
      }
    });
    channel.sink.add(jsonEncode(<String, Object?>{'type': 'auth', 'projectId': 'p', 'apiKey': 'k'}));
    channel.sink.add(jsonEncode(<String, Object?>{'type': 'subscribe', 'subId': 's1', 'path': 'c'}));
    await done.future.timeout(const Duration(seconds: 15));
    await sub.cancel();
    await channel.sink.close();
    expect(seen['mutation']! - seen['auth_ack']!, greaterThan(900),
        reason: 'frames arrived together: the browser buffered the stream ($seen)');
  });
}
