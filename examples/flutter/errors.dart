import 'dart:io';
// Executed against the live PostgreSQL API by scripts/run-dart-examples.mjs.
//
// Errors & limits — probe the canonical VELLUM error codes.
// What you'll build: a tour of quota/complexity/size/conflict errors, printing
// only stable code + status pairs.
// Real-world scenario: clients must handle these boundary failures gracefully.
// `VellumException` carries `code` and `statusCode` for every >=400 response.
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
  final prefix = 'ex_flutter_errors_${DateTime.now().microsecondsSinceEpoch}';

  Future<void> probe(String label, Future<void> Function() action) async {
    try {
      await action();
      print('$label: unexpected success');
    } on VellumException catch (e) {
      print('$label: code=${e.code} status=${e.statusCode}');
    }
  }

  try {
    print('=== Errors & Limits (Flutter) ===');

    await probe('limit', () => client.collection(prefix).limit(501).get());

    Query<Map<String, dynamic>> complex = client.collection(prefix);
    for (var i = 0; i < 11; i++) {
      complex = complex.where('f$i', '==', i);
    }
    await probe('whereClauses=11', () => complex.get());

    final writes = List.generate(
        101,
        (i) => {
              'type': 'create',
              'path': '$prefix/bulk-$i',
              'data': {'i': i},
            });
    await probe('batchOperations=101',
        () => client.request('POST', '/batchWrite', body: {'writes': writes}));

    await client.request('POST', '/indexes', body: {
      'collectionPath': prefix,
      'fields': [
        {'path': 'onlyField', 'dir': 'asc'},
      ]
    });
    await probe(
        'duplicateIndex',
        () => client.request('POST', '/indexes', body: {
              'collectionPath': prefix,
              'fields': [
                {'path': 'onlyField', 'dir': 'asc'},
              ],
            }));

    await client.doc('$prefix/stale').set({'n': 0});
    await probe('staleVersion',
        () => client.doc('$prefix/stale').update({'n': 2}, ifVersion: 0));

    await probe(
        'documentTooLarge',
        () => client.request('POST', '/documents/$prefix/too-large', body: {
              'data': {'blob': 'x' * 1048577},
            }));

    await probe('notFound', () => client.doc('$prefix/does-not-exist').get());
  } finally {
    try {
      await client.doc('$prefix/stale').delete();
    } catch (_) {}
    client.dispose();
  }
}
