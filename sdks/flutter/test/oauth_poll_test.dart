import 'dart:async';
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

const _serverVector = 'C9F58F';

void main() {
  late List<Map<String, Object?>> calls;
  late int pendingLeft;
  late VellumClient client;
  setUp(() {
    calls = <Map<String, Object?>>[];
    pendingLeft = 2;
    client = VellumClient(
      endpoint: 'https://api.example.com',
      projectId: 'prj_1',
      apiKey: 'pk_test_abc',
      httpTransport: (method, url, headers, body) async {
        calls.add(
            <String, Object?>{'url': url, 'body': body, 'headers': headers});
        if (url.endsWith('/auth/oauth/google/start')) {
          return <String, dynamic>{
            'authorizeUrl':
                'https://accounts.google.com/o/oauth2/v2/auth?state=sealed',
          };
        }
        if (url.endsWith('/auth/oauth/poll')) {
          if (pendingLeft-- > 0) return <String, dynamic>{'status': 'pending'};
          return _session();
        }
        if (url.endsWith('/auth/sign-in/email')) return _session();
        throw StateError('unexpected $url');
      },
    );
  });
  tearDown(() => client.auth.dispose());

  test(
      'redirect-less sign-in: no redirect URI, key in a header, polls with the verifier until done',
      () async {
    Uri? opened;
    String? shown;
    final oauth = VellumOAuth.polling(
      auth: client.auth,
      onConfirmationCode: (code) => shown = code,
      pollInterval: const Duration(milliseconds: 5),
      openUrl: (url) async => opened = url,
    );
    final result = await oauth.signIn('google');
    expect(result, isA<VellumSession>());
    expect(opened.toString(), contains('accounts.google.com'));
    final start = calls.first;
    final startBody = start['body']! as Map;
    expect(startBody['delivery'], 'poll');
    expect(startBody.containsKey('redirectUri'), isFalse);
    expect(start['url'].toString(), isNot(contains('pk_test_abc')));
    final polls = calls.skip(1).toList();
    expect(polls, hasLength(3));
    final verifier = (polls.first['body']! as Map)['codeVerifier'] as String;
    final expected = base64Url
        .encode(crypto.sha256.convert(utf8.encode(verifier)).bytes)
        .replaceAll('=', '');
    expect(startBody['codeChallenge'], expected);
    expect(client.auth.currentUser?.id, 'usr_1');
    // The code shown to the user is derived from the challenge, matching the server.
    expect(shown, vellumConfirmationCode(expected));
    expect(shown, matches(RegExp(r'^[A-HJ-NP-Z2-9]{6}$')));
  });

  test('times out with CANCELLED when the browser step never finishes',
      () async {
    pendingLeft = 1 << 30;
    final oauth = VellumOAuth.polling(
      auth: client.auth,
      onConfirmationCode: (_) {},
      pollInterval: const Duration(milliseconds: 5),
      timeout: const Duration(milliseconds: 60),
      openUrl: (url) async {},
    );
    await expectLater(
      oauth.signIn('google'),
      throwsA(
          isA<VellumException>().having((e) => e.code, 'code', 'CANCELLED')),
    );
    expect(client.auth.currentUser, isNull);
  });

  test('a failing browser launch surfaces as CANCELLED and never polls',
      () async {
    final oauth = VellumOAuth.polling(
      auth: client.auth,
      onConfirmationCode: (_) {},
      openUrl: (url) async => throw Exception('no browser'),
    );
    await expectLater(oauth.signIn('google'), throwsA(isA<VellumException>()));
    expect(calls.where((c) => c['url'].toString().endsWith('/poll')), isEmpty);
  });

  test('a resume signal polls immediately instead of waiting for the interval',
      () async {
    final resume = StreamController<void>();
    final oauth = VellumOAuth.polling(
      auth: client.auth,
      onConfirmationCode: (_) {},
      pollInterval: const Duration(seconds: 30),
      resumeSignals: resume.stream,
      openUrl: (url) async {},
    );
    final done = oauth.signIn('google');
    for (var i = 0; i < 2; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
      resume.add(null);
    }
    expect(
        await done.timeout(const Duration(seconds: 5)), isA<VellumSession>());
    await resume.close();
  });

  test(
      'link requires a signed-in user and then starts with the user token and link flag',
      () async {
    final oauth = VellumOAuth.polling(
      auth: client.auth,
      onConfirmationCode: (_) {},
      pollInterval: const Duration(milliseconds: 5),
      openUrl: (url) async {},
    );
    expect(() => oauth.link('google'), throwsA(isA<VellumException>()));
    pendingLeft = 0;
    await client.auth.signInWithEmailAndPassword(
        email: 'a@example.com', password: 'pw-123456');
    // The sign-in above hit the fake transport; reset the call log.
    calls.clear();
    pendingLeft = 0;
    await oauth.link('google');
    expect((calls.first['body']! as Map)['link'], isTrue);
    expect(
        (calls.first['headers']! as Map)
            .keys
            .map((k) => k.toString().toLowerCase()),
        contains('authorization'));
  });

  test('confirmation code derivation is stable and matches the server vector',
      () {
    expect(vellumConfirmationCode('c' * 43), vellumConfirmationCode('c' * 43));
    expect(vellumConfirmationCode('c' * 43),
        isNot(vellumConfirmationCode('d' * 43)));
    expect(vellumConfirmationCode('c' * 43), _serverVector);
  });

  test('polling sign-in and link refuse to run without a code callback', () {
    expect(() => createVellumOAuth(auth: client.auth), throwsArgumentError);
    final oauth = VellumOAuth(
      auth: client.auth,
      redirectUri: 'myapp://cb',
      launcher: (u, s) async => 'myapp://cb',
    );
    expect(oauth.onConfirmationCode, isNull);
  });
}
