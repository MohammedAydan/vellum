# Flutter / Dart SDK Guide (`vellum_flutter`)

Complete engineering guide for `vellum_flutter` v0.0.3 — grounded directly in `sdks/flutter/lib/vellum_flutter.dart`. The pre-rebrand import `package:vellum_flutter/vellum_flutter.dart` and the `Vellum*` typedefs remain as compatibility aliases; new code should use the `Vellum*` names.

Pure Dart (`>=3.4.0 <4.0.0`), strictly null-safe, with zero Flutter binding required. Works identically in Flutter mobile/web/desktop apps, Dart CLI tools, and Dart backend services.

> **Security Note**: Embed only publishable `pk_` keys in client apps and enforce access via Security Rules and end-user EdDSA auth. Never ship `sk_` keys inside Flutter binaries.

---

## 1. Installation & Client Initialization

```yaml
dependencies:
  vellum_flutter: ^0.0.3
```

```dart
import 'package:vellum_flutter/vellum_flutter.dart';
import 'package:http/http.dart' as http;

final httpClient = http.Client(); // Reuse a single client for TCP/TLS connection pooling

final client = VellumClient(
  endpoint: 'https://api.example.com',
  projectId: 'proj_01j9...',
  apiKey: 'pk_live_...',
  httpClient: httpClient,
  authStorage: SecureAuthTokenStorage(), // Implement AuthTokenStorage with flutter_secure_storage
  requestTimeout: const Duration(seconds: 15),
  maxRetries: 3,
  retryBaseDelay: const Duration(milliseconds: 250),
  retryMaxDelay: const Duration(seconds: 15),
  coalesceInFlightGets: true,
  warnOnMissingIndexes: true,
  onIndexSuggestion: (VellumIndexSuggestion suggestion) {
    // Route index recommendations to your logger/observability sink
  },
);
```

### `VellumClient` Constructor Options

| Parameter | Default | Description |
| --- | --- | --- |
| `projectId` | **Required** | Target VELLUM project ID. |
| `apiKey` | **Required** | Sent in `x-vellum-api-key` and `X-Project-Key`. |
| `endpoint` | `''` | Origin host; derives `<endpoint>/v1/projects/<projectId>`. |
| `baseUrl` | Derived | Full REST prefix override. |
| `httpClient` | Short-lived `http.Client` | Caller-owned `package:http` client (recommended in production). |
| `httpTransport` | Derived | Low-level transport seam (`Future<Object?> Function(method, url, headers, body)`). |
| `authStorage` / `authTokenStorage` | `InMemoryAuthTokenStorage()` | Pluggable session persistence (`AuthTokenStorage`). |
| `getAuthToken` | `null` | Explicit bearer provider (takes precedence over `client.auth`). |
| `requestTimeout` | `Duration(seconds: 30)` | Per-request timeout (`VellumException(code: 'REQUEST_TIMEOUT', statusCode: 408)`). |
| `maxRetries` | `3` | Retries on `429`, `408`, `5xx`, `TimeoutException`, `ClientException`, and socket/handshake errors for idempotent requests. |
| `retryBaseDelay` | `Duration(milliseconds: 250)` | Base delay for full-jitter HTTP retry backoff. |
| `retryMaxDelay` | `Duration(seconds: 15)` | Cap for full-jitter backoff and `Retry-After` waits. |
| `coalesceInFlightGets` | `true` | Deduplicates concurrent identical `GET` requests (skips transactional reads). |
| `realtimeUrlOverride` | Derived via `vellumRealtimeUrl()` | Explicit `ws://` / `wss://` endpoint. |
| `warnOnMissingIndexes` | `true` | Prints deduplicated index advisor warnings from `x-vellum-index-*` headers. |
| `onIndexSuggestion` | `null` | Structured `VellumIndexSuggestion` callback. |

---

## 2. CRUD, Field Operations & Tagged Wire Types

### Reference & Shorthand APIs

```dart
final userRef = client.collection('users').doc('usr_101');

// Create (POST — fails with 409 if already exists)
await userRef.create(
  {
    'name': 'Ada Lovelace',
    'credits': 100,
    'roles': ['user'],
    'createdAt': FieldValue.serverTimestamp(),
  },
  ttlSeconds: 604800,
  idempotencyKey: 'create-usr-101',
);

// Read (supports include and select)
final snap = await userRef.get(
  select: ['name', 'credits', 'roles'],
  include: ['organizationId'],
);
print('${snap.id} v${snap.version}: ${snap.data()} (included: ${snap.included})');

// Upsert (PUT with upsert: true)
await userRef.upsert({'name': 'Ada Lovelace', 'credits': 150}, merge: true);

// Update (PATCH with OCC and atomic FieldValue transforms)
await userRef.update(
  {
    'credits': FieldValue.increment(-25),
    'roles': FieldValue.arrayUnion(['admin']),
    'legacyField': FieldValue.deleteField(),
    'updatedAt': FieldValue.serverTimestamp(),
  },
  ifVersion: snap.version,
);

// Shorthand helpers on VellumClient
final doc = await client.getDoc('users/usr_101');
await client.setDoc('users/usr_101', {'active': true}, merge: true);
await client.updateDoc('users/usr_101', {'credits': FieldOp.increment(10)});
await client.deleteDoc('users/usr_101', ifVersion: doc.version + 2);
```

