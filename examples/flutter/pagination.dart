import 'dart:io';
// Executed against the live PostgreSQL API by scripts/run-dart-examples.mjs.
//
// Cursor pagination — list users two at a time via opaque cursors.
// What you'll build: a paged user directory that follows `nextCursor` into
// `startAfter` until no cursor is returned.
// Real-world scenario: an admin list avoids SQL OFFSET; each page is anchored
// to the last row of the previous page. `vellum_flutter` exposes `startAfter`
// only (no `startAt`).
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
      'ex_flutter_pagination_${DateTime.now().microsecondsSinceEpoch}';
  final col = client.collection(prefix);

  try {
    print('=== Cursor Pagination (Flutter) ===');
    for (var i = 0; i < 6; i++) {
      await col
          .doc('u$i')
          .set({'seq': i, 'status': 'active', 'name': 'user-$i'});
    }

    final base = col.where('status', '==', 'active').orderBy('seq').limit(2);
    Query<Map<String, dynamic>> query = base;
    final seen = <String>[];
    var pageNumber = 0;

    while (true) {
      final page = await query.get();
      pageNumber++;
      final ids = page.docs.map((d) => d.id).toList();
      seen.addAll(ids);
      final next = page.nextCursor;
      print('page=$pageNumber ids=$ids cursorReturned=${next != null}');
      if (next == null) break;
      query = base.startAfter(next);
      if (pageNumber >= 10) break;
    }
    print(
        'pages=$pageNumber total=${seen.length} unique=${seen.toSet().length}');
  } finally {
    for (var i = 0; i < 6; i++) {
      try {
        await col.doc('u$i').delete();
      } catch (_) {}
    }
    client.dispose();
  }
}
