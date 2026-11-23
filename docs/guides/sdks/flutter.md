---
title: Flutter SDK (vellum_flutter)
order: 1
group: SDKs
description: Practical Dart reference for vellum_flutter — client setup, CRUD, field ops, V2 queries, cursor streams, chunked batches, realtime, EdDSA auth, and hardening.
---

# Flutter SDK (`vellum_flutter`)

Practical Dart API reference for `vellum_flutter` v0.0.1 derived from `sdks/flutter/lib/vellum_flutter.dart`. Pure Dart (`>=3.4.0 <4.0.0`), strictly null-safe, with zero Flutter engine binding required.

```dart
import 'package:vellum_flutter/vellum_flutter.dart';
```

---

## Client Initialization (`VellumClient`)

```dart
import 'package:http/http.dart' as http;

final httpClient = http.Client();
final client = VellumClient(
  endpoint: 'https://api.example.com',
  projectId: 'proj_01j9...',
  apiKey: 'pk_live_...',
  httpClient: httpClient,
  authStorage: SecureAuthTokenStorage(),
  requestTimeout: const Duration(seconds: 30),
  maxRetries: 3,
  retryBaseDelay: const Duration(milliseconds: 250),
  retryMaxDelay: const Duration(seconds: 15),
  coalesceInFlightGets: true,
);
```

| Parameter | Default | Notes |
| --- | --- | --- |
| `projectId` / `apiKey` | Required | Sent via `x-vellum-api-key` & `X-Project-Key`. Redacted in `toString()`. |
| `endpoint` / `baseUrl` | `''` / derived | Use `endpoint` (origin) or full `baseUrl` prefix. |
| `httpClient` / `httpTransport` | Short-lived `http.Client` | Pass a shared `http.Client` for connection pooling or `MockClient`. |
| `authStorage` / `authTokenStorage` | `InMemoryAuthTokenStorage()` | Implement `AuthTokenStorage` with `flutter_secure_storage` in production. |
| `requestTimeout` | `Duration(seconds: 30)` | Throws `VellumException(code: 'REQUEST_TIMEOUT', statusCode: 408)`. |
| `maxRetries` | `3` | Retries 429/408/5xx/network on idempotent requests (`Retry-After` + full jitter). |
| `coalesceInFlightGets` | `true` | Deduplicates concurrent identical `GET` calls (skips transactional reads). |
| `warnOnMissingIndexes` / `onIndexSuggestion` | `true` / `null` | Handles `x-vellum-index-*` headers. |

---

## CRUD, Field Operations & `withConverter<R>()`

- References: `client.collection(path)`, `client.doc(path)`, `col.doc(id)`, `doc.collection(subCol)`.
- Shorthands on `VellumClient`: `getDoc(path)`, `setDoc(path, data, {merge, ifVersion, idempotencyKey})`, `updateDoc(path, data, {ifVersion, idempotencyKey})`, `deleteDoc(path, {ifVersion, idempotencyKey})`.
- On `DocumentReference<T>`: `get({include, select})`, `create(value, {ttlSeconds, expiresAt, idempotencyKey})`, `set(value, {merge, ifVersion, ttlSeconds, expiresAt, upsert, idempotencyKey})`, `upsert(...)`, `update(data, {ifVersion, idempotencyKey})`, `delete({ifVersion, idempotencyKey})`.
- Type-safe mapping: `client.collection('tasks').withConverter<Task>(fromVellum: ..., toVellum: ...)`.
- Field ops (`FieldValue` / `FieldOp`): `serverTimestamp()`, `increment(by)`, `arrayUnion(elements)`, `arrayRemove(elements)`, `deleteField()` (and `FieldValue.delete()`).
- Wire helpers (`VellumWire`): `int64`, `timestamp`, `reference`, `bytes`, `geopoint`, `escapeMap`, `decodeWireValue`.

---

## Queries, Aggregations & Cursor `Stream` Pagination

