# `vellum_flutter`

Official **Flutter** SDK for **VELLUM** — a PostgreSQL-backed, multi-tenant document database with strong consistency, cursor streaming, real-time WebSocket sync, and reactive EdDSA end-user authentication.

A single package for **Flutter (iOS, Android, Web, macOS, Windows, Linux)**, strictly null-safe (Dart `>=3.4.0 <4.0.0`, Flutter `>=3.22.0`). It includes the data client, auth, realtime (web supported; the built-in browser sign-in launcher covers mobile and desktop), **encrypted persistent sessions**, and **Google and GitHub sign-in** through the system browser (`createVellumOAuth`). Nothing else to install or configure. For the native Google account picker, add the official `google_sign_in` package to your own app and pass its ID token to `signInWithGoogleIdToken`.

It requires the Flutter SDK. It is no longer usable from plain Dart servers or CLIs.

### Sign in with Google or GitHub on Android and iOS

```dart
final oauth = createVellumOAuth(
  auth: client.auth, // no redirect URI
  onConfirmationCode: (code) => setState(() => shownCode = code), // show it while signing in
);
final result = await oauth.signIn('google'); // or 'github'
setState(() => shownCode = null);
```

Without a `redirectUri` the SDK uses redirect-less sign-in, which you must first turn on in Auth Studio (Providers > Redirect-less sign-in; off by default because a fake app can show the confirmation code too, so deep links or App/Universal Links are safer). It opens the system browser (Custom Tabs on Android, Safari on iOS) and collects the result by polling the API with a PKCE verifier that never leaves the app. You register nothing in `AndroidManifest.xml` or `Info.plist`, add nothing to Auth Studio, and it keeps working if the OS recreates your app while the browser is open. The browser page asks the person to type the short code your app shows through `onConfirmationCode` (required: it stops a phishing link from signing a victim in to someone else's app or linking their account to an attacker's), then they return to the app. Pass `redirectUri: 'myapp://auth-callback'` if you prefer a deep link (then register the scheme and add the URI in Auth Studio). Both Google and GitHub need to be enabled and configured in Auth Studio > Providers. For Google's native account picker use `google_sign_in` and `signInWithGoogleIdToken`; add your Android and iOS client IDs as extra allowed audiences.

---

## Highlights

- **Type-Safe Domain Models**: `CollectionReference.withConverter<R>(fromVellum:, toVellum:)` for compile-time safety across CRUD, queries, streaming, and realtime streams.
- **Complete CRUD & Atomic Field Operations**: `collection()`, `doc()`, shorthand `getDoc`/`setDoc`/`updateDoc`/`deleteDoc`, optimistic concurrency (`ifVersion`), per-document TTL (`ttlSeconds` / `expiresAt`), `Idempotency-Key` support, and `FieldOp` / `FieldValue` (`increment`, `serverTimestamp`, `arrayUnion`, `arrayRemove`, `deleteField`).
- **Full V2 Query Engine**: All 13 filter operators (`contains_ci`, `starts_with_ci`, `text_search`, etc.), disjunctive `or()`, eager `include()` (`VellumInclude`), dot-path `select()`, and server-side `aggregate()` (`AggregateMetric.count/sum/avg/min/max`, `groupBy`).
- **Lazy Cursor `Stream` Pagination**: `streamPages()` and `streamDocuments()` iterate arbitrarily large collections over HMAC-signed cursors with bounded memory.
- **Auto-Chunked Bulk Writes & OCC Transactions**: `writeBatchChunked()` and fluent `client.batch().commitChunked()` (default 500 ops/chunk with deterministic `idempotencyKeyPrefix`), plus `runTransaction()` with automatic `ABORTED_CONFLICT` retry.
- **Production HTTP Hardening**: `coalesceInFlightGets` (enabled by default), configurable `requestTimeout`, `maxRetries`, `Retry-After` (delta-seconds & IMF-fixdate) + full-jitter exponential backoff.
- **Resilient Realtime WebSocket**: Single multiplexed connection with decorrelated jitter reconnect (`500ms`–`30s`), per-subscription `resumeSeqId`, bounded outbound queue (`256` frames), and `25s`/`60s` ping/pong heartbeat.
- **Hardened EdDSA Auth & Security**: `VellumAuth` with `sessionEpoch` race protection, proactive 45s + single-flight 401 refresh, pluggable `AuthTokenStorage`, secret-redacted `toString()` on all sensitive types, path-traversal protection, and `dispose()`/`close()`.

