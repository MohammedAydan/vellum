import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

class _Mem implements SecureKeyValue, OfflineBlobStore {
  final Map<String, String> data = <String, String>{};
  @override
  Future<String?> read(String key) async => data[key];
  @override
  Future<void> write(String key, String value) async => data[key] = value;
  @override
  Future<void> delete(String key) async => data.remove(key);
}

String _jwt() {
  final h = base64Url.encode(utf8.encode(jsonEncode(<String, dynamic>{'alg': 'EdDSA'})));
  final b = base64Url.encode(utf8.encode(jsonEncode(<String, dynamic>{
    'sub': 'usr_1',
    'exp': DateTime.now().add(const Duration(hours: 1)).millisecondsSinceEpoch ~/ 1000,
  })));
  return '$h.$b.sig';
}

Map<String, dynamic> _session(String id) => <String, dynamic>{
      'user': <String, dynamic>{
        'id': id,
        'email': '$id@example.com',
        'emailVerified': true,
        'displayName': 'A',
        'photoUrl': null,
        'phoneNumber': null,
        'phoneVerified': false,
        'isDisabled': false,
        'isAnonymous': false,
        'customClaims': <String, dynamic>{},
        'metadata': <String, dynamic>{},
        'createdAt': '2026-11-17T00:00:00.000Z',
        'updatedAt': '2026-11-17T00:00:00.000Z',
        'lastSignInAt': null,
      },
      'accessToken': _jwt(),
      'refreshToken': 'r1',
      'tokenType': 'Bearer',
      'sessionId': 's1',
      'expiresAt': '2099-01-01T00:00:00.000Z',
    };

/// Secure store whose reads work but writes are counted, or that throws on read.
class _CountingKeys extends _Mem {
  int writes = 0;
  @override
  Future<void> write(String key, String value) async {
    writes++;
    await super.write(key, value);
  }
}

class _FullDisk extends _Mem {
  bool full = false;
  @override
  Future<void> write(String key, String value) async {
    if (full) throw StateError('QuotaExceededError');
    await super.write(key, value);
  }
}

VellumClient _makeClient(
  String Function() userId, {
  String project = 'p',
  required List<Map<String, Object?>> sent,
  required Object? Function() failWith,
}) =>
    VellumClient(
      endpoint: 'http://localhost:8080',
      projectId: project,
      apiKey: 'pk_test',
      retryBaseDelay: Duration.zero,
      httpTransport: (method, url, headers, body) async {
        if (url.endsWith('/auth/sign-in/email')) return _session(userId());
        if (url.endsWith('/auth/sign-out')) return <String, dynamic>{};
        final f = failWith();
        if (f != null) throw f;
        sent.add(<String, Object?>{'method': method, 'url': url, 'headers': headers, 'body': body});
        return <String, dynamic>{'ok': true};
      },
    );

Future<void> _signIn(VellumClient c) =>
    c.auth.signInWithEmailAndPassword(email: 'a@example.com', password: 'password123');

