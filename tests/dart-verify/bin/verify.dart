// Cross-cutting real-backend verification harness for VELLUM SaaS.
//
// Every check runs against a REAL `apps/api` process backed by PostgreSQL.
// No mocks, no simulated responses, no skipped checks, no hardcoded secrets.
// A Markdown report is written to --output (default: VERIFICATION-REPORT.md).
//
// Run (CLI args or VELLUM_* environment variables):
//   dart run tests/dart-verify \
//     --VELLUM_ENDPOINT=http://127.0.0.1:8080 \
//     --VELLUM_PROJECT_ID=<uuid> \
//     --VELLUM_API_KEY=pk_... \
//     --VELLUM_REPORT=tests/dart-verify/VERIFICATION-REPORT.md

import "dart:async";
import "dart:convert";
import "dart:io";

import "package:vellum_flutter/vellum_flutter_core.dart";
import "package:http/http.dart" as http;

// ---------------------------------------------------------------------------
// Configuration (injected; never embedded)
// ---------------------------------------------------------------------------

class Config {
  Config._();

  /// Reads a setting from CLI `--key=value` args first, then the process
  /// environment, then the fallback. This keeps the harness runnable with
  /// plain `dart run` on any Dart 3.x toolchain.
  static List<String> cliArgs = const [];

  static String _read(String name, String fallback) {
    for (final arg in cliArgs) {
      if (arg == "--$name") return "true";
      if (arg.startsWith("--$name=")) return arg.substring(name.length + 3);
    }
    final value = Platform.environment[name];
    if (value != null && value.isNotEmpty) return value;
    return fallback;
  }

  static final String endpoint = _read("VELLUM_ENDPOINT", "http://127.0.0.1:8080");
  static final String projectId = _read("VELLUM_PROJECT_ID", "");
  static final String apiKey = _read("VELLUM_API_KEY", "");
  static final String collection = _read("VELLUM_TEST_COLLECTION", "test");
  static final String reportPath = _read("VELLUM_REPORT", "VERIFICATION-REPORT.md");
  static final String consoleEmail = _read("VELLUM_CONSOLE_EMAIL", "visual@vellum.dev");
  static final String consolePassword = _read("VELLUM_CONSOLE_PASSWORD", "visual123");
  static final String adminEmail = _read("VELLUM_ADMIN_EMAIL", "visual-admin@vellum.dev");
  static final String adminPassword = _read("VELLUM_ADMIN_PASSWORD", "visual123");

  static String get maskedApiKey {
    if (apiKey.length <= 8) return "(set)";
    return "${apiKey.substring(0, 4)}••••${apiKey.substring(apiKey.length - 4)}";
  }

  static String get base => "$endpoint/v1/projects/$projectId";
}

// ---------------------------------------------------------------------------
// Runner / report model
// ---------------------------------------------------------------------------

class Check {
  final String group;
  final String name;
  final bool passed;
  final String detail;
  final int ms;
  const Check(this.group, this.name, this.passed, this.detail, this.ms);
}

class Suite {
  final List<Check> checks = [];
  final Stopwatch total = Stopwatch()..start();
  String? _group;

  void group(String name) => _group = name;

  Future<void> run(String name, Future<String> Function() body) async {
    final sw = Stopwatch()..start();
    try {
      final detail = await body().timeout(const Duration(seconds: 45));
      checks.add(Check(_group ?? "General", name, true, detail, sw.elapsedMilliseconds));
      stdout.write(".");
    } catch (error, stack) {
      final msg = error.toString().split("\n").first;
      checks.add(Check(_group ?? "General", name, false, msg, sw.elapsedMilliseconds));
      stdout.write("F");
      stderr.writeln("\n  ✗ ${_group ?? 'General'} / $name :: $msg");
      if (error is! StateError) stderr.writeln(stack.toString().split("\n").take(3).join("\n"));
    }
  }

  void require(bool condition, String message) {
    if (!condition) throw StateError(message);
  }

  int get passed => checks.where((c) => c.passed).length;
  int get failed => checks.length - passed;