### Atomic Field Operations (`FieldOp` / `FieldValue`)

- `FieldValue.serverTimestamp()` / `FieldOp.serverTimestamp()` → `{'$op': 'serverTimestamp'}`
- `FieldValue.increment(num by)` / `FieldOp.increment(by)` → `{'$op': 'inc', 'by': by}`
- `FieldValue.arrayUnion(List<Object?> elements)` → `{'$op': 'arrayUnion', 'elements': elements}`
- `FieldValue.arrayRemove(List<Object?> elements)` → `{'$op': 'arrayRemove', 'elements': elements}`
- `FieldValue.deleteField()` / `FieldValue.delete()` → `{'$op': 'deleteField'}`

### Tagged Wire Helpers (`VellumWire`)

Encode lossless rich types (`int64`, `timestamp`, `reference`, `bytes`, `geopoint`, `escapeMap`) and decode recursively with `VellumWire.decodeWireValue(value)`.

### Type-Safe `withConverter<R>()`

```dart
final invoices = client.collection('invoices').withConverter<Invoice>(
      fromVellum: (data, id) => Invoice.fromJson(data, id),
      toVellum: (invoice) => invoice.toJson(),
    );

final snap = await invoices.doc('inv_42').get();
final Invoice? invoice = snap.data();
```

---

## 3. Queries, Relations, Aggregations & Cursor Streams

### All 13 Filter Operators

`==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not-in`, `array-contains`, `array-contains-any`, `contains_ci`, `starts_with_ci`, `text_search`.

```dart
final query = client
    .collection('orders')
    .where('status', 'in', ['paid', 'shipped'])
    .where('notes', 'contains_ci', 'express')
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
    .orderBy('createdAt', dir: 'desc')
    .limit(50);

final firstPage = await query.get();
```

### Reverse Reference Lookup (`referencedBy()`)

Permission-filtered reverse lookup: which documents reference this one. Wraps
`POST /documents:referencedBy` with opaque cursor pagination — keep paging
while `nextCursor` is non-null, even after an empty page.

```dart
var page = await client.collection('users').doc('u1').referencedBy(
  collection: 'orders',           // optional: narrow to one collection
  field: 'customerId',            // optional: narrow to one reference field
  limit: 50,                      // 1..100 per page
  include: ['customer'],          // optional: resolve relations on dependents
);
for (final doc in page.documents) {
  print('${doc.path} -> ${doc.data()}');
}

// Typed dependents via a caller-supplied converter (the target's own
// converter is never applied to dependents):
final typed = await client.collection('users').doc('u1').referencedByAs<int>(
  fromVellum: (data, id) => data['total'] as int,
);
```

See `docs/RELATION-LOOKUP-CONTRACT.md` for the permission-filtering and
pagination semantics.

### Lazy Cursor `Stream` Pagination (`streamPages()` & `streamDocuments()`)

```dart
// Stream one QuerySnapshot page at a time
await for (final page in query.streamPages(pageSize: 100, maxPages: 25)) {
  processPage(page.docs);
}

// Stream individual DocumentSnapshots lazily across all cursor pages
await for (final doc in query.streamDocuments(pageSize: 100, maxPages: 25)) {
  processDoc(doc);
}
```

### Server-Side Aggregations & Bulk Deletes

```dart
final totalOpen = await client.collection('orders').where('status', '==', 'open').count();
final totalRev = await client.collection('orders').where('status', '==', 'paid').sum('totalCents');
final avgOrder = await client.collection('orders').where('status', '==', 'paid').avg('totalCents');

final grouped = await client.collection('orders').aggregate(
  groupBy: ['currency'],
  metrics: {
    'count': const AggregateMetric.count(),
    'revenue': const AggregateMetric.sum('totalCents'),
    'minOrder': const AggregateMetric.min('totalCents'),
    'maxOrder': const AggregateMetric.max('totalCents'),
  },
);

final deleted = await client
    .collection('sessions')
    .where('expired', '==', true)
    .deleteWhere(limit: 1000);
```

---

## 4. Auto-Chunked Bulk Writes & OCC Transactions

### `writeBatchChunked()` & `client.batch().commitChunked()`

```dart
// Fluent builder API
final batch = client.batch();
for (final doc in docsToSync) {
  batch.set(client.collection('catalog').doc(doc.id), doc.toMap(), merge: true);
}

// Single atomic batch (<= 100 ops)
await batch.commit(idempotencyKey: 'sync-small-batch');

// Or auto-chunked into 100-op batches with per-chunk idempotency keys ("sync-job-0", "sync-job-1", ...)
final responses = await batch.commitChunked(
  chunkSize: 100,
  idempotencyKeyPrefix: 'sync-job',
);

// Direct list API
await client.writeBatchChunked(rawWrites, chunkSize: 100, idempotencyKeyPrefix: 'bulk-import');
```

