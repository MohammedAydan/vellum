# JavaScript / TypeScript SDK Guide (`@vellumdb/sdk-js`)

Complete engineering guide for `@vellumdb/sdk-js` v0.0.5 — grounded directly in `packages/sdk-js/src/{index,types,client,field-ops,batch,read-cache,auth-client,auth-storage,realtime-transport,backoff,safe-json}.ts`.

> **Security Note**: The document plane is API-key scoped with an optional end-user EdDSA bearer token. Use publishable `pk_` keys in browsers and reserve secret `sk_` keys strictly for trusted server environments.

---

## 1. Installation & Initialization

```bash
npm install @vellumdb/sdk-js
# or
pnpm add @vellumdb/sdk-js
```

All public APIs, types, storage adapters, and transport helpers are exported from the package root:

```ts
import {
  createClient,
  fieldOp,
  BoundedReadCache,
  BrowserLocalStorage,
  MemoryAuthStorage,
  RealtimeTransport,
  toRealtimeUrl,
} from "@vellumdb/sdk-js";
import type {
  ClientConfig,
  VellumClient,
  DocDataConverter,
  DocumentSnapshot,
  QuerySnapshot,
  RealtimeSnapshot,
  ConnectionState,
  AuthState,
  MfaRequiredResult,
} from "@vellumdb/sdk-js";
```

### Creating a Production Client

```ts
const db: VellumClient = createClient({
  projectId: "proj_01j9...",
  apiKey: process.env.VELLUM_API_KEY!,
  endpoint: "https://api.example.com",
  // HTTP resilience
  timeoutMs: 15_000,
  maxRetries: 3,
  retryBaseDelayMs: 250,
  retryMaxDelayMs: 10_000,
  // Read optimization
  cache: { enabled: true, ttlMs: 30_000, maxEntries: 1_000 },
  dedupeReads: true,
  // Index advisor telemetry
  warnOnMissingIndexes: process.env.NODE_ENV !== "production",
  onIndexSuggestion: ({ url, suggestion }) => {
    metrics.increment("vellum.index_suggestion", { url, suggestion });
  },
});
```

### Full `ClientConfig` Reference

| Option | Default | Behavior |
| --- | --- | --- |
| `projectId` | **Required** | Project identifier (validated & URI-encoded into `/v1/projects/:projectId`). |
| `apiKey` | **Required** | Sent in `x-vellum-api-key` and `x-project-key`. |
| `endpoint` | `"http://localhost:8080"` | Base HTTP(S) origin. |
| `realtimeUrl` | `toRealtimeUrl(endpoint)` | Explicit `ws://` or `wss://` override. |
| `getAuthToken` | `null` | Custom async/sync bearer provider; overrides managed `db.auth` session when returning a non-null token. |
| `authStorage` | `BrowserLocalStorage` (browser) / `MemoryAuthStorage` (Node) | Persists `AuthState` under `vellum.auth.session.v1`. |
| `customFetch` | `globalThis.fetch` | Injectable `fetch` for custom agents, proxies, or unit tests. |
| `timeoutMs` | `30_000` | Per-request timeout via `AbortController`. Throws `Error` with `code: "REQUEST_TIMEOUT"`. Set `0` to disable. |
| `maxRetries` | `3` | Transient retries on `429`, `500`, `502`, `503`, `504`, or network errors for idempotent requests. Set `0` to disable. |
| `retryBaseDelayMs` | `250` | Base delay for full-jitter backoff. |
| `retryMaxDelayMs` | `10_000` | Maximum cap for full-jitter backoff. |
| `cache` | `{ enabled: false, ttlMs: 30_000, maxEntries: 1_000 }` | Opt-in `BoundedReadCache` (LRU + TTL) for `doc.get()`. |
| `dedupeReads` | `false` | Opt-in single-flight GET coalescing for identical concurrent `doc.get()` calls. |
| `warnOnMissingIndexes` | `true` | Prints deduplicated one-click index advisor links (capped at 1,000 fingerprints). |
| `onIndexSuggestion` | `undefined` | Fires for every `x-vellum-index-*` response header even when `warnOnMissingIndexes` is `false`. |
| `realtimeTransportOptions` | `null` | Override `heartbeatIntervalMs` (`25_000`), `pongTimeoutMs` (`60_000`), `connectTimeoutMs` (`10_000`), `maxOutboundQueueSize` (`1_000`), `randomFn`. |

