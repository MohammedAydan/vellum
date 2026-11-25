import 'dart:convert';

import 'package:crypto/crypto.dart' as crypto;
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
  late List<Map<String, Object?>> posts;
  late VellumClient client;
  late List<Map<String, Object?>> starts;
  setUp(() {
    starts = <Map<String, Object?>>[];
    posts = <Map<String, Object?>>[];
    client = VellumClient(
      endpoint: 'https://api.example.com',
      projectId: 'prj_1',
      apiKey: 'pk_test_abc',
      httpTransport: (method, url, headers, body) async {
        if (url.endsWith('/auth/oauth/google/start') ||
            url.endsWith('/auth/oauth/github/start')) {
          starts.add(<String, Object?>{'url': url, 'body': body, 'headers': headers});
          return <String, dynamic>{
            'authorizeUrl': 'https://accounts.google.com/o/oauth2/v2/auth?state=sealed',
          };
        }
        posts.add(<String, Object?>{'url': url, 'body': body});
        if (url.endsWith('/auth/oauth/exchange') &&
            (body as Map)['code'] == 'mfa') {
          return <String, dynamic>{
            'mfaRequired': true,
            'mfaTicket': 't1',
            'factors': <String>['totp'],
            'expiresAt': 'x',
          };
        }
        return _session();
      },
    );
  });
  tearDown(() => client.auth.dispose());

  test(
      'start is a POST with the key in a header (never a URL), a redirect URI and a valid S256 challenge; exchange sends the verifier',
      () async {
    late Uri started;
    final oauth = VellumOAuth(
      auth: client.auth,
      redirectUri: 'myapp://auth-callback',
      launcher: (url, scheme) async {
        started = url;
        expect(scheme, 'myapp');
        return 'myapp://auth-callback?vellum_code=one-time&state=${(starts.last['body']! as Map)['state']}';
      },
    );
    final result = await oauth.signIn('google');
    expect(result, isA<VellumSession>());
    expect(starts.single['url'], endsWith('/v1/projects/prj_1/auth/oauth/google/start'));
    expect(starts.single['url'].toString(), isNot(contains('pk_test_abc')));
    expect(started.toString(), isNot(contains('pk_test_abc')));
    expect(
        (starts.single['headers']! as Map).values.join(','), contains('pk_test_abc'));
    final startBody = starts.single['body']! as Map;
    expect(startBody['redirectUri'], 'myapp://auth-callback');
    final sent = posts.single['body']! as Map;
    expect(sent['code'], 'one-time');
    final expected = base64Url
        .encode(crypto.sha256
            .convert(utf8.encode(sent['codeVerifier'] as String))
            .bytes)
        .replaceAll('=', '');
    expect(startBody['codeChallenge'], expected);
    expect(client.auth.currentUser?.id, 'usr_1');
  });

  test('a mismatched state is rejected before any exchange', () async {
    final oauth = VellumOAuth(
      auth: client.auth,
      redirectUri: 'myapp://auth-callback',
      launcher: (url, scheme) async =>
          'myapp://auth-callback?vellum_code=x&state=forged',
    );
    await expectLater(oauth.signIn('github'), throwsA(isA<VellumException>()));
    expect(posts, isEmpty);
  });

  test('provider errors and cancellation surface as VellumException', () async {
    final denied = VellumOAuth(
      auth: client.auth,
      redirectUri: 'myapp://auth-callback',
      launcher: (url, scheme) async =>
          'myapp://auth-callback?error=access_denied&error_description=No',
    );
    await expectLater(
      denied.signIn('google'),
      throwsA(isA<VellumException>()
          .having((e) => e.code, 'code', 'PERMISSION_DENIED')),
    );
    final cancelled = VellumOAuth(
      auth: client.auth,
      redirectUri: 'myapp://auth-callback',
      launcher: (url, scheme) async => throw StateError('closed'),
    );
    await expectLater(
      cancelled.signIn('google'),
      throwsA(
          isA<VellumException>().having((e) => e.code, 'code', 'CANCELLED')),
    );
  });

  test('MFA-required result is returned without a session', () async {
    final oauth = VellumOAuth(
      auth: client.auth,
      redirectUri: 'myapp://auth-callback',
      launcher: (url, scheme) async =>
          'myapp://auth-callback?vellum_code=mfa&state=${(starts.last['body']! as Map)['state']}',
    );
    expect(await oauth.signIn('google'), isA<VellumMfaRequired>());
    expect(client.auth.currentUser, isNull);
    final user = await client.auth.verifyMfaChallenge(
        mfaTicket: 't1', code: 'ABCD-EFGH', factorType: 'recovery_code');
    expect(user.id, 'usr_1');
    expect(client.auth.currentUser, isNotNull);
    final challenge = posts
        .lastWhere((p) => (p['url'] as String).endsWith('/auth/mfa/challenge'));
    expect((challenge['body'] as Map)['factorType'], 'recovery_code');
  });

  test('disableMfa posts the code to the disable endpoint', () async {
    await client.auth.disableMfa(code: '123456');
    final call = posts.last;
    expect((call['url'] as String).endsWith('/auth/mfa/disable'), isTrue);
    expect((call['body'] as Map)['code'], '123456');
  });

  test('signInWithGoogleIdToken posts the token to the verifying endpoint',
      () async {
    final result = await client.auth
        .signInWithGoogleIdToken(idToken: 'id.tok.en', nonce: 'n');
    expect(result, isA<VellumSession>());
    expect(posts.single['url'], endsWith('/auth/oauth/google/id-token'));
    expect(posts.single['body'],
        <String, Object?>{'idToken': 'id.tok.en', 'nonce': 'n'});
  });

  test('redirectUri must be absolute', () {
    expect(
      () => VellumOAuth(
          auth: client.auth,
          redirectUri: '/relative',
          launcher: (u, s) async => ''),
      throwsArgumentError,
    );
  });
}