### OCC `runTransaction()`

```dart
final newBalance = await client.runTransaction<int>((tx) async {
  final accRef = client.doc('accounts/acc_1');
  final snap = await tx.get(accRef);
  final current = (snap.data()?['balance'] as num?)?.toInt() ?? 0;
  if (current < 50) throw StateError('Insufficient balance');
  tx.update(accRef, {'balance': current - 50});
  return current - 50;
}, maxAttempts: 5);
```

---

## 5. Realtime WebSocket Streams

`VellumRealtimeTransport` multiplexes all subscriptions over a single RFC 6455 WebSocket with:
- **Decorrelated jitter reconnect** (`500ms` base, `30_000ms` cap via `computeDecorrelatedJitterBackoffMs`)
- **Per-subscription `resumeSeqId`** tracking so missed mutations replay cleanly on reconnect
- **Bounded outbound queue** (`maxOutboundQueueSize = 256` frames; drops oldest if offline buffer saturates)
- **Active heartbeat** (`25s` ping interval, `60s` pong timeout, `10s` connect timeout)

```dart
// Document stream (emits cached snapshot immediately if available, then live updates)
final docSub = client.doc('orders/ord_1').snapshots().listen((snap) {
  print('Order v${snap.version}: ${snap.data()}');
});

// Query stream (maintains materialized docs list + incremental DocumentChange events)
final querySub = client
    .watchCollection('orders', where: {'status': 'open'}, orderBy: 'createdAt', limit: 50)
    .listen((snapshot) {
      print('Open orders: ${snapshot.docs.length}, watermark: ${snapshot.watermarkSeqId}');
    });

await docSub.cancel();
await querySub.cancel();
```

### Opt-in Relation Includes on Realtime Streams

Subscriptions can ask the server to resolve relations point-in-time on every
emitted document (max 10 specs, depth 1 — snapshots at event time, not a live
join):

```dart
client.collection('orders').doc('ord_1').snapshots(
  resolveIncludes: true,
  include: ['customer', const VellumInclude(field: 'items', select: ['sku'])],
).listen((snap) {
  print(snap.included);      // resolved payloads under _included
  print(snap.redactedRefs);  // targets hidden by security rules
});
```

`Query.snapshots()` accepts the same options; when `include` is omitted, the
query's own `.include(...)` specs are reused. Wire semantics:
`docs/REALTIME-INCLUDES-CONTRACT.md`.

---

## 6. Reactive EdDSA Authentication (`client.auth`)

- **Persistent Storage**: Implement `AuthTokenStorage` backed by `flutter_secure_storage`, pass it to `VellumClient(authStorage: ...)`, and call `await client.auth.restore()` on startup.
- **Race-Safe `sessionEpoch`**: A monotonic `sessionEpoch` counter increments on sign-in, `restore()`, `signOut()`, and `dispose()`. Any in-flight refresh whose epoch no longer matches is discarded so sign-out can never be resurrected by a slow network response.
- **Single-Flight Proactive & Reactive 401 Refresh**: Proactive refresh runs 45s before JWT `exp`. Concurrent `401` responses coalesce through `refreshOnUnauthorized(failedToken)` into a single `/auth/token/refresh` call and replay once.
- **Sealed Sign-In Result**: `signInWithEmailAndPassword` returns `VellumAuthResult` (`VellumSession` or `VellumMfaRequired`) for exhaustive pattern matching in Dart 3.

```dart
await client.auth.restore();

final res = await client.auth.signInWithEmailAndPassword(
  email: 'ada@example.com',
  password: 'secret-password',
);

switch (res) {
  case VellumSession(:final user):
    print('Signed in: ${user.id}');
  case VellumMfaRequired(:final mfaTicket):
    await client.auth.verifyMfaChallenge(mfaTicket: mfaTicket, code: '123456', factorType: 'totp');
}

// Revoke all active sessions on every device
await client.auth.signOut(allSessions: true);
```

---

## 7. Security Hardening, Collections Lifecycle & Disposal

### Secret Redaction & Path-Traversal Defense

- `toString()` on `VellumClient`, `VellumUser`, `VellumMfaRequired`, `TotpEnrollment`, `AuthActionResult`, `TransactionContext`, and `VellumException` redacts `Bearer` tokens, `pk_`/`sk_` keys, JWTs (`eyJ...`), and MFA secrets.
- `validateVellumSegment` and `validateVellumPath` reject empty segments, `.`, `..`, percent-encoded traversal (`%2e%2e`, `%2f`, `%5c`), backslashes, `?`, `#`, and ASCII control characters before any HTTP request is built.

### Collections Lifecycle

`listCollections`, `createCollection`, `getCollectionInfo`, `updateCollection`, `clearCollection`, `deleteCollection`, `importDocuments`, and `exportDocuments` are all available on `VellumClient`.

### Lifecycle Cleanup

Always call `client.dispose()` (or `client.close()`) when tearing down the client or Riverpod/BLoC scope, and close any caller-owned `http.Client`:

```dart
client.dispose();
httpClient.close();
```

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