---

## 2. CRUD, Field Operations & Converters

### Document Lifecycle

```ts
const userRef = db.collection("users").doc("usr_101");

// 1. Create (POST — fails with 409 if document already exists)
await userRef.create(
  { name: "Grace Hopper", credits: 100, roles: ["user"], createdAt: fieldOp.serverTimestamp() },
  { ttlSeconds: 604_800 } // or expiresAt: "2026-12-31T23:59:59Z"
);

// 2. Read (GET — supports select, include, dedupe, bypassCache, signal)
const snap = await userRef.get({
  select: ["name", "credits", "roles"],
  include: ["organizationId"],
});
console.log(snap.id, snap.path, snap.version, snap.exists, snap.data(), snap.included);

// 3. Upsert (PUT with upsert: true — INSERT ... ON CONFLICT DO UPDATE)
await userRef.upsert({ name: "Grace Hopper", credits: 150, roles: ["admin"] }, { merge: true });

// 4. Set (PUT — full replace or merge, optional OCC via ifVersion)
await userRef.set({ name: "Rear Admiral Hopper" }, { merge: true, ifVersion: snap.version });

// 5. Update (PATCH — atomic partial update with fieldOp sentinels)
await userRef.update(
  {
    credits: fieldOp.increment(-25),
    roles: fieldOp.arrayUnion("architect"),
    deprecatedField: fieldOp.deleteField(),
    updatedAt: fieldOp.serverTimestamp(),
  },
  { ifVersion: snap.version + 1 }
);

// 6. Delete (DELETE — optional OCC via ifVersion)
await userRef.delete({ ifVersion: snap.version + 2 });
```

### Atomic Field Operations (`fieldOp`)

| Helper | Wire Payload | Effect |
| --- | --- | --- |
| `fieldOp.serverTimestamp()` | `{ $op: "serverTimestamp" }` | Sets field to authoritative server UTC timestamp. |
| `fieldOp.increment(by = 1)` | `{ $op: "inc", by }` | Atomically adds `by` (positive or negative) to a numeric field. |
| `fieldOp.arrayUnion(...elements)` | `{ $op: "arrayUnion", elements }` | Appends elements not already present in the array. |
| `fieldOp.arrayRemove(...elements)` | `{ $op: "arrayRemove", elements }` | Removes all matching elements from the array. |
| `fieldOp.deleteField()` | `{ $op: "deleteField" }` | Removes the key from the document JSON object. |

### Type-Safe `withConverter<T>()`

`withConverter<U>(converter)` is available on `CollectionReference`, `DocumentReference`, and `QueryBuilder` (pass `null` to strip an existing converter):

```ts
import type { DocDataConverter } from "@vellumdb/sdk-js";

interface Order {
  id: string;
  totalCents: number;
  status: "open" | "paid";
}

const orderConverter: DocDataConverter<Order> = {
  toDoc: (order) => ({ totalCents: order.totalCents, status: order.status }),
  fromDoc: (snap) => {
    const d = snap.data();
    return {
      id: snap.id,
      totalCents: Number(d["totalCents"] ?? 0),
      status: (d["status"] as Order["status"]) ?? "open",
    };
  },
};

const orders = db.collection("orders").withConverter(orderConverter);
const snap = await orders.doc("ord_1").get();
const order: Order = snap.data();
```

---

## 3. Queries, Relations & Aggregations

### All 13 Filter Operators

