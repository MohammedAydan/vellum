/// Live end-to-end testbed for `vellum_flutter`.
///
/// Every scenario talks to a real, running VELLUM HTTP API. There
/// are no mocks, no simulations and no skips. Secrets (API keys, JWTs, refresh
/// tokens) are held in memory only and are never written to logs or results.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:vellum_flutter/vellum_flutter.dart';
import 'package:http/http.dart' as http;

/// Outcome of one live scenario. [error] never contains credential material.
class ScenarioResult {
  final String name;
  final bool passed;
  final int latencyMs;
  final String? error;

  const ScenarioResult({
    required this.name,
    required this.passed,
    required this.latencyMs,
    this.error,
  });

  String get status => passed ? 'PASS' : 'FAIL';
}

class _Bootstrap {
  final String organizationId;
  final String projectId;
  final String publicKey;
  final String serverKey;

  const _Bootstrap({
    required this.organizationId,
    required this.projectId,
    required this.publicKey,
    required this.serverKey,
  });
}

class _ApiResponse {
  final int statusCode;
  final Object? decoded;

  const _ApiResponse(this.statusCode, this.decoded);

  JsonMap get object {
    if (decoded is Map) return (decoded as Map).cast<String, Object?>();
    return <String, Object?>{};
  }
}

/// Counts refresh calls without ever inspecting or retaining token values.
class CountingHttpClient extends http.BaseClient {
  final http.Client _inner;
  int refreshCalls = 0;

  CountingHttpClient(this._inner);

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final path = request.url.path;
    if (request.method == 'POST' && path.endsWith('/auth/token/refresh')) {
      refreshCalls++;
    }
    return _inner.send(request);
  }

  @override
  void close() {
    _inner.close();
    super.close();
  }
}

/// Runs the 16 live scenarios against `VELLUM_API_BASE_URL`.
class VellumLiveTestbedRunner {
  static const String _defaultBaseUrl = 'http://127.0.0.1:8080';
  static const String _password = 'LiveTestbed1';
  static const String _newPassword = 'LiveTestbed2';

  final String baseUrl;
  final http.Client _rawClient = http.Client();
  final CountingHttpClient aliceHttp = CountingHttpClient(http.Client());
  final http.Client bobHttp = http.Client();
  final http.Client realtimeHttp = http.Client();
  final http.Client v2AdvisorHttp = http.Client();
  final http.Client collectionsHttp = http.Client();

  late final VellumClient aliceClient;
  late final VellumClient bobClient;
  late final VellumClient realtimeClient;
  /// Server-key client used for collection registry lifecycle operations.
  late final VellumClient collectionsClient;

  _Bootstrap? _bootstrap;
  String? _aliceEmail;
  String? _aliceUid;
  String? _bobTaskId;
  String? _totpSecret;
  String? _customFieldValue;
  Future<JsonMap>? _v2RulesFuture;

  VellumLiveTestbedRunner({String? baseUrl})
      : baseUrl = baseUrl ?? _resolveBaseUrl();

  static String _resolveBaseUrl() {
    final fromEnv = Platform.environment['VELLUM_API_BASE_URL'];
    if (fromEnv != null && fromEnv.trim().isNotEmpty) {
      var value = fromEnv.trim();
      while (value.endsWith('/')) {
        value = value.substring(0, value.length - 1);
      }
      return value;
    }
    return _defaultBaseUrl;
  }

  String get _projectId => _bootstrap!.projectId;
  String get _publicKey => _bootstrap!.publicKey;
  String get _serverKey => _bootstrap!.serverKey;

  String get _authPrefix =>
      '/v1/projects/$_projectId/auth';
  String get _adminPrefix => '$_authPrefix/admin';

  String get _v1Prefix => '/v1/projects/$_projectId';

  /// Valid v2 rules DSL. The compiler emits a leading slash on every `match`
  /// path; the engine matches document paths without one, so the compiled AST
  /// is normalized before publication.
  static const String _v2RulesDsl = r'''rules_version = '2';

match /v2posts/{postId} {
  allow read: if auth.uid != null;
  allow write: if auth.uid != null;
}

match /v2users/{uid} {
  allow get: if auth.uid == path.uid;
}

match /v2metrics/{docId} {
  allow read: if true;
  allow write: if true;
}''';

