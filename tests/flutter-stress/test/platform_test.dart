import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:test/test.dart';
import 'package:vellum_flutter/vellum_flutter_core.dart';

late String origin, projectId, secret, publicKey, consoleToken;
late VellumClient db;
final stamp = DateTime.now().microsecondsSinceEpoch;
const password = 'Stress-Password-827!';

Future<Map<String, dynamic>> raw(String method, String path,
    [Map<String, Object?>? body, Map<String, String>? headers]) async {
  final request = http.Request(method, Uri.parse('$origin$path'));
  request.headers.addAll({'content-type': 'application/json', ...?headers});
  if (body != null) request.body = jsonEncode(body);
  final response = await http.Response.fromStream(await request.send());
  final decoded =
      response.body.isEmpty ? <String, dynamic>{} : jsonDecode(response.body);
  if (response.statusCode >= 400)
    throw StateError('$method $path: ${response.statusCode} $decoded');
  return (decoded as Map).cast<String, dynamic>();
}

VellumClient client([String? key, TokenStoragePort? storage]) => VellumClient(
      endpoint: origin,
      projectId: projectId,
      apiKey: key ?? secret,
      authStorage: storage,
      maxRetries: 3,
      retryBaseDelay: Duration(milliseconds: 100),
      warnOnMissingIndexes: false,
    );
Matcher status(int code) =>
    isA<VellumException>().having((e) => e.statusCode, 'status', code);
Future<void> rules(List<Map<String, Object?>> entries) async {
  await raw('POST', '/v1/projects/$projectId/rulesets', {
    'rulesAst': {'version': 1, 'rules': entries}
  });
}

String totp(String secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  var bits = 0, value = 0;
  final key = <int>[];
  for (final unit in secret.toUpperCase().split('')) {
    final index = alphabet.indexOf(unit);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      key.add((value >> bits) & 255);
    }
  }
  final counter = ByteData(8)
    ..setUint64(0, DateTime.now().millisecondsSinceEpoch ~/ 30000);
  final digest = Hmac(sha1, key).convert(counter.buffer.asUint8List()).bytes;
  final offset = digest.last & 15;
  final number = ((digest[offset] & 127) << 24) |
      (digest[offset + 1] << 16) |
      (digest[offset + 2] << 8) |
      digest[offset + 3];
  return (number % 1000000).toString().padLeft(6, '0');
}

Future<void> waitIndex(String id) async {
  for (var i = 0; i < 100; i++) {
    final list = await db.request('GET', '/indexes');
    final row =
        (list['indexes'] as List).cast<Map>().firstWhere((r) => r['id'] == id);
    if (row['status'] == 'ready') return;
    await Future<void>.delayed(Duration(milliseconds: 100));
  }
  throw TimeoutException('index did not become ready');
}