- **Comparison**: `==`, `!=`, `<`, `<=`, `>`, `>=`
- **Membership**: `in`, `not-in` (up to 30 values)
- **Arrays**: `array-contains`, `array-contains-any` (up to 30 values)
- **V2 Text & Search**: `contains_ci` (case-insensitive substring), `starts_with_ci` (case-insensitive prefix), `text_search` (full-text search)

### Chaining `where()`, `or()`, `include()`, `select()`, `orderBy()`

`QueryBuilder` is immutable — every chained method returns a new builder instance.

```ts
const result = await db
  .collection("articles")
  .where("published", "==", true)
  .where("title", "contains_ci", "postgres")
  .or([
    [{ field: "category", op: "==", value: "engineering" }],
    [{ field: "featured", op: "==", value: true }],
  ])
  .include([
    "authorId",
    {
      field: "reviewerId",
      collection: "users",
      as: "reviewer",
      select: ["name", "avatarUrl"],
    },
  ])
  .select("title", "publishedAt", "author.name")
  .orderBy("publishedAt", "desc")
  .limit(20)
  .get();
```

### Reverse Reference Lookup (`referencedBy()`)

Permission-filtered reverse lookup: which documents reference this one. Wraps
`POST /documents:referencedBy` with opaque cursor pagination — keep paging
while `nextCursor` is non-null, even after an empty page.

```ts
let cursor: string | undefined;
do {
  const page = await db.doc("users/u1").referencedBy({
    collection: "orders",       // optional: narrow to one collection
    field: "customerId",        // optional: narrow to one reference field
    limit: 25,                  // 1..100 per page
    cursor,
    include: ["customer"],      // optional: resolve relations on dependents
  });
  for (const doc of page.documents) console.log(doc.path, doc.data());
  cursor = page.nextCursor ?? undefined;
} while (cursor !== undefined);
```

Options also accept `select` and `signal`. Dependents are normal
`DocumentSnapshot`s of their own type; the target reference's converter is
never applied to them. See `docs/RELATION-LOOKUP-CONTRACT.md` for the
permission-filtering and pagination semantics.

### Aggregations & Bulk Deletes

```ts
// Scalar helpers
const count = await db.collection("orders").where("status", "==", "paid").count();
const sum = await db.collection("orders").where("status", "==", "paid").sum("totalCents");
const avg = await db.collection("orders").where("status", "==", "paid").avg("totalCents");
const min = await db.collection("orders").where("status", "==", "paid").min("totalCents");
const max = await db.collection("orders").where("status", "==", "paid").max("totalCents");

// Grouped aggregation (returns AggregateRow[])
const rows = await db
  .collection("orders")
  .where("status", "==", "paid")
  .aggregate({
    groupBy: ["currency"],
    metrics: {
      orders: { op: "count" },
      grossCents: { op: "sum", field: "totalCents" },
    },
  });

// Filtered bulk delete (invalidates collection read cache)
const { deletedCount } = await db
  .collection("sessions")
  .where("expired", "==", true)
  .deleteWhere({ limit: 500 });
```

---

## 4. Cursor Pagination & Streaming (`pages()` / `stream()`)

Every query uses HMAC-signed opaque cursors (`startAfter` / `startAt`) with a deterministic `document_id` tie-breaker — never SQL `OFFSET`.

```ts
// Manual cursor loop
let cursor: string | null = null;
do {
  let q = db.collection("audit_logs").orderBy("createdAt", "desc").limit(100);
  if (cursor) q = q.startAfter(cursor);
  const page = await q.get();
  handlePage(page.docs);
  cursor = page.nextCursor;
} while (cursor);

// Enterprise async generators with AbortSignal & safety caps
const ac = new AbortController();

for await (const page of db
  .collection("audit_logs")
  .orderBy("createdAt", "desc")
  .pages({ pageSize: 200, maxPages: 50, signal: ac.signal })) {
  await processBatch(page.docs);
}

for await (const doc of db
  .collection("audit_logs")
  .orderBy("createdAt", "desc")
  .stream({ pageSize: 200, maxDocs: 5_000, signal: ac.signal })) {
  await processDoc(doc);
}
```