  /// Provisions an isolated organization, project, API keys, ruleset and auth
  /// configuration through the real HTTP control plane.
  Future<void> _provision() async {
    _ApiResponse health;
    try {
      health = await _raw('GET', '/v1/health/ready');
    } catch (error) {
      throw StateError(
        'VELLUM_API_BASE_URL="$baseUrl" is not reachable (${error.runtimeType}). '
        'Start the live VELLUM API before running this suite.',
      );
    }
    if (health.statusCode >= 500) {
      throw StateError(
        'VELLUM_API_BASE_URL="$baseUrl" reported an unhealthy database plane '
        '(HTTP ${health.statusCode}).',
      );
    }

    final suffix = _uuid();
    final org = _expectOk(
      await _raw('POST', '/v1/organizations', body: <String, Object?>{
        'name': 'Flutter Live Testbed $suffix',
        'slug': 'ftb-org-$suffix',
        'planTier': 'pro',
      }),
      'organization provisioning',
    );
    final orgId = org['id'] as String?;
    if (orgId == null || orgId.isEmpty) {
      throw StateError('organization provisioning returned no id');
    }

    final createdProject = _expectOk(
      await _raw(
        'POST',
        '/v1/organizations/$orgId/projects',
        body: <String, Object?>{
          'name': 'Flutter Live Testbed Project',
          'slug': 'ftb-proj-$suffix',
        },
      ),
      'project provisioning',
    );
    final project = createdProject['project'];
    if (project is! Map) {
      throw StateError('project provisioning returned no project');
    }
    final projectId = project['id'] as String?;
    if (projectId == null || projectId.isEmpty) {
      throw StateError('project provisioning returned no project id');
    }

    final keysPath =
        '/v1/projects/$projectId/api-keys';
    final publishable = _expectOk(
      await _raw('POST', keysPath, body: <String, Object?>{
        'name': 'ftb-publishable',
        'keyType': 'publishable',
      }),
      'publishable API key provisioning',
    );
    final secret = _expectOk(
      await _raw('POST', keysPath, body: <String, Object?>{
        'name': 'ftb-server',
        'keyType': 'secret',
      }),
      'secret API key provisioning',
    );
    final publicKey = publishable['rawKey'] as String?;
    final serverKey = secret['rawKey'] as String?;
    if (publicKey == null ||
        !publicKey.startsWith('pk_') ||
        serverKey == null ||
        !serverKey.startsWith('sk_')) {
      throw StateError('API key provisioning returned unexpected key material');
    }

    _expectOk(
      await _raw(
        'POST',
        '/v1/projects/$projectId/rulesets',
        body: <String, Object?>{'rulesAst': _rulesAst()},
      ),
      'security ruleset publication',
    );

    _expectOk(
      await _raw(
        'PATCH',
        '/v1/projects/$projectId/auth/admin/config',
        headers: <String, String>{'x-vellum-api-key': serverKey},
        body: <String, Object?>{
          'enableEmailPassword': true,
          'enableTotpMfa': true,
          'enableUserProjection': true,
          'projectionCollectionPath': 'users',
          'requireEmailVerification': false,
          'passwordMinLength': 8,
        },
      ),
      'auth configuration',
    );

    _bootstrap = _Bootstrap(
      organizationId: orgId,
      projectId: projectId,
      publicKey: publicKey,
      serverKey: serverKey,
    );

    aliceClient = VellumClient(
      endpoint: baseUrl,
      projectId: projectId,
      apiKey: publicKey,
      httpClient: aliceHttp,
    );
    bobClient = VellumClient(
      endpoint: baseUrl,
      projectId: projectId,
      apiKey: publicKey,
      httpClient: bobHttp,
    );
    // The WebSocket handshake has no end-user session: the scenario observes
    // the durable outbox on a public-read task path under `tasks/`.
    realtimeClient = VellumClient(
      endpoint: baseUrl,
      projectId: projectId,
      apiKey: publicKey,
      httpClient: realtimeHttp,
    );
    // Collections mutations require an sk_ server key; document writes through
    // this client auto-register their collection in the same tenant registry.
    collectionsClient = VellumClient(
      endpoint: baseUrl,
      projectId: projectId,
      apiKey: serverKey,
      httpClient: collectionsHttp,
    );
  }

  JsonMap _rulesAst() {
    JsonMap eq(String left, String right) => <String, Object?>{
          'op': '==',
          'left': <String, Object?>{'var': left},
          'right': <String, Object?>{'var': right},
        };
    JsonMap moderator() => <String, Object?>{
          'op': '==',
          'left': <String, Object?>{'var': 'auth.claims.role'},
          'right': <String, Object?>{'val': 'moderator'},
        };
    JsonMap anyOf(
      JsonMap a,
      JsonMap b,
    ) =>
        <String, Object?>{
          'op': 'any',
          'conditions': <JsonMap>[a, b],
        };

    return <String, Object?>{
      'version': 1,
      'rules': <JsonMap>[
        <String, Object?>{
          'match': 'users/{userId}',
          'allow': <String, Object?>{
            'read': eq('auth.uid', 'path.userId'),
            'write': eq('auth.uid', 'path.userId'),
          },
        },
        <String, Object?>{
          'match': 'tasks/{taskId}',
          'allow': <String, Object?>{
            'create': anyOf(
              eq('request.data.ownerId', 'auth.uid'),
              moderator(),
            ),
            'read': anyOf(eq('resource.data.ownerId', 'auth.uid'), moderator()),
            'write': anyOf(eq('resource.data.ownerId', 'auth.uid'), moderator()),
          },
        },
        <String, Object?>{
          'match': 'tasks/public/items/{taskId}',
          'allow': <String, Object?>{
            'read': true,
            'write': true,
          },
        },
      ],
    };
  }

  /// Executes all 20 live scenarios in order and never short-circuits on a
  /// failure, so a single run reports the complete picture.
  Future<List<ScenarioResult>> runAll() async {
    final results = <ScenarioResult>[];
    try {
      await _provision();
      results.add(await _run('01 JWKS discovery (OKP/Ed25519)', _scenarioJwks));
      results.add(await _run(
          '02 Signup + automatic user projection', _scenarioSignupProjection));
      results.add(await _run(
          '03 Merge preservation + updateProfile', _scenarioMergeAndProfile));
      results.add(await _run(
          '04 Email verification via devToken', _scenarioEmailVerification));
      results.add(await _run('05 TOTP MFA challenge', _scenarioTotpMfa));
      results.add(await _run(
          '06 Security rules owner vs stranger (403)', _scenarioOwnerVsStranger));
      results.add(await _run(
          '07 Claims elevation via customer admin', _scenarioClaimsElevation));
      results.add(await _run(
          '08 Sorted query + cursor pagination', _scenarioQueryAndCursor));
      results.add(await _run('09 Realtime WebSocket watch', _scenarioRealtime));
      results.add(await _run(
          '10 Expired access token silent refresh', _scenarioSilentRefresh));
      results.add(await _run(
          '11 Parallel refresh mutex (5 calls)', _scenarioParallelRefresh));
      results.add(await _run(
          '12 Password reset + session revocation', _scenarioPasswordReset));
      results.add(await _run(
          '13 V2 Rules DSL compile -> publish -> simulate', _scenarioV2RulesDsl));
      results.add(await _run(
          '14 V2 relations include + redaction', _scenarioV2RelationsAndRedaction));
      results.add(await _run(
          '15 V2 aggregations + OR + CI operators', _scenarioV2Aggregations));
      results.add(await _run(
          '16 V2 index advisor callback + apply', _scenarioV2IndexAdvisor));
      results.add(await _run(
          '17 Collections: create empty persists', _scenarioCollectionsCreateEmpty));
      results.add(await _run(
          '18 Collections: SDK write auto-registers', _scenarioCollectionsAutoDiscover));
      results.add(await _run(
          '19 Collections: clear keeps empty', _scenarioCollectionsClear));
      results.add(await _run(
          '20 Collections: delete removes collection + docs', _scenarioCollectionsDelete));
    } finally {
      _dispose();
    }
    return results;
  }

  void _dispose() {
    if (_bootstrap != null) {
      aliceClient.auth.dispose();
      bobClient.auth.dispose();
      realtimeClient.auth.dispose();
      collectionsClient.auth.dispose();
    }
    aliceHttp.close();
    bobHttp.close();
    realtimeHttp.close();
    v2AdvisorHttp.close();
    collectionsHttp.close();
    _rawClient.close();
  }