void main() {
  setUpAll(() async {
    origin = Platform.environment['VELLUM_STRESS_ORIGIN'] ?? '';
    final uri = Uri.parse(origin);
    if (uri.scheme != 'http' || uri.host != '127.0.0.1')
      throw StateError('Use run.ts, loopback server required');
    final session = await raw('POST', '/v1/auth/sign-up/email', {
      'name': 'Flutter Stress Owner',
      'email': 'console-$stamp@example.test',
      'password': password,
    });
    consoleToken = session['accessToken'] as String;
    final org = await raw('POST', '/v1/organizations', {
      'name': 'Flutter Stress',
      'slug': 'flutter-$stamp',
      'planTier': 'pro',
    }, {
      'authorization': 'Bearer $consoleToken'
    });
    final project =
        await raw('POST', '/v1/organizations/${org['id']}/projects', {
      'name': 'Flutter Stress',
      'slug': 'flutter-project-$stamp',
    }, {
      'authorization': 'Bearer $consoleToken'
    });
    projectId = project['project']['id'] as String;
    for (final type in ['secret', 'publishable']) {
      final key = await raw('POST', '/v1/projects/$projectId/api-keys',
          {'name': type, 'keyType': type});
      if (type == 'secret') {
        secret = key['rawKey'] as String;
      } else {
        publicKey = key['rawKey'] as String;
      }
    }
    db = client();
    await db.request('PATCH', '/auth/admin/config', body: {
      'requireEmailVerification': false,
      'enableAnonymousAuth': true,
      'maxSignupsPerHour': 1000
    });
  });
  tearDownAll(() => db.dispose());

  group('real PostgreSQL document and wire operations', () {
    test('create, duplicate create, merge, patch, version precondition, delete',
        () async {
      final ref = db.doc('crud/full');
      await ref.create({
        'name': 'first',
        'nested': {'a': 1},
        'keep': true
      });
      await expectLater(
          ref.create({'name': 'duplicate'}), throwsA(status(409)));
      final first = await ref.get();
      await ref.set({
        'nested': {'b': 2}
      }, merge: true);
      expect((await ref.get()).data()?['keep'], true);
      await expectLater(ref.update({'name': 'stale'}, ifVersion: first.version),
          throwsA(isA<VellumException>()));
      await ref.update({'name': 'updated'});
      expect((await ref.get()).data()?['name'], 'updated');
      await ref.delete();
      await expectLater(ref.get(), throwsA(status(404)));
    });
    test('unicode IDs, subcollections, and reserved URL characters', () async {
      final ref = db.doc('unicode/عربي &+%');
      await ref.set({'text': 'مرحبا 🌍'});
      expect((await ref.get()).data()?['text'], 'مرحبا 🌍');
      final child = ref.collection('children').doc('child');
      await child.set({'ok': true});
      expect((await child.get()).exists, true);
    });
    test('atomic field operations and nested wire values', () async {
      final ref = db.doc('wire/ops');
      await ref.set({
        'n': 2,
        'tags': ['a'],
        'remove': true,
        'ref': VellumWire.reference('crud/target'),
        'big': VellumWire.int64(9007199254740993),
        'bytes': VellumWire.bytes([0, 127, 255]),
        'geo': VellumWire.geopoint(30.0, 31.0)
      });
      await ref.update({
        'n': FieldValue.increment(5),
        'tags': FieldValue.arrayUnion(['a', 'b']),
        'remove': FieldValue.delete(),
        'at': FieldValue.serverTimestamp()
      });
      var data = (await ref.get()).data()!;
      expect(data['n'], 7);
      expect(data['tags'], ['a', 'b']);
      expect(data.containsKey('remove'), false);
      expect(VellumWire.decodeWireValue(data['big']), 9007199254740993);
      await ref.update({
        'tags': FieldValue.arrayRemove(['a'])
      });
      expect((await ref.get()).data()?['tags'], ['b']);
    });
    test('upsert and optimistic delete', () async {
      final ref = db.doc('crud/upsert');
      await ref.upsert({'v': 1});
      await ref.upsert({'v': 2});
      final snap = await ref.get();
      expect(snap.data()?['v'], 2);
      await expectLater(ref.delete(ifVersion: snap.version - 1),
          throwsA(isA<VellumException>()));
      await ref.delete(ifVersion: snap.version);
    });
    test('missing update and malformed query return SDK exceptions', () async {
      await expectLater(
          db.doc('crud/missing').update({'x': 1}), throwsA(status(404)));
      await expectLater(db.collection('crud').where('x', 'nonsense', 1).get(),
          throwsA(isA<VellumException>()));
    });
    test('TTL expiration is hidden from point reads and queries', () async {
      await db.doc('expiry/short').set({'v': 1}, ttlSeconds: 1);
      expect((await db.doc('expiry/short').get()).exists, true);
      await Future<void>.delayed(Duration(milliseconds: 1200));
      await expectLater(db.doc('expiry/short').get(), throwsA(status(404)));
      expect((await db.collection('expiry').get()).docs, isEmpty);
    });
    test('concurrent idempotent create succeeds with one logical mutation',
        () async {
      final ref = db.doc('crud/concurrent-replay');
      await Future.wait(List.generate(
          8, (_) => ref.create({'n': 1}, idempotencyKey: 'concurrent-$stamp')));
      expect((await ref.get()).version, 1);
    });
    test('idempotent creation replays without duplicate error', () async {
      final ref = db.doc('crud/idempotent');
      await ref.create({'v': 1}, idempotencyKey: 'flutter-create-$stamp');
      await ref.create({'v': 1}, idempotencyKey: 'flutter-create-$stamp');
      expect((await ref.get()).data()?['v'], 1);
    });
  });

  group('queries, pagination, aggregates and converters', () {
    setUpAll(() async {
      final batch = db.batch();
      for (var i = 0; i < 61; i++) {
        batch.set(db.doc('scores/d${i.toString().padLeft(3, '0')}'), {
          'rank': i,
          'group': i % 3,
          'nested': {'yes': true},
          'tags': ['common', 't${i % 2}']
        });
      }
      await batch.commitChunked(chunkSize: 13);
    });
    test('multi-page traversal has no gaps or duplicate IDs', () async {
      final docs = await db
          .collection('scores')
          .orderBy('rank')
          .streamDocuments(pageSize: 7)
          .toList();
      expect(docs.length, 61);
      expect(docs.map((d) => d.id).toSet().length, 61);
      expect(docs.map((d) => d.data()?['rank']), List.generate(61, (i) => i));
    });
    test('filters, descending order, limits and projection', () async {
      final page = await db
          .collection('scores')
          .where('rank', '>=', 50)
          .orderBy('rank', dir: 'desc')
          .limit(4)
          .select(['rank']).get();
      expect(page.docs.map((d) => d.data()?['rank']), [60, 59, 58, 57]);
      expect(page.docs.first.data()!.containsKey('tags'), false);
    });
    test('in and array-contains filters', () async {
      expect(
          (await db.collection('scores').where('group', 'in', [0, 1]).get())
              .docs
              .length,
          41);
      expect(
          (await db
                  .collection('scores')
                  .where('tags', 'array-contains', 'common')
                  .limit(100)
                  .get())
              .docs
              .length,
          61);
    });
    test('OR filters union correctly', () async {
      final result = await db.collection('scores').or([
        [
          {'field': 'rank', 'op': '==', 'value': 0}
        ],
        [
          {'field': 'rank', 'op': '==', 'value': 60}
        ]
      ]).get();
      expect(result.docs.length, 2);
    });
    test('secondary ordering remains correct across tied cursor pages',
        () async {
      final index = await db.request('POST', '/indexes', body: {
        'collectionPath': 'scores',
        'fields': [
          {'path': 'group', 'dir': 'asc'},
          {'path': 'rank', 'dir': 'desc'}
        ]
      });
      await waitIndex(index['id'] as String);
      addTearDown(() => db.request('DELETE', '/indexes/${index['id']}'));
      final docs = await db
          .collection('scores')
          .orderBy('group')
          .orderBy('rank', dir: 'desc')
          .streamDocuments(pageSize: 4)
          .toList();
      final expected = List.generate(61, (i) => i)
        ..sort((a, b) {
          final g = (a % 3).compareTo(b % 3);
          return g != 0 ? g : b.compareTo(a);
        });
      expect(docs.map((d) => d.data()?['rank']), expected);
    });
    test('descending signed numeric values page without lexical drift',
        () async {
      final values = [-100, -9, -1, 0, 1, 2, 9, 10, 100];
      for (var i = 0; i < values.length; i++) {
        await db.doc('signed/n$i').set({'v': values[i]});
      }
      final docs = await db
          .collection('signed')
          .orderBy('v', dir: 'desc')
          .streamDocuments(pageSize: 2)
          .toList();
      expect(docs.map((d) => d.data()?['v']), values.reversed);
    });
    test('count sum avg and grouped aggregates', () async {
      expect(await db.collection('scores').count(), 61);
      expect(await db.collection('scores').sum('rank'), 1830);
      expect(await db.collection('scores').avg('rank'), 30);
      final grouped = await db.collection('scores').aggregate(
          groupBy: ['group'], metrics: {'total': AggregateMetric.count()});
      expect((grouped['rows'] as List).length, 3);
    });
    test('typed converter works for get query and transactions', () async {
      final typed = db.collection('typed').withConverter<int>(
          fromVellum: (data, id) => data['v'] as int,
          toVellum: (value) => {'v': value});
      await typed.doc('one').set(42);
      expect((await typed.doc('one').get()).data(), 42);
      expect((await typed.get()).docs.single.data(), 42);
      await db.runTransaction((tx) async {
        final old = await tx.get(typed.doc('one'));
        tx.set(typed.doc('one'), old.data()! + 1);
      });
      expect((await typed.doc('one').get()).data(), 43);
    });
    test('maxPages bounds traversal and invalid cursor is rejected', () async {
      expect(
          (await db
                  .collection('scores')
                  .streamPages(pageSize: 5, maxPages: 2)
                  .toList())
              .length,
          2);
      await expectLater(
          db.collection('scores').startAfter('tampered-cursor').get(),
          throwsA(isA<VellumException>()));
    });
  });

  group('transactions and atomicity', () {
    test('atomic batch rolls back preceding write on missing update', () async {
      final b = db.batch().set(db.doc('atomic/no-leak'), {'v': 1}).update(
          db.doc('atomic/absent'), {'v': 2});
      await expectLater(b.commit(), throwsA(isA<VellumException>()));
      await expectLater(db.doc('atomic/no-leak').get(), throwsA(status(404)));
    });
    test('concurrent OCC transactions conserve all increments', () async {
      await Future<void>.delayed(Duration(milliseconds: 1100));
      final counter = db.doc('atomic/counter');
      await counter.set({'n': 0});
      final workers = <VellumClient>[];
      for (var i = 0; i < 8; i++) {
        final key = await raw('POST', '/v1/projects/$projectId/api-keys',
            {'name': 'occ-worker-$i', 'keyType': 'secret'});
        final worker = client(key['rawKey'] as String);
        workers.add(worker);
        addTearDown(worker.dispose);
      }
      await Future.wait(List.generate(
          8,
          (i) => workers[i].runTransaction((tx) async {
                final s = await tx.get(counter);
                await Future<void>.delayed(Duration(milliseconds: 8));
                tx.update(counter, {'n': (s.data()!['n'] as int) + 1});
              }, maxAttempts: 20)));
      expect((await counter.get()).data()?['n'], 8);
    });
    test('callback failure never commits staged writes', () async {
      await expectLater(db.runTransaction((tx) async {
        tx.set(db.doc('atomic/aborted'), {'v': 1});
        throw StateError('intentional');
      }), throwsStateError);
      await expectLater(db.doc('atomic/aborted').get(), throwsA(status(404)));
    });
    test('chunked writes validate size and empty input', () async {
      expect(await db.writeBatchChunked([]), isEmpty);
      await expectLater(db.writeBatchChunked([], chunkSize: 0),
          throwsA(isA<VellumException>()));
    });
  });

  group('end-user auth via endpoint plus projectId', () {
    late VellumClient user;
    late String email;
    setUp(() {
      user = client(publicKey);
      email = 'user-${DateTime.now().microsecondsSinceEpoch}@example.test';
    });
    tearDown(() => user.dispose());
    test('signup preserves displayName profile metadata and session', () async {
      final created = await user.auth.signUpWithEmailAndPassword(
          email: email,
          password: password,
          displayName: 'محمد Stress 🌍',
          metadata: {'source': 'stress'});
      expect(created.displayName, 'محمد Stress 🌍');
      expect(created.metadata['source'], 'stress');
      expect(created.accessToken, isNotEmpty);
      expect((await user.auth.getUser()).id, created.id);
      expect(user.auth.currentUser?.id, created.id);
    });
    test('logout login refresh profile update and non-enumerating reset',
        () async {
      final created = await user.auth.signUpWithEmailAndPassword(
          email: email, password: password, displayName: 'Before');
      await user.auth.signOut();
      expect(user.auth.currentUser, null);
      await user.auth
          .signInWithEmailAndPassword(email: email, password: password);
      expect(user.auth.currentUser?.id, created.id);
      expect(await user.auth.getIdToken(forceRefresh: true), isNotEmpty);
      final updated = await user.auth.updateProfile(displayName: 'After');
      expect(updated.displayName, 'After');
      await user.auth.sendPasswordResetEmail('nonexistent-$stamp@example.test');
    });
    test('wrong password and duplicate signup fail without erasing session',
        () async {
      final created = await user.auth
          .signUpWithEmailAndPassword(email: email, password: password);
      await expectLater(
          user.auth
              .signInWithEmailAndPassword(email: email, password: 'Wrong-827!'),
          throwsA(isA<VellumException>()));
      expect(user.auth.currentUser?.id, created.id);
      await expectLater(
          user.auth
              .signUpWithEmailAndPassword(email: email, password: password),
          throwsA(status(409)));
    });
    test('weak passwords and invalid email are rejected', () async {
      await expectLater(
          user.auth.signUpWithEmailAndPassword(email: email, password: 'x'),
          throwsA(isA<VellumException>()));
      await expectLater(
          user.auth
              .signUpWithEmailAndPassword(email: 'bad', password: password),
          throwsA(isA<VellumException>()));
    });
    test('anonymous auth creates a real anonymous session', () async {
      final anon = await user.auth.signInAnonymously(displayName: 'Guest');
      expect(anon.isAnonymous, true);
      expect(anon.displayName, 'Guest');
      await user.auth.signOut(allSessions: true);
      expect(user.auth.currentUser, null);
    });
    test('TOTP enrollment challenge recovery code and invalid code paths',
        () async {
      await db.request('PATCH', '/auth/admin/config',
          body: {'enableTotpMfa': true});
      await user.auth
          .signUpWithEmailAndPassword(email: email, password: password);
      final enrollment = await user.auth.enrollTotpMfa();
      expect(enrollment.secret, isNotEmpty);
      expect(enrollment.recoveryCodes, isNotEmpty);
      await expectLater(user.auth.confirmTotpMfa(code: 'bad-code'),
          throwsA(isA<VellumException>()));
      await user.auth.confirmTotpMfa(code: totp(enrollment.secret));
      await user.auth.signOut();
      final challenge = await user.auth
          .signInWithEmailAndPassword(email: email, password: password);
      expect(challenge, isA<VellumMfaRequired>());
      expect(user.auth.currentUser, null);
      final mfa = challenge as VellumMfaRequired;
      await expectLater(
          user.auth
              .verifyMfaChallenge(mfaTicket: mfa.mfaTicket, code: 'bad-code'),
          throwsA(isA<VellumException>()));
      final signed = await user.auth.verifyMfaChallenge(
          mfaTicket: mfa.mfaTicket,
          code: enrollment.recoveryCodes.first,
          factorType: 'recovery_code');
      expect(signed.id, isNotEmpty);
    });
    test('idempotent create replays after user token rotation', () async {
      await rules([
        {
          'match': 'replay/{id}',
          'allow': {'read': true, 'write': true}
        }
      ]);
      await user.auth
          .signUpWithEmailAndPassword(email: email, password: password);
      final ref = user.doc('replay/rotated');
      await ref.create({'n': 1}, idempotencyKey: 'rotated-$stamp');
      expect(await user.auth.getIdToken(forceRefresh: true), isNotNull);
      await ref.create({'n': 1}, idempotencyKey: 'rotated-$stamp');
      expect((await ref.get()).version, 1);
    });
    test('concurrent forced refreshes rotate a real session once', () async {
      await user.auth
          .signUpWithEmailAndPassword(email: email, password: password);
      final tokens = await Future.wait(
          List.generate(12, (_) => user.auth.getIdToken(forceRefresh: true)));
      expect(tokens.every((token) => token != null && token.isNotEmpty), true);
      expect(tokens.toSet().length, 1);
      expect((await user.auth.getUser()).email, email);
    });
    test('invalid reset verification OAuth and signed-out profile fail cleanly',
        () async {
      await expectLater(
          user.auth
              .confirmPasswordReset(token: 'bad-token', newPassword: password),
          throwsA(isA<VellumException>()));
      await expectLater(user.auth.confirmEmailVerification('bad-token'),
          throwsA(isA<VellumException>()));
      await expectLater(user.auth.getUser(), throwsA(isA<VellumException>()));
      await expectLater(
          user.auth.signInWithOAuth(provider: 'unknown', idToken: 'invalid'),
          throwsA(isA<VellumException>()));
    });
    test('session storage restore and independent auth streams', () async {
      final storage = InMemoryAuthTokenStorage();
      final a = client(publicKey, storage);
      final b = client(publicKey, storage);
      addTearDown(a.dispose);
      addTearDown(b.dispose);
      final events1 = <VellumUser?>[], events2 = <VellumUser?>[];
      final sub1 = a.auth.authStateChanges.listen(events1.add);
      final sub2 = a.auth.authStateChanges.listen(events2.add);
      final created = await a.auth
          .signUpWithEmailAndPassword(email: email, password: password);
      await b.auth.restore();
      expect(b.auth.currentUser?.id, created.id);
      await a.auth.signOut();
      await Future<void>.delayed(Duration(milliseconds: 10));
      expect(events1.whereType<VellumUser>().length, greaterThanOrEqualTo(1));
      expect(events2.length, events1.length);
      await sub1.cancel();
      await sub2.cancel();
    });
  });

  group('relations and security rules', () {
    test('include, reverse lookup and projection on actual stored references',
        () async {
      final author = db.doc('authors/ada');
      await author.set({'name': 'Ada', 'private': 'hidden'});
      for (var i = 0; i < 5; i++) {
        await db.doc('articles/a$i').set({
          'author': VellumWire.reference(author.path),
          'title': 'Article $i'
        });
      }
      final article = await db.doc('articles/a0').get(include: [
        VellumInclude(field: 'author', select: ['name'])
      ]);
      expect(article.included['author'], isNotNull);
      final refs = await author.referencedBy(
          collection: 'articles', field: 'author', limit: 2);
      expect(refs.documents.length, 2);
      expect(refs.nextCursor, isNotNull);
      final next = await author.referencedBy(
          collection: 'articles',
          field: 'author',
          limit: 2,
          cursor: refs.nextCursor);
      expect(
          next.documents
              .map((d) => d.id)
              .toSet()
              .intersection(refs.documents.map((d) => d.id).toSet()),
          isEmpty);
      expect(
          (await db.collection('articles').include(['author']).get())
              .docs
              .first
              .included,
          isNotEmpty);
    });
    test('denied include targets are redacted without leaking private fields',
        () async {
      await rules([
        {
          'match': 'visible/{id}',
          'allow': {'read': true}
        },
        {
          'match': 'hidden/{id}',
          'allow': {'read': false}
        },
      ]);
      await db.doc('hidden/secret').set({'private': 'must-not-leak'});
      await db
          .doc('visible/root')
          .set({'link': VellumWire.reference('hidden/secret')});
      final guest = client(publicKey);
      addTearDown(guest.dispose);
      final result = await guest.doc('visible/root').get(include: ['link']);
      expect(result.redactedRefs, isNotEmpty);
      expect(jsonEncode(result.included), isNot(contains('must-not-leak')));
    });
    test('owner rules allow self deny other users and anonymous calls',
        () async {
      await rules([
        {
          'match': 'private/{uid}',
          'allow': {
            'read': {
              'op': '==',
              'left': {'var': 'auth.uid'},
              'right': {'var': 'path.uid'}
            },
            'write': {
              'op': '==',
              'left': {'var': 'auth.uid'},
              'right': {'var': 'path.uid'}
            }
          }
        }
      ]);
      final a = client(publicKey),
          b = client(publicKey),
          guest = client(publicKey);
      addTearDown(a.dispose);
      addTearDown(b.dispose);
      addTearDown(guest.dispose);
      final owner = await a.auth.signUpWithEmailAndPassword(
          email: 'owner-$stamp@example.test', password: password);
      await b.auth.signUpWithEmailAndPassword(
          email: 'other-$stamp@example.test', password: password);
      await a.doc('private/${owner.id}').set({'secret': true});
      expect(
          (await a.doc('private/${owner.id}').get()).data()?['secret'], true);
      await expectLater(
          b.doc('private/${owner.id}').get(), throwsA(status(403)));
      await expectLater(
          guest.doc('private/${owner.id}').get(), throwsA(status(403)));
      await expectLater(b.doc('private/${owner.id}').update({'secret': false}),
          throwsA(status(403)));
    });
    for (final action in ['restrict', 'set_null', 'cascade']) {
      test('relation rule $action is applied atomically', () async {
        await raw('PUT', '/v1/projects/$projectId/relation-rules', {
          'rules': [
            {
              'collection': 'dependents',
              'field': 'parent',
              'targetCollection': 'parents',
              'onDelete': action
            }
          ]
        }, {
          'authorization': 'Bearer $consoleToken'
        });
        final parent = db.doc('parents/$action'),
            child = db.doc('dependents/$action');
        await parent.set({'kind': action});
        await child.set({'parent': VellumWire.reference(parent.path)});
        if (action == 'restrict') {
          await expectLater(parent.delete(), throwsA(status(412)));
          expect((await parent.get()).exists, true);
        } else {
          await parent.delete();
          if (action == 'cascade') {
            await expectLater(child.get(), throwsA(status(404)));
          } else {
            expect((await child.get()).data()?['parent'], null);
          }
        }
      });
    }
  });

  group('collections lifecycle import export', () {
    test('create patch list import export clear delete', () async {
      final info =
          await db.createCollection('lifecycle', description: 'before');
      expect(info.name, 'lifecycle');
      await db.updateCollection('lifecycle', description: 'after');
      expect((await db.getCollectionInfo('lifecycle'))?.description, 'after');
      final imported = await db.importDocuments(
          'lifecycle',
          List.generate(
              9,
              (i) => {
                    'id': 'i$i',
                    'data': {'n': i}
                  }));
      expect(imported, isNotNull);
      final page = await db.exportDocuments('lifecycle', limit: 3);
      expect(page.documents.length, 3);
      expect(page.nextCursor, isNotNull);
      expect((await db.listCollections(search: 'lifecycle')).collections,
          isNotEmpty);
      await db.clearCollection('lifecycle');
      expect(await db.collection('lifecycle').count(), 0);
      await db.deleteCollection('lifecycle');
      expect(await db.getCollectionInfo('lifecycle'), null);
    });
    test('filtered bulk deletion preserves other documents', () async {
      for (var i = 0; i < 6; i++) {
        await db.doc('bulk/b$i').set({'n': i});
      }
      expect(await db.collection('bulk').where('n', '<', 3).deleteWhere(), 3);
      expect(await db.collection('bulk').count(), 3);
    });
  });

  group('realtime and resource lifecycle', () {
    test('document stream initial state then live update and cancellation',
        () async {
      final ref = db.doc('live/document');
      await ref.set({'n': 0});
      final events = <DocumentSnapshot<JsonMap>>[];
      final errors = <Object>[];
      final done = Completer<void>();
      final sub = ref.snapshots().listen((s) {
        events.add(s);
        if (s.data()?['n'] == 7 && !done.isCompleted) done.complete();
      }, onError: errors.add);
      await Future<void>.delayed(Duration(milliseconds: 500));
      await ref.update({'n': 7});
      await done.future.timeout(Duration(seconds: 12));
      await sub.cancel();
      expect(errors, isEmpty);
      expect(events.last.data()?['n'], 7);
    });
    test(
        'authenticated stream survives original JWT expiry after token rotation',
        () async {
      await db.request('PATCH', '/auth/admin/config',
          body: {'accessTokenTtlSeconds': 60});
      final owner = client(publicKey);
      addTearDown(owner.dispose);
      final user = await owner.auth.signUpWithEmailAndPassword(
          email: 'live-owner-$stamp@example.test', password: password);
      final ref = owner.doc('private/${user.id}');
      await ref.set({'n': 0});
      final initialized = Completer<void>(), updated = Completer<void>();
      final errors = <Object>[];
      final sub = ref.snapshots().listen((s) {
        if (!initialized.isCompleted) initialized.complete();
        if (s.data()?['n'] == 99 && !updated.isCompleted) updated.complete();
      }, onError: errors.add);
      addTearDown(sub.cancel);
      await initialized.future.timeout(Duration(seconds: 10));
      await Future<void>.delayed(Duration(seconds: 2));
      expect(await owner.auth.getIdToken(forceRefresh: true), isNotNull);
      // Original token has expired, while scheduled refresh keeps REST/WS live.
      await Future<void>.delayed(Duration(seconds: 60));
      await db.doc(ref.path).update({'n': 99});
      await updated.future.timeout(Duration(seconds: 10));
      expect(errors, isEmpty);
      await db.request('PATCH', '/auth/admin/config',
          body: {'accessTokenTtlSeconds': 3600});
    }, timeout: Timeout(Duration(seconds: 90)));
    test('query streams multiplex and dispose closes all streams', () async {
      final live = client();
      await live.doc('live_query/one').set({'n': 1});
      final first = Completer<void>(),
          closedA = Completer<void>(),
          closedB = Completer<void>();
      final a = live.collection('live_query').snapshots().listen((s) {
        if (!first.isCompleted) first.complete();
      }, onDone: closedA.complete);
      final b = live
          .doc('live_query/one')
          .snapshots()
          .listen((_) {}, onDone: closedB.complete);
      await first.future.timeout(Duration(seconds: 12));
      live.dispose();
      live.dispose();
      await Future.wait([closedA.future, closedB.future])
          .timeout(Duration(seconds: 3));
      await a.cancel();
      await b.cancel();
    });
    test('index lifecycle keeps ordering identical before and after backfill',
        () async {
      final before =
          await db.collection('scores').orderBy('rank').limit(100).get();
      final index = await db.request('POST', '/indexes', body: {
        'collectionPath': 'scores',
        'fields': [
          {'path': 'rank', 'dir': 'asc'}
        ]
      });
      final id = index['id'] as String;
      var ready = false;
      for (var i = 0; i < 100; i++) {
        final list = await db.request('GET', '/indexes');
        final row = (list['indexes'] as List)
            .cast<Map>()
            .firstWhere((r) => r['id'] == id);
        if (row['status'] == 'ready') {
          ready = true;
          break;
        }
        await Future<void>.delayed(Duration(milliseconds: 100));
      }
      expect(ready, true);
      final after = await db
          .collection('scores')
          .orderBy('rank')
          .streamDocuments(pageSize: 7)
          .toList();
      expect(after.map((d) => d.id), before.docs.map((d) => d.id));
      await db.request('DELETE', '/indexes/$id');
    });
    test('invalid API key is rejected without retries', () async {
      final bad = client('pk_invalid');
      addTearDown(bad.dispose);
      await expectLater(
          bad.doc('live/document').get(), throwsA(isA<VellumException>()));
    });
  });
}