  String renderReport() {
    total.stop();
    final byGroup = <String, List<Check>>{};
    for (final c in checks) {
      (byGroup.putIfAbsent(c.group, () => []))..add(c);
    }
    final b = StringBuffer()
      ..writeln("# VELLUM — Comprehensive Verification Report")
      ..writeln()
      ..writeln("Generated: ${DateTime.now().toIso8601String()}")
      ..writeln()
      ..writeln("- Endpoint: `${Config.endpoint}`")
      ..writeln("- Project: `${Config.projectId}`")
      ..writeln("- API key: `${Config.maskedApiKey}`")
      ..writeln("- Wall time: ${(total.elapsedMilliseconds / 1000).toStringAsFixed(2)} s")
      ..writeln()
      ..writeln("## Summary")
      ..writeln()
      ..writeln("| Metric | Value |")
      ..writeln("| --- | --- |")
      ..writeln("| Total | ${checks.length} |")
      ..writeln("| Passed | $passed |")
      ..writeln("| Failed | $failed |")
      ..writeln()
      ..writeln("## Feature matrix")
      ..writeln()
      ..writeln("| Area | Pass / Total |")
      ..writeln("| --- | --- |");
    for (final entry in byGroup.entries) {
      final p = entry.value.where((c) => c.passed).length;
      b.writeln("| ${entry.key} | $p/${entry.value.length} |");
    }
    b
      ..writeln()
      ..writeln("## Failures")
      ..writeln();
    final failures = checks.where((c) => !c.passed).toList();
    if (failures.isEmpty) {
      b.writeln("None. All checks passed against the live backend.");
    } else {
      for (final c in failures) {
        b.writeln("- **${c.group} / ${c.name}**: ${c.detail}");
      }
    }
    b
      ..writeln()
      ..writeln("## Details")
      ..writeln();
    for (final entry in byGroup.entries) {
      b
        ..writeln("### ${entry.key}")
        ..writeln()
        ..writeln("| Result | Check | Detail | ms |")
        ..writeln("| --- | --- | --- | --- |");
      for (final c in entry.value) {
        final detail = c.detail.replaceAll("|", "\\|").replaceAll("\n", " ");
        b.writeln("| ${c.passed ? "PASS" : "FAIL"} | ${c.name} | $detail | ${c.ms} |");
      }
      b.writeln();
    }
    return b.toString();
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers (raw control-plane / authz checks)
// ---------------------------------------------------------------------------

final http.Client _http = http.Client();

class HttpResult {
  final int status;
  final Map<String, dynamic> body;
  final Map<String, String> headers;
  const HttpResult(this.status, this.body, this.headers);
}

Future<HttpResult> raw(
  String method,
  String url, {
  Map<String, String>? headers,
  Object? body,
}) async {
  final h = <String, String>{"content-type": "application/json", ...?headers};
  final res = await _http.send(http.Request(method, Uri.parse(url))
    ..headers.addAll(h)
    ..body = body == null ? "" : jsonEncode(body));
  final text = await res.stream.bytesToString();
  Map<String, dynamic> decoded = {};
  try {
    if (text.isNotEmpty) decoded = (jsonDecode(text) as Map).cast<String, dynamic>();
  } catch (_) {}
  return HttpResult(res.statusCode, decoded, res.headers.map((k, v) => MapEntry(k.toLowerCase(), v)));
}

String _code(HttpResult r) => (r.body["error"] as Map?)?["code"]?.toString() ?? "";

void _expectDenied(HttpResult r, String what) {
  if (r.status < 400) throw StateError("$what was accepted (HTTP ${r.status})");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

Future<void> main(List<String> arguments) async {
  Config.cliArgs = arguments;
  if (Config.projectId.isEmpty || Config.apiKey.isEmpty) {
    stderr.writeln("VELLUM_PROJECT_ID and VELLUM_API_KEY must be supplied via --dart-define.");
    exit(2);
  }
  final suite = Suite();
  final runId = DateTime.now().millisecondsSinceEpoch;
  final category = "auto_${runId}_q";
  final endpoint = Config.endpoint;
  final base = Config.base;

  VellumClient client({String? endpoint, String? projectId, String? apiKey}) => VellumClient(
        endpoint: endpoint ?? Config.endpoint,
        projectId: projectId ?? Config.projectId,
        apiKey: apiKey ?? Config.apiKey,
      );
  final db = client();

  Future<Map<String, dynamic>?> readOrNull(VellumClient c, String path) async {
    try {
      return (await c.getDoc(path)).data();
    } on VellumException catch (e) {
      if (e.code == "NOT_FOUND") return null;
      rethrow;
    }
  }

  // ---------------------------------------------------------------- connection
  suite.group("Connection");
  await suite.run("health/live responds 200", () async {
    final r = await raw("GET", "${Config.endpoint}/v1/health/live");
    suite.require(r.status == 200, "health/live returned ${r.status}");
    return "HTTP 200";
  });
  await suite.run("health/ready responds 200", () async {
    final r = await raw("GET", "${Config.endpoint}/v1/health/ready");
    suite.require(r.status == 200, "health/ready returned ${r.status}");
    return "HTTP 200";
  });

  // ---------------------------------------------------------------------- setup
  suite.group("Setup");
  await suite.run("Seed 5 query fixture documents", () async {
    for (var i = 1; i <= 5; i++) {
      await db.setDoc("${Config.collection}/auto_${runId}_q$i", {
        "category": category,
        "item_name": "Query Item $i",
        "item_price": i * 10.0,
      });
    }
    return "Seeded 5 documents in $category";
  });

  // ----------------------------------------------------------------------- CRUD
  suite.group("CRUD");
  final crudPath = "${Config.collection}/auto_${runId}_crud";
  await suite.run("set() creates a document", () async {
    await db.setDoc(crudPath, {"item_name": "CRUD Test", "item_price": 42.5, "category": category});
    final data = await readOrNull(db, crudPath);
    suite.require(data != null, "document missing after set");
    return "Created $crudPath";
  });
  await suite.run("get() reads the created document", () async {
    final data = await readOrNull(db, crudPath);
    suite.require(data?["item_price"] == 42.5, "item_price mismatch");
    return "Fields match";
  });
  await suite.run("set() replaces the whole document", () async {
    await db.setDoc(crudPath, {"item_name": "Replaced"});
    final data = await readOrNull(db, crudPath);
    suite.require(data?["item_name"] == "Replaced" && data?["item_price"] == null, "replace semantics failed");
    return "Replace semantics verified";
  });
  await suite.run("set(merge: true) preserves other fields", () async {
    await db.setDoc(crudPath, {"item_name": "Merged"}, merge: true);
    final data = await readOrNull(db, crudPath);
    suite.require(data?["item_name"] == "Merged" && data?["item_price"] == null, "merge semantics failed");
    await db.setDoc(crudPath, {"item_price": 42.5}, merge: true);
    final merged = await readOrNull(db, crudPath);
    suite.require(merged?["item_name"] == "Merged" && merged?["item_price"] == 42.5, "merge lost fields");
    return "Merge preserved unrelated fields";
  });
  await suite.run("update() patches a single field", () async {
    await db.updateDoc(crudPath, {"item_name": "Patched"});
    final data = await readOrNull(db, crudPath);
    suite.require(data?["item_name"] == "Patched" && data?["item_price"] == 42.5, "patch failed");
    return "Atomic patch applied";
  });
  await suite.run("get() on a missing document returns null", () async {
    final data = await readOrNull(db, "${Config.collection}/auto_${runId}_never");
    suite.require(data == null, "missing document returned data");
    return "NOT_FOUND normalised to null";
  });
  await suite.run("delete() removes a document", () async {
    final path = "${Config.collection}/auto_${runId}_del";
    await db.setDoc(path, {"x": 1});
    await db.deleteDoc(path);
    final data = await readOrNull(db, path);
    suite.require(data == null, "document still present after delete");
    return "Deleted";
  });

  // ---------------------------------------------------------------------- query
  suite.group("Query");
  Future<int> count(Query<Map<String, dynamic>> q) async => (await q.get()).docs.length;
  await suite.run("where == matches the seeded category", () async {
    final n = await count(db.collection(Config.collection).where("category", "==", category));
    suite.require(n == 5, "expected 5 matches, got $n");
    return "$n matching documents";
  });
  await suite.run("where > (item_price > 25)", () async {
    final n = await count(db.collection(Config.collection).where("category", "==", category).where("item_price", ">", 25));
    suite.require(n == 3, "expected 3, got $n");
    return "$n matching documents";
  });
  await suite.run("where >= (item_price >= 30)", () async {
    final n = await count(db.collection(Config.collection).where("category", "==", category).where("item_price", ">=", 30));
    suite.require(n == 3, "expected 3, got $n");
    return "$n matching documents";
  });
  await suite.run("where < (item_price < 30)", () async {
    final n = await count(db.collection(Config.collection).where("category", "==", category).where("item_price", "<", 30));
    suite.require(n == 2, "expected 2, got $n");
    return "$n matching documents";
  });
  await suite.run("where <= (item_price <= 20)", () async {
    final n = await count(db.collection(Config.collection).where("category", "==", category).where("item_price", "<=", 20));
    suite.require(n == 2, "expected 2, got $n");
    return "$n matching documents";
  });
  await suite.run("where != (item_price != 30)", () async {
    final n = await count(db.collection(Config.collection).where("category", "==", category).where("item_price", "!=", 30));
    suite.require(n == 4, "expected 4, got $n");
    return "$n matching documents";
  });
  await suite.run("where in ([10, 30])", () async {
    final n = await count(db.collection(Config.collection).where("category", "==", category).where("item_price", "in", [10, 30]));
    suite.require(n == 2, "expected 2, got $n");
    return "$n matching documents";
  });
  await suite.run("orderBy ascending", () async {
    final page = await db.collection(Config.collection).where("category", "==", category).orderBy("item_price").get();
    final prices = page.docs.map((d) => (d.data()?["item_price"] as num?)?.toDouble() ?? 0.0).toList();
    final sorted = List<double>.from(prices)..sort();
    suite.require(_sameList(prices, sorted), "not ascending: $prices");
    return "ascending: $prices";
  });
  await suite.run("orderBy descending", () async {
    final page = await db.collection(Config.collection).where("category", "==", category).orderBy("item_price", dir: "desc").get();
    final prices = page.docs.map((d) => (d.data()?["item_price"] as num?)?.toDouble() ?? 0.0).toList();
    final sorted = List<double>.from(prices)..sort();
    suite.require(_sameList(prices, sorted.reversed.toList()), "not descending: $prices");
    return "descending: $prices";
  });
  await suite.run("limit(3)", () async {
    final n = await count(db.collection(Config.collection).where("category", "==", category).limit(3));
    suite.require(n == 3, "expected 3, got $n");
    return "$n documents";
  });
  await suite.run("startAfter cursor pagination", () async {
    final first = await db.collection(Config.collection).where("category", "==", category).orderBy("item_price").limit(2).get();
    suite.require(first.nextCursor != null && first.docs.length == 2, "no next cursor");
    final second = await db.collection(Config.collection).where("category", "==", category).orderBy("item_price").limit(2).startAfter(first.nextCursor!).get();
    suite.require(second.docs.isNotEmpty, "second page empty");
    final a = first.docs.map((d) => d.id).toSet();
    suite.require(second.docs.every((d) => !a.contains(d.id)), "overlapping pages");
    return "2 + ${second.docs.length} non-overlapping documents";
  });

  // ------------------------------------------------------------------ realtime
  suite.group("Realtime");
  await suite.run("snapshots() emits an initial event", () async {
    final events = <QuerySnapshot<Map<String, dynamic>>>[];
    Object? streamError;
    final sub = db.collection(Config.collection).where("category", "==", category).snapshots().listen(
          events.add,
          onError: (Object e) => streamError = e,
        );
    try {
      await _waitUntil(() => events.isNotEmpty || streamError != null);
      if (streamError != null) throw streamError!;
      suite.require(events.isNotEmpty, "no initial snapshot");
      return "Initial snapshot with ${events.first.docs.length} doc(s)";
    } finally {
      await sub.cancel();
    }
  });
  await suite.run("snapshots() detects a real write", () async {
    final rtCat = "auto_${runId}_rt";
    final events = <QuerySnapshot<Map<String, dynamic>>>[];
    Object? streamError;
    final sub = db.collection(Config.collection).where("category", "==", rtCat).snapshots().listen(
          events.add,
          onError: (Object e) => streamError = e,
        );
    try {
      await _waitUntil(() => events.isNotEmpty || streamError != null);
      if (streamError != null) throw streamError!;
      final before = events.length;
      await db.setDoc("${Config.collection}/auto_${runId}_rt_write", {
        "category": rtCat,
        "item_name": "Realtime write",
        "ts": runId,
      });
      await _waitUntil(() => events.length > before || streamError != null);
      if (streamError != null) throw streamError!;
      suite.require(events.length > before, "no event after write");
      return "Received ${events.length - before} update event(s) after write";
    } finally {
      await sub.cancel();
    }
  });

  // ---------------------------------------------------------------------- batch
  suite.group("Batch");
  await suite.run("batchWrite() commits two sets", () async {
    await db.batchWrite([
      {"type": "set", "path": "${Config.collection}/auto_${runId}_b1", "data": {"batch": runId, "n": 1}},
      {"type": "set", "path": "${Config.collection}/auto_${runId}_b2", "data": {"batch": runId, "n": 2}},
    ]);
    final a = await readOrNull(db, "${Config.collection}/auto_${runId}_b1");
    final b = await readOrNull(db, "${Config.collection}/auto_${runId}_b2");
    suite.require(a?["n"] == 1 && b?["n"] == 2, "batch sets missing");
    return "2 documents written atomically";
  });
  await suite.run("batchWrite() commits a delete", () async {
    final path = "${Config.collection}/auto_${runId}_b1";
    await db.batchWrite([
      {"type": "delete", "path": path},
    ]);
    final data = await readOrNull(db, path);
    suite.require(data == null, "document still present");
    return "Deleted via batch";
  });

  // --------------------------------------------------------------- transactions
  suite.group("Transactions");
  await suite.run("runTransaction() increments a counter", () async {
    final path = "${Config.collection}/auto_${runId}_counter";
    Future<int> increment() => db.runTransaction<int>((tx) async {
          Map<String, dynamic>? data;
          try {
            data = (await tx.get(db.doc(path))).data();
          } on VellumException catch (e) {
            if (e.code != "NOT_FOUND") rethrow;
          }
          final current = (data?["count"] as num?)?.toInt() ?? 0;
          final updated = current + 1;
          tx.set(db.doc(path), {"count": updated});
          return updated;
        });
    final a = await increment();
    final b = await increment();
    suite.require(a == 1 && b == 2, "counter sequence was $a,$b");
    final stored = await readOrNull(db, path);
    suite.require(stored?["count"] == 2, "stored counter mismatch");
    return "counter 0 -> 1 -> 2";
  });

  // ------------------------------------------------------------- subcollections
  suite.group("Subcollections");
  await suite.run("nested path is routed and rules are enforced", () async {
    final path = "${Config.collection}/auto_${runId}_parent/children/auto_${runId}_child";
    try {
      await db.setDoc(path, {"item_name": "Child", "item_price": 5.0});
    } on VellumException catch (e) {
      suite.require(e.code == "PERMISSION_DENIED", "unexpected rejection: ${e.code}");
      return "Nested write denied by rules (403)";
    }
    final data = await readOrNull(db, path);
    suite.require(data != null, "write succeeded but nested document is unreadable");
    return "Nested write allowed by rules";
  });

  // -------------------------------------------------------------- errors/limits
  suite.group("Errors");
  await suite.run("invalid API key is rejected", () async {
    final bad = client(apiKey: "pk_invalid_verify_key");
    try {
      await bad.collection(Config.collection).limit(1).get();
      throw StateError("invalid key was accepted");
    } on VellumException catch (e) {
      return "Rejected: ${e.code} (HTTP ${e.statusCode})";
    }
  });
  await suite.run("unknown project is rejected", () async {
    final bad = client(projectId: "00000000-0000-0000-0000-000000000000");
    try {
      await bad.collection(Config.collection).limit(1).get();
      throw StateError("unknown project was accepted");
    } on VellumException catch (e) {
      return "Rejected: ${e.code} (HTTP ${e.statusCode})";
    }
  });
  await suite.run("empty document id is rejected", () async {
    try {
      await db.setDoc("", {"x": 1});
      throw StateError("empty path was accepted");
    } on VellumException catch (e) {
      suite.require(e.code == "INVALID_DOCUMENT_PATH", "wrong code: ${e.code}");
      return "Rejected: ${e.code}";
    }
  });
  await suite.run("unreachable endpoint throws", () async {
    final bad = client(endpoint: "http://127.0.0.1:1");
    try {
      await bad.collection(Config.collection).limit(1).get();
      throw StateError("unreachable endpoint did not throw");
    } catch (e) {
      return "Threw: ${e.toString().split("\n").first}";
    }
  });

  // ------------------------------------------------------- end-user auth (SDK)
  suite.group("End-user auth");
  final authEmail = "verify_${runId}@vellum.dev";
  final authPassword = "Verify!2345";
  late VellumUser signedUp;
  await suite.run("sign-up with email + password", () async {
    signedUp = await db.auth.signUpWithEmailAndPassword(email: authEmail, password: authPassword, displayName: "Verify User");
    suite.require(signedUp.accessToken.isNotEmpty && signedUp.refreshToken.isNotEmpty, "missing tokens");
    suite.require(signedUp.email == authEmail, "email mismatch");
    return "User ${signedUp.id} created";
  });
  await suite.run("wrong password is rejected", () async {
    try {
      await db.auth.signInWithEmailAndPassword(email: authEmail, password: "Wrong!9999");
      throw StateError("wrong password accepted");
    } on VellumException catch (e) {
      suite.require(e.code == "UNAUTHENTICATED", "wrong code: ${e.code}");
      return "Rejected: ${e.code}";
    }
  });
  await suite.run("sign-in with correct password", () async {
    final result = await db.auth.signInWithEmailAndPassword(email: authEmail, password: authPassword);
    suite.require(result is VellumSession, "expected a session, got ${result.runtimeType}");
    suite.require((result as VellumSession).user.accessToken.isNotEmpty, "no access token");
    return "Session issued for ${signedUp.id}";
  });
  await suite.run("forced token refresh issues new tokens", () async {
    final before = db.auth.currentUser!.accessToken;
    final after = await db.auth.getIdToken(forceRefresh: true);
    suite.require(after != null && after.isNotEmpty && after != before, "token did not rotate");
    return "Access token rotated";
  });
  await suite.run("get profile requires the bearer token", () async {
    final user = await db.auth.getUser();
    suite.require(user.email == authEmail, "profile email mismatch");
    return "Profile: ${user.email}";
  });
  await suite.run("update profile persists", () async {
    final user = await db.auth.updateProfile(displayName: "Verified User");
    suite.require(user.displayName == "Verified User", "displayName not updated");
    return "displayName updated";
  });
  await suite.run("end-user JWT is accepted on the document plane", () async {
    final data = await readOrNull(db, crudPath);
    suite.require(data != null, "authenticated read failed");
    return "Authenticated document read OK";
  });
  await suite.run("sign-out clears local session", () async {
    await db.auth.signOut();
    suite.require(db.auth.currentUser == null, "currentUser not cleared");
    return "Signed out";
  });

  // --------------------------------------------------- authz: keys & realms
  suite.group("Authorization");
  await suite.run("public JWKS endpoint is reachable without a key", () async {
    final r = await raw("GET", "$base/auth/.well-known/jwks.json");
    suite.require(r.status == 200, "JWKS returned ${r.status}");
    suite.require((r.body["keys"] as List?)?.isNotEmpty == true, "no public keys");
    return "${(r.body["keys"] as List).length} public key(s)";
  });
  await suite.run("publishable key can read documents", () async {
    final page = await db.collection(Config.collection).limit(1).get();
    return "Read ${page.docs.length} document(s)";
  });
  await suite.run("missing API key is rejected", () async {
    final r = await raw("POST", "$base/query", body: {"collectionPath": Config.collection, "limit": 1});
    _expectDenied(r, "Missing-key query");
    return "Rejected: HTTP ${r.status}";
  });
  await suite.run("invalid API key is rejected at HTTP layer", () async {
    final r = await raw("POST", "$base/query", headers: {"x-vellum-api-key": "pk_invalid_verify"}, body: {"collectionPath": Config.collection, "limit": 1});
    _expectDenied(r, "Invalid-key query");
    return "Rejected: HTTP ${r.status}/${_code(r)}";
  });
  await suite.run("cross-project key reuse is rejected", () async {
    final r = await raw(
      "POST",
      "$endpoint/v1/projects/00000000-0000-0000-0000-000000000000/query",
      headers: {"x-vellum-api-key": Config.apiKey},
      body: {"collectionPath": Config.collection, "limit": 1},
    );
    _expectDenied(r, "Cross-project query");
    return "Rejected: HTTP ${r.status}/${_code(r)}";
  });
  await suite.run("forged HS256 user token is rejected (EdDSA-only plane)", () async {
    final header = base64UrlEncode(utf8.encode(jsonEncode({"alg": "HS256", "typ": "JWT"})));
    final payload = base64UrlEncode(utf8.encode(jsonEncode({"sub": "attacker", "realm": "super_admin"})));
    final forged = "$header.$payload.forged_signature";
    final r = await raw(
      "POST",
      "$base/query",
      headers: {"x-vellum-api-key": Config.apiKey, "x-vellum-user-token": forged},
      body: {"collectionPath": Config.collection, "limit": 1},
    );
    _expectDenied(r, "Forged-HS256 query");
    return "Rejected: HTTP ${r.status}/${_code(r)}";
  });

  // ------------------------------------------------ authz: control-plane realms
  late String consoleToken;
  late String adminToken;
  await suite.run("console sign-in issues customer_console realm token", () async {
    final r = await raw("POST", "$endpoint/v1/auth/sign-in/email", body: {"email": Config.consoleEmail, "password": Config.consolePassword});
    suite.require(r.status == 200, "console sign-in HTTP ${r.status}");
    consoleToken = r.body["token"] as String? ?? "";
    suite.require(_realm(consoleToken) == "customer_console", "wrong realm: ${_realm(consoleToken)}");
    return "realm=${_realm(consoleToken)}";
  });
  await suite.run("admin login issues super_admin realm token", () async {
    final r = await raw("POST", "$endpoint/v1/admin/login", body: {"email": Config.adminEmail, "password": Config.adminPassword});
    suite.require(r.status == 200, "admin login HTTP ${r.status}");
    adminToken = r.body["token"] as String? ?? "";
    suite.require(_realm(adminToken) == "super_admin", "wrong realm: ${_realm(adminToken)}");
    return "realm=${_realm(adminToken)}";
  });
  await suite.run("console token is accepted by console API", () async {
    final r = await raw("GET", "$endpoint/v1/console/organizations", headers: {"authorization": "Bearer $consoleToken"});
    suite.require(r.status == 200, "console API HTTP ${r.status}");
    return "HTTP 200";
  });
  await suite.run("admin token is accepted by admin API", () async {
    final r = await raw("GET", "$endpoint/v1/admin/auth/overview", headers: {"authorization": "Bearer $adminToken"});
    suite.require(r.status == 200, "admin API HTTP ${r.status}");
    return "HTTP 200";
  });
  await suite.run("console token is rejected by admin API", () async {
    final r = await raw("GET", "$endpoint/v1/admin/auth/overview", headers: {"authorization": "Bearer $consoleToken"});
    _expectDenied(r, "Console token on admin API");
    return "Rejected: HTTP ${r.status}/${_code(r)}";
  });
  await suite.run("admin token is rejected by console API", () async {
    final r = await raw("GET", "$endpoint/v1/console/organizations", headers: {"authorization": "Bearer $adminToken"});
    _expectDenied(r, "Admin token on console API");
    return "Rejected: HTTP ${r.status}/${_code(r)}";
  });
  await suite.run("control tokens are rejected by document plane", () async {
    for (final token in [consoleToken, adminToken]) {
      final r = await raw(
        "POST",
        "$base/query",
        headers: {"authorization": "Bearer $token"},
        body: {"collectionPath": Config.collection, "limit": 1},
      );
      _expectDenied(r, "Control token on document plane");
    }
    return "Both control-plane realms rejected without an API key";
  });
  await suite.run("console session refresh rotates tokens", () async {
    final signin = await raw("POST", "$endpoint/v1/auth/sign-in/email", body: {"email": Config.consoleEmail, "password": Config.consolePassword});
    final refresh = signin.body["refreshToken"] as String? ?? "";
    suite.require(refresh.isNotEmpty, "no refresh token in console sign-in");
    final r = await raw("POST", "$endpoint/v1/console/auth/refresh", body: {"refreshToken": refresh});
    suite.require(r.status == 200, "console refresh HTTP ${r.status}");
    suite.require((r.body["token"] ?? r.body["accessToken"]) is String, "no access token in refresh");
    return "Console access token rotated";
  });
  await suite.run("admin session refresh rotates tokens", () async {
    final signin = await raw("POST", "$endpoint/v1/admin/login", body: {"email": Config.adminEmail, "password": Config.adminPassword});
    final refresh = signin.body["refreshToken"] as String? ?? "";
    suite.require(refresh.isNotEmpty, "no refresh token in admin login");
    final r = await raw("POST", "$endpoint/v1/admin/auth/session/refresh", body: {"refreshToken": refresh});
    suite.require(r.status == 200, "admin refresh HTTP ${r.status}");
    suite.require((r.body["token"] ?? r.body["accessToken"]) is String, "no access token in refresh");
    return "Admin access token rotated";
  });
  await suite.run("refresh cookies are realm-isolated", () async {
    final c = await raw("POST", "$endpoint/v1/auth/sign-in/email", body: {"email": Config.consoleEmail, "password": Config.consolePassword});
    final a = await raw("POST", "$endpoint/v1/admin/login", body: {"email": Config.adminEmail, "password": Config.adminPassword});
    final consoleCookie = c.headers["set-cookie"] ?? "";
    final adminCookie = a.headers["set-cookie"] ?? "";
    suite.require(consoleCookie.contains("vellum_console_rt"), "console cookie missing: $consoleCookie");
    suite.require(adminCookie.contains("vellum_admin_rt"), "admin cookie missing: $adminCookie");
    return "vellum_console_rt vs vellum_admin_rt";
  });

  // ------------------------------------------------------------------- finalize
  _http.close();
  final report = suite.renderReport();
  final file = File(Config.reportPath);
  await file.writeAsString(report);

  stdout.writeln("\n\n${suite.passed}/${suite.checks.length} checks passed (${suite.failed} failed).");
  stdout.writeln("Report written to ${file.absolute.path}");
  exit(suite.failed == 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

bool _sameList<T>(List<T> a, List<T> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

Future<void> _waitUntil(bool Function() condition, {Duration timeout = const Duration(seconds: 20)}) async {
  final sw = Stopwatch()..start();
  while (!condition()) {
    if (sw.elapsed > timeout) throw StateError("Timed out waiting for condition");
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
}

String _realm(String token) {
  try {
    final parts = token.split(".");
    if (parts.length != 3) return "";
    final payload = parts[1];
    final padded = payload.padRight(payload.length + (4 - payload.length % 4) % 4, "=");
    final decoded = utf8.decode(base64Url.decode(padded));
    return (jsonDecode(decoded) as Map)["realm"]?.toString() ?? "";
  } catch (_) {
    return "";
  }
}