  Future<ScenarioResult> _run(
    String name,
    Future<void> Function() scenario,
  ) async {
    final stopwatch = Stopwatch()..start();
    try {
      await scenario();
      stopwatch.stop();
      return ScenarioResult(
        name: name,
        passed: true,
        latencyMs: stopwatch.elapsedMilliseconds,
      );
    } catch (error) {
      stopwatch.stop();
      return ScenarioResult(
        name: name,
        passed: false,
        latencyMs: stopwatch.elapsedMilliseconds,
        error: _safeError(error),
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Scenarios                                                              */
  /* ---------------------------------------------------------------------- */

  Future<void> _scenarioJwks() async {
    final response = await _raw(
      'GET',
      '$_authPrefix/.well-known/jwks.json',
    );
    if (response.statusCode != 200) {
      throw StateError('JWKS discovery returned HTTP ${response.statusCode}');
    }
    final keys = response.object['keys'];
    if (keys is! List) {
      throw StateError('JWKS response has no keys array');
    }
    final hasEd25519 = keys.any((Object? key) {
      if (key is! Map) return false;
      return key['kty'] == 'OKP' && key['crv'] == 'Ed25519';
    });
    if (!hasEd25519) {
      throw StateError('JWKS has no OKP/Ed25519 verification key');
    }
  }

  Future<void> _scenarioSignupProjection() async {
    final email = 'alice-${_uuid()}@example.test';
    _aliceEmail = email;
    final user = await aliceClient.auth.signUpWithEmailAndPassword(
      email: email,
      password: _password,
      displayName: 'Alice',
    );
    _aliceUid = user.id;
    if (user.id.isEmpty) {
      throw StateError('sign-up returned no user id');
    }

    final snapshot = await aliceClient.getDoc('users/${user.id}');
    final data = snapshot.data();
    if (data == null) {
      throw StateError('automatic projection document is missing');
    }
    if (data['uid'] != user.id ||
        data['email'] != email ||
        data['displayName'] != 'Alice') {
      throw StateError('projection fields (uid/email/displayName) do not match');
    }
  }

  Future<void> _scenarioMergeAndProfile() async {
    final uid = _aliceUid;
    if (uid == null) throw StateError('sign-up scenario did not produce a uid');
    final path = 'users/$uid';
    _customFieldValue = 'kept-${_uuid()}';

    await aliceClient.setDoc(
      path,
      <String, Object?>{'devCustomField': _customFieldValue},
      merge: true,
    );

    final updated = await aliceClient.auth.updateProfile(
      displayName: 'Alice Updated',
    );
    if (updated.displayName != 'Alice Updated') {
      throw StateError('updateProfile did not change the in-memory profile');
    }

    final snapshot = await aliceClient.getDoc(path);
    final data = snapshot.data();
    if (data == null) {
      throw StateError('projected user document disappeared after update');
    }
    if (data['devCustomField'] != _customFieldValue) {
      throw StateError('custom field was not preserved by the merge write');
    }
    if (data['uid'] != uid || data['email'] != _aliceEmail) {
      throw StateError('system projection fields were lost after updateProfile');
    }
  }

  Future<void> _scenarioEmailVerification() async {
    final action = await aliceClient.auth.sendEmailVerification();
    final token = action.devToken;
    if (token == null || token.isEmpty) {
      throw StateError('email verification devToken was not returned');
    }
    await aliceClient.auth.confirmEmailVerification(token);
    final profile = await aliceClient.auth.getUser();
    if (!profile.emailVerified) {
      throw StateError('emailVerified is still false after confirmation');
    }
  }

  Future<void> _scenarioTotpMfa() async {
    final enrollment = await aliceClient.auth.enrollTotpMfa(issuer: 'VELLUM');
    if (enrollment.secret.isEmpty) {
      throw StateError('TOTP enrollment returned no secret');
    }
    _totpSecret = enrollment.secret;

    await aliceClient.auth.confirmTotpMfa(code: _totpCode(enrollment.secret));
    await aliceClient.auth.signOut();

    final email = _aliceEmail;
    if (email == null) throw StateError('missing Alice email');
    final result = await aliceClient.auth.signInWithEmailAndPassword(
      email: email,
      password: _password,
    );
    if (result is! VellumMfaRequired) {
      throw StateError('sign-in did not require an MFA challenge');
    }

    final user = await aliceClient.auth.verifyMfaChallenge(
      mfaTicket: result.mfaTicket,
      code: _totpCode(_totpSecret!),
    );
    if (user.id.isEmpty || aliceClient.auth.currentUser == null) {
      throw StateError('MFA challenge did not establish a session');
    }
  }

  Future<void> _scenarioOwnerVsStranger() async {
    final uid = _aliceUid;
    if (uid == null) throw StateError('missing Alice uid');

    final bob = await bobClient.auth.signUpWithEmailAndPassword(
      email: 'bob-${_uuid()}@example.test',
      password: _password,
      displayName: 'Bob',
    );
    if (bob.id.isEmpty) throw StateError('Bob sign-up returned no uid');

    final aliceTaskId = 'alice-task-${_uuid()}';
    await aliceClient.setDoc('tasks/$aliceTaskId', <String, Object?>{
      'title': 'Alice private task',
      'ownerId': uid,
      'priority': 9000,
    });
    await _expectForbidden(
      () => bobClient.getDoc('tasks/$aliceTaskId'),
      'Bob reading Alice task',
    );

    final bobTaskId = 'bob-task-${_uuid()}';
    _bobTaskId = bobTaskId;
    await bobClient.setDoc('tasks/$bobTaskId', <String, Object?>{
      'title': 'Bob private task',
      'ownerId': bob.id,
      'priority': 9100,
    });
    await _expectForbidden(
      () => aliceClient.getDoc('tasks/$bobTaskId'),
      'Alice reading Bob task before elevation',
    );
  }

  Future<void> _scenarioClaimsElevation() async {
    final uid = _aliceUid;
    final bobTaskId = _bobTaskId;
    if (uid == null || bobTaskId == null) {
      throw StateError('prerequisite scenarios did not complete');
    }

    _expectOk(
      await _raw(
        'PUT',
        '$_adminPrefix/users/$uid/claims',
        headers: <String, String>{'x-vellum-api-key': _serverKey},
        body: <String, Object?>{
          'claims': <String, Object?>{'role': 'moderator'},
        },
      ),
      'custom claims elevation',
    );

    final refreshed = await aliceClient.auth.getIdToken(forceRefresh: true);
    if (refreshed == null || refreshed.isEmpty) {
      throw StateError('forced refresh returned no token');
    }

    final before = await aliceClient.getDoc('tasks/$bobTaskId');
    if (before.data() == null) {
      throw StateError('moderator could not read the protected task');
    }
    await aliceClient.updateDoc('tasks/$bobTaskId', <String, Object?>{
      'moderatorNote': 'elevated-$_uuid',
    });
    final after = await aliceClient.getDoc('tasks/$bobTaskId');
    if (after.data()?['title'] != 'Bob private task') {
      throw StateError('moderator write overwrote unrelated fields');
    }
    if (after.data()?['moderatorNote'] == null) {
      throw StateError('moderator write was not persisted');
    }
  }

  Future<void> _scenarioQueryAndCursor() async {
    final uid = _aliceUid;
    if (uid == null) throw StateError('missing Alice uid');

    final base = 100 + Random().nextInt(100);
    for (var index = 0; index < 5; index++) {
      final priority = base + index;
      await aliceClient.setDoc('tasks/priority-${_uuid()}', <String, Object?>{
        'title': 'Prioritized task $priority',
        'ownerId': uid,
        'priority': priority,
      });
    }

    JsonMap where = <String, Object?>{'ownerId': uid};
    JsonMap orderBy = <String, Object?>{
      'field': 'priority',
      'dir': 'desc',
    };

    final firstPage = await aliceClient
        .query('tasks', where: where, orderBy: orderBy, limit: 2)
        .get();
    if (firstPage.docs.length != 2) {
      throw StateError('first page returned ${firstPage.docs.length} documents');
    }
    final cursor = firstPage.nextCursor;
    if (cursor == null || cursor.isEmpty) {
      throw StateError('first page did not return a nextCursor');
    }
    final secondPage = await aliceClient
        .query(
          'tasks',
          where: where,
          orderBy: orderBy,
          limit: 2,
          cursor: cursor,
        )
        .get();
    if (secondPage.docs.isEmpty) {
      throw StateError('cursor page returned no documents');
    }

    final firstIds = firstPage.docs.map((doc) => doc.id).toSet();
    if (secondPage.docs.any((doc) => firstIds.contains(doc.id))) {
      throw StateError('cursor pagination repeated a document');
    }

    final pagedDocs = <DocumentSnapshot<JsonMap>>[
      ...firstPage.docs,
      ...secondPage.docs,
    ];
    final priorities = pagedDocs.map((doc) {
      final raw = doc.data()?['priority'];
      if (raw is! num) {
        throw StateError('task ${doc.id} has no numeric priority');
      }
      return raw.toInt();
    }).toList();
    for (var index = 1; index < priorities.length; index++) {
      if (priorities[index] >= priorities[index - 1]) {
        throw StateError('priority order broke across the cursor boundary');
      }
    }
  }

  Future<void> _scenarioRealtime() async {
    final uid = _aliceUid;
    if (uid == null) throw StateError('missing Alice uid');

    final newTaskId = 'realtime-${_uuid()}';
    final taskPath = 'tasks/public/items/$newTaskId';
    final snapshots = <DocumentSnapshot<JsonMap>>[];
    Object? streamError;
    final subscription = realtimeClient.watchDocument(taskPath).listen(
          snapshots.add,
          onError: (Object error, StackTrace stack) {
            streamError = error;
          },
        );

    try {
      // Let the WebSocket handshake and initial_sync complete before writing.
      await Future<void>.delayed(const Duration(milliseconds: 250));
      await aliceClient.setDoc(taskPath, <String, Object?>{
        'title': 'Realtime task',
        'ownerId': uid,
        'priority': 99999,
      });

      final deadline = DateTime.now().add(const Duration(seconds: 2));
      while (DateTime.now().isBefore(deadline) &&
          !_hasRealtimeEvent(snapshots, newTaskId)) {
        if (streamError != null) break;
        await Future<void>.delayed(const Duration(milliseconds: 25));
      }
      if (streamError != null) {
        throw StateError(
          'realtime stream error: ${streamError.runtimeType}',
        );
      }
      if (!_hasRealtimeEvent(snapshots, newTaskId)) {
        throw StateError('no realtime event for the new task within 2 seconds');
      }
    } finally {
      await subscription.cancel();
    }
  }

  bool _hasRealtimeEvent(
    List<DocumentSnapshot<JsonMap>> snapshots,
    String taskId,
  ) {
    return snapshots.any((snapshot) => snapshot.id == taskId);
  }

  Future<void> _scenarioSilentRefresh() async {
    final user = aliceClient.auth.currentUser;
    if (user == null || user.refreshToken.isEmpty) {
      throw StateError('no active session to test silent refresh');
    }

    final storage = InMemoryAuthTokenStorage();
    await storage.writeUser(user.toJson());
    await storage.writeAccessToken(_expiredJwt());
    await storage.writeRefreshToken(user.refreshToken);

    final countingHttp = CountingHttpClient(http.Client());
    final client = VellumClient(
      endpoint: baseUrl,
      projectId: _projectId,
      apiKey: _publicKey,
      authStorage: storage,
      httpClient: countingHttp,
    );
    try {
      await client.auth.restore();
      final snapshot = await client.getDoc('users/$_aliceUid');
      if (snapshot.data() == null) {
        throw StateError('document read after silent refresh returned no data');
      }
      if (countingHttp.refreshCalls < 1) {
        throw StateError('document read succeeded without any token refresh');
      }
    } finally {
      client.auth.dispose();
      countingHttp.close();
    }
  }

  Future<void> _scenarioParallelRefresh() async {
    final before = aliceHttp.refreshCalls;
    final tokens = await Future.wait<String?>(
      List<Future<String?>>.generate(
        5,
        (int _) => aliceClient.auth.getIdToken(forceRefresh: true),
      ),
    );
    if (tokens.any((token) => token == null || token.isEmpty)) {
      throw StateError('one of the parallel refreshes returned no token');
    }
    if (tokens.toSet().length != 1) {
      throw StateError('parallel refreshes returned divergent tokens');
    }
    if (aliceClient.auth.currentUser == null) {
      throw StateError('session was lost during parallel refresh');
    }
    final refreshes = aliceHttp.refreshCalls - before;
    if (refreshes != 1) {
      throw StateError(
        'expected the mutex to collapse 5 refreshes into 1, observed $refreshes',
      );
    }
  }

  Future<void> _scenarioPasswordReset() async {
    final email = _aliceEmail;
    if (email == null) throw StateError('missing Alice email');
    final previousRefreshToken =
        aliceClient.auth.currentUser?.refreshToken ?? '';

    final request = await aliceClient.auth.sendPasswordResetEmail(email);
    final devToken = request.devToken;
    if (devToken == null || devToken.isEmpty) {
      throw StateError('password reset devToken was not returned');
    }
    await aliceClient.auth.confirmPasswordReset(
      token: devToken,
      newPassword: _newPassword,
    );

    if (previousRefreshToken.isNotEmpty) {
      await _expectRefreshRejected(
        previousRefreshToken,
        'pre-reset refresh token',
      );
    }

    final result = await aliceClient.auth.signInWithEmailAndPassword(
      email: email,
      password: _newPassword,
    );
    if (result is VellumMfaRequired) {
      final secret = _totpSecret;
      if (secret == null) throw StateError('MFA required but no secret stored');
      await aliceClient.auth.verifyMfaChallenge(
        mfaTicket: result.mfaTicket,
        code: _totpCode(secret),
      );
    }
    final sessionRefreshToken =
        aliceClient.auth.currentUser?.refreshToken ?? '';
    if (sessionRefreshToken.isEmpty) {
      throw StateError('sign-in with the new password yielded no session');
    }

    await aliceClient.auth.signOut(allSessions: true);
    if (aliceClient.auth.currentUser != null) {
      throw StateError('currentUser survived signOut(allSessions: true)');
    }
    await _expectRefreshRejected(
      sessionRefreshToken,
      'post-signout refresh token',
    );
  }

  /* ---------------------------------------------------------------------- */
  /* V2 scenarios                                                           */
  /* ---------------------------------------------------------------------- */

  /// Compile the V2 DSL through the real REST endpoint, merge the resulting
  /// rules into the bootstrap ruleset and publish them. Memoized so every V2
  /// scenario is safe to run in isolation from the dashboard.
  Future<JsonMap> _ensureV2Rules() {
    final cached = _v2RulesFuture;
    if (cached != null) return cached;
    _v2RulesFuture = (() async {
      final compiled = _expectOk(
        await _raw('POST', '$_v1Prefix/rules/compile',
            headers: <String, String>{'x-vellum-api-key': _serverKey},
            body: <String, Object?>{'source': _v2RulesDsl}),
        'V2 rules DSL compile',
      );
      final ast = compiled['ast'];
      if (ast is! Map) throw StateError('rules/compile returned no AST');
      final rules = ast['rules'];
      if (rules is! List || rules.length != 3) {
        throw StateError('rules/compile returned unexpected rules');
      }
      final normalizedRules = rules.map((Object? rule) {
        if (rule is! Map) throw StateError('invalid compiled rule');
        final match = rule['match'];
        return <String, Object?>{
          ...rule.cast<String, Object?>(),
          if (match is String) 'match': match.replaceFirst(RegExp(r'^/+'), ''),
        };
      }).toList();

      final baseRules = (_rulesAst()['rules'] as List).cast<JsonMap>();
      final published = _expectOk(
        await _raw('POST', '$_v1Prefix/rulesets',
            body: <String, Object?>{
              'rulesAst': <String, Object?>{
                'version': 1,
                'rules': <JsonMap>[...baseRules, ...normalizedRules],
              },
            }),
        'V2 ruleset publication',
      );
      if (published['version'] == null && published['id'] == null) {
        throw StateError('ruleset publication returned no version/id');
      }
      return <String, Object?>{
        'version': ast['version'] ?? 1,
        'rules': normalizedRules,
      };
    })();
    return _v2RulesFuture!;
  }

  /// Scenario 12 deliberately signs Alice out of every session. The V2 relation
  /// scenario needs an authenticated public-key client again, so restore her
  /// session (including the TOTP challenge) before reading a rules-gated doc.
  Future<void> _ensureAliceSignedIn() async {
    if (aliceClient.auth.currentUser != null) return;
    final email = _aliceEmail;
    if (email == null) throw StateError('missing Alice email');
    // Scenario 12 resets Alice's password, so the original secret no longer
    // authenticates after that point. Try the current password first.
    Object? result;
    try {
      result = await aliceClient.auth.signInWithEmailAndPassword(
        email: email,
        password: _newPassword,
      );
    } catch (_) {
      result = await aliceClient.auth.signInWithEmailAndPassword(
        email: email,
        password: _password,
      );
    }
    if (result is VellumMfaRequired) {
      await aliceClient.auth.verifyMfaChallenge(
        mfaTicket: result.mfaTicket,
        code: _totpCode(_totpSecret!),
      );
    }
    if (aliceClient.auth.currentUser == null) {
      throw StateError('could not restore Alice session for V2 scenarios');
    }
  }

  Future<void> _writeDoc(String path, JsonMap data) async {
    final response = await _raw(
      'PUT',
      '/v1/projects/$_projectId/documents/$path',
      headers: <String, String>{'x-vellum-api-key': _serverKey},
      body: <String, Object?>{'data': data},
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw StateError('writing $path failed (HTTP ${response.statusCode})');
    }
  }

  Future<void> _scenarioV2RulesDsl() async {
    final ast = await _ensureV2Rules();
    if (ast['version'] != 1) throw StateError('compiled rules AST is not version 1');

    final decompiled = _expectOk(
      await _raw('POST', '$_v1Prefix/rules/decompile',
          headers: <String, String>{'x-vellum-api-key': _serverKey},
          body: <String, Object?>{'rulesAst': ast}),
      'V2 rules decompile',
    );
    final dsl = decompiled['dsl'];
    if (dsl is! String || !dsl.contains("rules_version = '2';")) {
      throw StateError('decompile did not reproduce rules_version 2');
    }

    final allowed = _expectOk(
      await _raw('POST', '$_v1Prefix/rules/simulate',
          headers: <String, String>{'x-vellum-api-key': _serverKey},
          body: <String, Object?>{
            'rulesAst': ast,
            'operation': 'create',
            'path': '/v2posts/p1',
            'auth': <String, Object?>{'uid': 'user-1', 'claims': <String, Object?>{}},
            'incomingData': <String, Object?>{'title': 'simulated'},
          }),
      'V2 rules simulate (ALLOW)',
    );
    if (allowed['allowed'] != true) throw StateError('simulator did not ALLOW the authenticated create');
    final matched = allowed['matchedRule'];
    if (matched != 'v2posts/{postId}' && matched != '/v2posts/{postId}') {
      throw StateError('simulator matched the wrong rule: $matched');
    }
    final allowedTrace = allowed['evaluationTrace'];
    if (allowedTrace is! List || !allowedTrace.any((line) => '$line'.contains('ALLOW'))) {
      throw StateError('simulator ALLOW trace is missing');
    }

    final denied = _expectOk(
      await _raw('POST', '$_v1Prefix/rules/simulate',
          headers: <String, String>{'x-vellum-api-key': _serverKey},
          body: <String, Object?>{
            'rulesAst': ast,
            'operation': 'create',
            'path': '/v2posts/p1',
            'auth': null,
            'incomingData': <String, Object?>{'title': 'simulated'},
          }),
      'V2 rules simulate (DENY)',
    );
    if (denied['allowed'] != false) throw StateError('simulator did not DENY the anonymous create');
    final deniedTrace = denied['evaluationTrace'];
    if (deniedTrace is! List || !deniedTrace.any((line) => '$line'.contains('DENY'))) {
      throw StateError('simulator DENY trace is missing');
    }
  }

  Future<void> _scenarioV2RelationsAndRedaction() async {
    await _ensureV2Rules();
    await _ensureAliceSignedIn();
    final uid = _aliceUid;
    if (uid == null) throw StateError('sign-up scenario did not produce a uid');

    final suffix = _uuid().replaceAll('-', '').substring(0, 8);
    final visiblePath = 'v2users/$uid';
    final hiddenPath = 'v2users/hidden-$suffix';
    final parentPath = 'v2posts/relations-$suffix';
    await _writeDoc(visiblePath, <String, Object?>{
      'uid': uid,
      'name': 'Alice V2',
      'secret': 'none',
    });
    await _writeDoc(hiddenPath, <String, Object?>{
      'uid': 'someone-else',
      'name': 'Hidden User',
      'secret': 'CLASSIFIED-V2-RELATION',
    });
    await _writeDoc(parentPath, <String, Object?>{
      'title': 'V2 relations',
      'refs': <String>[visiblePath, hiddenPath],
    });

    final snapshot = await aliceClient.doc(parentPath).get(
          include: <Object>[
            VellumInclude(field: 'refs', collection: 'v2users', as: 'targets'),
          ],
        );
    final targets = snapshot.included['targets'];
    if (targets is! List || targets.length != 1) {
      throw StateError('include did not resolve exactly one readable target');
    }
    final resolved = targets.first;
    if (resolved is! Map || resolved['path'] != visiblePath) {
      throw StateError('include resolved the wrong relation target');
    }
    if (!snapshot.redactedRefs.contains('targets')) {
      throw StateError('unauthorized relation target was not recorded as redacted');
    }
    if ('${snapshot.included}'.contains('CLASSIFIED-V2-RELATION')) {
      throw StateError('redacted relation leaked secret data');
    }
  }

  Future<void> _scenarioV2Aggregations() async {
    await _ensureV2Rules();
    final bucket = 'v2_${_uuid().replaceAll('-', '').substring(0, 10)}';
    final rows = <JsonMap>[
      <String, Object?>{'team': 'red', 'score': 10, 'title': 'Scoring Sprint'},
      <String, Object?>{'team': 'red', 'score': 20, 'title': 'PrefixBeta'},
      <String, Object?>{'team': 'blue', 'score': 4, 'title': 'Scoring Marathon'},
      <String, Object?>{'team': 'blue', 'score': 6, 'title': 'Other'},
    ];
    for (var i = 0; i < rows.length; i++) {
      await _writeDoc('v2metrics/${bucket}_$i', <String, Object?>{
        ...rows[i],
        'bucket': bucket,
      });
    }

    final base = aliceClient.query('v2metrics').where('bucket', '==', bucket);
    final count = await base.count();
    if (count != rows.length) throw StateError('count returned $count, expected ${rows.length}');
    final sum = await base.sum('score');
    if (sum != 40) throw StateError('sum returned $sum, expected 40');
    final avg = await base.avg('score');
    if (avg != 10) throw StateError('avg returned $avg, expected 10');

    final extrema = await base.aggregate(metrics: <String, AggregateMetric>{
      'min': const AggregateMetric.min('score'),
      'max': const AggregateMetric.max('score'),
    });
    final extremaRows = extrema['rows'];
    if (extremaRows is! List || extremaRows.isEmpty) throw StateError('min/max returned no rows');
    final first = extremaRows.first;
    num? numeric(Object? value) => value is num ? value : num.tryParse('$value');
    if (first is! Map || numeric(first['min']) != 4 || numeric(first['max']) != 20) {
      throw StateError('min/max returned unexpected values');
    }

    final grouped = await base.aggregate(
      groupBy: <String>['team'],
      metrics: <String, AggregateMetric>{
        'count': const AggregateMetric.count(),
        'sum': AggregateMetric.sum('score'),
      },
    );
    final groupedRows = grouped['rows'];
    if (groupedRows is! List || groupedRows.length != 2) {
      throw StateError('groupBy returned ${groupedRows is List ? groupedRows.length : 0} groups, expected 2');
    }
    final byTeam = <String, Object?>{};
    for (final row in groupedRows) {
      if (row is Map) byTeam['${row['team']}'] = row;
    }
    if (numeric((byTeam['red'] as Map)['sum']) != 30 ||
        numeric((byTeam['blue'] as Map)['sum']) != 10) {
      throw StateError('grouped sums are wrong');
    }

    final ci = await base.where('title', 'contains_ci', 'SCORING').get();
    if (ci.docs.length != 2) throw StateError('contains_ci matched ${ci.docs.length} docs, expected 2');
    // Each inner group is ANDed; groups are ORed (the locked ESR query shape).
    final orDocs = await base
        .or(<List<JsonMap>>[
          <JsonMap>[
            <String, Object?>{'field': 'team', 'op': '==', 'value': 'red'},
          ],
          <JsonMap>[
            <String, Object?>{'field': 'score', 'op': '==', 'value': 4},
          ],
        ])
        .get();
    if (orDocs.docs.length != 3) {
      throw StateError('or group matched ${orDocs.docs.length} docs, expected 3');
    }
  }

  Future<void> _scenarioV2IndexAdvisor() async {
    await _ensureV2Rules();
    final captured = <VellumIndexSuggestion>[];
    final advisorHttp = CountingHttpClient(http.Client());
    final advisorClient = VellumClient(
      endpoint: baseUrl,
      projectId: _projectId,
      apiKey: _serverKey,
      httpClient: advisorHttp,
      onIndexSuggestion: captured.add,
    );
    try {
      final bucket = 'adv_${_uuid().replaceAll('-', '').substring(0, 10)}';
      await advisorClient.doc('v2metrics/${bucket}_1').set(<String, Object?>{
        'bucket': bucket,
        'team': 'red',
        'kind': 'ticket',
      });
      await advisorClient.doc('v2metrics/${bucket}_2').set(<String, Object?>{
        'bucket': bucket,
        'team': 'blue',
        'kind': 'ticket',
      });

      await advisorClient
          .query('v2metrics')
          .where('bucket', '==', bucket)
          .where('kind', '==', 'ticket')
          .get();
      if (captured.isEmpty) {
        throw StateError('SDK onIndexSuggestion callback was not invoked');
      }
      final suggestion = captured.first;
      if (suggestion.fingerprint.isEmpty) throw StateError('suggestion has no fingerprint');
      if (suggestion.collectionPath != 'v2metrics') {
        throw StateError('suggestion points at the wrong collection');
      }
      if (suggestion.fields.length < 2) throw StateError('suggestion has no recommended fields');

      // The PG-backed recorder buffers recommendations (<=1 flush / 5s per
      // fingerprint). Wait for the durable row BEFORE applying so the applied
      // marker cannot be written against a row that has not landed yet.
      JsonList recorded = const <Object?>[];
      for (var attempt = 0; attempt < 25; attempt++) {
        final listed = _expectOk(
          await _raw('GET', '$_v1Prefix/indexes/recommendations',
              headers: <String, String>{'x-vellum-api-key': _serverKey}),
          'list index recommendations',
        );
        final rows = listed['recommendations'];
        if (rows is List) {
          recorded = rows
              .where((row) => row is Map && row['fingerprint'] == suggestion.fingerprint)
              .toList();
        }
        if (recorded.isNotEmpty) break;
        await Future<void>.delayed(const Duration(milliseconds: 400));
      }
      if (recorded.isEmpty) {
        throw StateError('the advisor did not persist the uncovered-query recommendation');
      }

      final created = _expectOk(
        await _raw('POST', '$_v1Prefix/indexes',
            headers: <String, String>{'x-vellum-api-key': _serverKey},
            body: <String, Object?>{
              'collectionPath': 'v2metrics',
              'fields': suggestion.fields,
              'fingerprint': suggestion.fingerprint,
            }),
        'apply index recommendation',
      );
      if (created['id'] == null) throw StateError('index creation returned no id');

      final after = _expectOk(
        await _raw('GET', '$_v1Prefix/indexes/recommendations',
            headers: <String, String>{'x-vellum-api-key': _serverKey}),
        'list applied recommendations',
      );
      final afterRows = after['recommendations'];
      final applied = afterRows is List
          ? afterRows.where((row) => row is Map && row['fingerprint'] == suggestion.fingerprint).toList()
          : const <Object?>[];
      if (applied.isEmpty) throw StateError('applied recommendation disappeared after apply');
      if ((applied.first as Map)['status'] != 'applied') {
        throw StateError('recommendation status is ${(applied.first as Map)['status']}, expected applied');
      }
    } finally {
      advisorClient.auth.dispose();
      advisorHttp.close();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Collections lifecycle                                                  */
  /* ---------------------------------------------------------------------- */

  /// Unique, path-safe collection name for one scenario in one run.
  String _collectionsName(String tag) =>
      'qa_${tag}_${_uuid().replaceAll('-', '').substring(0, 10)}';

  /// Always request `limit=500`: the shared live registry holds more
  /// collections than the API's default page of 50, so a default fetch would
  /// hide the collections created by this testbed.
  Future<VellumCollectionInfo?> _findCollection(String name) async {
    final page = await collectionsClient.listCollections(
      limit: 500,
      search: name,
    );
    for (final VellumCollectionInfo candidate in page.collections) {
      if (candidate.name == name) return candidate;
    }
    return null;
  }

  Future<void> _scenarioCollectionsCreateEmpty() async {
    final name = _collectionsName('empty');
    final created = await collectionsClient.createCollection(name);
    if (created.name != name) {
      throw StateError('createCollection returned the wrong name');
    }
    if (created.documentCount != 0) {
      throw StateError('new collection has ${created.documentCount} documents');
    }
    final found = await _findCollection(name);
    if (found == null) {
      throw StateError('empty collection is not visible in listCollections');
    }
    if (found.documentCount != 0) {
      throw StateError('empty collection was listed with a non-zero count');
    }
  }

  Future<void> _scenarioCollectionsAutoDiscover() async {
    final name = _collectionsName('auto');
    await collectionsClient.setDoc('$name/doc_auto_1', <String, Object?>{
      'note': 'written directly through the SDK',
    });
    final found = await _findCollection(name);
    if (found == null) {
      throw StateError('direct SDK write did not auto-register the collection');
    }
    if (found.documentCount != 1) {
      throw StateError('auto-registered collection has ${found.documentCount} documents');
    }
  }

  Future<void> _scenarioCollectionsClear() async {
    final name = _collectionsName('clear');
    await collectionsClient.createCollection(name);
    await collectionsClient.setDoc('$name/d1', <String, Object?>{'value': 1});
    if ((await _findCollection(name))?.documentCount != 1) {
      throw StateError('pre-clear document count is not 1');
    }
    final cleared = await collectionsClient.clearCollection(name);
    if (cleared.deletedCount < 1) {
      throw StateError('clearCollection deleted ${cleared.deletedCount} documents');
    }
    final after = await _findCollection(name);
    if (after == null) {
      throw StateError('clearCollection removed the collection registration');
    }
    if (after.documentCount != 0) {
      throw StateError('cleared collection still reports documents');
    }
  }

  Future<void> _scenarioCollectionsDelete() async {
    final name = _collectionsName('delete');
    await collectionsClient.createCollection(name);
    await collectionsClient.setDoc('$name/d1', <String, Object?>{'value': 1});
    final dropped = await collectionsClient.deleteCollection(name);
    if (!dropped.deletedCollection) {
      throw StateError('deleteCollection did not drop the registration');
    }
    if (dropped.deletedDocuments < 1) {
      throw StateError('deleteCollection did not remove the documents');
    }
    if (await _findCollection(name) != null) {
      throw StateError('deleted collection is still listed');
    }
    if (await collectionsClient.getCollectionInfo(name) != null) {
      throw StateError('deleted collection info is not null');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  Future<void> _expectForbidden(
    Future<Object?> Function() action,
    String what,
  ) async {
    try {
      await action();
    } on VellumException catch (error) {
      if (error.statusCode == 403) return;
      throw StateError(
        '$what: expected HTTP 403, got ${error.statusCode} (${error.code})',
      );
    }
    throw StateError('$what: expected HTTP 403 but the request succeeded');
  }

  Future<void> _expectRefreshRejected(String token, String what) async {
    final response = await _raw(
      'POST',
      '$_authPrefix/token/refresh',
      headers: <String, String>{'x-vellum-api-key': _publicKey},
      body: <String, Object?>{'refreshToken': token},
    );
    if (response.statusCode < 400) {
      throw StateError('$what was still accepted (HTTP ${response.statusCode})');
    }
  }

  Future<_ApiResponse> _raw(
    String method,
    String path, {
    Map<String, String>? headers,
    Object? body,
  }) async {
    final uri = Uri.parse('$baseUrl$path');
    final allHeaders = <String, String>{
      'accept': 'application/json',
      ...?headers,
    };
    final String? encoded;
    if (body == null) {
      encoded = null;
    } else {
      allHeaders['content-type'] = 'application/json';
      encoded = jsonEncode(body);
    }

    final http.Response response;
    switch (method.toUpperCase()) {
      case 'GET':
        response = await _rawClient.get(uri, headers: allHeaders);
        break;
      case 'POST':
        response =
            await _rawClient.post(uri, headers: allHeaders, body: encoded);
        break;
      case 'PUT':
        response =
            await _rawClient.put(uri, headers: allHeaders, body: encoded);
        break;
      case 'PATCH':
        response =
            await _rawClient.patch(uri, headers: allHeaders, body: encoded);
        break;
      case 'DELETE':
        response =
            await _rawClient.delete(uri, headers: allHeaders, body: encoded);
        break;
      default:
        throw StateError('unsupported HTTP method $method');
    }

    Object? decoded;
    if (response.body.isNotEmpty) {
      try {
        decoded = jsonDecode(response.body);
      } on FormatException {
        decoded = response.body;
      }
    }
    return _ApiResponse(response.statusCode, decoded);
  }

  JsonMap _expectOk(_ApiResponse response, String what) {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final rawError = response.decoded is Map
          ? (response.decoded as Map)['error']
          : null;
      final error = rawError is Map ? rawError : const <Object?, Object?>{};
      final code = error['code'];
      final message = error['message'];
      final detail = <String>[
        'HTTP ${response.statusCode}',
        if (code is String) code,
        if (message is String) message,
      ].join(', ');
      throw StateError('$what failed ($detail)');
    }
    return response.object;
  }

  String _expiredJwt() {
    String encode(Map<String, Object?> value) =>
        base64Url.encode(utf8.encode(jsonEncode(value))).replaceAll('=', '');
    final header = encode(<String, Object?>{'alg': 'EdDSA', 'typ': 'JWT'});
    final payload = encode(<String, Object?>{
      'sub': _aliceUid ?? 'unknown',
      'exp': DateTime.now()
              .subtract(const Duration(minutes: 2))
              .millisecondsSinceEpoch ~/
          1000,
    });
    return '$header.$payload.signature';
  }

  /// RFC 6238 TOTP: HMAC-SHA1, 6 digits, 30-second step.
  String _totpCode(String secret, {DateTime? at}) {
    final counter =
        (at ?? DateTime.now()).millisecondsSinceEpoch ~/ 1000 ~/ 30;
    final message = <int>[];
    for (var shift = 56; shift >= 0; shift -= 8) {
      message.add((counter >> shift) & 0xff);
    }
    final digest = Hmac(sha1, _base32Decode(secret)).convert(message).bytes;
    final offset = digest[digest.length - 1] & 0x0f;
    final binary = ((digest[offset] & 0x7f) << 24) |
        (digest[offset + 1] << 16) |
        (digest[offset + 2] << 8) |
        digest[offset + 3];
    return (binary % 1000000).toString().padLeft(6, '0');
  }

  List<int> _base32Decode(String input) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    final clean = input
        .toUpperCase()
        .replaceAll(RegExp(r'=+$'), '')
        .replaceAll(RegExp(r'[^A-Z2-7]'), '');
    var bits = 0;
    var value = 0;
    final output = <int>[];
    for (final codeUnit in clean.codeUnits) {
      final index = alphabet.indexOf(String.fromCharCode(codeUnit));
      if (index < 0) continue;
      value = (value << 5) | index;
      bits += 5;
      if (bits >= 8) {
        output.add((value >> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return output;
  }

  String _uuid() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (int _) => random.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    String hex(int value) => value.toRadixString(16).padLeft(2, '0');
    return <String>[
      hex(bytes[0]),
      hex(bytes[1]),
      hex(bytes[2]),
      hex(bytes[3]),
      '-',
      hex(bytes[4]),
      hex(bytes[5]),
      '-',
      hex(bytes[6]),
      hex(bytes[7]),
      '-',
      hex(bytes[8]),
      hex(bytes[9]),
      '-',
      hex(bytes[10]),
      hex(bytes[11]),
      hex(bytes[12]),
      hex(bytes[13]),
      hex(bytes[14]),
      hex(bytes[15]),
    ].join();
  }

  String _safeError(Object error) {
    if (error is VellumException) {
      return '${error.code} [HTTP ${error.statusCode}]: ${error.message}';
    }
    if (error is StateError) return error.message;
    if (error is TimeoutException) return 'operation timed out';
    if (error is SocketException) return 'network error: ${error.message}';
    return error.runtimeType.toString();
  }
}
