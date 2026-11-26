import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

void main() {
  test('a deleted document reports exists == false', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final sockets = <WebSocket>[];
    final ready = Completer<String>();
    final listener = server.listen((request) async {
      final socket = await WebSocketTransformer.upgrade(request);
      sockets.add(socket);
      socket.listen((raw) {
        final frame = jsonDecode(raw as String) as Map;
        if (frame['type'] == 'auth') {
          socket.add(jsonEncode({'type': 'auth_ack'}));
        }
        if (frame['type'] == 'subscribe' && !ready.isCompleted) {
          ready.complete(frame['subId'] as String);
        }
      });
    });
    final client = VellumClient(
        endpoint: 'http://127.0.0.1:${server.port}',
        projectId: 'project',
        apiKey: 'pk_test',
        realtimeMode: VellumRealtimeMode.websocket,
        httpTransport: (method, url, headers, body) async =>
            <String, Object?>{});
    final seen = <bool>[];
    final sub = client.doc('chats/c1').snapshots().listen((snap) {
      seen.add(snap.exists);
    });
    try {
      final subId = await ready.future.timeout(const Duration(seconds: 3));
      final doc = {
        'documentId': 'c1',
        'path': 'chats/c1',
        'version': 2,
        'data': {'n': 1}
      };
      void send(Map<String, Object?> f) => sockets.first.add(jsonEncode(f));
      send({
        'type': 'initial_sync',
        'subId': subId,
        'seqId': 1,
        'documents': [doc]
      });
      send({
        'type': 'mutation',
        'subId': subId,
        'seqId': 2,
        'operation': 'delete',
        'document': doc
      });
      await Future<void>.delayed(const Duration(milliseconds: 500));
      expect(seen, [true, false]);
    } finally {
      await sub.cancel();
      for (final s in sockets) {
        await s.close();
      }
      await listener.cancel();
      await server.close(force: true);
      client.dispose();
    }
  });
}
