import 'dart:io';
// Executed against the live PostgreSQL API by scripts/run-dart-examples.mjs.
//
// Atomic field transforms — update engagement counters without lost updates.
// What you'll build: a social post whose likes, tags and history change via
// `$op` sentinels, with a field removed and a server timestamp added.
// Real-world scenario: concurrent readers like and tag a post; sending field
// operations (not a client-side read/modify/write) keeps the counter correct.
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
      'ex_flutter_field_transforms_${DateTime.now().microsecondsSinceEpoch}';
  final ref = client.collection(prefix).doc('social-post');

  try {
    print('=== Atomic Field Transforms (Flutter) ===');

    await ref.set({
      'likes': 10,
      'tags': ['launch'],
      'history': ['featured'],
      'scratch': 'temporary'
    });
    print('before: ${(await ref.get()).data()}');

    await ref.update({
      'likes': FieldOp.increment(5),
      'tags': FieldOp.arrayUnion(['release', 'news']),
      'history': FieldOp.arrayRemove(['featured']),
      'updatedAt': FieldOp.serverTimestamp(),
      'scratch': FieldOp.deleteField(),
    });

    final data = (await ref.get()).data() ?? const <String, dynamic>{};
    final stamp = data['updatedAt'];
    print('likes=${data['likes']} tags=${data['tags']}');
    print(
        'scratchAbsent=${!data.containsKey('scratch')} updatedAtWire=${stamp is Map ? stamp['\$t'] : null}');
  } finally {
    try {
      await ref.delete();
    } catch (_) {
      // Best effort cleanup.
    }
    client.dispose();
  }
}
