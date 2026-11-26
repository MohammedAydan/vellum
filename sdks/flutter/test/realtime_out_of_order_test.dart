import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

void main() {
  test('an update older than the held version is ignored', () async {
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
    final seen = <Object?>[];
    final sub = client
        .collection('chats')
        .where('memberIds', 'array-contains', 'u1')
        .snapshots()
        .listen((snap) {
      for (final d in snap.docs) {
        if (d.id == 'c1') seen.add((d.data() as Map)['n']);
      }
    });
    try {
      final subId = await ready.future.timeout(const Duration(seconds: 3));
      Map<String, Object?> doc(int v, int n) => {
            'documentId': 'c1',
            'path': 'chats/c1',
            'version': v,
            'data': {'n': n}
          };
      void send(Map<String, Object?> f) => sockets.first.add(jsonEncode(f));
      send({
        'type': 'initial_sync',
        'subId': subId,
        'seqId': 1,
        'documents': [doc(1, 0)]
      });
      send({
        'type': 'mutation',
        'subId': subId,
        'seqId': 3,
        'operation': 'update',
        'document': doc(3, 2)
      });
      send({
        'type': 'mutation',
        'subId': subId,
        'seqId': 2,
        'operation': 'update',
        'document': doc(2, 1)
      });
      send({
        'type': 'mutation',
        'subId': subId,
        'seqId': 4,
        'operation': 'update',
        'document': doc(4, 3)
      });
      // The same version again is a duplicate and must not be delivered twice.
      send({
        'type': 'mutation',
        'subId': subId,
        'seqId': 5,
        'operation': 'update',
        'document': doc(4, 3)
      });
      await Future<void>.delayed(const Duration(milliseconds: 400));
      expect(seen, [0, 2, 3]);
    } finally {
      await sub.cancel();
      client.dispose();
      for (final s in sockets) {
        await s.close();
      }
      await listener.cancel();
      await server.close(force: true);
    }
  });
}
