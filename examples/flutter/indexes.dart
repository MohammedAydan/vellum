import 'dart:io';
// Executed against the live PostgreSQL API by scripts/run-dart-examples.mjs.
//
// Composite indexes — a leaderboard index over (team, score).
// What you'll build: a tenant composite index created as a row via the REST
// API, an ordered query that uses it, then cleanup.
// Real-world scenario: ranking players by team and score needs a composite
// index, but no CREATE INDEX is ever issued on the shared documents table.
// `vellum_flutter` has no index helper, so `client.request` is used directly.
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
  final prefix = 'ex_flutter_indexes_${DateTime.now().microsecondsSinceEpoch}';
  final col = client.collection(prefix);

  String? createdIndexId;
  try {
    print('=== Composite Indexes (Flutter) ===');
    for (final row in [
      {'id': 'p1', 'team': 'red', 'score': 10},
      {'id': 'p2', 'team': 'red', 'score': 30},
      {'id': 'p3', 'team': 'blue', 'score': 20},
    ]) {
      await col.doc(row['id'] as String).set(row);
    }

    final created = await client.request('POST', '/indexes', body: {
      'collectionPath': prefix,
      'fields': [
        {'path': 'team', 'dir': 'asc'},
        {'path': 'score', 'dir': 'asc'},
      ],
    });
    createdIndexId = created['id'] as String?;
    print('create: idReturned=${createdIndexId != null}');

    final listed = await client.request('GET', '/indexes');
    final indexes =
        (listed['indexes'] as List? ?? []).cast<Map<String, dynamic>>();
    print('listed: count=${indexes.length}');

    final rows = await col.where('team', '==', 'red').orderBy('score').get();
    print(
        'query ids=${rows.docs.map((d) => d.id).toList()} indexUsed=${rows.meta['indexUsed']}');
  } finally {
    if (createdIndexId != null) {
      try {
        await client.request('DELETE', '/indexes/$createdIndexId');
      } catch (_) {}
    }
    for (final id in ['p1', 'p2', 'p3']) {
      try {
        await col.doc(id).delete();
      } catch (_) {}
    }
    client.dispose();
  }
}
