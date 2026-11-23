import 'dart:io';
// Executed by scripts/run-dart-examples.mjs against a PostgreSQL API.
//
// Security rules AST — publish a deny-by-default v1 ruleset.
// What you'll build: a versioned ruleset with one explicit scoped allow, then
// verification, rejection of a malformed AST, and restoration.
// Real-world scenario: locking down a collection means allowing only the
// listed operations; everything else is denied by default. Console endpoints
// live outside the data-plane baseUrl, so `client.httpTransport` is used with a
// session bearer token. Credentials are injected via --dart-define, never hard-coded.
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
  final prefix = 'ex_flutter_rules_${DateTime.now().microsecondsSinceEpoch}';
  final rulesUrl = '$endpoint/v1/console/projects/$projectId/rulesets';

  final signIn = await client.httpTransport(
    'POST',
    '$endpoint/v1/auth/sign-in/email',
    {'Content-Type': 'application/json'},
    {'email': email, 'password': password},
  );
  final login = objectMap(signIn, 'sign-in');
  if (login['token'] is! String) throw StateError('Missing sign-in token');
  final headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ${login['token']}',
  };

  final original = await client.httpTransport('GET', rulesUrl, headers, null);
  final originalMap = objectMap(original, 'ruleset');
  final originalAst = originalMap['rulesAst'] ?? {'version': 1, 'rules': []};
  final beforeVersion = (originalMap['version'] as num?) ?? 0;

  try {
    print('=== Security Rules AST (Flutter) ===');
    print('before: hasRuleset=${beforeVersion > 0}');

    // Deny by default: only a scoped read and a conditional create are granted.
    final ast = {
      'version': 1,
      'rules': [
        {
          'match': '$prefix/{docId}',
          'allow': {
            'read': true,
            'create': {
              'op': '==',
              'left': {'var': 'request.data.team'},
              'right': {'val': 'red'}
            },
          },
        },
      ],
    };
    final published = await client
        .httpTransport('POST', rulesUrl, headers, {'rulesAst': ast});
    print(
        'publish: versionAdvancedBy=${(objectMap(published, 'published ruleset')['version'] as num) - beforeVersion}');

    final active = await client.httpTransport('GET', rulesUrl, headers, null);
    final activeMap = objectMap(active, 'active ruleset');
    final rulesValue = objectMap(activeMap['rulesAst'], 'rules AST')['rules'];
    if (rulesValue is! List || rulesValue.isEmpty)
      throw StateError('Expected non-empty rules');
    final allow =
        objectMap(objectMap(rulesValue.first, 'rule')['allow'], 'allow');
    print(
        'activeVersion=${activeMap['version']} operations=${allow.keys.toList()}');

    try {
      await client.httpTransport('POST', rulesUrl, headers, {
        'rulesAst': {'version': 2, 'rules': []}
      });
    } on VellumException catch (e) {
      print('invalidAst: code=${e.code} status=${e.statusCode}');
    }
  } finally {
    try {
      await client
          .httpTransport('POST', rulesUrl, headers, {'rulesAst': originalAst});
    } finally {
      client.dispose();
    }
  }
}

Map<String, dynamic> objectMap(Object? value, String context) {
  if (value is VellumHttpResponse) value = value.body;
  if (value is! Map<String, dynamic>)
    throw FormatException('Expected object: $context');
  return value;
}
