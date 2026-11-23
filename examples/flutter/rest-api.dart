import 'dart:io';
// Executed against the live PostgreSQL API by scripts/run-dart-examples.mjs.
//
// Raw REST API — call the public data plane with `vellum_flutter`'s request()
// helper, which attaches the x-project-key header for you.
// What you'll build: document POST/GET/PUT/PATCH/DELETE, a collection listing
// and a structured /query call.
// Real-world scenario: request() is the escape hatch for endpoints that have no
// convenience method (indexes, rulesets, batchWrite, transactions, etc.).
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
  final prefix = 'ex_flutter_rest_api_${DateTime.now().microsecondsSinceEpoch}';
  final docPath = '$prefix/rest-doc';

  try {
    print('=== Raw REST API (Flutter) ===');

    await client.request('POST', '/documents/$docPath', body: {
      'data': {'title': 'raw', 'count': 1}
    });
    print('POST /documents/:path: 201');

    final fetched = await client.request('GET', '/documents/$docPath');
    print('GET: version=${fetched['version']}');

    final put = await client.request('PUT', '/documents/$docPath', body: {
      'data': {'title': 'merged'},
      'merge': true
    });
    print('PUT: version=${put['version']}');

    final patch = await client.request('PATCH', '/documents/$docPath', body: {
      'data': {'count': 2}
    });
    print('PATCH: version=${patch['version']}');

    final query = await client.request('POST', '/query', body: {
      'collectionPath': prefix,
      'where': [
        {'field': 'count', 'op': '==', 'value': 2},
      ],
      'orderBy': [],
      'limit': 10,
      'select': null,
      'startAt': null,
      'startAfter': null,
    });
    final ids =
        (query['documents'] as List).map((d) => d['documentId']).toList();
    print('POST /query: ids=$ids');

    final listing = await client.request('GET', '/documents/$prefix?limit=10');
    print('GET collection: count=${(listing['documents'] as List).length}');

    await client.request('DELETE', '/documents/$docPath');
    print('DELETE: 200');
  } finally {
    try {
      await client.doc(docPath).delete();
    } catch (_) {}
    client.dispose();
  }
}
