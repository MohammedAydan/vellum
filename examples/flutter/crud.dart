import 'dart:io';
// Executed against the live PostgreSQL API by scripts/run-dart-examples.mjs.
//
// Document CRUD & optimistic concurrency — manage a versioned user profile.
// What you'll build: a profile created, merged, replaced, conditionally patched
// and deleted, plus a rejected stale write.
// Real-world scenario: a settings screen uses ifVersion so an old tab cannot
// silently overwrite newer profile data.
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
  final prefix = 'ex_flutter_crud_${DateTime.now().microsecondsSinceEpoch}';
  final ref = client.collection(prefix).doc('user-profile');

  try {
    print('=== Document CRUD & Optimistic Concurrency (Flutter) ===');

    // `create` has no dedicated helper on DocumentReference; use request().
    await client.request('POST', '/documents/${ref.path}', body: {
      'data': {
        'displayName': 'Ada Lovelace',
        'email': 'ada@example.com',
        'status': 'active',
        'loginCount': 0,
        'note': 'imported',
      },
    });
    final first = await ref.get();
    print('create profile: version=${first.version}');

    // Partial merge: verifying the email must not drop the other fields.
    await ref.set({'status': 'verified'}, merge: true);
    final merged = await ref.get();
    print(
        'set(merge): version=${merged.version} note=${merged.data()?['note']}');

    // Full replacement.
    await ref.set({'displayName': 'Ada L.'}, merge: false);
    final replaced = await ref.get();
    print(
        'set(replace): version=${replaced.version} keys=${replaced.data()?.keys.toList()}');

    // Guarded patch.
    await ref.update({'loginCount': 7}, ifVersion: 3);
    final patched = await ref.get();
    print(
        'update(ifVersion=3): version=${patched.version} loginCount=${patched.data()?['loginCount']}');

    try {
      await ref.update({'loginCount': 99}, ifVersion: 3);
    } on VellumException catch (e) {
      print('stale tab: code=${e.code} status=${e.statusCode}');
    }

    await ref.delete(ifVersion: 4);
    print('delete(ifVersion=4): true');
  } finally {
    try {
      await ref.delete();
    } catch (_) {
      // Best effort cleanup.
    }
    client.dispose();
  }
}
