import 'package:vellum_flutter/vellum_flutter.dart';
import 'package:test/test.dart';

/// Fake transport that returns a decoded body *and* response headers, matching
/// the style used by `v2_test.dart`.
typedef CollectionsHandler = VellumHttpResponse Function(
  String method,
  String url,
  Map<String, String> headers,
  Map<String, dynamic>? body,
);

const String _apiKey = 'pk_test_secret_123';
const String _base = 'http://localhost:8080/v1/projects/p';

VellumClient _client(CollectionsHandler handler) {
  return VellumClient(
    baseUrl: _base,
    projectId: 'p',
    apiKey: _apiKey,
    warnOnMissingIndexes: false,
    httpTransport: (String method, String url, Map<String, String> headers,
        Map<String, dynamic>? body) async {
      // The collection surface uses the same auth headers as every other route.
      expect(headers['x-vellum-api-key'], equals(_apiKey));
      expect(headers['X-Project-Key'], equals(_apiKey));
      return handler(method, url, headers, body);
    },
  );
}

Map<String, dynamic> _collectionJson({
  String id = 'col_1',
  String name = 'users',
  String? description = 'User directory',
  int? defaultTtlSeconds = 3600,
  Map<String, dynamic>? schemaValidation,
  int documentCount = 7,
  int storageBytes = 2048,
  String? lastDocumentAt = '2026-11-19T10:00:00.000Z',
}) =>
    <String, dynamic>{
      'id': id,
      'projectId': 'p',
      'name': name,
      'description': description,
      'defaultTtlSeconds': defaultTtlSeconds,
      'schemaValidation': schemaValidation ??
          <String, dynamic>{'requiredFields': <String>['email'], 'strict': true},
      'isSystem': false,
      'metadata': <String, dynamic>{},
      'createdAt': '2026-11-01T00:00:00.000Z',
      'updatedAt': '2026-11-18T00:00:00.000Z',
      'documentCount': documentCount,
      'storageBytes': storageBytes,
      'lastDocumentAt': lastDocumentAt,
    };

