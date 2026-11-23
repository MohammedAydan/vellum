import 'dart:convert';
import 'package:test/test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

class UserModel {
  final String id;
  final String name;
  final int age;

  UserModel({required this.id, required this.name, required this.age});

  factory UserModel.fromJson(Map<String, dynamic> json, String id) {
    return UserModel(
      id: id,
      name: json['name'] as String,
      age: json['age'] as int,
    );
  }

  Map<String, dynamic> toJson() => {
        'name': name,
        'age': age,
      };
}

void main() {
  group('VellumWire Codec', () {
    test('encodes and decodes int64 properly', () {
      final encoded = VellumWire.int64(9007199254740991);
      expect(encoded['\$t'], equals('int'));
      expect(encoded['\$v'], equals('9007199254740991'));

      final decoded = VellumWire.decodeWireValue(encoded);
      expect(decoded, equals(9007199254740991));
    });

    test('encodes and decodes timestamp properly', () {
      final now = DateTime.utc(2026, 11, 15, 12, 0, 0);
      final encoded = VellumWire.timestamp(now);
      expect(encoded['\$t'], equals('ts'));
      expect(encoded['\$v'], equals('2026-11-15T12:00:00.000Z'));
      expect(encoded['\$ms'], equals(now.millisecondsSinceEpoch));

      final decoded = VellumWire.decodeWireValue(encoded);
      expect(decoded, equals(now));
    });

    test('encodes and decodes reference properly', () {
      final encoded = VellumWire.reference('users/usr_123');
      expect(encoded['\$t'], equals('ref'));
      expect(encoded['\$v'], equals('users/usr_123'));

      final decoded = VellumWire.decodeWireValue(encoded);
      expect(decoded, equals('users/usr_123'));
    });

    test('encodes and decodes bytes properly', () {
      final raw = utf8.encode('Hello VELLUM');
      final encoded = VellumWire.bytes(raw);
      expect(encoded['\$t'], equals('bytes'));
      expect(encoded['\$v'], equals(base64Encode(raw)));

      final decoded = VellumWire.decodeWireValue(encoded);
      expect(decoded, equals(raw));
    });

    test('encodes and decodes geopoint properly', () {
      final encoded = VellumWire.geopoint(37.7749, -122.4194);
      expect(encoded['\$t'], equals('geo'));
      expect(encoded['\$v'], equals({'lat': 37.7749, 'lng': -122.4194}));

      final decoded = VellumWire.decodeWireValue(encoded);
      expect(decoded, equals({'lat': 37.7749, 'lng': -122.4194}));
    });

    test('escapes and unescapes map reserved keys', () {
      final mapWithTag = {'\$t': 'custom', 'val': 123};
      final escaped = VellumWire.escapeMap(mapWithTag);
      expect(escaped['\$t'], equals('map'));
      expect(escaped['\$v'], equals(mapWithTag));
    });
  });

  group('FieldValue Transformations', () {
    test('generates atomic operations payload', () {
      expect(FieldValue.serverTimestamp(), equals({'\$op': 'serverTimestamp'}));
      expect(FieldValue.increment(5), equals({'\$op': 'inc', 'by': 5}));
      expect(FieldValue.arrayUnion(['a', 'b']), equals({
        '\$op': 'arrayUnion',
        'elements': ['a', 'b'],
      }));
      expect(FieldValue.arrayRemove(['c']), equals({
        '\$op': 'arrayRemove',
        'elements': ['c'],
      }));
      expect(FieldValue.delete(), equals({'\$op': 'deleteField'}));
      expect(FieldValue.deleteField(), equals({'\$op': 'deleteField'}));
    });
  });

  group('Path Parsing & Client Construction', () {
    final client = VellumClient(
      endpoint: 'http://localhost:8080',
      projectId: 'proj_test',
      apiKey: 'pk_test_12345',
      httpTransport: (method, url, headers, body) async => <String, dynamic>{},
    );

    test('parses collection and document references correctly', () {
      final col = client.collection('/users/');
      expect(col.collectionPath, equals('users'));

      final doc = col.doc('usr_001');
      expect(doc.path, equals('users/usr_001'));
      expect(doc.id, equals('usr_001'));

      final directDoc = client.doc('/users/usr_002');
      expect(directDoc.path, equals('users/usr_002'));
      expect(directDoc.id, equals('usr_002'));
    });

    test('throws error on uneven document path segments', () {
      expect(
        () => client.doc('users'),
        throwsA(isA<VellumException>().having(
          (e) => e.code,
          'code',
          equals('INVALID_DOCUMENT_PATH'),
        )),
      );
    });

    test('builds baseUrl properly with encoding', () {
      expect(
        client.baseUrl,
        equals('http://localhost:8080/v1/projects/proj_test'),
      );
    });
  });

  group('Query Builder', () {
    final client = VellumClient(
      endpoint: 'http://localhost:8080',
      projectId: 'p',
      apiKey: 'k',
      httpTransport: (m, u, h, b) async => <String, dynamic>{},
    );

    test('constructs structured query specification', () {
      final q = client
          .collection('orders')
          .where('status', '==', 'pending')
          .where('amount', '>=', 50)
          .orderBy('createdAt', dir: 'desc')
          .limit(25)
          .startAfter('cursor_abc123');

      final spec = q.toQuerySpec();
      expect(spec['collectionPath'], equals('orders'));
      expect(spec['limit'], equals(25));
      expect(spec['startAfter'], equals('cursor_abc123'));
      expect(
        spec['where'],
        equals([
          {'field': 'status', 'op': '==', 'value': 'pending'},
          {'field': 'amount', 'op': '>=', 'value': 50},
        ]),
      );
      expect(
        spec['orderBy'],
        equals([
          {'field': 'createdAt', 'dir': 'desc'},
        ]),
      );
    });
  });

  group('withConverter<T>()', () {
    test('converts document data to strongly-typed model', () async {
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: (method, url, headers, body) async {
          return {
            'documentId': 'usr_42',
            'path': 'users/usr_42',
            'version': 1,
            'data': {'name': 'Ada Lovelace', 'age': 36},
          };
        },
      );

      final userCol = client.collection('users').withConverter<UserModel>(
            fromVellum: (data, id) => UserModel.fromJson(data, id),
            toVellum: (user) => user.toJson(),
          );

      final doc = userCol.doc('usr_42');
      final snap = await doc.get();

      expect(snap.exists, isTrue);
      expect(snap.data()?.name, equals('Ada Lovelace'));
      expect(snap.data()?.age, equals(36));
    });
  });

  group('OCC Transaction Context & Retries', () {
    test('commits transaction with token', () async {
      var beginCalled = false;
      var commitCalled = false;

      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: (method, url, headers, body) async {
          if (url.endsWith('/transactions:begin')) {
            beginCalled = true;
            return {'transactionToken': 'tok_xyz987'};
          }
          if (url.endsWith('/transactions:commit')) {
            commitCalled = true;
            expect(body?['transactionToken'], equals('tok_xyz987'));
            return {'status': 'committed', 'commitTimestamp': '2026-11-15T00:00:00Z'};
          }
          if (method == 'GET') {
            return {
              'documentId': 'acc_01',
              'path': 'accounts/acc_01',
              'version': 3,
              'data': {'balance': 100},
            };
          }
          return {};
        },
      );

      final finalBalance = await client.runTransaction((tx) async {
        final docRef = client.collection('accounts').doc('acc_01');
        final snap = await tx.get(docRef);
        final current = (snap.data()?['balance'] as int?) ?? 0;
        final updated = current + 50;
        tx.set(docRef, {'balance': updated});
        return updated;
      });

      expect(beginCalled, isTrue);
      expect(commitCalled, isTrue);
      expect(finalBalance, equals(150));
    });

    test('retries on ABORTED_CONFLICT up to maxAttempts', () async {
      var attempts = 0;

      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: (method, url, headers, body) async {
          if (url.endsWith('/transactions:begin')) {
            return {'transactionToken': 'tok_${attempts++}'};
          }
          if (url.endsWith('/transactions:commit')) {
            if (attempts < 3) {
              throw const VellumException(
                code: 'ABORTED_CONFLICT',
                message: 'Version conflict',
                statusCode: 409,
              );
            }
            return {'status': 'committed'};
          }
          return {};
        },
      );

      final res = await client.runTransaction((tx) async {
        final ref = client.collection('items').doc('i1');
        tx.set(ref, {'count': 10});
        return 'success';
      });

      expect(res, equals('success'));
      expect(attempts, equals(3));
    });
  });

  group('Full-Jitter Exponential Backoff', () {
    test('computes backoff within bounds', () {
      for (var attempt = 0; attempt < 10; attempt++) {
        final backoff = computeReconnectBackoffMs(attempt);
        expect(backoff, greaterThanOrEqualTo(0));
        expect(backoff, lessThanOrEqualTo(30000));
      }
    });
  });

  group('In-memory cache', () {
    test('caches and retrieves document snapshots', () {
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: (m, u, h, b) async => {},
      );

      const snap = DocumentSnapshot<Map<String, dynamic>>(
        id: 'doc1',
        path: 'users/doc1',
        version: 1,
        data: {'name': 'Test'},
      );

      client.setCachedDocument('users/doc1', snap);
      final retrieved = client.getCachedDocument('users/doc1');
      expect(retrieved, isNotNull);
      expect(retrieved?.id, equals('doc1'));

      client.clearCache();
      expect(client.getCachedDocument('users/doc1'), isNull);
    });
  });

  group('Realtime WebSocket parity ', () {
    test('wraps query specs in the canonical nested WS frame', () {
      final client = VellumClient(
        endpoint: 'http://localhost:8080',
        projectId: 'p',
        apiKey: 'k',
        httpTransport: (m, u, h, b) async => {},
      );
      final query = client
          .query('tasks')
          .where('ownerId', '==', 'user-1')
          .orderBy('priority', dir: 'desc')
          .startAfter('opaque-cursor');

      expect(query.toRealtimeQuerySpec(), equals(<String, dynamic>{
        'collectionPath': 'tasks',
        'where': <Map<String, dynamic>>[
          <String, dynamic>{'field': 'ownerId', 'op': '==', 'value': 'user-1'},
        ],
        'orderBy': <Map<String, dynamic>>[
          <String, dynamic>{'field': 'priority', 'direction': 'desc'},
        ],
        'limit': 50,
      }));
    });

    test('converts endpoints to the canonical realtime URL', () {
      expect(vellumRealtimeUrl('http://localhost:8080'), equals('ws://localhost:8080/v1/realtime'));
      expect(vellumRealtimeUrl('https://api.example.com/'), equals('wss://api.example.com/v1/realtime'));
      expect(vellumRealtimeUrl('ws://host:9000'), equals('ws://host:9000/v1/realtime'));
      expect(vellumRealtimeUrl('wss://host/v1/realtime'), equals('wss://host/v1/realtime'));
    });

    test('encodes and decodes protocol frames', () {
      final frame = {'type': 'subscribe', 'subId': 's1', 'path': 'users/u1'};
      final encoded = RealtimeFrames.encode(frame);
      expect(RealtimeFrames.decode(encoded), equals(frame));
      expect(RealtimeFrames.decode(utf8.encode(encoded)), equals(frame));
      expect(RealtimeFrames.decode('not json'), isNull);
      expect(RealtimeFrames.decode(42), isNull);
    });

    test('maps wire documents to typed snapshots', () {
      final snap = snapshotFromWire<Map<String, dynamic>>(
        {
          'path': 'users/u1',
          'documentId': 'u1',
          'version': 3,
          'data': {'name': 'Ada'},
        },
        (data, id) => data,
      );
      expect(snap, isNotNull);
      expect(snap!.id, equals('u1'));
      expect(snap.path, equals('users/u1'));
      expect(snap.version, equals(3));
      expect(snap.data(), equals({'name': 'Ada'}));
      expect(snapshotFromWire(42, (data, id) => data), isNull);
    });
  });
}
