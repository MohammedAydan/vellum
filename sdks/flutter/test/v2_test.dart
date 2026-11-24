import 'dart:async';
import 'dart:convert';

import 'package:vellum_flutter/vellum_flutter.dart';
import 'package:flutter_test/flutter_test.dart';

/// Fake transport that returns a decoded body *and* a response-header map.
typedef V2Handler = VellumHttpResponse Function(
  String method,
  String url,
  Map<String, String> headers,
  Map<String, dynamic>? body,
);

final String _apiKey = 'pk_test_secret_123';
final String _bearer = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c3JfMSJ9.signature_value';

int _unique = 0;
String _fingerprint(String label) => 'fp-v2-$label-${_unique++}';

Map<String, String> _suggestHeaders(
  String fingerprint, {
  String? url,
  String reason = 'Add a composite index on (status, createdAt).',
  String collection = 'orders',
}) =>
    <String, String>{
      'x-vellum-index-suggestion': jsonEncode(<String, dynamic>{
        'fingerprint': fingerprint,
        'reason': reason,
        'collectionPath': collection,
        'fields': <Map<String, dynamic>>[
          <String, dynamic>{'path': 'status', 'dir': 'asc'},
          <String, dynamic>{'path': 'createdAt', 'dir': 'desc'},
        ],
      }),
      'x-vellum-index-url': url ??
          'http://localhost:3000/orgs/o/projects/p/indexes?suggest=abc123',
    };

VellumClient _client(
  V2Handler handler, {
  IndexSuggestionCallback? onIndexSuggestion,
  bool warnOnMissingIndexes = true,
}) {
  return VellumClient(
    baseUrl: 'http://localhost:8080/v1/projects/p',
    projectId: 'p',
    apiKey: _apiKey,
    onIndexSuggestion: onIndexSuggestion,
    warnOnMissingIndexes: warnOnMissingIndexes,
    httpTransport: (String method, String url, Map<String, String> headers,
        Map<String, dynamic>? body) async {
      // Prove the request carries secrets: none of them may reach the advisor.
      expect(headers['x-vellum-api-key'], equals(_apiKey));
      return handler(method, url, headers, body);
    },
  );
}

Future<List<String>> _capturePrint(Future<void> Function() action) async {
  final lines = <String>[];
  await runZoned(
    () async => action(),
    zoneSpecification: ZoneSpecification(
      print: (Zone self, ZoneDelegate parent, Zone zone, String line) {
        lines.add(line);
      },
    ),
  );
  return lines;
}

