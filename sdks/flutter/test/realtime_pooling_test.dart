import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

// Recipe 4.1 (Flutter parity): 1 socket for <= 25 subscriptions, an automatic second socket beyond, 30/30 delivered.
void main() {
  test('multiplexes 20 subscriptions on one socket and pools a second socket for 30', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    var connections = 0;
    final subsPerSocket = <int>[];
    final listener = server.listen((request) async {
      final socket = await WebSocketTransformer.upgrade(request);
      final index = connections++;
      subsPerSocket.add(0);
      socket.listen((raw) {
        final frame = jsonDecode(raw as String) as Map;
        if (frame['type'] == 'auth') socket.add(jsonEncode({'type': 'auth_ack'}));
        if (frame['type'] == 'subscribe') {
          subsPerSocket[index]++;
          socket.add(jsonEncode({'type': 'initial_sync', 'subId': frame['subId'], 'seqId': 1, 'documents': <Object?>[]}));
        }
      });
    });
    final client = VellumClient(
      endpoint: 'http://127.0.0.1:${server.port}',
      projectId: 'project',
      apiKey: 'pk_test',
      realtimeMode: VellumRealtimeMode.websocket,
      httpTransport: (method, url, headers, body) async => <String, Object?>{},
    );
    final delivered = <int>{};
    final errors = <Object>[];
    final subs = <StreamSubscription<Object?>>[];
    void listenTo(int i) {
      subs.add(client.doc('chats/c$i').snapshots().listen((snap) {
        if (!snap.exists) delivered.add(i);
      }, onError: errors.add));
    }

    try {
      for (var i = 0; i < 20; i++) {
        listenTo(i);
      }
      await Future<void>.delayed(const Duration(milliseconds: 600));
      expect(connections, 1);
      for (var i = 20; i < 30; i++) {
        listenTo(i);
      }
      await Future<void>.delayed(const Duration(milliseconds: 800));
      expect(connections, 2);
      expect(subsPerSocket, <int>[25, 5]);
      expect(errors, isEmpty);
      expect(delivered.length, 30);
    } finally {
      for (final s in subs) {
        await s.cancel();
      }
      await listener.cancel();
      await server.close(force: true);
      client.dispose();
    }
  });
}