---

## Installation

Add `vellum_flutter` to your `pubspec.yaml`:

```yaml
dependencies:
  vellum_flutter: ^0.0.5
```

```bash
dart pub get
# or
flutter pub get
```

---

## Quick Start

```dart
import 'package:vellum_flutter/vellum_flutter.dart';

Future<void> main() async {
  final client = VellumClient(
    endpoint: 'https://api.example.com',
    projectId: 'proj_01j9...',
    apiKey: 'pk_live_...',
    requestTimeout: const Duration(seconds: 15),
    maxRetries: 3,
    coalesceInFlightGets: true,
  );

  // Create a document with TTL and atomic server timestamp
  await client.collection('users').doc('usr_ada').create(
    {
      'name': 'Ada Lovelace',
      'role': 'admin',
      'loginCount': 1,
      'tags': ['engineering'],
      'createdAt': FieldValue.serverTimestamp(),
    },
    ttlSeconds: 86400,
  );

  // Read with field projection
  final snap = await client.doc('users/usr_ada').get(select: ['name', 'role', 'loginCount']);
  print('v${snap.version}: ${snap.data()}');

  // Atomic partial update with optimistic concurrency
  await client.updateDoc(
    'users/usr_ada',
    {
      'loginCount': FieldValue.increment(1),
      'tags': FieldValue.arrayUnion(['founders']),
      'legacyFlag': FieldValue.deleteField(),
    },
    ifVersion: snap.version,
  );

  // Always release auth timers, caches, and WebSocket connections
  client.dispose();
}
```

---

## Client Configuration (`VellumClient`)

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `projectId` | `String` | **Required** | Target VELLUM project ID. |
| `apiKey` | `String` | **Required** | Project API key (`pk_...` for mobile/web, `sk_...` for trusted backends). |
| `endpoint` | `String?` | `''` | Host origin; derives `<endpoint>/v1/projects/<projectId>`. |
| `baseUrl` | `String?` | Derived from `endpoint` | Explicit full REST prefix override. |
| `httpClient` | `http.Client?` | Short-lived `http.Client` | Inject a long-lived `package:http` client for connection pooling or `MockClient`. |
| `authStorage` | `AuthTokenStorage?` | `SecureAuthTokenStorage()` | Encrypted persistent session with an in-memory fallback. Pluggable. |
| `getAuthToken` | `Future<String?> Function()?` | `null` | Custom bearer provider (takes precedence over `client.auth`). |
| `requestTimeout` | `Duration` | `Duration(seconds: 30)` | Per-request timeout; throws `VellumException(code: 'REQUEST_TIMEOUT', statusCode: 408)`. |
| `maxRetries` | `int` | `3` | Transient retries (429/408/5xx/network) for idempotent requests or requests with `idempotencyKey`. |
| `retryBaseDelay` | `Duration` | `Duration(milliseconds: 250)` | Base delay for full-jitter HTTP retry backoff. |
| `retryMaxDelay` | `Duration` | `Duration(seconds: 15)` | Maximum cap for HTTP retry and `Retry-After` waits. |
| `coalesceInFlightGets` | `bool` | `true` | Single-flight deduplication for concurrent identical `GET` requests (skips transactional reads). |
| `warnOnMissingIndexes` | `bool` | `true` | Print deduplicated one-click index suggestions from `x-vellum-index-*` headers. |
| `onIndexSuggestion` | `IndexSuggestionCallback?` | `null` | Advisory callback for index suggestions. |
| `realtimeUrlOverride` | `String?` | Derived from `endpoint` | Explicit `ws://` / `wss://` override. |

---

## Typed Models with `withConverter<R>()`

```dart
class Task {
  final String id;
  final String title;
  final bool done;

  const Task({required this.id, required this.title, required this.done});

  factory Task.fromMap(Map<String, dynamic> data, String id) => Task(
        id: id,
        title: data['title'] as String? ?? '',
        done: data['done'] == true,
      );

  Map<String, dynamic> toMap() => {'title': title, 'done': done};
}

final tasks = client.collection('tasks').withConverter<Task>(
      fromVellum: Task.fromMap,
      toVellum: (task) => task.toMap(),
    );

await tasks.doc('t_1').upsert(const Task(id: 't_1', title: 'Ship v2', done: false));
final snap = await tasks.doc('t_1').get();
final Task? task = snap.data();
```

