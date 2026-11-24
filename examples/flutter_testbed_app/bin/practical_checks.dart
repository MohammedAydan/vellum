/// Practical, hands-on experiments against a live VELLUM API using vellum_flutter.
///
/// Provisions an isolated tenant, then performs real operations and prints the
/// observable result of each one: authentication, CRUD, queries + pagination,
/// relations with redaction, aggregations, batch writes, OCC transactions,
/// collections, rules DSL and realtime WebSocket delivery.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:vellum_flutter/vellum_flutter_core.dart';
import 'package:http/http.dart' as http;

class Step {
  final String name;
  final bool passed;
  final String detail;
  final int ms;
  const Step(this.name, this.passed, this.detail, this.ms);

  @override
  String toString() =>
      '${passed ? 'PASS' : 'FAIL'}  ${name.padRight(44)} $detail  (${ms}ms)';
}

final List<Step> steps = <Step>[];

Future<void> check(String name, Future<String> Function() body) async {
  final Stopwatch sw = Stopwatch()..start();
  try {
    final String detail = await body();
    steps.add(Step(name, true, detail, sw.elapsedMilliseconds));
  } catch (error) {
    steps.add(Step(name, false, _safe(error), sw.elapsedMilliseconds));
  }
  stdout.writeln(steps.last.toString());
}

String _safe(Object error) {
  if (error is VellumException) {
    return '${error.code} [HTTP ${error.statusCode}]: ${error.message}';
  }
  if (error is StateError) return error.message;
  return error.runtimeType.toString();
}