---

## 5. Batch Writes, Auto-Chunking & OCC Transactions

### `batchWrite()` & `batchWriteChunked()`

```ts
// Single atomic batch (up to 100 operations)
await db.batchWrite([
  { type: "set", path: "items/a", data: { price: 10 }, merge: true },
  { type: "update", path: "items/b", data: { stock: fieldOp.increment(-1) } },
  { type: "delete", path: "items/c" },
]);

// Conditional batch across documents, one round trip. Every precondition is checked before
// anything is written: if any document is stale, none change and you get FAILED_PRECONDITION (412).
await db.batchWrite([
  { type: "update", path: "accounts/a", data: { balance: 90 }, ifVersion: 4 },
  { type: "update", path: "accounts/b", data: { balance: 110 }, ifVersion: 7 },
  { type: "set", path: "audit/t1", data: { from: "a", to: "b" }, exists: false },
]);

// Auto-chunked bulk write for thousands of operations
const ac = new AbortController();
const res = await db.batchWriteChunked(largeWriteArray, {
  chunkSize: 100,     // default 500 ops/chunk
  concurrency: 4,     // default 4 concurrent HTTP chunks
  signal: ac.signal,
  onProgress: (p) => {
    console.log(`${p.completedOperations}/${p.totalOperations} (${p.completedChunks}/${p.totalChunks})`);
  },
});
console.log(res.totalOperations, res.totalChunks);
```

### `runTransaction()`

Executes a read-modify-write unit with Optimistic Concurrency Control and automatic retry on `ABORTED_CONFLICT`:

```ts
const { result, commit } = await db.runTransaction(
  async (tx) => {
    const snap = await tx.get(db.doc("inventory/sku_99"));
    const qty = Number(snap.data()["quantity"] ?? 0);
    if (qty < 1) throw new Error("Out of stock");

    tx.update("inventory/sku_99", { quantity: qty - 1 });
    tx.create("reservations/res_42", { sku: "sku_99", qty: 1 });
    return qty - 1;
  },
  { maxAttempts: 5 }
);
```

---

## 6. Read Caching, Coalescing & HTTP Resilience

### `BoundedReadCache` & `dedupeReads`

- **`cache: { enabled: true, ttlMs: 30_000, maxEntries: 1_000 }`**: O(1) LRU + TTL cache keyed by `(documentPath, select, include)`. Every `doc.get()` returns a defensive clone so caller mutations never corrupt cached entries.
- **Automatic Invalidation**: Local writes (`create`, `set`, `upsert`, `update`, `delete`, `batchWrite`, `runTransaction`, `deleteWhere`, `clearCollection`, `deleteCollection`, `importDocuments`) and incoming realtime mutations automatically invalidate affected paths/collections and bump write epochs to prevent stale in-flight reads from repopulating the cache.
- **Per-Call Overrides**: `doc.get({ bypassCache: true })`, `doc.get({ dedupe: true })`, and manual `db.clearCache()`.

### `AbortSignal`, Timeouts & `Retry-After` Backoff

- Every read, write, query, stream, batch, collection, and transaction method accepts `{ signal?: AbortSignal }`, composed with `timeoutMs`. Aborted calls reject with `code = "REQUEST_ABORTED"`; timed-out calls reject with `code = "REQUEST_TIMEOUT"`.
- Automatic retries (`maxRetries`, default `3`) apply **only** to safe idempotent requests (`GET`, `HEAD`, `OPTIONS`, `POST /query`, `POST /documents:aggregate`, or requests carrying `Idempotency-Key` / `X-Idempotency-Key`).
- On `429` or `503` with a `Retry-After` header (delta-seconds or HTTP-date), the SDK honors the server delay (clamped to `60_000ms`); otherwise it applies full-jitter exponential backoff between `retryBaseDelayMs` and `retryMaxDelayMs`.

