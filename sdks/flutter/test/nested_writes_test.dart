import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

void main() {
  late List<Map<String, Object?>> calls;
  late VellumClient client;

  setUp(() {
    calls = <Map<String, Object?>>[];
    client = VellumClient(
      baseUrl: 'http://localhost:8080/v1/projects/p',
      projectId: 'p',
      apiKey: 'pk_test',
      httpTransport: (method, url, headers, body) async {
        calls
            .add(<String, Object?>{'method': method, 'url': url, 'body': body});
        return <String, Object?>{};
      },
    );
  });

  test('DocumentReference values in set/update/create become tagged references',
      () async {
    await client.collection('orders').doc('o1').set(<String, Object?>{
      'total': 250,
      'customer': client.doc('users/u_123'),
      'tags': <Object?>[client.doc('tags/t1')],
    });
    final data = (calls[0]['body'] as Map)['data'] as Map;
    expect(data['customer'], {r'$t': 'ref', r'$v': 'users/u_123'});
    expect((data['tags'] as List).first, {r'$t': 'ref', r'$v': 'tags/t1'});
    await client
        .collection('orders')
        .doc('o1')
        .update(<String, Object?>{'customer': client.doc('users/u_9')});
    expect(((calls[1]['body'] as Map)['data'] as Map)['customer'],
        {r'$t': 'ref', r'$v': 'users/u_9'});
  });

  test('add() creates under an auto id', () async {
    final ref =
        await client.collection('orders').add(<String, Object?>{'a': 1});
    expect(ref.id, hasLength(20));
    expect(calls.single['method'], 'POST');
  });

  test('addWithRelated writes parent and children in one batchWrite', () async {
    final ref = await client.collection('orders').addWithRelated(
      <String, Object?>{'total': 250, 'customer': client.doc('users/u_123')},
      <String, RelatedWrite>{
        'items': const RelatedWrite(
          collection: 'order_items',
          parentField: 'order',
          docs: <Map<String, Object?>>[
            <String, Object?>{'qty': 2},
            <String, Object?>{'qty': 1},
          ],
        ),
      },
    );
    expect(calls, hasLength(1));
    expect(calls.single['url'], endsWith('/batchWrite'));
    final writes =
        ((calls.single['body'] as Map)['writes'] as List).cast<Map<String, Object?>>();
    expect(writes, hasLength(3));
    expect(writes[0]['path'], ref.path);
    final parentData = writes[0]['data'] as Map;
    expect(parentData['customer'], {r'$t': 'ref', r'$v': 'users/u_123'});
    expect(parentData['items'], [
      {r'$t': 'ref', r'$v': writes[1]['path']},
      {r'$t': 'ref', r'$v': writes[2]['path']},
    ]);
    for (final child in writes.skip(1)) {
      expect((child['path'] as String).startsWith('order_items/'), isTrue);
      expect((child['data'] as Map)['order'], {r'$t': 'ref', r'$v': ref.path});
    }
  });

  test('addWithRelated rejects more than 100 documents', () async {
    expect(
      client
          .collection('orders')
          .addWithRelated(<String, Object?>{}, <String, RelatedWrite>{
        'items': RelatedWrite(
          collection: 'i',
          docs: List<Map<String, Object?>>.generate(
              100, (_) => <String, Object?>{}),
        ),
      }),
      throwsArgumentError,
    );
  });
}
