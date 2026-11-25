import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

String _jwt() {
  final h = base64Url
      .encode(utf8.encode(jsonEncode(<String, dynamic>{'alg': 'EdDSA'})));
  final b = base64Url.encode(utf8.encode(jsonEncode(<String, dynamic>{
    'sub': 'usr_1',
    'exp':
        DateTime.now().add(const Duration(hours: 1)).millisecondsSinceEpoch ~/
            1000,
  })));
  return '$h.$b.sig';
}

Map<String, dynamic> _session() => <String, dynamic>{
      'user': <String, dynamic>{
        'id': 'usr_1',
        'email': 'a@example.com',
        'emailVerified': true,
        'displayName': 'A',
        'photoUrl': null,
        'phoneNumber': null,
        'phoneVerified': false,
        'isDisabled': false,
        'isAnonymous': false,
        'customClaims': <String, dynamic>{},
        'metadata': <String, dynamic>{},
        'createdAt': '2026-11-17T00:00:00.000Z',
        'updatedAt': '2026-11-17T00:00:00.000Z',
        'lastSignInAt': null,
      },
      'accessToken': _jwt(),
      'refreshToken': 'r1',
      'tokenType': 'Bearer',
      'sessionId': 's1',
      'expiresAt': '2099-01-01T00:00:00.000Z',
    };

void main() {
  late List<Map<String, Object?>> calls;
  late VellumClient client;
  setUp(() {
    calls = <Map<String, Object?>>[];
    client = VellumClient(
      endpoint: 'https://api.example.com',
      projectId: 'prj_1',
      apiKey: 'pk_test_abc',
      httpTransport: (method, url, headers, body) async {
        calls.add(<String, Object?>{'method': method, 'url': url, 'body': body});
        if (url.endsWith('/auth/user') && method == 'DELETE') {
          return <String, dynamic>{'deleted': true};
        }
        if (url.endsWith('/auth/sessions') && method == 'GET') {
          return <String, dynamic>{
            'sessions': <Map<String, dynamic>>[
              <String, dynamic>{'id': 's1', 'userAgent': 'ua', 'ipAddress': null, 'createdAt': 'x', 'lastRefreshedAt': null, 'expiresAt': 'y'},
            ],
          };
        }
        if (url.endsWith('/auth/identities') && method == 'GET') {
          return <String, dynamic>{
            'identities': <Map<String, dynamic>>[
              <String, dynamic>{'provider': 'google', 'email': 'a@b.c', 'lastSignInAt': 'x', 'createdAt': 'y'},
            ],
            'hasPassword': false,
          };
        }
        if (method == 'DELETE') return <String, dynamic>{'success': true};
        return _session();
      },
    );
  });
  tearDown(() => client.auth.dispose());

  test('changePassword posts both passwords and keeps the fresh session', () async {
    await client.auth.signInWithEmailAndPassword(email: 'a@example.com', password: 'old-password-1');
    final user = await client.auth.changePassword(
      currentPassword: 'old-password-1',
      newPassword: 'new-password-2',
    );
    final call = calls.last;
    expect(call['url'], endsWith('/auth/password/change'));
    expect(call['body'], <String, Object?>{
      'currentPassword': 'old-password-1',
      'newPassword': 'new-password-2',
    });
    expect(user.id, 'usr_1');
    expect(client.auth.currentUser?.id, 'usr_1');
  });

  test('deleteAccount sends DELETE /auth/user and signs out locally', () async {
    await client.auth.signInWithEmailAndPassword(email: 'a@example.com', password: 'old-password-1');
    await client.auth.deleteAccount(password: 'old-password-1');
    final del = calls.firstWhere((c) => c['method'] == 'DELETE');
    expect(del['url'], endsWith('/auth/user'));
    expect(del['body'], <String, Object?>{'password': 'old-password-1'});
    expect(client.auth.currentUser, isNull);
  });

  test('sessions and linked providers', () async {
    await client.auth.signInWithEmailAndPassword(email: 'a@example.com', password: 'old-password-1');
    final sessions = await client.auth.listSessions();
    expect(sessions.single.id, 's1');
    await client.auth.revokeSession('s1');
    final linked = await client.auth.listLinkedProviders();
    expect(linked.providers.single.provider, 'google');
    expect(linked.hasPassword, isFalse);
    await client.auth.unlinkProvider('google', currentPassword: 'old-password-1');
    expect(calls.any((c) => c['method'] == 'DELETE' && c['url'].toString().endsWith('/auth/sessions/s1')), isTrue);
    final unlink = calls.lastWhere((c) => c['method'] == 'DELETE' && c['url'].toString().endsWith('/auth/identities/google'));
    expect(unlink['body'], <String, Object?>{'currentPassword': 'old-password-1'});
  });

  test('updateProfile forwards currentPassword when changing the email', () async {
    await client.auth.signInWithEmailAndPassword(email: 'a@example.com', password: 'old-password-1');
    await client.auth.updateProfile(email: 'new@example.com', currentPassword: 'old-password-1');
    final patch = calls.lastWhere((c) => c['method'] == 'PATCH');
    expect(patch['body'], <String, Object?>{
      'email': 'new@example.com',
      'currentPassword': 'old-password-1',
    });
  });
}