---

## 7. Realtime Subscriptions & Connection Observability

```ts
console.log("Initial state:", db.connectionState); // "disconnected"

const offState = db.onConnectionStateChange((state, previousState) => {
  console.log(`[realtime] ${previousState} -> ${state}`);
});

const offDoc = db.doc("orders/ord_1").onSnapshot(
  (snapshot) => {
    for (const change of snapshot.changes) {
      console.log(change.type, change.seqId, change.doc.data());
    }
  },
  (err) => console.error("Doc stream error:", err)
);

const offQuery = db
  .collection("orders")
  .where("status", "==", "open")
  .orderBy("createdAt", "desc")
  .limit(50)
  .onSnapshot((snapshot) => {
    console.log("Materialized docs:", snapshot.docs.length, "watermark:", snapshot.watermarkSeqId);
  });

// Unsubscribe; closing the last subscription closes the underlying WebSocket
offDoc();
offQuery();
offState();
```

### Opt-in Relation Includes on Subscriptions

`onSnapshot` accepts `RealtimeListenOptions` as its last argument:
`resolveIncludes: true` asks the server to resolve relations point-in-time on
every emitted document (max 10 specs, depth 1 — snapshots at event time, not
a live join). Resolved payloads land on `snapshot.doc.included`; targets
hidden by security rules appear in `redactedRefs`.

```ts
const off = db.doc("orders/ord_1").onSnapshot(
  (snapshot) => console.log(snapshot.doc.included),
  (err) => console.error(err),
  { resolveIncludes: true, include: ["customer", { field: "items", select: ["sku"] }] }
);
```

Wire semantics: `docs/REALTIME-INCLUDES-CONTRACT.md`.

---

## 8. End-User Authentication (EdDSA)

All methods live on `db.auth` and are mirrored directly on `db`:

- **Session creation**: `signUpWithEmailAndPassword`, `signInWithEmailAndPassword` (returns `AuthState | MfaRequiredResult`), `signInAnonymously`, `signInWithOAuth`
- **MFA**: `enrollTotpMfa`, `confirmTotpMfa`, `verifyMfaChallenge`
- **Account recovery & verification**: `sendPasswordResetEmail`, `confirmPasswordReset`, `sendEmailVerification`, `confirmEmailVerification`
- **Profile & tokens**: `getUser`, `updateProfile`, `getIdToken(forceRefresh?)`, `currentUser`, `onAuthStateChanged(cb)`, `signOut({ allSessions? })`

**Hardening guarantees**:
1. Proactive silent refresh fires **45 seconds** before the EdDSA JWT `exp` claim.
2. Concurrent `401 Unauthorized` responses coalesce into a **single-flight** `/auth/token/refresh` request and replay once with the fresh token.
3. A monotonic `sessionEpoch` prevents an in-flight refresh from resurrecting a session after `signOut()` or `dispose()`.
4. Whenever the bearer token rotates, active WebSocket connections automatically send a fresh `auth` frame (`reauthenticateRealtime`).

---

## 9. Collections Lifecycle & Disposal

```ts
await db.createCollection("invoices", {
  description: "Customer invoices",
  defaultTtlSeconds: 31_536_000,
  schemaValidation: { requiredFields: ["customerId", "amountCents"], strict: false },
  ifNotExists: true,
});

const { collections } = await db.listCollections({ search: "inv", limit: 20 });
const info = await db.collection("invoices").info();
await db.importDocuments("invoices", [{ id: "inv_1", data: { customerId: "c1", amountCents: 500 } }], {
  mode: "upsert",
});
const exported = await db.exportDocuments("invoices", { limit: 100 });

// Always dispose on process exit or component teardown
db.dispose?.();
```

`dispose()` stops auth refresh timers, closes the multiplexed WebSocket transport, clears all listeners, purges the read cache, and releases in-flight maps.

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
