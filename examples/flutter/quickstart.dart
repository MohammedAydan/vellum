import 'dart:io';
// Executed against the live PostgreSQL API by scripts/run-dart-examples.mjs.
//
// Quickstart — verify the connection and run one document lifecycle with
// `vellum_flutter`.
// What you'll build: a status-page service record that counts views.
// Real-world scenario: before building a screen, confirm the client can create,
// read, patch and delete a document. A short-lived server key is injected via
// `--dart-define=VELLUM_API_KEY=...`; no secret is hard-coded here.
import 'package:vellum_flutter/vellum_flutter.dart';

Future<void> main() async {
  final endpoint = Platform.environment['VELLUM_API_BASE'] ??
      const String.fromEnvironment('VELLUM_API_BASE',
          defaultValue: 'http://127.0.0.1:8080');
  final projectId = Platform.environment['VELLUM_PROJECT_ID'] ??
      const String.fromEnvironment('VELLUM_PROJECT_ID');
  final apiKey = Platform.environment['VELLUM_API_KEY'] ??
      const String.fromEnvironment('VELLUM_API_KEY');

  final client = VellumClient(
    endpoint: endpoint,
    projectId: projectId,
    apiKey: apiKey,
  );

  final prefix =
      'ex_flutter_quickstart_${DateTime.now().microsecondsSinceEpoch}';
  final ref = client.collection(prefix).doc('status-page');

  try {
    print('=== Quickstart (Flutter) ===');

    await ref
        .set({'service': 'checkout-api', 'status': 'operational', 'views': 0});
    final created = await ref.get();
    print('created: exists=${created.exists} version=${created.version}');

    await ref.update({'views': 1});
    final updated = await ref.get();
    final data = updated.data() ?? const <String, dynamic>{};
    print('updated: version=${updated.version} views=${data['views']}');

    await ref.delete();
    print('deleted: true');
  } finally {
    try {
      await ref.delete();
    } catch (_) {
      // Best effort cleanup; the doc may already be gone.
    }
    client.dispose();
  }
}
