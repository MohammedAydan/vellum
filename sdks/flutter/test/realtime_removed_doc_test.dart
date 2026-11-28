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

  Future<
      ({
        List<bool> seen,
        String subId,
        Future<void> Function(Map<String, Object?>) send,
        Future<void> Function() close,
      })> docHarness({bool resolveCache = false}) async {
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
    final subId = await ready.future.timeout(const Duration(seconds: 3));
    return (
      seen: seen,
      subId: subId,
      send: (Map<String, Object?> f) async {
        sockets.first.add(jsonEncode(f));
      },
      close: () async {
        await sub.cancel();
        for (final s in sockets) {
          await s.close();
        }
        await listener.cancel();
        await server.close(force: true);
        client.dispose();
      },
    );
  }

  test('a missing document reports exists == false once', () async {
    final h = await docHarness();
    try {
      await h.send({'type': 'initial_sync', 'subId': h.subId, 'seqId': 1, 'documents': []});
      await Future<void>.delayed(const Duration(milliseconds: 500));
      expect(h.seen, [false]);
    } finally {
      await h.close();
    }
  });

  test('identical (exists, version) emissions are deduplicated', () async {
    final h = await docHarness();
    final doc = {
      'documentId': 'c1',
      'path': 'chats/c1',
      'version': 2,
      'data': {'n': 1}
    };
    try {
      await h.send({'type': 'initial_sync', 'subId': h.subId, 'seqId': 1, 'documents': [doc]});
      await h.send({'type': 'mutation', 'subId': h.subId, 'seqId': 2, 'operation': 'update', 'document': doc});
      await Future<void>.delayed(const Duration(milliseconds: 500));
      expect(h.seen, [true]);
    } finally {
      await h.close();
    }
  });

  test('connectionState stream reports connecting then connected with transport kind (Track 3)',
      () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final listener = server.listen((request) async {
      final socket = await WebSocketTransformer.upgrade(request);
      socket.listen((raw) {
        final frame = jsonDecode(raw as String) as Map;
        if (frame['type'] == 'auth') {
          socket.add(jsonEncode({'type': 'auth_ack'}));
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
    final states = <VellumRealtimeConnectionState>[];
    final sub = client.connectionStateStream.listen((info) {
      states.add(info.state);
      expect(info.transportKind, 'websocket');
    });
    try {
      final s2 = client.doc('chats/c1').snapshots().listen((_) {});
      await Future<void>.delayed(const Duration(milliseconds: 800));
      expect(states, contains(VellumRealtimeConnectionState.connected));
      expect(client.connectionState.state,
          VellumRealtimeConnectionState.connected);
      await s2.cancel();
    } finally {
      await sub.cancel();
      await listener.cancel();
      await server.close(force: true);
      client.dispose();
    }
  });

  // Recipe 2 (Flutter): missing -> created (v1, once) -> updated (v2) -> deleted / TTL-expired, no duplicates.
  test('missing-document lifecycle: false, true v1 once, true v2, then false on delete and TTL expiry', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final sockets = <WebSocket>[];
    final subIds = <String>[];
    final ready = Completer<void>();
    final listener = server.listen((request) async {
      final socket = await WebSocketTransformer.upgrade(request);
      sockets.add(socket);
      socket.listen((raw) {
        final frame = jsonDecode(raw as String) as Map;
        if (frame['type'] == 'auth') socket.add(jsonEncode({'type': 'auth_ack'}));
        if (frame['type'] == 'subscribe') {
          subIds.add(frame['subId'] as String);
          if (subIds.length == 2 && !ready.isCompleted) ready.complete();
        }
      });
    });
    final client = VellumClient(
        endpoint: 'http://127.0.0.1:${server.port}',
        projectId: 'project',
        apiKey: 'pk_test',
        realtimeMode: VellumRealtimeMode.websocket,
        httpTransport: (method, url, headers, body) async => <String, Object?>{});
    final life = <String>[];
    final ttl = <String>[];
    final errors = <Object>[];
    String tag(DocumentSnapshot<Map<String, Object?>> s) => '${s.exists}:${s.exists ? s.version : 0}';
    final s1 = client.doc('chats/c1/messages/missing_life_2').snapshots().listen((s) => life.add(tag(s)), onError: errors.add);
    final s2 = client.doc('chats/c1/messages/ttl_life').snapshots().listen((s) => ttl.add(tag(s)), onError: errors.add);
    try {
      await ready.future.timeout(const Duration(seconds: 3));
      Map<String, Object?> doc(String id, int v) => {'documentId': id, 'path': 'chats/c1/messages/$id', 'version': v, 'data': {'memberIds': ['alice']}};
      void send(Map<String, Object?> f) => sockets.first.add(jsonEncode(f));
      final lifeSub = subIds[0];
      final ttlSub = subIds[1];
      send({'type': 'initial_sync', 'subId': lifeSub, 'seqId': 1, 'documents': []});
      send({'type': 'initial_sync', 'subId': ttlSub, 'seqId': 1, 'documents': [doc('ttl_life', 1)]});
      send({'type': 'mutation', 'subId': lifeSub, 'seqId': 2, 'operation': 'create', 'document': doc('missing_life_2', 1)});
      send({'type': 'mutation', 'subId': lifeSub, 'seqId': 3, 'operation': 'update', 'document': doc('missing_life_2', 2)});
      send({'type': 'mutation', 'subId': lifeSub, 'seqId': 4, 'operation': 'delete', 'document': doc('missing_life_2', 2)});
      send({'type': 'mutation', 'subId': ttlSub, 'seqId': 5, 'operation': 'delete', 'document': doc('ttl_life', 0)});
      await Future<void>.delayed(const Duration(milliseconds: 600));
      expect(life, ['false:0', 'true:1', 'true:2', 'false:0']);
      expect(ttl, ['true:1', 'false:0']);
      expect(errors, isEmpty);
    } finally {
      await s1.cancel();
      await s2.cancel();
      for (final s in sockets) {
        await s.close();
      }
      await listener.cancel();
      await server.close(force: true);
      client.dispose();
    }
  });
}