String _uuid() {
  final Random random = Random.secure();
  final List<int> b = List<int>.generate(16, (_) => random.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  String hex(int v) => v.toRadixString(16).padLeft(2, '0');
  return <String>[
    hex(b[0]), hex(b[1]), hex(b[2]), hex(b[3]), '-',
    hex(b[4]), hex(b[5]), '-', hex(b[6]), hex(b[7]), '-',
    hex(b[8]), hex(b[9]), '-', hex(b[10]), hex(b[11]), hex(b[12]),
    hex(b[13]), hex(b[14]), hex(b[15]),
  ].join();
}

Map<String, dynamic> _eq(String left, String right) => <String, dynamic>{
  'op': '==',
  'left': <String, dynamic>{'var': left},
  'right': <String, dynamic>{'var': right},
};

Map<String, dynamic> _rules() => <String, dynamic>{
  'version': 1,
  'rules': <Map<String, dynamic>>[
    <String, dynamic>{
      'match': 'users/{userId}',
      'allow': <String, dynamic>{
        'read': _eq('auth.uid', 'path.userId'),
        'write': _eq('auth.uid', 'path.userId'),
      },
    },
    <String, dynamic>{
      'match': 'tasks/{taskId}',
      'allow': <String, dynamic>{
        'create': _eq('request.data.ownerId', 'auth.uid'),
        'read': _eq('resource.data.ownerId', 'auth.uid'),
        'write': _eq('resource.data.ownerId', 'auth.uid'),
      },
    },
    <String, dynamic>{
      'match': 'public/items/demo/{itemId}',
      'allow': <String, dynamic>{'read': true, 'write': true},
    },
    <String, dynamic>{
      'match': 'rel/{docId}',
      'allow': <String, dynamic>{'read': true, 'write': true},
    },
  ],
};

Future<void> main(List<String> args) async {
  final String base = (args.isEmpty
          ? (Platform.environment['VELLUM_API_BASE_URL'] ??
              'http://127.0.0.1:8080')
          : args.first)
      .replaceAll(RegExp(r'/+$'), '');
  final http.Client raw = http.Client();
  final String suffix = _uuid().substring(0, 8);

  Future<Map<String, dynamic>> api(
    String method,
    String path, {
    Map<String, String>? headers,
    Object? body,
  }) async {
    final Uri uri = Uri.parse('$base$path');
    final Map<String, String> h = <String, String>{
      'content-type': 'application/json',
      ...?headers,
    };
    final http.Response response = switch (method) {
      'GET' => await raw.get(uri, headers: h),
      'POST' => await raw.post(uri, headers: h, body: jsonEncode(body)),
      'PUT' => await raw.put(uri, headers: h, body: jsonEncode(body)),
      'PATCH' => await raw.patch(uri, headers: h, body: jsonEncode(body)),
      'DELETE' => await raw.delete(uri, headers: h, body: jsonEncode(body)),
      _ => throw StateError('unsupported method $method'),
    };
    Object? decoded;
    if (response.body.isNotEmpty) {
      try {
        decoded = jsonDecode(response.body);
      } on FormatException {
        decoded = response.body;
      }
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError('$method $path -> HTTP ${response.statusCode}: '
          '${decoded is Map ? decoded['error'] : decoded}');
    }
    if (decoded is Map) return decoded.cast<String, dynamic>();
    return <String, dynamic>{'value': decoded};
  }

  stdout.writeln('=== VELLUM practical experiments ===');
  stdout.writeln('Target: $base');
  stdout.writeln('');

  late String projectId;
  late String publicKey;
  late String serverKey;

  await check('00 provision tenant + rules', () async {
    final org = await api('POST', '/v1/organizations', body: <String, dynamic>{
      'name': 'Practical Checks $suffix',
      'slug': 'pc-org-$suffix',
      'planTier': 'pro',
    });
    final created = await api(
        'POST', '/v1/organizations/${org['id']}/projects',
        body: <String, dynamic>{
          'name': 'Practical Project',
          'slug': 'pc-proj-$suffix',
        });
    projectId = (created['project'] as Map)['id'] as String;
    final pk = await api('POST', '/v1/projects/$projectId/api-keys',
        body: <String, dynamic>{'name': 'pk', 'keyType': 'publishable'});
    final sk = await api('POST', '/v1/projects/$projectId/api-keys',
        body: <String, dynamic>{'name': 'sk', 'keyType': 'secret'});
    publicKey = pk['rawKey'] as String;
    serverKey = sk['rawKey'] as String;
    await api('POST', '/v1/projects/$projectId/rulesets',
        body: <String, dynamic>{'rulesAst': _rules()});
    await api('PATCH', '/v1/projects/$projectId/auth/admin/config',
        headers: <String, String>{'x-vellum-api-key': serverKey},
        body: <String, dynamic>{
          'enableEmailPassword': true,
          'enableUserProjection': true,
          'projectionCollectionPath': 'users',
          'requireEmailVerification': false,
          'passwordMinLength': 8,
        });
    return 'project=$projectId, keys=pk_/sk_, rules=published';
  });

  final alice = VellumClient(
      endpoint: base, projectId: projectId, apiKey: publicKey);
  final admin = VellumClient(
      endpoint: base, projectId: projectId, apiKey: serverKey);
  final String aliceEmail = 'alice-$suffix@vellum.dev';
  String? aliceUid;

  await check('01 auth signup + sign-in + token', () async {
    final user = await alice.auth.signUpWithEmailAndPassword(
        email: aliceEmail, password: 'Practical1');
    aliceUid = user.id;
    final session = await alice.auth.signInWithEmailAndPassword(
        email: aliceEmail, password: 'Practical1');
    final token = await alice.auth.getIdToken();
    if (token == null || token.isEmpty) throw StateError('no access token');
    final me = await alice.auth.getUser();
    return 'uid=${user.id}, session=${session.runtimeType}, token=${token.length} chars, getUser=${me.email}';
  });

  final String taskId = 'task-$suffix';
  await check('02 CRUD create/get/update/delete (rules-owned)', () async {
    await alice.setDoc('tasks/$taskId', <String, dynamic>{
      'title': 'Practical task',
      'ownerId': aliceUid,
      'priority': 7,
    });
    final created = await alice.getDoc('tasks/$taskId');
    await alice.updateDoc('tasks/$taskId', <String, dynamic>{'done': true});
    final updated = await alice.getDoc('tasks/$taskId');
    if (created.data()?['title'] != 'Practical task' ||
        updated.data()?['done'] != true) {
      throw StateError('CRUD state mismatch');
    }
    await alice.deleteDoc('tasks/$taskId');
    return 'created v${created.version} -> updated v${updated.version} -> deleted';
  });

  await check('03 public CRUD without auth', () async {
    final path = 'public/items/demo/first-$suffix';
    await admin.setDoc(path, <String, dynamic>{
      'name': 'Alpha', 'score': 10, 'bucket': suffix,
    });
    final snap = await admin.getDoc(path);
    await admin.updateDoc(path, <String, dynamic>{'score': 12});
    final after = await admin.getDoc(path);
    return '${snap.data()?['name']} score ${snap.data()?['score']} -> ${after.data()?['score']}';
  });

  await check('04 query + filter + sort + cursor pagination', () async {
    for (int i = 0; i < 5; i++) {
      await admin.setDoc('public/items/demo/q-$suffix-$i', <String, dynamic>{
        'name': 'Item $i',
        'score': i,
        'bucket': suffix,
      });
    }
    final first = await admin
        .query('public/items/demo',
            where: <String, dynamic>{'bucket': suffix},
            orderBy: <String, dynamic>{'field': 'score', 'dir': 'desc'},
            limit: 2)
        .get();
    final cursor = first.nextCursor;
    if (cursor == null || cursor.isEmpty) throw StateError('no nextCursor');
    final second = await admin
        .query('public/items/demo',
            where: <String, dynamic>{'bucket': suffix},
            orderBy: <String, dynamic>{'field': 'score', 'dir': 'desc'},
            limit: 2,
            cursor: cursor)
        .get();
    final ids = first.docs.map((d) => d.id).toSet();
    if (second.docs.any((d) => ids.contains(d.id))) {
      throw StateError('cursor repeated a document');
    }
    return 'page1=${first.docs.map((d) => d.data()?['score']).toList()}, '
        'page2=${second.docs.map((d) => d.data()?['score']).toList()}, cursor=${cursor.length} chars';
  });

  await check('05 relations include + unauthorized redaction', () async {
    final visible = 'users/$aliceUid';
    final hidden = 'users/hidden-$suffix';
    await admin.setDoc(visible, <String, dynamic>{
      'uid': aliceUid, 'name': 'Alice', 'secret': 'none',
    });
    await admin.setDoc(hidden, <String, dynamic>{
      'uid': 'someone-else', 'name': 'Hidden', 'secret': 'CLASSIFIED',
    });
    final parent = 'rel/post-$suffix';
    await admin.setDoc(parent, <String, dynamic>{
      'title': 'Post',
      'refs': <String>[visible, hidden],
    });
    final snap = await alice.doc(parent).get(include: <Object>[
      VellumInclude(field: 'refs', collection: 'users', as: 'targets'),
    ]);
    final targets = snap.included['targets'];
    if (targets is! List || targets.length != 1) {
      throw StateError('expected exactly 1 resolved relation');
    }
    if ('${snap.included}'.contains('CLASSIFIED')) {
      throw StateError('redacted relation leaked data');
    }
    return 'resolved=${targets.length}, redactedRefs=${snap.redactedRefs}';
  });

  await check('06 aggregations count/sum/avg/min/max', () async {
    final base = admin.query('public/items/demo').where('bucket', '==', suffix);
    final count = await base.count();
    final sum = await base.sum('score');
    final avg = await base.avg('score');
    if (count < 5 || sum == null || avg == null) {
      throw StateError('aggregation returned null/empty');
    }
    return 'count=$count, sum=$sum, avg=${avg.toStringAsFixed(2)}';
  });

  await check('07 atomic batchWrite', () async {
    final batch = admin.batch();
    for (int i = 0; i < 3; i++) {
      batch.set(admin.doc('public/items/demo/batch-$suffix-$i'),
          <String, dynamic>{'name': 'Batch $i', 'bucket': suffix});
    }
    final res = await batch.commit();
    return 'writes=3, responseKeys=${res.keys.toList()}';
  });

  await check('08 OCC transaction read-modify-write', () async {
    final path = 'public/items/demo/tx-$suffix';
    await admin.setDoc(path, <String, dynamic>{'counter': 0, 'bucket': suffix});
    final int next = await admin.runTransaction<int>((tx) async {
      final snap = await tx.get(admin.doc(path));
      final int current = (snap.data()?['counter'] as num).toInt();
      tx.set(admin.doc(path), <String, dynamic>{
        'counter': current + 1,
        'bucket': suffix,
      });
      return current + 1;
    });
    final after = await admin.getDoc(path);
    if (after.data()?['counter'] != next) {
      throw StateError('transaction did not persist');
    }
    return 'counter 0 -> $next (v${after.version})';
  });

  await check('09 collections lifecycle via SDK', () async {
    final name = 'pc_col_$suffix';
    await admin.createCollection(name);
    final listed = await admin.listCollections();
    final names = listed.collections.map((c) => c.name).toList();
    if (!names.contains(name)) throw StateError('created collection missing');
    await admin.clearCollection(name);
    await admin.deleteCollection(name);
    return 'created "$name", listed ${names.length} collections, cleared + deleted';
  });

  await check('10 rules DSL compile + simulate', () async {
    final dsl = "rules_version = '2';\n\nmatch /public/items/{id} {\n  allow read: if true;\n  allow write: if true;\n}\n";
    final compiled = await api('POST', '/v1/projects/$projectId/rules/compile',
        headers: <String, String>{'x-vellum-api-key': serverKey},
        body: <String, dynamic>{'rulesDsl': dsl});
    final simulated = await api('POST', '/v1/projects/$projectId/rules/simulate',
        headers: <String, String>{'x-vellum-api-key': serverKey},
        body: <String, dynamic>{
          'rulesAst': compiled['ast'],
          'operation': 'get',
          'path': '/public/items/x',
          'auth': <String, dynamic>{'uid': aliceUid, 'claims': <String, dynamic>{}},
        });
    return 'astVersion=${(compiled['ast'] as Map)['version']}, allowed=${simulated['allowed']}';
  });

  await check('11 realtime WebSocket mutation delivery', () async {
    final path = 'public/items/demo/rt-$suffix';
    final Completer<String> got = Completer<String>();
    final StreamSubscription<DocumentSnapshot<Map<String, dynamic>>> sub =
        admin.watchDocument(path).listen(
              (snap) {
                if (!got.isCompleted) got.complete('${snap.data()?['name']}');
              },
              onError: (Object e) {
                if (!got.isCompleted) got.completeError(e);
              },
            );
    await Future<void>.delayed(const Duration(milliseconds: 250));
    await admin.setDoc(path, <String, dynamic>{'name': 'Realtime-OK', 'bucket': suffix});
    final String value = await got.future.timeout(const Duration(seconds: 8));
    await sub.cancel();
    if (value != 'Realtime-OK') throw StateError('unexpected payload $value');
    return 'received mutation payload "$value" over WebSocket';
  });

  final int passed = steps.where((s) => s.passed).length;
  stdout.writeln('');
  stdout.writeln('=== RESULT: $passed/${steps.length} practical experiments passed ===');
  raw.close();
  alice.dispose();
  admin.dispose();
  if (passed != steps.length) exitCode = 1;
}
