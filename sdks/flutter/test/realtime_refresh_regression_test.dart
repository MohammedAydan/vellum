import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

void main() {
  test('refresh reauthenticates socket and restores active subscription',
      () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final sockets = <WebSocket>[];
    final authTokens = <String>[];
    var subscriptions = 0;
    final initial = Completer<void>(), renewed = Completer<void>();
    final listener = server.listen((request) async {
      final socket = await WebSocketTransformer.upgrade(request);
      sockets.add(socket);
      socket.listen((raw) {
        final frame = jsonDecode(raw as String) as Map;
        if (frame['type'] == 'auth') {
          authTokens.add(frame['authToken'] as String);
          socket.add(jsonEncode({'type': 'auth_ack'}));
        }
        if (frame['type'] == 'subscribe') {
          subscriptions++;
          if (subscriptions == 1 && !initial.isCompleted) initial.complete();
          if (subscriptions == 2 && !renewed.isCompleted) renewed.complete();
        }
      });
    });
    final expiry = DateTime.now().add(const Duration(hours: 1));
    String token(int version) =>
        'header.${base64Url.encode(utf8.encode(jsonEncode({
              'exp': expiry.millisecondsSinceEpoch ~/ 1000,
              'v': version
            })))}.sig';
    Map<String, Object?> session(int version) => {
          'user': {'id': 'one', 'email': 'one@example.test'},
          'accessToken': token(version),
          'refreshToken': 'refresh-$version',
          'sessionId': 'session',
          'expiresAt': expiry.toIso8601String(),
        };
    final client = VellumClient(
        endpoint: 'http://127.0.0.1:${server.port}',
        projectId: 'project',
        apiKey: 'pk_test',
        realtimeMode: VellumRealtimeMode.websocket,
        httpTransport: (method, url, headers, body) async {
          if (url.endsWith('/auth/sign-up/email')) return session(1);
          if (url.endsWith('/auth/token/refresh')) return session(2);
          return <String, Object?>{};
        });
    try {
      await client.auth.signUpWithEmailAndPassword(
          email: 'one@example.test', password: 'Password123!');
      final id = client.realtime.subscribe(
          {'target': 'document', 'path': 'items/one'}, (_) {}, (_) {});
      await initial.future.timeout(const Duration(seconds: 3));
      await client.auth.getIdToken(forceRefresh: true);
      await renewed.future.timeout(const Duration(seconds: 3));
      expect(authTokens, [token(1), token(2)]);
      expect(sockets.length, 1);
      client.realtime.unsubscribe(id);
    } finally {
      client.dispose();
      for (final socket in sockets) {
        await socket.close();
      }
      await listener.cancel();
      await server.close(force: true);
    }
  });
}
