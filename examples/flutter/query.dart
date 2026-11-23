import 'dart:io';
// Executed against the live PostgreSQL API by scripts/run-dart-examples.mjs.
//
// Structured queries — analytics filters over revenue events.
// What you'll build: a ranked "top events in a region" view plus a disjunctive
// `in` filter, using the immutable query builder.
// Real-world scenario: the widget needs only a few fields and an exact set of
// revenue bands. Note: `vellum_flutter`'s Query has no `select()` builder method;
// use `toQuerySpec()` with `client.request('POST', '/query', body: spec)` when
// field projection is required.
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
  final prefix = 'ex_flutter_query_${DateTime.now().microsecondsSinceEpoch}';
  final col = client.collection(prefix);

  try {
    print('=== Structured Queries (Flutter) ===');
    for (final fixture in [
      {'id': 'a', 'event': 'signup', 'region': 'north', 'revenue': 10},
      {'id': 'b', 'event': 'purchase', 'region': 'south', 'revenue': 20},
      {'id': 'c', 'event': 'renewal', 'region': 'north', 'revenue': 30},
      {'id': 'd', 'event': 'upgrade', 'region': 'south', 'revenue': 40},
      {'id': 'e', 'event': 'purchase', 'region': 'north', 'revenue': 50},
    ]) {
      await col.doc(fixture['id'] as String).set(fixture);
    }

    final topNorth = await col
        .where('region', '==', 'north')
        .orderBy('revenue', dir: 'desc')
        .limit(3)
        .get();
    print('top north ids=${topNorth.docs.map((d) => d.id).toList()}');
    for (final doc in topNorth.docs) {
      print('  ${doc.id}: ${doc.data()}');
    }

    final bands =
        await col.where('revenue', 'in', [10, 40]).orderBy('revenue').get();
    print('in filter ids=${bands.docs.map((d) => d.id).toList()}');

    final spec = col.where('region', '==', 'south').limit(1).toQuerySpec();
    print('toQuerySpec: $spec');
  } finally {
    // Best effort cleanup of the seeded fixtures.
    for (final id in ['a', 'b', 'c', 'd', 'e']) {
      try {
        await col.doc(id).delete();
      } catch (_) {}
    }
    client.dispose();
  }
}