void main() {
  group('Flutter SDK collections lifecycle', () {
    test('listCollections maps stats and forwards search/limit/cursor', () async {
      late String method;
      late String url;
      final client = _client((m, u, h, b) {
        method = m;
        url = u;
        return VellumHttpResponse(body: <String, dynamic>{
          'collections': <Map<String, dynamic>>[
            _collectionJson(),
            _collectionJson(
              id: 'col_2',
              name: 'orders',
              description: null,
              defaultTtlSeconds: null,
              documentCount: 42,
              storageBytes: 8192,
              lastDocumentAt: null,
            ),
          ],
          'nextCursor': 'cur_page_2',
        });
      });

      final result = await client.listCollections(
        search: 'use',
        limit: 25,
        cursor: 'cur_page_1',
      );

      expect(method, equals('GET'));
      expect(url, startsWith('$_base/collections?'));
      final params = Uri.parse(url).queryParameters;
      expect(params['search'], equals('use'));
      expect(params['limit'], equals('25'));
      expect(params['cursor'], equals('cur_page_1'));

      expect(result.nextCursor, equals('cur_page_2'));
      expect(result.collections, hasLength(2));
      final users = result.collections.first;
      expect(users.id, equals('col_1'));
      expect(users.name, equals('users'));
      expect(users.description, equals('User directory'));
      expect(users.defaultTtlSeconds, equals(3600));
      expect(users.schemaValidation?['requiredFields'], equals(<String>['email']));
      expect(users.documentCount, equals(7));
      expect(users.storageBytes, equals(2048));
      expect(users.createdAt, equals('2026-11-01T00:00:00.000Z'));
      expect(users.lastDocumentAt, equals('2026-11-19T10:00:00.000Z'));

      final orders = result.collections.last;
      expect(orders.description, isNull);
      expect(orders.defaultTtlSeconds, isNull);
      expect(orders.lastDocumentAt, isNull);
      expect(orders.documentCount, equals(42));
      expect(orders.storageBytes, equals(8192));
    });

    test('listCollections omits the query string when no filters are given',
        () async {
      late String url;
      final client = _client((m, u, h, b) {
        url = u;
        return const VellumHttpResponse(body: <String, dynamic>{
          'collections': <dynamic>[],
          'nextCursor': null,
        });
      });

      final result = await client.listCollections();

      expect(url, equals('$_base/collections'));
      expect(result.collections, isEmpty);
      expect(result.nextCursor, isNull);
    });

    test('createCollection posts name and optional settings', () async {
      late String method;
      late String url;
      Map<String, dynamic>? body;
      final client = _client((m, u, h, b) {
        method = m;
        url = u;
        body = b;
        return VellumHttpResponse(body: _collectionJson());
      });

      final created = await client.createCollection(
        'users',
        description: 'User directory',
        defaultTtlSeconds: 3600,
        schemaValidation: <String, dynamic>{
          'requiredFields': <String>['email'],
          'strict': true,
        },
      );

      expect(method, equals('POST'));
      expect(url, equals('$_base/collections'));
      expect(body, equals(<String, dynamic>{
            'name': 'users',
            'description': 'User directory',
            'defaultTtlSeconds': 3600,
            'schemaValidation': <String, dynamic>{
              'requiredFields': <String>['email'],
              'strict': true,
            },
          }));
      expect(created.name, equals('users'));
      expect(created.documentCount, equals(7));
    });

    test('createCollection omits absent optional fields', () async {
      Map<String, dynamic>? body;
      final client = _client((m, u, h, b) {
        body = b;
        return VellumHttpResponse(body: _collectionJson(description: null));
      });

      await client.createCollection('users');

      expect(body, equals(<String, dynamic>{'name': 'users'}));
    });

    test('getCollectionInfo parses a single collection response', () async {
      late String method;
      late String url;
      final client = _client((m, u, h, b) {
        method = m;
        url = u;
        return VellumHttpResponse(body: _collectionJson(name: 'users'));
      });

      final info = await client.getCollectionInfo('users');

      expect(method, equals('GET'));
      expect(url, equals('$_base/collections/users'));
      expect(info, isNotNull);
      expect(info!.name, equals('users'));
      expect(info.schemaValidation?['strict'], isTrue);
      expect(info.toJson()['documentCount'], equals(7));
    });

    test('getCollectionInfo returns null on 404 and on an empty body', () async {
      var calls = 0;
      final client = _client((m, u, h, b) {
        calls++;
        if (calls == 1) {
          throw const VellumException(
            code: 'NOT_FOUND',
            message: 'Collection not found',
            statusCode: 404,
          );
        }
        return const VellumHttpResponse(body: null);
      });

      expect(await client.getCollectionInfo('missing'), isNull);
      expect(await client.getCollectionInfo('empty'), isNull);
      expect(calls, equals(2));
    });

    test('getCollectionInfo does not swallow non-404 errors', () async {
      final client = _client((m, u, h, b) {
        throw const VellumException(
          code: 'FORBIDDEN',
          message: 'Not allowed',
          statusCode: 403,
        );
      });

      await expectLater(
        client.getCollectionInfo('users'),
        throwsA(isA<VellumException>().having(
          (VellumException e) => e.statusCode,
          'statusCode',
          equals(403),
        )),
      );
    });

    test('updateCollection patches only the supplied fields', () async {
      late String method;
      late String url;
      Map<String, dynamic>? body;
      final client = _client((m, u, h, b) {
        method = m;
        url = u;
        body = b;
        return VellumHttpResponse(
          body: _collectionJson(description: 'Renamed', defaultTtlSeconds: 7200),
        );
      });

      final updated = await client.updateCollection(
        'users',
        description: 'Renamed',
        defaultTtlSeconds: 7200,
      );

      expect(method, equals('PATCH'));
      expect(url, equals('$_base/collections/users'));
      expect(body, equals(<String, dynamic>{
            'description': 'Renamed',
            'defaultTtlSeconds': 7200,
          }));
      expect(updated.description, equals('Renamed'));
      expect(updated.defaultTtlSeconds, equals(7200));
    });

    test('clearCollection maps deletedCount and freedBytes', () async {
      late String method;
      late String url;
      final client = _client((m, u, h, b) {
        method = m;
        url = u;
        return const VellumHttpResponse(body: <String, dynamic>{
          'deletedCount': 12,
          'freedBytes': 4096,
        });
      });

      final result = await client.clearCollection('users');

      expect(method, equals('POST'));
      expect(url, equals('$_base/collections/users/clear'));
      expect(result.deletedCount, equals(12));
      expect(result.freedBytes, equals(4096));
      expect(result.toJson(), equals(<String, dynamic>{
            'deletedCount': 12,
            'freedBytes': 4096,
          }));
    });

    test('deleteCollection maps the drop result', () async {
      late String method;
      late String url;
      final client = _client((m, u, h, b) {
        method = m;
        url = u;
        return const VellumHttpResponse(body: <String, dynamic>{
          'deletedCollection': true,
          'deletedDocuments': 12,
          'freedBytes': 4096,
        });
      });

      final result = await client.deleteCollection('users');

      expect(method, equals('DELETE'));
      expect(url, equals('$_base/collections/users'));
      expect(result.deletedCollection, isTrue);
      expect(result.deletedDocuments, equals(12));
      expect(result.freedBytes, equals(4096));
    });

    test('importDocuments sends the mode payload and maps per-item errors',
        () async {
      late String method;
      late String url;
      Map<String, dynamic>? body;
      final docs = <Map<String, dynamic>>[
        <String, dynamic>{'id': 'u1', 'email': 'a@example.com'},
        <String, dynamic>{'email': 'b@example.com'},
      ];
      final client = _client((m, u, h, b) {
        method = m;
        url = u;
        body = b;
        return const VellumHttpResponse(body: <String, dynamic>{
          'importedCount': 1,
          'skippedCount': 1,
          'errors': <Map<String, dynamic>>[
            <String, dynamic>{'index': 1, 'message': 'duplicate id'},
          ],
        });
      });

      final result = await client.importDocuments('users', docs,
          mode: 'insert_only');

      expect(method, equals('POST'));
      expect(url, equals('$_base/collections/users/import'));
      expect(body, equals(<String, dynamic>{
            'documents': docs,
            'mode': 'insert_only',
          }));
      expect(result.importedCount, equals(1));
      expect(result.skippedCount, equals(1));
      expect(result.errors.single['index'], equals(1));
      expect(result.errors.single['message'], equals('duplicate id'));
    });

    test('importDocuments omits mode when not supplied', () async {
      Map<String, dynamic>? body;
      final client = _client((m, u, h, b) {
        body = b;
        return const VellumHttpResponse(body: <String, dynamic>{
          'importedCount': 0,
          'skippedCount': 0,
          'errors': <dynamic>[],
        });
      });

      final result = await client.importDocuments(
        'users',
        const <Map<String, dynamic>>[],
      );

      expect(body, equals(<String, dynamic>{
            'documents': <dynamic>[],
          }));
      expect(result.errors, isEmpty);
    });

    test('exportDocuments builds the limit/cursor query string', () async {
      late String method;
      late String url;
      final client = _client((m, u, h, b) {
        method = m;
        url = u;
        return const VellumHttpResponse(body: <String, dynamic>{
          'documents': <Map<String, dynamic>>[
            <String, dynamic>{
              'id': 'u1',
              'path': 'users/u1',
              'data': <String, dynamic>{'email': 'a@example.com'},
            },
          ],
          'nextCursor': 'cur_next',
        });
      });

      final result = await client.exportDocuments(
        'users',
        limit: 50,
        cursor: 'cur_prev',
      );

      expect(method, equals('GET'));
      expect(url, startsWith('$_base/collections/users/export?'));
      final params = Uri.parse(url).queryParameters;
      expect(params['limit'], equals('50'));
      expect(params['cursor'], equals('cur_prev'));
      expect(result.documents, hasLength(1));
      expect(result.documents.first['id'], equals('u1'));
      expect(result.documents.first['data'], equals(<String, dynamic>{
            'email': 'a@example.com',
          }));
      expect(result.nextCursor, equals('cur_next'));
    });

    test('collection names are percent-encoded across every endpoint', () async {
      const String name = 'a b/c';
      final urls = <String>[];
      final client = _client((m, u, h, b) {
        urls.add(u);
        return VellumHttpResponse(body: _collectionJson(name: name));
      });

      await client.getCollectionInfo(name);
      await client.updateCollection(name, description: 'x');
      await client.clearCollection(name);
      await client.deleteCollection(name);
      await client.importDocuments(name, const <Map<String, dynamic>>[]);
      await client.exportDocuments(name);

      expect(urls, hasLength(6));
      for (final String url in urls) {
        expect(url, contains('/collections/a%20b%2Fc'));
        expect(url.contains('/a b/'), isFalse);
      }
    });

    test('VellumCollectionInfo tolerates numeric strings and missing fields',
        () async {
      final info = VellumCollectionInfo.fromJson(<String, dynamic>{
        'id': 'col_9',
        'name': 'legacy',
        'documentCount': '15',
        'storageBytes': '1024',
        'defaultTtlSeconds': '60',
      });

      expect(info.documentCount, equals(15));
      expect(info.storageBytes, equals(1024));
      expect(info.defaultTtlSeconds, equals(60));
      expect(info.description, isNull);
      expect(info.schemaValidation, isNull);
      expect(info.createdAt, isEmpty);
      expect(info.lastDocumentAt, isNull);
    });
  });
}