---

## Queries, Relations, Aggregations & Cursor Streams

### All 13 Operators

`==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not-in`, `array-contains`, `array-contains-any`, `contains_ci`, `starts_with_ci`, `text_search`.

```dart
final query = client
    .collection('orders')
    .where('status', 'in', ['paid', 'shipped'])
    .or([
      [
        {'field': 'priority', 'op': '==', 'value': 'urgent'},
      ],
      [
        {'field': 'totalCents', 'op': '>=', 'value': 50000},
      ],
    ])
    .include([
      'customerId',
      const VellumInclude(
        field: 'assigneeId',
        collection: 'users',
        as: 'assignee',
        select: ['name', 'email'],
      ),
    ])
    .select(['status', 'totalCents', 'customerId'])
    .orderBy('createdAt', dir: 'desc');

// Lazy cursor streaming (no SQL OFFSET, bounded memory)
await for (final doc in query.streamDocuments(pageSize: 100, maxPages: 10)) {
  print('${doc.id}: ${doc.data()}');
}

// Or stream one QuerySnapshot page at a time
await for (final page in query.streamPages(pageSize: 50)) {
  print('Loaded ${page.docs.length} docs (nextCursor: ${page.nextCursor})');
}

// Server-side aggregations
final openCount = await client.collection('orders').where('status', '==', 'open').count();
final grouped = await client.collection('orders').aggregate(
  groupBy: ['region'],
  metrics: {
    'count': const AggregateMetric.count(),
    'revenue': const AggregateMetric.sum('totalCents'),
    'avgOrder': const AggregateMetric.avg('totalCents'),
  },
);
```

---

## Auto-Chunked Bulk Writes & OCC Transactions

### Fluent Batch & `commitChunked()`

```dart
final batch = client.batch();
for (final item in items) {
  batch.set(client.collection('catalog').doc(item.id), item.toJson(), merge: true);
}

// Splits automatically into 100-op batches with per-chunk idempotency keys
final chunkResponses = await batch.commitChunked(
  chunkSize: 100,
  idempotencyKeyPrefix: 'catalog-sync-2026-11-21',
);
```

### OCC `runTransaction()`

```dart
final transferred = await client.runTransaction<int>((tx) async {
  final fromRef = client.doc('accounts/acc_a');
  final toRef = client.doc('accounts/acc_b');
  final from = await tx.get(fromRef);
  final to = await tx.get(toRef);

  final balance = (from.data()?['balance'] as num?)?.toInt() ?? 0;
  if (balance < 100) throw StateError('Insufficient funds');

  tx.update(fromRef, {'balance': balance - 100});
  tx.update(toRef, {'balance': ((to.data()?['balance'] as num?)?.toInt() ?? 0) + 100});
  return 100;
}, maxAttempts: 5);
```

---

## Realtime Streams (`snapshots()`)

```dart
final sub = client
    .collection('messages')
    .where('roomId', '==', 'general')
    .orderBy('createdAt', dir: 'desc')
    .limit(50)
    .snapshots()
    .listen(
      (snapshot) {
        print('Watermark: ${snapshot.watermarkSeqId}, docs: ${snapshot.docs.length}');
      },
      onError: (Object err) => print('Realtime error: $err'),
    );

// Cancel when widget disposes
await sub.cancel();
```

---

## Reactive EdDSA Authentication

```dart
// Restore persisted session at app startup (when using a secure AuthTokenStorage)
await client.auth.restore();

// Listen to sign-in, token refresh, profile update, and sign-out events
final authSub = client.auth.authStateChanges.listen((VellumUser? user) {
  print(user == null ? 'Signed out' : 'Signed in: ${user.id}');
});

final result = await client.auth.signInWithEmailAndPassword(
  email: 'ada@example.com',
  password: 'correct-horse-battery',
);

switch (result) {
  case VellumSession(:final user):
    print('Welcome ${user.displayName}');
  case VellumMfaRequired(:final mfaTicket):
    await client.auth.verifyMfaChallenge(mfaTicket: mfaTicket, code: '123456', factorType: 'totp');
}

// Single-flight 401 refresh + sessionEpoch guards prevent stale refresh commits
await client.auth.signOut();
await authSub.cancel();
```

