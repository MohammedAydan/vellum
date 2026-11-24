import 'dart:io' show SocketException;

import 'package:test/test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

class _Server {
  final Map<String, Map<String, Object?>> docs = {
    'posts/a': <String, Object?>{'title': 'v1'},
  };
  bool online = true;
  int gets = 0;

  VellumClient client({CachePolicy? policy, bool enableCache = true}) =>
      VellumClient(
        baseUrl: 'http://localhost:8080/v1/projects/p',
        projectId: 'p',
        apiKey: 'pk_test',
        maxRetries: 0,
        enableCache: enableCache,
        cachePolicy: policy ?? CachePolicy.networkFirst,
        httpTransport: (method, url, headers, body) async {
          if (!online) throw const SocketException('offline');
          final path =
              Uri.decodeFull(url.split('/documents/').last.split('?').first);
          if (method == 'PUT' || method == 'PATCH') {
            docs[path] = {
              ...?docs[path],
              ...(body!['data'] as Map).cast<String, Object?>()
            };
            return <String, Object?>{
              'path': path,
              'documentId': path.split('/').last,
              'version': 2,
              'data': docs[path]
            };
          }
          if (method == 'DELETE') {
            docs.remove(path);
            return <String, Object?>{};
          }
          gets++;
          if (!docs.containsKey(path)) {
            throw const VellumException(
                code: 'NOT_FOUND', message: 'nf', statusCode: 404);
          }
          return <String, Object?>{
            'path': path,
            'documentId': path.split('/').last,
            'version': 1,
            'data': docs[path]
          };
        },
      );
}

Future<void> flush() => Future<void>.delayed(const Duration(milliseconds: 5));

void main() {
  test('networkFirst serves the stored copy with fromCache when offline',
      () async {
    final s = _Server();
    final ref = s.client().collection('posts').doc('a');
    final live = await ref.get();
    expect(live.fromCache, isFalse);
    await flush();
    s.online = false;
    final offline = await ref.get();
    expect(offline.exists, isTrue);
    expect(offline.data(), {'title': 'v1'});
    expect(offline.fromCache, isTrue);
  });

  test('networkFirst throws offline when nothing is stored', () async {
    final s = _Server()..online = false;
    expect(s.client().collection('posts').doc('a').get(),
        throwsA(isA<SocketException>()));
  });

  test('a real 404 is never masked by stored data', () async {
    final s = _Server();
    final ref = s.client().collection('posts').doc('a');
    await ref.get();
    await flush();
    s.docs.clear();
    expect(ref.get(), throwsA(isA<VellumException>()));
  });

  test('cacheFirst skips the network when fresh; networkOnly always hits it',
      () async {
    final s = _Server();
    final ref = s.client().collection('posts').doc('a');
    await ref.get(cachePolicy: CachePolicy.cacheFirst);
    await flush();
    await ref.get(cachePolicy: CachePolicy.cacheFirst);
    expect(s.gets, 1);
    await ref.get(cachePolicy: CachePolicy.networkOnly);
    expect(s.gets, 2);
  });

  test('cacheOnly never touches the network', () async {
    final s = _Server();
    final ref = s.client().collection('posts').doc('a');
    final miss = await ref.get(cachePolicy: CachePolicy.cacheOnly);
    expect(miss.exists, isFalse);
    expect(miss.fromCache, isTrue);
    expect(s.gets, 0);
    await ref.get();
    await flush();
    expect((await ref.get(cachePolicy: CachePolicy.cacheOnly)).data(),
        {'title': 'v1'});
  });

  test('writes invalidate the stored copy', () async {
    final s = _Server();
    final ref = s.client().collection('posts').doc('a');
    await ref.get();
    await flush();
    await ref.set(<String, Object?>{'title': 'v2'});
    await flush();
    expect((await ref.get(cachePolicy: CachePolicy.cacheOnly)).exists, isFalse);
  });

  test('enableCache: false disables the offline fallback', () async {
    final s = _Server();
    final ref = s.client(enableCache: false).collection('posts').doc('a');
    await ref.get();
    s.online = false;
    expect(ref.get(), throwsA(isA<SocketException>()));
  });

  test(
      'MemoryDocumentCacheStore evicts LRU past the budget and handles 50k docs',
      () async {
    final small = MemoryDocumentCacheStore(maxBytes: 4000);
    for (var i = 0; i < 20; i++) {
      await small.set(
          'k$i',
          CachedDocument(
              path: 'c/$i', value: {'b': 'x' * 500}, storedAt: DateTime.now()));
    }
    expect(small.sizeBytes, lessThanOrEqualTo(4000));
    expect(await small.get('k0'), isNull);
    expect(await small.get('k19'), isNotNull);

    final big = MemoryDocumentCacheStore();
    for (var i = 0; i < 50000; i++) {
      await big.set(
          'k$i',
          CachedDocument(
              path: 'c/$i', value: {'n': i}, storedAt: DateTime.now()));
    }
    expect(big.length, 50000);
    await big.deletePrefix('c/1');
    expect(big.length, lessThan(50000));
  });
}
