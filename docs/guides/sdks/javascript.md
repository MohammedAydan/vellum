---
title: JavaScript SDK (@vellumdb/sdk-js)
order: 2
group: SDKs
description: Exported-symbol reference for @vellumdb/sdk-js — client, references, query builder, streaming, caching, chunked batches, realtime transport, and EdDSA auth.
---

# JavaScript SDK (`@vellumdb/sdk-js`)

Complete API reference for `@vellumdb/sdk-js` v0.0.2 derived from `packages/sdk-js/src/{index,types,client,field-ops,batch,read-cache,auth-client,auth-storage,realtime-transport,backoff,safe-json}.ts`. For narrative walkthroughs see [Quickstart](../quickstart.md), [Query](../query.md), [Pagination](../pagination.md), [Realtime](../realtime.md), and [Batch Writes & Transactions](../batch-and-transactions.md).

```ts
import {
  createClient,
  fieldOp,
  BoundedReadCache,
  BrowserLocalStorage,
  MemoryAuthStorage,
  RealtimeTransport,
  toRealtimeUrl,
  computeReconnectBackoffMs,
  computeDecorrelatedJitterMs,
  parseRetryAfterMs,
} from "@vellumdb/sdk-js";
```

---

## Client Initialization (`createClient`)

```ts
const db = createClient({
  projectId: "proj_01j9...",
  apiKey: process.env.VELLUM_API_KEY!,
  endpoint: "https://api.example.com",
  timeoutMs: 30_000,
  maxRetries: 3,
  retryBaseDelayMs: 250,
  retryMaxDelayMs: 10_000,
  cache: { enabled: true, ttlMs: 30_000, maxEntries: 1_000 },
  dedupeReads: true,
  warnOnMissingIndexes: true,
});
```

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `projectId` / `apiKey` | `string` | Required | Validated and URI-encoded; `apiKey` sent via `x-vellum-api-key` & `x-project-key`. |
| `endpoint` | `string` | `"http://localhost:8080"` | Base HTTP(S) origin. |
| `realtimeUrl` | `string` | `<endpoint>/v1/realtime` | Optional `ws://` / `wss://` override. |
| `getAuthToken` | `() => Promise<string \| null> \| string \| null` | `null` | Explicit bearer override. |
| `authStorage` | `AuthStorage \| null` | `BrowserLocalStorage` or `MemoryAuthStorage` | Persists `AuthState`. |
| `timeoutMs` | `number` | `30_000` | Per-request `AbortController` timeout (`code: "REQUEST_TIMEOUT"`). `0` disables. |
| `maxRetries` | `number` | `3` | Transient retries on `429`/5xx/network for idempotent requests. `0` disables. |
| `retryBaseDelayMs` / `retryMaxDelayMs` | `number` | `250` / `10_000` | Full-jitter exponential backoff bounds; honors `Retry-After` header. |
| `cache` | `ReadCacheConfig` | `{ enabled: false, ttlMs: 30_000, maxEntries: 1_000 }` | Opt-in `BoundedReadCache` (LRU + TTL) for `doc.get()`. |
| `dedupeReads` | `boolean` | `false` | Single-flight GET coalescing with defensive clones. |
| `warnOnMissingIndexes` / `onIndexSuggestion` | `boolean` / callback | `true` / `undefined` | Index advisor header handling (`x-vellum-index-*`). |

---

## References, CRUD & `withConverter<T>()`

- `db.collection<T>(collectionPath)` → `CollectionReferenceInterface<T>`
- `db.doc<T>(documentPath)` / `col.doc(docId)` → `DocumentReferenceInterface<T>`
- `doc.collection<SubT>(subCollectionName)` → `CollectionReferenceInterface<SubT>`
- `.withConverter<U>(converter: DocDataConverter<U> | null)` on `CollectionRef`, `DocumentRef`, and `QueryBuilder`

| Method | Signature | Notes |
| --- | --- | --- |
| `doc.get` | `(options?: { include?, select?, dedupe?, bypassCache?, signal? }) => Promise<DocumentSnapshot<T>>` | Returns defensive clones; supports cache bypass and single-flight coalescing. |
| `doc.create` | `(data: T, options?: { ttlSeconds?, expiresAt?, signal? }) => Promise<unknown>` | `POST /documents/:path`; invalidates cache. |
| `doc.set` | `(data: T, options?: { merge?, ifVersion?, ttlSeconds?, expiresAt?, upsert?, signal? }) => Promise<unknown>` | `PUT /documents/:path`; invalidates cache. |
| `doc.upsert` | `(data: T, options?: Omit<DocumentSetOptions, "upsert">) => Promise<unknown>` | Shorthand for `set(data, { ...options, upsert: true })`. |
| `doc.update` | `(data: Record<string, unknown>, options?: { ifVersion?, signal? }) => Promise<unknown>` | `PATCH /documents/:path`; supports `fieldOp` sentinels. |
| `doc.delete` | `(options?: { ifVersion?, signal? }) => Promise<unknown>` | `DELETE /documents/:path`; invalidates cache. |

