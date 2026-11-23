import 'dart:io';
// Executed against the live PostgreSQL API by scripts/run-dart-examples.mjs.
//
// Batch write — onboard two users atomically.
// What you'll build: one batch that creates two users, patches one and deletes a
// stale user; a second batch with a stale ifVersion fails the whole request.
// Real-world scenario: provisioning a profile and settings row together so a
// partial signup can never be observed. `vellum_flutter` has no `batchWrite`
// helper, so `client.request('POST', '/batchWrite', body: ...)` is used.
import 'package:vellum_flutter/vellum_flutter.dart';

Future<void> main() async {
  final endpoint = Platform.environment['VELLUM_API_BASE'] ??
      const String.fromEnvironment('VELLUM_API_BASE',
          defaultValue: 'http://127.0.0.1:8080');
  final projectId = Platform.environment['VELLUM_PROJECT_ID'] ??
      const String.fromEnvironment('VELLUM_PROJECT_ID');
  final apiKey = Platform.environment['VELLUM_API_KEY'] ??
      const String.fromEnvironment('VELLUM_API_KEY');

  final client =
      VellumClient(endpoint: endpoint, projectId: projectId, apiKey: apiKey);
  final prefix =
      'ex_flutter_batch_write_${DateTime.now().microsecondsSinceEpoch}';
  final docPath = (String id) => '$prefix/$id';

  try {
    print('=== Batch Write (Flutter) ===');
    await client.request('POST', '/documents/${docPath('stale-user')}', body: {
      'data': {'seats': 0}
    });

    final result = await client.request('POST', '/batchWrite', body: {
      'writes': [
        {
          'type': 'create',
          'path': docPath('u1'),
          'data': {'seats': 1, 'group': 'onboarding'}
        },
        {
          'type': 'set',
          'path': docPath('u2'),
          'data': {'seats': 2, 'group': 'onboarding'}
        },
        {
          'type': 'update',
          'path': docPath('u1'),
          'data': {'seats': 10}
        },
        {'type': 'delete', 'path': docPath('stale-user')},
      ],
    });
    print('batch responseKeys=${result.keys.toList()}');

    final u1 = await client.doc(docPath('u1')).get();
    final u2 = await client.doc(docPath('u2')).get();
    print('u1 seats=${u1.data()?['seats']} u2 seats=${u2.data()?['seats']}');

    try {
      await client.request('POST', '/batchWrite', body: {
        'writes': [
          {
            'type': 'update',
            'path': docPath('u1'),
            'data': {'seats': 999},
            'ifVersion': 1
          },
          {
            'type': 'create',
            'path': docPath('should-not-exist'),
            'data': {'seats': 0}
          },
        ],
      });
    } on VellumException catch (e) {
      print('preconditionBatchCode=${e.code} status=${e.statusCode}');
    }
  } finally {
    for (final id in ['u1', 'u2', 'stale-user', 'should-not-exist']) {
      try {
        await client.doc(docPath(id)).delete();
      } catch (_) {}
    }
    client.dispose();
  }
}
