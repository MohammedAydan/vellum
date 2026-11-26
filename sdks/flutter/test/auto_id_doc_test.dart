import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

VellumClient _client(
  Map<String, Map<String, Object?>> store,
  List<String> calls,
) {
  return VellumClient(
    baseUrl: 'http://localhost:8080/v1/projects/p',
    projectId: 'p',
    apiKey: 'pk_test_secret_123',
    warnOnMissingIndexes: false,
    httpTransport: (String method, String url, Map<String, String> headers,
        Map<String, dynamic>? body) async {
      calls.add('$method $url');
      final path =
          Uri.decodeFull(url.split('/documents/').last.split('?').first);
      if (method == 'PUT') {
        store[path] = (body!['data'] as Map).cast<String, Object?>();
        return VellumHttpResponse(body: <String, Object?>{
          'path': path,
          'documentId': path.split('/').last,
          'version': 1,
          'data': store[path],
        });
      }
      if (!store.containsKey(path)) {
        throw const VellumException(
          code: 'NOT_FOUND',
          message: 'Document not found',
          statusCode: 404,
        );
      }
      return VellumHttpResponse(body: <String, Object?>{
        'path': path,
        'documentId': path.split('/').last,
        'version': 1,
        'data': store[path],
      });
    },
  );
}

void main() {
  group('collection.doc() with optional id', () {
    test('generates a 20 char id locally with no network request', () {
      final calls = <String>[];
      final ref = _client({}, calls).collection('posts').doc();
      expect(ref.id, matches(RegExp(r'^[0-9A-Za-z]{20}$')));
      expect(ref.path, 'posts/${ref.id}');
      expect(calls, isEmpty);
    });

    test('ids are unique and sort by time', () {
      final ids = {for (var i = 0; i < 2000; i++) generateVellumAutoId()};
      expect(ids.length, 2000);
      expect(
        generateVellumAutoId(DateTime.fromMillisecondsSinceEpoch(1000))
            .compareTo(generateVellumAutoId(
                DateTime.fromMillisecondsSinceEpoch(1001))),
        lessThan(0),
      );
    });

    test('doc() then set() creates the document under the generated id',
        () async {
      final store = <String, Map<String, Object?>>{};
      final ref = _client(store, <String>[]).collection('posts').doc();
      await ref.set(<String, Object?>{'title': 'hello'});
      expect(store[ref.path], <String, Object?>{'title': 'hello'});
      final snap = await ref.get();
      expect(snap.exists, isTrue);
      expect(snap.id, ref.id);
    });

    test('doc() then get() before saving gives exists=false and null data',
        () async {
      final ref = _client({}, <String>[]).collection('posts').doc();
      final snap = await ref.get();
      expect(snap.exists, isFalse);
      expect(snap.data(), isNull);
      expect(snap.id, ref.id);
    });

    test("doc('id') addresses the explicit document", () async {
      final store = <String, Map<String, Object?>>{
        'posts/custom-id': <String, Object?>{'a': 1},
      };
      final ref =
          _client(store, <String>[]).collection('posts').doc('custom-id');
      expect(ref.id, 'custom-id');
      expect((await ref.get()).data(), <String, Object?>{'a': 1});
    });

    test('explicit ids resolve a missing document as exists == false', () async {
      final ref = _client({}, <String>[]).collection('posts').doc('missing');
      final snap = await ref.get();
      expect(snap.exists, isFalse);
      expect(snap.data(), isNull);
    });
  });
}