### Atomic Field Operations (`fieldOp`)

- `fieldOp.serverTimestamp()`
- `fieldOp.increment(by = 1)`
- `fieldOp.arrayUnion(...elements)`
- `fieldOp.arrayRemove(...elements)`
- `fieldOp.deleteField()`

---

## Query Builder, Streaming & Aggregations

All 13 operators are supported: `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not-in`, `array-contains`, `array-contains-any`, `contains_ci`, `starts_with_ci`, `text_search`.

```ts
const ac = new AbortController();

// Stream documents lazily with bounded memory and hard caps
for await (const doc of db
  .collection("orders")
  .where("status", "==", "paid")
  .or([
    [{ field: "channel", op: "==", value: "web" }],
    [{ field: "totalCents", op: ">=", value: 10_000 }],
  ])
  .include(["customerId", { field: "assigneeId", collection: "users", as: "assignee", select: ["name"] }])
  .orderBy("createdAt", "desc")
  .stream({ pageSize: 100, maxPages: 25, maxDocs: 2_000, signal: ac.signal })) {
  console.log(doc.id, doc.data(), doc.included);
}
```

- **Pagination**: `.startAfter(cursor)`, `.startAt(cursor)`, `.pages(options?: QueryStreamOptions)`, `.stream(options?: QueryStreamOptions)`
- **Aggregations**: `.aggregate({ groupBy?, metrics }, options?)`, `.count(options?)`, `.sum(field, options?)`, `.avg(field, options?)`, `.min(field, options?)`, `.max(field, options?)`
- **Bulk Delete**: `.deleteWhere({ limit?, signal? })` → `Promise<{ deletedCount: number }>`

---

## Batch Writes, Chunking & Transactions

- `db.batchWrite(writes, options?: RequestOptions)` — single atomic batch (max 500 writes).
- `db.batchWriteChunked(operations, { chunkSize = 500, concurrency = 4, onProgress?, signal? })` — auto-chunks large arrays with bounded concurrency and progress reporting (`BatchWriteChunkedResult`).
- `db.runTransaction(async (tx) => ..., { maxAttempts = 5, signal? })` — OCC transaction (`tx.get`, `tx.create`, `tx.set`, `tx.update`, `tx.delete`) with jittered retry on `ABORTED_CONFLICT`.

---

## Realtime Subscriptions & Connection State

- `doc.onSnapshot(callback, onError?)` and `query.onSnapshot(callback, onError?)` return an `unsubscribe` function.
- `db.connectionState` exposes `"disconnected" | "connecting" | "connected" | "reconnecting"`.
- `db.onConnectionStateChange((state, previousState) => void)` returns an unsubscribe function.
- Incoming realtime mutations automatically invalidate matching entries in `BoundedReadCache`.

---

## End-User Auth (EdDSA) & Lifecycle

- `db.auth` and top-level aliases: `signUpWithEmailAndPassword`, `signInWithEmailAndPassword`, `signInAnonymously`, `signInWithOAuth`, `verifyMfaChallenge`, `enrollTotpMfa`, `confirmTotpMfa`, `sendPasswordResetEmail`, `confirmPasswordReset`, `sendEmailVerification`, `confirmEmailVerification`, `getUser`, `updateProfile`, `getIdToken`, `signOut`, `onAuthStateChanged`, `currentUser`.
- Proactive refresh 45s before JWT `exp`, single-flight reactive 401 refresh, automatic live WebSocket re-authentication, and `sessionEpoch` guards.
- `db.clearCache()` clears the read cache; `db.dispose?.()` closes WebSockets, clears auth timers, and releases listeners.

## Modular Architecture & Tamper-Proofing

`@vellumdb/sdk-js` separates concerns across `src/core/`, `src/cache/`, `src/auth/`, `src/realtime/`, `src/references/`, `src/batch/`, and `src/client/`. Facades, `fieldOp` sentinels, and snapshots are frozen with `Object.freeze`, credentials are redacted in `toJSON()`/`toString()`, and `data()`/cache reads return prototype-safe clones.
