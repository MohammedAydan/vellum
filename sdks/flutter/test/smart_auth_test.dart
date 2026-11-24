import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

String _jwt(int expSeconds) {
  final header = base64Url
      .encode(utf8.encode(jsonEncode(<String, Object?>{'alg': 'EdDSA'})));
  final body = base64Url.encode(utf8.encode(
      jsonEncode(<String, Object?>{'sub': 'usr_1', 'exp': expSeconds})));
  return '$header.$body.sig';
}

int _in(int seconds) => DateTime.now().millisecondsSinceEpoch ~/ 1000 + seconds;

Map<String, Object?> _session(String token, String refresh) =>
    <String, Object?>{
      'user': <String, Object?>{
        'id': 'usr_1',
        'email': 'a@example.com',
        'emailVerified': false,
        'displayName': null,
        'photoUrl': null,
        'phoneNumber': null,
        'phoneVerified': false,
        'isDisabled': false,
        'isAnonymous': false,
        'customClaims': <String, Object?>{},
        'metadata': <String, Object?>{},
        'createdAt': '2026-11-17T00:00:00.000Z',
        'updatedAt': '2026-11-17T00:00:00.000Z',
        'lastSignInAt': null,
      },
      'accessToken': token,
      'refreshToken': refresh,
      'tokenType': 'Bearer',
      'sessionId': 's',
      'expiresAt': '2026-11-24T00:00:00.000Z',
    };

void main() {
  test('setCustomToken wins over the session and null removes it', () async {
    final client = VellumClient(
      endpoint: 'http://localhost:8080',
      projectId: 'p',
      apiKey: 'pk_test',
      httpTransport: (m, u, h, b) async => <String, Object?>{},
    );
    final custom = _jwt(_in(3600));
    client.setCustomToken(custom);
    expect(await client.resolveAuthToken(), custom);
    client.setCustomToken(null);
    expect(await client.resolveAuthToken(), isNull);
  });

  test('autoRefresh: false skips silent refresh; forced refresh still works',
      () async {
    final soon = _jwt(_in(20));
    final fresh = _jwt(_in(7200));
    var refreshCalls = 0;
    final client = VellumClient(
      endpoint: 'http://localhost:8080',
      projectId: 'p',
      apiKey: 'pk_test',
      autoRefresh: false,
      httpTransport: (m, u, h, b) async {
        if (u.endsWith('/auth/sign-up/email')) return _session(soon, 'r1');
        if (u.endsWith('/auth/token/refresh')) {
          refreshCalls++;
          return _session(fresh, 'r2');
        }
        return <String, Object?>{};
      },
    );
    await client.auth.signUpWithEmailAndPassword(
        email: 'a@example.com', password: 'password123');
    expect(await client.auth.getIdToken(), soon);
    expect(refreshCalls, 0);
    expect(await client.auth.getIdToken(forceRefresh: true), fresh);
    expect(refreshCalls, 1);
    client.auth.dispose();
  });
}
