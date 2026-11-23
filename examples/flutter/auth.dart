import 'dart:io';
// Executed by scripts/run-dart-examples.mjs against a PostgreSQL API.
//
// Authentication & API keys — full key lifecycle with immediate revocation.
// What you'll build: sign-in, session check, server key creation, a probe with
// that key, revocation, and proof the revoked key is rejected immediately.
// Real-world scenario: rotating a leaked key must take effect on the next
// request. Auth/console endpoints are outside baseUrl, so httpTransport is used
// directly; credentials are injected via --dart-define, never hard-coded.
import 'package:vellum_flutter/vellum_flutter.dart';

Future<void> main() async {
  final endpoint = Platform.environment['VELLUM_API_BASE'] ??
      const String.fromEnvironment('VELLUM_API_BASE',
          defaultValue: 'http://127.0.0.1:8080');
  final projectId = Platform.environment['VELLUM_PROJECT_ID'] ??
      const String.fromEnvironment('VELLUM_PROJECT_ID');
  final apiKey = Platform.environment['VELLUM_API_KEY'] ??
      const String.fromEnvironment('VELLUM_API_KEY');
  final email = Platform.environment['VELLUM_EMAIL'] ??
      const String.fromEnvironment('VELLUM_EMAIL');
  final password = Platform.environment['VELLUM_PASSWORD'] ??
      const String.fromEnvironment('VELLUM_PASSWORD');

  final client =
      VellumClient(endpoint: endpoint, projectId: projectId, apiKey: apiKey);
  final prefix = 'ex_flutter_auth_${DateTime.now().microsecondsSinceEpoch}';
  final keysUrl = '$endpoint/v1/console/projects/$projectId/api-keys';
  final probeUrl = '$endpoint/v1/projects/$projectId/documents/$prefix/probe';
  final jsonHeaders = {'Content-Type': 'application/json'};

  try {
    print('=== Authentication & API Keys (Flutter) ===');

    final login = await client.httpTransport(
      'POST',
      '$endpoint/v1/auth/sign-in/email',
      jsonHeaders,
      {'email': email, 'password': password},
    );
    final loginMap = objectMap(login, 'sign-in');
    final token = loginMap['token'];
    if (token is! String || token.isEmpty)
      throw StateError('Missing sign-in token');
    print('signIn: success=${loginMap['success']} tokenLength=${token.length}');

    final session = await client.httpTransport(
      'GET',
      '$endpoint/v1/auth/session',
      {...jsonHeaders, 'Authorization': 'Bearer $token'},
      null,
    );
    print(
        'session: hasSession=${objectMap(session, 'session')['session'] != null}');

    final authHeaders = {...jsonHeaders, 'Authorization': 'Bearer $token'};
    final listedResponse =
        await client.httpTransport('GET', keysUrl, authHeaders, null);
    final listed = listedResponse is VellumHttpResponse
        ? listedResponse.body
        : listedResponse;
    if (listed is! List) throw StateError('Expected API key list');
    for (final key in listed) {
      objectMap(key, 'API key');
    }
    print('listKeys: responseReceived=${listed.isNotEmpty}');

    final created = await client.httpTransport('POST', keysUrl, authHeaders, {
      'name': 'examples:flutter-auth:ephemeral',
      'keyType': 'server',
    });
    final createdMap = objectMap(created, 'created key');
    final ephemeralId = objectMap(createdMap['apiKey'], 'API key')['id'];
    final rawKey = createdMap['rawKey'];
    if (ephemeralId is! String || rawKey is! String)
      throw StateError('Malformed created key');
    print('createKey: idReturned=${ephemeralId.isNotEmpty}');

    try {
      var missingKeyRejected = false;
      try {
        await client.httpTransport('GET', probeUrl, jsonHeaders, null);
      } on VellumException catch (e) {
        if (e.statusCode != 401) rethrow;
        missingKeyRejected = true;
        print('missingKey: code=${e.code} status=${e.statusCode}');
      }

      if (!missingKeyRejected) throw StateError('Missing key was accepted');
      try {
        await client.httpTransport(
            'GET', probeUrl, {...jsonHeaders, 'x-project-key': rawKey}, null);
      } on VellumException catch (error) {
        // A missing probe document still proves that authentication succeeded.
        if (error.statusCode != 404) rethrow;
      }
      print('freshKeyAuthenticates: true');
    } finally {
      await client.httpTransport(
          'DELETE', '$keysUrl/$ephemeralId', authHeaders, null);
    }
    print('revokeKey: true');
    var revokedKeyRejected = false;
    try {
      await client.httpTransport(
          'GET', probeUrl, {...jsonHeaders, 'x-project-key': rawKey}, null);
    } on VellumException catch (e) {
      if (e.statusCode != 401) rethrow;
      revokedKeyRejected = true;
      print('revokedKeyRejected: code=${e.code} status=${e.statusCode}');
    }
    if (!revokedKeyRejected) throw StateError('Revoked key was accepted');
  } catch (e) {
    print('auth example error: $e');
    rethrow;
  } finally {
    client.dispose();
  }
}

Map<String, dynamic> objectMap(Object? value, String context) {
  if (value is VellumHttpResponse) value = value.body;
  if (value is! Map<String, dynamic>)
    throw FormatException('Expected object: $context');
  return value;
}