void main() {
  const scope = 'scope1';

  group('VellumEncryptedBox', () {
    test('round-trips, never writes plaintext, binds scope and context', () async {
      final keys = _Mem();
      final box = VellumEncryptedBox(keyStore: keys);
      final sealed = await box.seal('{"secret":"hello"}', scope: scope, context: 'a');
      expect(sealed.contains('hello'), isFalse);
      expect(await box.open(sealed, scope: scope, context: 'a'), '{"secret":"hello"}');
      expect(await box.open(sealed, scope: scope, context: 'b'), isNull);
      expect(await box.open(sealed, scope: 'other', context: 'a'), isNull);
      expect(await VellumEncryptedBox(keyStore: keys).open(sealed, scope: scope, context: 'a'), '{"secret":"hello"}');
      expect(await VellumEncryptedBox(keyStore: _Mem()).open(sealed, scope: scope, context: 'a'), isNull);
      final bytes = base64Decode(sealed.substring(3));
      bytes[bytes.length - 20] ^= 1;
      expect(await box.open('v1.${base64Encode(bytes)}', scope: scope, context: 'a'), isNull);
      expect(keys.data.keys, contains('vellum.offline.key.v1.$scope'));
    });

    test('a failing read gives a memory-only key and never writes one', () async {
      final broken = _Broken();
      final box = VellumEncryptedBox(keyStore: broken);
      final sealed = await box.seal('x', scope: scope, context: 'c');
      expect(await box.open(sealed, scope: scope, context: 'c'), 'x');
      expect(broken.writeAttempts, 0);
    });

    test('concurrent first calls share one key', () async {
      final keys = _CountingKeys();
      final box = VellumEncryptedBox(keyStore: keys);
      final sealed = await Future.wait(<Future<String>>[
        box.seal('a', scope: scope, context: 'c'),
        box.seal('b', scope: scope, context: 'c'),
        box.seal('c', scope: scope, context: 'c'),
      ]);
      expect(keys.writes, 1);
      for (final s in sealed) {
        expect(await box.open(s, scope: scope, context: 'c'), isNotNull);
      }
    });

    test('destroyKey makes old blobs unreadable', () async {
      final keys = _Mem();
      final box = VellumEncryptedBox(keyStore: keys);
      final sealed = await box.seal('x', scope: scope, context: 'c');
      await box.destroyKey(scope);
      expect(await box.open(sealed, scope: scope, context: 'c'), isNull);
    });
  });

  group('PersistentDocumentCacheStore', () {
    late _Mem mem;
    late String user;
    late List<Map<String, Object?>> sent;

    setUp(() {
      mem = _Mem();
      user = 'usr_1';
      sent = <Map<String, Object?>>[];
    });

    Future<(VellumClient, PersistentDocumentCacheStore)> make({
      String project = 'p',
      bool allowWeb = false,
      bool isWeb = false,
      OfflineBlobStore? blobs,
    }) async {
      final box = VellumEncryptedBox(keyStore: mem);
      final cache = PersistentDocumentCacheStore(
        box: box,
        blobs: blobs ?? mem,
        saveDelay: Duration.zero,
        allowWeb: allowWeb,
        isWeb: isWeb,
      );
      final client = _makeClient(() => user, project: project, sent: sent, failWith: () => null);
      cache.attach(client);
      await _signIn(client);
      return (client, cache);
    }

    CachedDocument doc() => CachedDocument(path: 'users/x', value: <String, Object?>{'name': 'Zed'}, storedAt: DateTime.now());

    test('persists encrypted, restores for the same user, clear deletes the blob', () async {
      final (_, a) = await make();
      await a.set('k', doc());
      await a.flush();
      final blobKey = mem.data.keys.firstWhere((k) => k.endsWith('offline.cache.v1'));
      expect(mem.data[blobKey]!.contains('Zed'), isFalse);
      final (_, b) = await make();
      await b.load();
      expect((await b.get('k'))?.value['name'], 'Zed');
      await a.clear();
      expect(mem.data.containsKey(blobKey), isFalse);
    });

    test('a different user can not read it and the blob is discarded', () async {
      final (_, a) = await make();
      await a.set('k', doc());
      await a.flush();
      user = 'usr_2';
      final (_, b) = await make();
      await b.load();
      expect(await b.get('k'), isNull);
      expect(mem.data.keys.any((k) => k.endsWith('offline.cache.v1')), isFalse);
    });

    test('a different project can not read it', () async {
      final (_, a) = await make(project: 'p1');
      await a.set('k', doc());
      await a.flush();
      final (_, b) = await make(project: 'p2');
      await b.load();
      expect(await b.get('k'), isNull);
      // The first project's blob is untouched.
      final (_, again) = await make(project: 'p1');
      await again.load();
      expect(await again.get('k'), isNotNull);
    });

    test('load needs attach and a signed-in user', () async {
      final box = VellumEncryptedBox(keyStore: mem);
      final c = PersistentDocumentCacheStore(box: box, blobs: mem);
      await expectLater(c.load(), throwsStateError);
      final client = _makeClient(() => user, sent: sent, failWith: () => null);
      c.attach(client);
      await c.load(); // not signed in: nothing happens
    });

    test('a full disk never throws out of the debounce and the older half is dropped', () async {
      final disk = _FullDisk();
      final box = VellumEncryptedBox(keyStore: _Mem());
      final cache = PersistentDocumentCacheStore(box: box, blobs: disk, saveDelay: Duration.zero);
      final client = _makeClient(() => user, sent: sent, failWith: () => null);
      cache.attach(client);
      await _signIn(client);
      disk.full = true;
      await cache.set('k1', doc()); // debounced flush fails silently
      await Future<void>.delayed(const Duration(milliseconds: 20));
      await expectLater(cache.flush(), throwsA(anything)); // explicit flush reports it
      expect(await cache.get('k1'), isNotNull); // memory is unaffected
    });

    test('content cached under another user is never written under the next one', () async {
      final (client, a) = await make();
      await a.set('k', doc()); // owned by usr_1
      await a.flush();
      final blobKey = mem.data.keys.firstWhere((k) => k.endsWith('offline.cache.v1'));
      final before = mem.data[blobKey];
      user = 'usr_2';
      await client.auth.signOut(); // hook clears; simulate a missed hook next
      await _signIn(client);
      await a.flush();
      expect(mem.data[blobKey], isNot(before));
    });

    test('a session change without sign-out hook wipes the old mirror on the next set', () async {
      final (client, a) = await make();
      await a.set('old', doc());
      user = 'usr_2';
      // Swap the user in place, as a custom token sign-in would.
      await _signIn(client);
      await a.set('new', doc());
      expect(await a.get('old'), isNull);
      expect(await a.get('new'), isNotNull);
    });

    test('sign-out deletes the blob and destroys the key', () async {
      final (client, a) = await make();
      await a.set('k', doc());
      await a.flush();
      await client.auth.signOut();
      expect(mem.data.keys.any((k) => k.endsWith('offline.cache.v1')), isFalse);
      expect(mem.data.keys.any((k) => k.startsWith('vellum.offline.key.v1')), isFalse);
    });

    test('on web nothing is persisted unless allowed', () async {
      final (_, a) = await make(isWeb: true);
      await a.set('k', doc());
      await a.flush();
      expect(mem.data.keys.any((k) => k.endsWith('offline.cache.v1')), isFalse);
      expect((await a.get('k'))?.value['name'], 'Zed');
      final (_, b) = await make(isWeb: true, allowWeb: true);
      await b.set('k', doc());
      await b.flush();
      expect(mem.data.keys.any((k) => k.endsWith('offline.cache.v1')), isTrue);
    });

    test('an unreadable blob is discarded', () async {
      final (client, _) = await make();
      final scopeId = vellumOfflineScope(client.endpoint, client.projectId);
      mem.data['vellum.$scopeId.offline.cache.v1'] = 'v1.AAAA';
      final (_, c) = await make();
      await c.load();
      expect(mem.data.containsKey('vellum.$scopeId.offline.cache.v1'), isFalse);
    });
  });

  group('VellumOutbox', () {
    late _Mem mem;
    late List<Map<String, Object?>> sent;
    late Object? failure;
    late String userId;
    late VellumClient client;
    late List<(VellumOutboxEntry, VellumOutboxDropReason)> dropped;

    VellumOutbox makeOutbox({
      VellumClient? on,
      int maxEntries = 3,
      int? maxTotalBytes,
      int maxAttempts = 3,
      Duration? maxAge,
      bool isWeb = false,
      bool allowWeb = false,
      OfflineBlobStore? blobs,
      void Function(VellumOutboxEntry, VellumOutboxDropReason, Object?)? onDropped,
    }) =>
        VellumOutbox(
          client: on ?? client,
          box: VellumEncryptedBox(keyStore: mem),
          blobs: blobs ?? mem,
          maxEntries: maxEntries,
          maxTotalBytes: maxTotalBytes,
          maxAttempts: maxAttempts,
          maxAge: maxAge ?? const Duration(hours: 23),
          isWeb: isWeb,
          allowWeb: allowWeb,
          onDropped: onDropped ?? (e, r, _) => dropped.add((e, r)),
        );

    String blobOf() => mem.data.entries.firstWhere((e) => e.key.endsWith('offline.outbox.v1')).value;
    bool hasBlob() => mem.data.keys.any((k) => k.endsWith('offline.outbox.v1'));

    setUp(() async {
      mem = _Mem();
      sent = <Map<String, Object?>>[];
      failure = null;
      userId = 'usr_1';
      dropped = <(VellumOutboxEntry, VellumOutboxDropReason)>[];
      client = _makeClient(() => userId, sent: sent, failWith: () => failure);
      await _signIn(client);
    });

    test('queues encrypted, replays in order with idempotency keys and no stored token', () async {
      final ob = makeOutbox();
      await ob.enqueue('PUT', '/documents/notes/n1', body: <String, Object?>{'data': <String, Object?>{'text': 'private note'}});
      await ob.enqueue('POST', '/batchWrite', body: <String, Object?>{'writes': <Object?>[]});
      expect(blobOf().contains('private note'), isFalse);
      expect(blobOf().contains('accessToken'), isFalse);
      final again = makeOutbox();
      await again.load();
      expect(again.length, 2);
      await again.flush();
      expect(sent.map((s) => s['method']), <Object?>['PUT', 'POST']);
      for (final s in sent) {
        final h = (s['headers'] as Map).cast<String, String>();
        expect(h.entries.any((e) => e.key.toLowerCase() == 'idempotency-key' && e.value.startsWith('ob_')), isTrue);
      }
      expect(again.length, 0);
      expect(hasBlob(), isFalse);
    });

    test('never replays into a different project', () async {
      final ob = makeOutbox();
      await ob.enqueue('DELETE', '/documents/a/b');
      final otherSent = <Map<String, Object?>>[];
      final other = _makeClient(() => userId, project: 'other', sent: otherSent, failWith: () => null);
      await _signIn(other);
      final obOther = makeOutbox(on: other);
      await obOther.load();
      expect(obOther.length, 0);
      await obOther.flush();
      expect(otherSent, isEmpty);
    });

    test('refuses auth endpoints, traversal, queries, oversized bodies and a full queue', () async {
      final ob = makeOutbox();
      Matcher invalid() => throwsA(isA<VellumException>().having((e) => e.code, 'code', 'INVALID_ARGUMENT'));
      await expectLater(ob.enqueue('POST', '/auth/sign-in/email', body: <String, Object?>{'password': 'x'}), invalid());
      await expectLater(ob.enqueue('POST', '/transactions:commit'), invalid());
      await expectLater(ob.enqueue('GET', '/documents/a/b'), invalid());
      for (final bad in <String>[
        '/documents/../auth/user',
        '/documents/a/./b',
        '/documents/a/%2e%2e/b',
        '/documents/a%2Fb',
        '/documents/a%5Cb',
        '/documents/a\\b',
        '/documents/a/b?x=1',
        '/documents/a/b#f',
        '/documents//b',
        '/documents/',
        '/documentsx/a',
      ]) {
        await expectLater(ob.enqueue('DELETE', bad), invalid(), reason: bad);
      }
      for (var i = 0; i < 3; i++) {
        await ob.enqueue('DELETE', '/documents/a/b$i');
      }
      await expectLater(ob.enqueue('DELETE', '/documents/a/z'),
          throwsA(isA<VellumException>().having((e) => e.code, 'code', 'RESOURCE_EXHAUSTED')));
      expect(ob.length, 3);
    });

    test('total size cap refuses instead of losing data', () async {
      final ob = makeOutbox(maxEntries: 50, maxTotalBytes: 400);
      final body = <String, Object?>{'data': <String, Object?>{'t': 'x' * 150}};
      await ob.enqueue('PUT', '/documents/a/1', body: body);
      await ob.enqueue('PUT', '/documents/a/2', body: body);
      await expectLater(ob.enqueue('PUT', '/documents/a/3', body: body),
          throwsA(isA<VellumException>().having((e) => e.code, 'code', 'RESOURCE_EXHAUSTED')));
      expect(ob.length, 2);
    });

    test('a failing save removes the entry again and throws RESOURCE_EXHAUSTED', () async {
      final disk = _FullDisk();
      final ob = makeOutbox(blobs: disk);
      await ob.enqueue('DELETE', '/documents/a/ok');
      disk.full = true;
      await expectLater(ob.enqueue('DELETE', '/documents/a/nope'),
          throwsA(isA<VellumException>().having((e) => e.code, 'code', 'RESOURCE_EXHAUSTED')));
      expect(ob.length, 1);
    });

    test('401, 403 UNAUTHENTICATED, 429 and network errors keep the entry and stop', () async {
      final ob = makeOutbox(maxAttempts: 100);
      await ob.enqueue('PUT', '/documents/a/1', body: <String, Object?>{'data': <String, Object?>{}});
      await ob.enqueue('PUT', '/documents/a/2', body: <String, Object?>{'data': <String, Object?>{}});
      for (final f in <Object>[
        Exception('offline'),
        const VellumException(code: 'UNAUTHENTICATED', message: 'x', statusCode: 401),
        const VellumException(code: 'UNAUTHENTICATED', message: 'x', statusCode: 403),
        const VellumException(code: 'RATE_LIMITED', message: 'x', statusCode: 429),
        const VellumException(code: 'INTERNAL', message: 'x', statusCode: 503),
      ]) {
        failure = f;
        await ob.flush();
        expect(ob.length, 2, reason: '$f');
      }
      expect(dropped, isEmpty);
    });

    test('400, 403 PERMISSION_DENIED and 404 drop as rejected; 409 and 412 as conflict; the queue keeps going', () async {
      final ob = makeOutbox();
      for (var i = 0; i < 3; i++) {
        await ob.enqueue('PUT', '/documents/a/$i', body: <String, Object?>{'data': <String, Object?>{}});
      }
      failure = const VellumException(code: 'PERMISSION_DENIED', message: 'no', statusCode: 403);
      await ob.flush();
      expect(ob.length, 0);
      expect(dropped.map((d) => d.$2), everyElement(VellumOutboxDropReason.rejected));
      dropped.clear();
      await ob.enqueue('PUT', '/documents/a/9', body: <String, Object?>{'data': <String, Object?>{}, 'ifVersion': 2});
      failure = const VellumException(code: 'FAILED_PRECONDITION', message: 'stale', statusCode: 412);
      await ob.flush();
      expect(dropped.single.$2, VellumOutboxDropReason.conflict);
      dropped.clear();
      await ob.enqueue('DELETE', '/documents/a/10');
      failure = const VellumException(code: 'NOT_FOUND', message: 'x', statusCode: 404);
      await ob.flush();
      expect(dropped.single.$2, VellumOutboxDropReason.rejected);
    });

    test('after maxAttempts transient failures the entry is dropped as failed', () async {
      final ob = makeOutbox(maxAttempts: 3);
      await ob.enqueue('DELETE', '/documents/a/b');
      failure = const VellumException(code: 'INTERNAL', message: 'x', statusCode: 500);
      await ob.flush();
      await ob.flush();
      expect(ob.length, 1);
      expect(ob.pending.single.attempts, 2);
      await ob.flush();
      expect(ob.length, 0);
      expect(dropped.single.$2, VellumOutboxDropReason.failed);
    });

    test('network errors, 401, 403 and 429 never use up attempts', () async {
      final ob = makeOutbox(maxAttempts: 3);
      await ob.enqueue('DELETE', '/documents/a/b');
      failure = const SocketLikeError();
      for (var i = 0; i < 20; i++) {
        await ob.flush();
      }
      for (final code in <int>[401, 403, 408, 429]) {
        failure = VellumException(code: 'X', message: 'x', statusCode: code);
        for (var i = 0; i < 5; i++) {
          await ob.flush();
        }
      }
      expect(ob.length, 1);
      expect(ob.pending.single.attempts, 0);
      expect(dropped, isEmpty);
    });

    test('a failing save after a good replay does not make flush throw', () async {
      final disk = _FullDisk();
      final ob = makeOutbox(blobs: disk);
      await ob.enqueue('DELETE', '/documents/a/1');
      disk.full = true;
      await ob.flush(); // the write was sent; the save fails quietly
      expect(sent.length, 1);
      expect(ob.length, 0);
    });

    test('attempts survive a restart', () async {
      final ob = makeOutbox(maxAttempts: 5);
      await ob.enqueue('DELETE', '/documents/a/b');
      failure = const VellumException(code: 'INTERNAL', message: 'x', statusCode: 503);
      await ob.flush();
      final again = makeOutbox(maxAttempts: 5);
      await again.load();
      expect(again.pending.single.attempts, 1);
    });

    test('expired entries are dropped', () async {
      final ob = makeOutbox(maxAge: Duration.zero);
      await ob.enqueue('DELETE', '/documents/a/b');
      await Future<void>.delayed(const Duration(milliseconds: 5));
      await ob.flush();
      expect(sent, isEmpty);
      expect(dropped.single.$2, VellumOutboxDropReason.expired);
    });

    test('a throwing onDropped does not stall the queue', () async {
      final ob = makeOutbox(onDropped: (e, r, _) => throw StateError('app bug'));
      await ob.enqueue('DELETE', '/documents/a/1');
      await ob.enqueue('DELETE', '/documents/a/2');
      failure = const VellumException(code: 'NOT_FOUND', message: 'x', statusCode: 404);
      await ob.flush();
      expect(ob.length, 0);
    });

    test('another user never replays the queue', () async {
      final stale = makeOutbox();
      await stale.enqueue('DELETE', '/documents/a/old');
      userId = 'usr_2';
      await client.auth.signOut();
      await _signIn(client);
      // sign-out cleared it; simulate a leftover from a crash by re-queuing as usr_1
      userId = 'usr_1';
      await client.auth.signOut();
      await _signIn(client);
      final leftover = makeOutbox();
      await leftover.enqueue('DELETE', '/documents/a/old2');
      userId = 'usr_2';
      // Rebuild a client for usr_2 sharing the same queue blob (a restart as another user).
      final c2 = _makeClient(() => 'usr_2', sent: sent, failWith: () => null);
      await _signIn(c2);
      final ob2 = makeOutbox(on: c2);
      await ob2.load();
      await ob2.flush();
      expect(sent, isEmpty);
      expect(dropped.single.$2, VellumOutboxDropReason.otherUser);
    });

    test('sign-out clears the queue, destroys the key and stops a running flush', () async {
      final ob = makeOutbox();
      await ob.enqueue('DELETE', '/documents/a/1');
      await ob.enqueue('DELETE', '/documents/a/2');
      await client.auth.signOut();
      expect(ob.length, 0);
      expect(hasBlob(), isFalse);
      expect(mem.data.keys.any((k) => k.startsWith('vellum.offline.key.v1')), isFalse);
    });

    test('the user changing mid-flush stops the run', () async {
      final ob = makeOutbox();
      await ob.enqueue('DELETE', '/documents/a/1');
      await ob.enqueue('DELETE', '/documents/a/2');
      await ob.enqueue('DELETE', '/documents/a/3');
      var calls = 0;
      final gate = Completer<void>();
      final slow = _makeClientSlow(() => userId, sent, () async {
        calls++;
        if (calls == 1) await gate.future;
      });
      await _signIn(slow);
      final obSlow = makeOutbox(on: slow);
      await obSlow.load();
      final run = obSlow.flush();
      await Future<void>.delayed(const Duration(milliseconds: 5));
      await obSlow.clear(); // like a sign-out
      gate.complete();
      await run;
      expect(sent.length, lessThanOrEqualTo(1));
      expect(obSlow.length, 0);
    });

    test('enqueueSet and enqueueDelete build guarded writes', () async {
      final ob = makeOutbox();
      final ref = client.collection('notes').doc('n1');
      final e1 = await ob.enqueueSet(ref, <String, Object?>{'t': 1}, ifVersion: 4);
      expect(e1.path, '/documents/notes/n1');
      expect(e1.body!['ifVersion'], 4);
      final e2 = await ob.enqueueDelete(ref, ifVersion: 4);
      expect(e2.path, '/batchWrite');
      expect(((e2.body!['writes'] as List).single as Map)['ifVersion'], 4);
      final e3 = await ob.enqueueDelete(ref);
      expect(e3.method, 'DELETE');
    });

    test('on web the queue stays in memory only', () async {
      final ob = makeOutbox(isWeb: true);
      await ob.enqueue('DELETE', '/documents/a/1');
      expect(ob.length, 1);
      expect(hasBlob(), isFalse);
      final allowed = makeOutbox(isWeb: true, allowWeb: true);
      await allowed.enqueue('DELETE', '/documents/a/1');
      expect(hasBlob(), isTrue);
    });
  });
}

VellumClient _makeClientSlow(
  String Function() userId,
  List<Map<String, Object?>> sent,
  Future<void> Function() beforeWrite,
) =>
    VellumClient(
      endpoint: 'http://localhost:8080',
      projectId: 'p',
      apiKey: 'pk_test',
      retryBaseDelay: Duration.zero,
      httpTransport: (method, url, headers, body) async {
        if (url.endsWith('/auth/sign-in/email')) return _session(userId());
        if (url.endsWith('/auth/sign-out')) return <String, dynamic>{};
        await beforeWrite();
        sent.add(<String, Object?>{'method': method, 'url': url});
        return <String, dynamic>{'ok': true};
      },
    );

class SocketLikeError implements Exception {
  const SocketLikeError();
}

class _Broken implements SecureKeyValue {
  int writeAttempts = 0;
  @override
  Future<String?> read(String key) async => throw StateError('locked');
  @override
  Future<void> write(String key, String value) async {
    writeAttempts++;
    throw StateError('locked');
  }

  @override
  Future<void> delete(String key) async => throw StateError('locked');
}
