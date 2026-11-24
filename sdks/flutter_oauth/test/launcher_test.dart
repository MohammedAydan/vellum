import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';
import 'package:vellum_flutter_oauth/vellum_flutter_oauth.dart';

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
}
