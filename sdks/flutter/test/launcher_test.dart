import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/src/oauth_launcher/loopback_io.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

void main() {
  test('createVellumOAuth rejects a relative redirect URI', () {
    final client = VellumClient(
      endpoint: 'https://api.example.com',
      projectId: 'p',
      apiKey: 'pk_test_abc',
      httpTransport: (m, u, h, b) async => <String, dynamic>{},
    );
    expect(
      () => createVellumOAuth(auth: client.auth, redirectUri: '/nope'),
      throwsArgumentError,
    );
    final oauth = createVellumOAuth(
      auth: client.auth,
      redirectUri: 'myapp://auth-callback',
    );
    expect(oauth.redirectUri, 'myapp://auth-callback');
    client.auth.dispose();
  });

  test('loopback launcher returns the redirect URL with its query', () async {
    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = probe.port;
    await probe.close();
    final redirect = Uri.parse('http://127.0.0.1:$port/callback');
    final result = awaitLoopbackCallback(redirect, () async {
      final client = HttpClient();
      final other =
          await client.getUrl(Uri.parse('http://127.0.0.1:$port/other'));
      expect((await other.close()).statusCode, 404);
      final req = await client.getUrl(
        Uri.parse('http://127.0.0.1:$port/callback?vellum_code=abc&state=xyz'),
      );
      final res = await req.close();
      expect(res.statusCode, 200);
      await res.drain<void>();
      client.close();
    }, const Duration(seconds: 10));
    final returned = Uri.parse(await result);
    expect(returned.path, '/callback');
    expect(returned.queryParameters['vellum_code'], 'abc');
    expect(returned.queryParameters['state'], 'xyz');
  });

  test('loopback launcher times out when no redirect arrives', () async {
    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = probe.port;
    await probe.close();
    await expectLater(
      awaitLoopbackCallback(
        Uri.parse('http://127.0.0.1:$port/callback'),
        () async {},
        const Duration(milliseconds: 200),
      ),
      throwsA(isA<TimeoutException>()),
    );
  });

  test('createVellumOAuth without a redirect URI uses redirect-less sign-in',
      () {
    final client = VellumClient(
      endpoint: 'https://api.example.com',
      projectId: 'p',
      apiKey: 'pk_test_abc',
      httpTransport: (m, u, h, b) async => <String, dynamic>{},
    );
    final oauth =
        createVellumOAuth(auth: client.auth, onConfirmationCode: (_) {});
    expect(oauth.redirectUri, '');
    client.auth.dispose();
  });
}