void main() {
  setUp(() {
    setOnIndexSuggestion(null);
    setWarnOnMissingIndexes(true);
    clearSeenIndexSuggestions();
  });

  group('V2 public types', () {
    test('VellumInclude.toJson serializes the full nested spec', () {
      final include = const VellumInclude(
        field: 'author',
        collection: 'users',
        as: 'writer',
        select: <String>['name', 'email'],
        include: <VellumInclude>[
          VellumInclude(field: 'profile', select: <String>['avatar']),
        ],
      );
      expect(include.toJson(), equals(<String, dynamic>{
            'field': 'author',
            'collection': 'users',
            'as': 'writer',
            'select': <String>['name', 'email'],
            'include': <Map<String, dynamic>>[
              <String, dynamic>{
                'field': 'profile',
                'select': <String>['avatar'],
              },
            ],
          }));
    });

    test('VellumInclude.toJson omits absent optional fields', () {
      expect(const VellumInclude(field: 'comments').toJson(),
          equals(<String, dynamic>{'field': 'comments'}));
    });

    test('AggregateMetric.toJson and convenience factories', () {
      expect(const AggregateMetric(op: 'count').toJson(),
          equals(<String, dynamic>{'op': 'count'}));
      expect(const AggregateMetric.sum('amount').toJson(),
          equals(<String, dynamic>{'op': 'sum', 'field': 'amount'}));
      expect(const AggregateMetric.avg('price').toJson(),
          equals(<String, dynamic>{'op': 'avg', 'field': 'price'}));
      expect(const AggregateMetric.min('x').op, equals('min'));
      expect(const AggregateMetric.max('x').op, equals('max'));
    });
  });

  group('Query V2 serialization', () {
    late VellumClient client;
    setUp(() {
      client = _client((m, u, h, b) => const VellumHttpResponse(body: <String, dynamic>{}));
    });

    test('include() accepts string shorthands and VellumInclude specs', () {
      final base = client.collection('posts');
      final q = base.include(<Object>[
        'author',
        const VellumInclude(field: 'comments', collection: 'comments'),
      ]);
      expect(q.toQuerySpec()['include'], equals(<Map<String, dynamic>>[
            <String, dynamic>{'field': 'author'},
            <String, dynamic>{'field': 'comments', 'collection': 'comments'},
          ]));
      // Original query is untouched (immutability).
      expect(base.toQuerySpec().containsKey('include'), isFalse);
    });

    test('select() serializes dot paths without mutating the receiver', () {
      final base = client.collection('users');
      final q = base.select(const <String>['name', 'author.profile.email']);
      expect(q.toQuerySpec()['select'], equals(<String>[
            'name',
            'author.profile.email',
          ]));
      expect(base.toQuerySpec().containsKey('select'), isFalse);
    });

    test('or() serializes disjunctive AND-groups', () {
      final groups = <List<Map<String, dynamic>>>[
        <Map<String, dynamic>>[
          <String, dynamic>{'field': 'status', 'op': '==', 'value': 'open'},
        ],
        <Map<String, dynamic>>[
          <String, dynamic>{'field': 'priority', 'op': '>=', 'value': 5},
        ],
      ];
      final spec = client.collection('tasks').or(groups).toQuerySpec();
      expect(spec['or'], equals(groups));
    });

    test('CI and text operators pass through where() without rejection', () {
      final spec = client
          .collection('posts')
          .where('title', 'contains_ci', 'hello')
          .where('slug', 'starts_with_ci', 'doc')
          .where('body', 'text_search', 'database')
          .toQuerySpec();
      expect(spec['where'], equals(<Map<String, dynamic>>[
            <String, dynamic>{'field': 'title', 'op': 'contains_ci', 'value': 'hello'},
            <String, dynamic>{'field': 'slug', 'op': 'starts_with_ci', 'value': 'doc'},
            <String, dynamic>{'field': 'body', 'op': 'text_search', 'value': 'database'},
          ]));
    });

    test('include/select/or also flow into the realtime query spec', () {
      final spec = client
          .collection('posts')
          .include(const <Object>['author'])
          .select(const <String>['title'])
          .or(<List<Map<String, dynamic>>>[
            <Map<String, dynamic>>[
              <String, dynamic>{'field': 'status', 'op': '==', 'value': 'open'},
            ],
          ])
          .toRealtimeQuerySpec();
      expect(spec['include'], equals(<Map<String, dynamic>>[
            <String, dynamic>{'field': 'author'},
          ]));
      expect(spec['select'], equals(<String>['title']));
      expect((spec['or'] as List).length, equals(1));
    });
  });

  group('Aggregate and bulk-delete requests', () {
    String? method;
    String? url;
    Map<String, dynamic>? body;

    VellumClient recordingClient(Object? response) {
      return _client((m, u, h, b) {
        method = m;
        url = u;
        body = b;
        return VellumHttpResponse(body: response);
      });
    }

    setUp(() {
      method = null;
      url = null;
      body = null;
    });

    test('count() posts the metrics body and returns rows.first.count', () async {
      final client = recordingClient(<String, dynamic>{
        'rows': <Map<String, dynamic>>[<String, dynamic>{'count': 7}],
        'executionTimeMs': 1.5,
      });
      final result = await client.collection('orders').where('status', '==', 'open').count();
      expect(result, equals(7));
      expect(method, equals('POST'));
      expect(url, endsWith('/documents:aggregate'));
      expect(body, equals(<String, dynamic>{
            'collectionPath': 'orders',
            'where': <Map<String, dynamic>>[
              <String, dynamic>{'field': 'status', 'op': '==', 'value': 'open'},
            ],
            'metrics': <String, dynamic>{
              'count': <String, dynamic>{'op': 'count'},
            },
          }));
    });

    test('sum() posts a sum metric and returns the numeric result', () async {
      final client = recordingClient(<String, dynamic>{
        'rows': <Map<String, dynamic>>[<String, dynamic>{'sum': 123.5}],
      });
      final result = await client.collection('orders').sum('total');
      expect(result, equals(123.5));
      expect(body?['metrics'], equals(<String, dynamic>{
            'sum': <String, dynamic>{'op': 'sum', 'field': 'total'},
          }));
    });

    test('avg() posts an avg metric and returns the numeric result', () async {
      final client = recordingClient(<String, dynamic>{
        'rows': <Map<String, dynamic>>[<String, dynamic>{'avg': 41}],
      });
      final result = await client.collection('orders').avg('total');
      expect(result, equals(41));
      expect(body?['metrics'], equals(<String, dynamic>{
            'avg': <String, dynamic>{'op': 'avg', 'field': 'total'},
          }));
    });

    test('aggregate() forwards groupBy and multiple named metrics', () async {
      final client = recordingClient(<String, dynamic>{
        'rows': <Map<String, dynamic>>[
          <String, dynamic>{'status': 'open', 'n': 2, 'maxTotal': 99},
        ],
        'executionTimeMs': 2.0,
      });
      final result = await client.collection('orders').aggregate(
        groupBy: const <String>['status'],
        metrics: <String, AggregateMetric>{
          'n': const AggregateMetric.count(),
          'maxTotal': const AggregateMetric.max('total'),
        },
      );
      expect(result['rows'], isA<List<Object?>>());
      expect(result['executionTimeMs'], equals(2.0));
      expect(body?['groupBy'], equals(<String>['status']));
      expect(body?['metrics'], equals(<String, dynamic>{
            'n': <String, dynamic>{'op': 'count'},
            'maxTotal': <String, dynamic>{'op': 'max', 'field': 'total'},
          }));
    });

    test('deleteWhere() posts bulk-delete and returns deletedCount', () async {
      final client = recordingClient(<String, dynamic>{'deletedCount': 12});
      final result = await client.collection('orders')
          .where('status', '==', 'stale')
          .deleteWhere(limit: 250);
      expect(result, equals(12));
      expect(method, equals('POST'));
      expect(url, endsWith('/documents:bulk-delete'));
      expect(body, equals(<String, dynamic>{
            'collectionPath': 'orders',
            'where': <Map<String, dynamic>>[
              <String, dynamic>{'field': 'status', 'op': '==', 'value': 'stale'},
            ],
            'limit': 250,
          }));
    });
  });

  group('DocumentReference V2 writes and reads', () {
    late String method;
    late String url;
    late Map<String, dynamic>? body;
    late VellumClient client;

    setUp(() {
      client = _client((m, u, h, b) {
        method = m;
        url = u;
        body = b;
        if (m == 'GET') {
          return const VellumHttpResponse(body: <String, dynamic>{
            'documentId': 'p1',
            'path': 'posts/p1',
            'version': 3,
            'data': <String, dynamic>{'title': 'VELLUM V2'},
            '_included': <String, dynamic>{
              'author': <String, dynamic>{'name': 'Ada'},
            },
            '_redactedRefs': <String>['users/private'],
          });
        }
        return const VellumHttpResponse(body: <String, dynamic>{});
      });
    });

    test('set() sends ttlSeconds, expiresAt and upsert in the body', () async {
      await client.doc('posts/p1').set(
        <String, dynamic>{'title': 'x'},
        ttlSeconds: 3600,
        expiresAt: '2026-12-01T00:00:00.000Z',
        upsert: true,
      );
      expect(method, equals('PUT'));
      expect(url, endsWith('/documents/posts/p1'));
      expect(body, equals(<String, dynamic>{
            'data': <String, dynamic>{'title': 'x'},
            'merge': false,
            'ttlSeconds': 3600,
            'expiresAt': '2026-12-01T00:00:00.000Z',
            'upsert': true,
          }));
    });

    test('create() uses the POST create route with TTL fields', () async {
      await client.doc('posts/p1').create(
        <String, dynamic>{'title': 'x'},
        ttlSeconds: 60,
      );
      expect(method, equals('POST'));
      expect(body, equals(<String, dynamic>{
            'data': <String, dynamic>{'title': 'x'},
            'ttlSeconds': 60,
          }));
    });

    test('upsert() forwards upsert: true through set()', () async {
      await client.doc('posts/p1').upsert(
        <String, dynamic>{'title': 'x'},
        expiresAt: '2026-12-01T00:00:00.000Z',
      );
      expect(method, equals('PUT'));
      expect(body?['upsert'], isTrue);
      expect(body?['expiresAt'], equals('2026-12-01T00:00:00.000Z'));
    });

    test('get(include:, select:) sends JSON query params and typed snapshot fields', () async {
      final snap = await client.doc('posts/p1').get(
        include: <Object>['author'],
        select: const <String>['title', 'author.name'],
      );
      expect(method, equals('GET'));
      final params = Uri.parse(url).queryParameters;
      expect(jsonDecode(params['include']!), equals(<Map<String, dynamic>>[
            <String, dynamic>{'field': 'author'},
          ]));
      expect(jsonDecode(params['select']!), equals(<String>['title', 'author.name']));
      final author = snap.included['author'];
      expect(author is Map<String, Object?> ? author['name'] : null, equals('Ada'));
      expect(snap.redactedRefs, equals(<String>['users/private']));
    });

    test('snapshot getters default to empty collections without includes', () {
      const snap = DocumentSnapshot<Map<String, dynamic>>(
        id: 'p1',
        path: 'posts/p1',
        version: 1,
        data: <String, dynamic>{},
      );
      expect(snap.included, isEmpty);
      expect(snap.redactedRefs, isEmpty);
    });
  });

  group('Index advisor warnings', () {
    test('requestMap handles plain bodies and VellumHttpResponse bodies', () async {
      final plain = await requestMap(
        (m, u, h, b) async => <String, dynamic>{'ok': true},
        'GET',
        'http://localhost/x',
        const <String, String>{},
        null,
      );
      expect(plain, equals(<String, dynamic>{'ok': true}));
      final wrapped = await requestMap(
        (m, u, h, b) async => const VellumHttpResponse(
          body: <String, dynamic>{'ok': 2},
          headers: <String, String>{},
        ),
        'GET',
        'http://localhost/x',
        const <String, String>{},
        null,
      );
      expect(wrapped, equals(<String, dynamic>{'ok': 2}));
    });

    test('first sighting prints a multi-line warning and invokes the callback', () async {
      final suggestions = <VellumIndexSuggestion>[];
      final fp = _fingerprint('first');
      final client = _client(
        (m, u, h, b) => VellumHttpResponse(
          body: <String, dynamic>{'documents': <dynamic>[]},
          headers: _suggestHeaders(fp),
        ),
        onIndexSuggestion: suggestions.add,
      );
      final lines = await _capturePrint(() async {
        await client.collection('orders').get();
      });
      expect(lines, hasLength(1));
      expect(lines.single, contains('[VELLUM Index Advisor]'));
      expect(lines.single, contains('\n'));
      expect(lines.single, contains('Add a composite index'));
      expect(lines.single, contains('http://localhost:3000/orgs/o'));
      expect(suggestions, hasLength(1));
      expect(suggestions.single.fingerprint, equals(fp));
    });

    test('two identical fingerprints warn and callback exactly once', () async {
      final suggestions = <VellumIndexSuggestion>[];
      final fp = _fingerprint('dedupe');
      final client = _client(
        (m, u, h, b) => VellumHttpResponse(
          body: <String, dynamic>{'documents': <dynamic>[]},
          headers: _suggestHeaders(fp),
        ),
        onIndexSuggestion: suggestions.add,
      );
      final lines = await _capturePrint(() async {
        await client.collection('orders').get();
        await client.collection('orders').get();
      });
      expect(lines, hasLength(1));
      expect(suggestions, hasLength(1));
    });

    test('different fingerprints each produce their own warning', () async {
      final suggestions = <VellumIndexSuggestion>[];
      final client = _client(
        (m, u, h, b) => VellumHttpResponse(
          body: <String, dynamic>{'documents': <dynamic>[]},
          headers: _suggestHeaders(_fingerprint('distinct')),
        ),
        onIndexSuggestion: suggestions.add,
      );
      final lines = await _capturePrint(() async {
        await client.collection('orders').get();
        await client.collection('invoices').get();
      });
      expect(lines, hasLength(2));
      expect(suggestions, hasLength(2));
    });

    test('warnOnMissingIndexes: false disables both print and callback', () async {
      final suggestions = <VellumIndexSuggestion>[];
      final client = _client(
        (m, u, h, b) => VellumHttpResponse(
          body: <String, dynamic>{'documents': <dynamic>[]},
          headers: _suggestHeaders(_fingerprint('disabled')),
        ),
        onIndexSuggestion: suggestions.add,
        warnOnMissingIndexes: false,
      );
      final lines = await _capturePrint(() async {
        await client.collection('orders').get();
      });
      expect(lines, isEmpty);
      expect(suggestions, isEmpty);
    });

    test('custom callback receives the parsed suggestion payload', () async {
      VellumIndexSuggestion? received;
      final fp = _fingerprint('payload');
      final client = _client(
        (m, u, h, b) => VellumHttpResponse(
          body: <String, dynamic>{'documents': <dynamic>[]},
          headers: _suggestHeaders(
            fp,
            url: 'http://localhost:3000/indexes?suggest=xyz',
            reason: 'ESR: equality status, sort createdAt',
            collection: 'orders',
          ),
        ),
        onIndexSuggestion: (suggestion) => received = suggestion,
      );
      await _capturePrint(() async {
        await client.collection('orders').get();
      });
      expect(received, isNotNull);
      expect(received!.fingerprint, equals(fp));
      expect(received!.reason, equals('ESR: equality status, sort createdAt'));
      expect(received!.collectionPath, equals('orders'));
      expect(received!.url, endsWith('suggest=xyz'));
      expect(received!.fields.first['path'], equals('status'));
      expect(received!.payload['fingerprint'], equals(fp));
      expect(received!.toJson()['reason'], equals(received!.reason));
    });

    test('setOnIndexSuggestion works as a process-wide fallback', () async {
      final suggestions = <VellumIndexSuggestion>[];
      setOnIndexSuggestion(suggestions.add);
      final client = _client((m, u, h, b) => VellumHttpResponse(
            body: <String, dynamic>{'documents': <dynamic>[]},
            headers: _suggestHeaders(_fingerprint('global')),
          ));
      await _capturePrint(() async {
        await client.collection('orders').get();
      });
      expect(suggestions, hasLength(1));
    });

    test('warning output never prints API keys or bearer tokens', () async {
      final client = _client((m, u, h, b) => VellumHttpResponse(
            body: <String, dynamic>{'documents': <dynamic>[]},
            headers: _suggestHeaders(
              _fingerprint('secrets'),
              url: 'http://localhost:3000/indexes?suggest=abc&apiKey=$_apiKey',
              reason: 'Retry with $_bearer',
            ),
          ));
      final lines = await _capturePrint(() async {
        await client.collection('orders').get();
      });
      final output = lines.join('\n');
      expect(output, contains('<redacted>'));
      expect(output.contains(_apiKey), isFalse);
      expect(output.contains(_bearer), isFalse);
      expect(output.contains('eyJhbGciOiJIUzI1NiJ9'), isFalse);
    });

    test('missing fingerprint falls back to a hashed URL that still dedupes', () async {
      final suggestions = <VellumIndexSuggestion>[];
      final url = 'http://localhost:3000/indexes?suggest=fallback-${_unique++}';
      final client = _client((m, u, h, b) => VellumHttpResponse(
            body: <String, dynamic>{'documents': <dynamic>[]},
            headers: <String, String>{
              'x-vellum-index-url': url,
              'x-vellum-index-suggestion': jsonEncode(<String, dynamic>{
                'reason': 'no fingerprint supplied',
              }),
            },
          ), onIndexSuggestion: suggestions.add);
      final lines = await _capturePrint(() async {
        await client.collection('orders').get();
        await client.collection('orders').get();
      });
      expect(lines, hasLength(1));
      expect(suggestions, hasLength(1));
      expect(suggestions.single.fingerprint, startsWith('url:'));
      expect(suggestions.single.url, equals(url));
    });
  });
}