Supports all 13 operators (`==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not-in`, `array-contains`, `array-contains-any`, `contains_ci`, `starts_with_ci`, `text_search`), `or(groups)`, `include(relations)` (strings or `VellumInclude`), `select(fields)`, `orderBy(field, {dir})`, `limit(n)`, `startAfter(cursor)`.

```dart
final q = client
    .collection('events')
    .where('type', '==', 'checkout')
    .orderBy('createdAt', dir: 'desc');

// Stream pages lazily
await for (final page in q.streamPages(pageSize: 100, maxPages: 20)) {
  handlePage(page.docs);
}

// Or stream individual documents
await for (final doc in q.streamDocuments(pageSize: 100, maxPages: 20)) {
  handleDoc(doc);
}

// Aggregations
final total = await q.count();
final sum = await q.sum('amountCents');
final avg = await q.avg('amountCents');
final grouped = await q.aggregate(
  groupBy: ['region'],
  metrics: {'total': const AggregateMetric.sum('amountCents')},
);
```

---

## Auto-Chunked Bulk Writes & OCC Transactions

```dart
// Auto-chunked fluent batch (default 500 ops/chunk)
final batch = client.batch()
  ..set(client.doc('items/1'), {'price': 10}, merge: true)
  ..update(client.doc('items/2'), {'stock': FieldValue.increment(-1)})
  ..delete(client.doc('items/3'));

await batch.commitChunked(chunkSize: 500, idempotencyKeyPrefix: 'sync-batch');

// Or direct chunked list API
await client.writeBatchChunked(writes, chunkSize: 500, idempotencyKeyPrefix: 'import');

// Interactive OCC transaction with automatic ABORTED_CONFLICT retry
await client.runTransaction<void>((tx) async {
  final ref = client.doc('accounts/a');
  final snap = await tx.get(ref);
  final bal = (snap.data()?['balance'] as num?)?.toInt() ?? 0;
  tx.update(ref, {'balance': bal - 10});
}, maxAttempts: 5);
```

---

## Realtime WebSocket Streams

- `doc.snapshots()` / `client.watchDocument(path)` → `Stream<DocumentSnapshot<T>>`
- `query.snapshots()` / `client.watchCollection(path, {where, orderBy, limit, cursor})` → `Stream<QuerySnapshot<T>>`
- `VellumRealtimeTransport` provides decorrelated jitter reconnect (`500ms`–`30s`), per-subscription `resumeSeqId`, bounded outbound queue (`256` frames), and `25s`/`60s` heartbeat.

---

## EdDSA Auth, Security Hardening & Lifecycle

- `client.auth` (`VellumAuth`): `restore()`, `authStateChanges`, `currentUser`, `sessionEpoch`, `signUpWithEmailAndPassword`, `signInWithEmailAndPassword` (sealed `VellumSession` | `VellumMfaRequired`), `signInAnonymously`, `signInWithOAuth`, `verifyMfaChallenge`, `enrollTotpMfa`, `confirmTotpMfa`, `sendPasswordResetEmail`, `confirmPasswordReset`, `sendEmailVerification`, `confirmEmailVerification`, `getUser`, `updateProfile`, `getIdToken`, `signOut`.
- Single-flight proactive (45s) and reactive 401 refresh (`refreshOnUnauthorized`) guarded by `sessionEpoch`.
- Secret-redacted `toString()` on all sensitive models/exceptions and strict path-traversal validation (`validateVellumSegment`, `validateVellumPath`).
- Call `client.dispose()` (or `client.close()`) on shutdown.

## Modular Architecture & Tamper-Proofing

`vellum_flutter` is split into 13 focused `part` modules under `lib/src/{core,models,auth,realtime,client}/` behind `lib/vellum_flutter.dart` (pure Dart, zero `dart:io`). Public model collections use `Map.unmodifiable`/`List.unmodifiable`, internal state is library-private, and `toString()` redacts secrets.