---

## Security & Lifecycle Guarantees

- **Secret-Redacted `toString()`**: `VellumClient`, `VellumUser`, `VellumMfaRequired`, `TotpEnrollment`, `AuthActionResult`, `TransactionContext`, and `VellumException` automatically redact API keys (`pk_`/`sk_`), `Bearer` tokens, JWTs (`eyJ...`), and MFA secrets so logs and crash reporters never leak credentials.
- **Path-Traversal Protection**: `validateVellumSegment` and `validateVellumPath` reject `.`, `..`, percent-encoded traversals (`%2e%2e`, `%2f`, `%5c`), `?`, `#`, backslashes, and control characters with `VellumException(code: 'INVALID_DOCUMENT_PATH', statusCode: 400)`.
- **Deterministic Cleanup**: Always call `client.dispose()` (or `client.close()`) when shutting down or tearing down a DI scope.

---

## Documentation

- [Flutter / Dart SDK Full Guide](../../docs/09-sdk-flutter-guide.md)
- [Flutter SDK API Reference](../../docs/guides/sdks/flutter.md)
- [Quickstart](../../docs/guides/quickstart.md) | [Querying](../../docs/guides/query.md) | [Pagination](../../docs/guides/pagination.md) | [Realtime](../../docs/guides/realtime.md) | [Batch & Transactions](../../docs/guides/batch-and-transactions.md) | [Production Checklist](../../docs/guides/production-checklist.md)

## Modular Architecture & Tamper-Proofing

`vellum_flutter` is structured as a pure-Dart, web-safe library (`library vellum_flutter;`, zero `dart:io` imports) split across `lib/src/core/`, `lib/src/models/`, `lib/src/auth/`, `lib/src/realtime/`, and `lib/src/client/`. Internal state is library-private (`_`), public model collections use `Map.unmodifiable` / `List.unmodifiable`, session storage copies defensively, and `toString()` overrides redact all tokens and API keys.


### Reverse reference lookup (`referencedBy`)

`DocumentReference.referencedBy()` wraps `POST /documents:referencedBy`:
permission-filtered reverse references with opaque cursor pagination. Keep
paging while `nextCursor` is non-null, even after an empty page.

```dart
// Which orders reference this user?
var page = await client
    .collection('users')
    .doc('u1')
    .referencedBy(collection: 'orders', field: 'customerId', limit: 50);

while (page.nextCursor != null) {
  page = await client
      .collection('users')
      .doc('u1')
      .referencedBy(collection: 'orders', field: 'customerId', limit: 50, cursor: page.nextCursor);
}
```

Dependents are not the target's type, so results are raw maps by default; use
`referencedByAs<D>(fromVellum: ...)` for typed decoding. `select` projects dot
paths and `include` eagerly resolves relations on the dependents. See
the reverse-lookup rules in `docs/12-relationships-and-advanced-queries.md` for the
permission filtering and pagination semantics.

### Realtime opt-in includes

Realtime subscriptions can ask the server to resolve relations point-in-time
on every emitted document (max 10 specs, depth 1 — snapshots at event time,
not a live join):

```dart
client.collection('orders').doc('o1').snapshots(
  resolveIncludes: true,
  include: ['customer', const VellumInclude(field: 'items', select: ['sku'])],
).listen((snap) {
  print(snap.included);      // resolved payloads
  print(snap.redactedRefs);  // targets hidden by security rules
});
```

`Query.snapshots()` accepts the same options; when `include` is omitted, the
query's own `.include(...)` specs are reused. Wire-level semantics live in the
the realtime includes section of `docs/12-relationships-and-advanced-queries.md`.

## Endpoint and account scope

Pass the API origin as `endpoint` (for example `https://api.example.com`),
without `/v1`, `/auth`, or a project suffix. The SDK adds the project route.
Dart's optional `baseUrl` is a full REST-prefix override, such as
`https://api.example.com/v1/projects/PROJECT_ID`; it is not interchangeable
with `endpoint`. Do not pass both. Project `db.auth` signup accepts
`displayName`; Console signup creates a different account and requires `name`.
Do not add Console fields to fix a wrong project URL.

Use `pk_` keys only with suitable security rules and end-user authentication.
Never bundle an `sk_` key into browser or mobile code.
