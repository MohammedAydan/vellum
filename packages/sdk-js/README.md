# `@vellumdb/sdk-js`

Official TypeScript & JavaScript SDK for **VELLUM** — a PostgreSQL-backed, multi-tenant document database with strong consistency, cursor pagination, real-time WebSocket sync, and end-user EdDSA authentication.

Built for **Node.js 18+**, modern **browsers**, and **edge runtimes** with zero runtime dependencies outside `ws` (lazy-loaded only in Node.js).

---

## Highlights

- **Strict End-to-End TypeScript**: Generic `CollectionReferenceInterface<T>`, `DocumentReferenceInterface<T>`, and Firestore-style `withConverter<T>()` bidirectional converters.
- **Full CRUD & Atomic Field Operations**: `create`, `set`, `upsert`, `update`, `delete`, `get`, optimistic concurrency (`ifVersion`), per-document TTL (`ttlSeconds` / `expiresAt`), and atomic `fieldOp` transforms (`increment`, `serverTimestamp`, `arrayUnion`, `arrayRemove`, `deleteField`).
- **Expressive V2 Query Engine**: All 13 filter operators (including `contains_ci`, `starts_with_ci`, `text_search`), disjunctive `or()` groups, eager `include()` relation loading, dot-path `select()` projections, and server-side `aggregate()` (`count`, `sum`, `avg`, `min`, `max` with `groupBy`).
- **Bounded-Memory Cursor Streaming**: HMAC-signed cursor pagination (`startAfter`, `startAt`) plus `pages()` and `stream()` async generators with `AbortSignal`, `maxPages`, and `maxDocs`.
- **Auto-Chunked Bulk Writes & OCC Transactions**: `batchWriteChunked()` with bounded concurrency, progress callbacks, and `AbortSignal`, alongside `runTransaction()` with automatic `ABORTED_CONFLICT` retry.
- **Production Read Caching & Coalescing**: Opt-in `BoundedReadCache` (LRU + TTL, auto-invalidated on writes and realtime mutations) and `dedupeReads` single-flight GET coalescing with defensive cloning.
- **Resilient HTTP & Realtime Transport**: Per-request `AbortSignal`, configurable `timeoutMs`, `Retry-After` + full-jitter backoff for idempotent requests, multiplexed RFC 6455 WebSocket with `resumeSeqId`, decorrelated jitter reconnect, heartbeat, and observable `connectionState` / `onConnectionStateChange()`.
- **EdDSA End-User Auth**: Email/password, anonymous, OAuth, TOTP MFA, proactive 45s refresh, single-flight reactive 401 refresh, pluggable `AuthStorage`, and clean `dispose()`.

---

## Installation

```bash
npm install @vellumdb/sdk-js
# or
pnpm add @vellumdb/sdk-js
```

---

## Quick Start

```ts
import { createClient, fieldOp } from "@vellumdb/sdk-js";

const db = createClient({
  projectId: "proj_01j9...",
  apiKey: process.env.VELLUM_API_KEY!, // Use pk_... in browsers, sk_... on servers
  endpoint: "https://api.example.com",
  timeoutMs: 15_000,
  maxRetries: 3,
  cache: { enabled: true, ttlMs: 30_000, maxEntries: 1_000 },
  dedupeReads: true,
});

// Create a document with TTL and atomic server timestamp
await db.collection("users").doc("usr_ada").create(
  {
    name: "Ada Lovelace",
    role: "admin",
    loginCount: 1,
    tags: ["engineering"],
    createdAt: fieldOp.serverTimestamp(),
  },
  { ttlSeconds: 86_400 }
);

// Read with field projection
const snap = await db.doc("users/usr_ada").get({ select: ["name", "role", "loginCount"] });
console.log(snap.id, snap.version, snap.data());

// Atomic partial update with optimistic concurrency
await db.doc("users/usr_ada").update(
  {
    loginCount: fieldOp.increment(1),
    tags: fieldOp.arrayUnion("founders"),
    legacyFlag: fieldOp.deleteField(),
  },
  { ifVersion: snap.version }
);

// Always release timers, caches, and WebSocket connections on shutdown
db.dispose?.();
```

---

## Client Configuration (`ClientConfig`)

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `projectId` | `string` | **Required** | Target VELLUM project ID. |
| `apiKey` | `string` | **Required** | Project API key (`pk_...` for clients, `sk_...` for trusted backends). |
| `endpoint` | `string` | `"http://localhost:8080"` | Base HTTP(S) origin. |
| `realtimeUrl` | `string` | `<endpoint>/v1/realtime` | Explicit `ws://` or `wss://` override. |
| `getAuthToken` | `() => Promise<string \| null> \| string \| null` | `null` | Custom bearer token provider (overrides managed `db.auth` session). |
| `authStorage` | `AuthStorage \| null` | `BrowserLocalStorage` or `MemoryAuthStorage` | Pluggable session persistence adapter. |
| `timeoutMs` | `number` | `30_000` | Per-request HTTP timeout (`AbortController`). Set `0` to disable. |
| `maxRetries` | `number` | `3` | Transient retry count (429/5xx/network) for idempotent requests. Set `0` to disable. |
| `retryBaseDelayMs` | `number` | `250` | Base delay for full-jitter exponential backoff. |
| `retryMaxDelayMs` | `number` | `10_000` | Maximum backoff delay cap. |
| `cache` | `{ enabled?: boolean; ttlMs?: number; maxEntries?: number }` | `{ enabled: false, ttlMs: 30_000, maxEntries: 1_000 }` | Opt-in `BoundedReadCache` (LRU + TTL) for `doc.get()`. |
| `dedupeReads` | `boolean` | `false` | Coalesce identical concurrent `doc.get()` calls into one HTTP request. |
| `warnOnMissingIndexes` | `boolean` | `true` | Log deduplicated one-click index advisor suggestions from `x-vellum-index-*` headers. |
| `onIndexSuggestion` | `(event: IndexSuggestionEvent) => void` | `undefined` | Advisory observability hook for index suggestions. |
| `customFetch` | `typeof fetch` | `globalThis.fetch` | Custom `fetch` implementation for proxies or tests. |

---

## Typed Models with `withConverter<T>()`

Attach a `DocDataConverter<T>` to a `CollectionReference`, `DocumentReference`, or `QueryBuilder` for full compile-time safety across reads, writes, streaming, and realtime snapshots:

```ts
import type { DocDataConverter } from "@vellumdb/sdk-js";

interface Invoice {
  id: string;
  customerId: string;
  amountCents: number;
  status: "draft" | "open" | "paid";
}

const invoiceConverter: DocDataConverter<Invoice> = {
  toDoc: (inv) => ({
    customerId: inv.customerId,
    amountCents: inv.amountCents,
    status: inv.status,
  }),
  fromDoc: (snap) => {
    const raw = snap.data();
    return {
      id: snap.id,
      customerId: String(raw["customerId"] ?? ""),
      amountCents: Number(raw["amountCents"] ?? 0),
      status: (raw["status"] as Invoice["status"]) ?? "draft",
    };
  },
};

const invoices = db.collection("invoices").withConverter(invoiceConverter);

await invoices.doc("inv_1001").upsert({
  id: "inv_1001",
  customerId: "cus_42",
  amountCents: 4900,
  status: "open",
});

const snap = await invoices.doc("inv_1001").get();
const invoice: Invoice = snap.data(); // Strongly typed
```

---

## Querying, Relations & Aggregations

### Supported Operators (13)

`==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not-in`, `array-contains`, `array-contains-any`, `contains_ci`, `starts_with_ci`, `text_search`.

```ts
const page = await db
  .collection("orders")
  .where("status", "in", ["paid", "shipped"])
  .or([
    [{ field: "priority", op: "==", value: "urgent" }],
    [{ field: "totalCents", op: ">=", value: 50_000 }],
  ])
  .include([
    "customerId",
    { field: "assigneeId", collection: "users", as: "assignee", select: ["name", "email"] },
  ])
  .select("status", "totalCents", "customerId")
  .orderBy("createdAt", "desc")
  .limit(25)
  .get();

for (const doc of page.docs) {
  console.log(doc.id, doc.data(), doc.included);
}
```

### Server-Side Aggregations

```ts
const totalOpen = await db.collection("invoices").where("status", "==", "open").count();
const totalRevenue = await db.collection("invoices").where("status", "==", "paid").sum("amountCents");

const byRegion = await db
  .collection("invoices")
  .where("status", "==", "paid")
  .aggregate({
    groupBy: ["region"],
    metrics: {
      invoiceCount: { op: "count" },
      revenueCents: { op: "sum", field: "amountCents" },
      avgTicket: { op: "avg", field: "amountCents" },
    },
  });
```

---

## Cursor Pagination & Streaming (`pages()` / `stream()`)

Never use SQL `OFFSET`. Iterate arbitrarily large datasets with constant memory and cooperative cancellation:

```ts
const controller = new AbortController();

// Stream individual documents with hard safety caps
for await (const doc of db
  .collection("events")
  .where("type", "==", "purchase")
  .orderBy("createdAt", "desc")
  .stream({
    pageSize: 100,
    maxPages: 20,
    maxDocs: 1_500,
    signal: controller.signal,
  })) {
  processEvent(doc.id, doc.data());
}

// Or process one QuerySnapshot page at a time
for await (const page of db.collection("events").orderBy("createdAt", "desc").pages({ pageSize: 200 })) {
  await writeBatchToWarehouse(page.docs);
}
```

---

## Auto-Chunked Bulk Writes & OCC Transactions

### `batchWriteChunked()`

Automatically splits large write arrays into chunks (SDK default `500` ops/chunk; pass `chunkSize: 100` for the current API cap) with bounded concurrency (default `4`), progress callbacks, and `AbortSignal`:

```ts
const operations = records.map((rec) => ({
  type: "set",
  path: `catalog/${rec.sku}`,
  data: rec,
  merge: true,
}));

const summary = await db.batchWriteChunked(operations, {
  chunkSize: 100,
  concurrency: 4,
  signal: controller.signal,
  onProgress: ({ completedOperations, totalOperations, completedChunks, totalChunks }) => {
    console.log(`Chunk ${completedChunks}/${totalChunks} (${completedOperations}/${totalOperations} ops)`);
  },
});
```

### `runTransaction()`

Optimistic Concurrency Control (OCC) with automatic retry on `ABORTED_CONFLICT` (default `maxAttempts: 5`):

```ts
const { result } = await db.runTransaction(
  async (tx) => {
    const from = await tx.get(db.doc("accounts/acc_a"));
    const to = await tx.get(db.doc("accounts/acc_b"));
    const balance = Number(from.data()["balance"]);
    if (balance < 100) throw new Error("Insufficient funds");

    tx.update(from.path, { balance: balance - 100 });
    tx.update(to.path, { balance: Number(to.data()["balance"]) + 100 });
    return { transferred: 100 };
  },
  { maxAttempts: 5, signal: controller.signal }
);
```

---

## Realtime Subscriptions & Connection Lifecycle

All `onSnapshot` subscriptions multiplex over a single RFC 6455 WebSocket with `resumeSeqId` replay, decorrelated jitter reconnect (`500ms`–`30s`), and heartbeat (`25s` ping / `60s` pong timeout).

```ts
const stopState = db.onConnectionStateChange((next, prev) => {
  console.log(`Realtime: ${prev} -> ${next}`); // disconnected | connecting | connected | reconnecting
});

const unsub = db
  .collection("messages")
  .where("roomId", "==", "general")
  .orderBy("createdAt", "desc")
  .limit(50)
  .onSnapshot(
    (snapshot) => {
      console.log("Watermark:", snapshot.watermarkSeqId);
      console.log("Changes:", snapshot.changes.map((c) => `${c.type}:${c.doc.id}`));
      renderMessages(snapshot.docs);
    },
    (err) => console.error("Realtime error:", err)
  );

// Cleanup
unsub();
stopState();
```

---

## End-User Authentication (EdDSA JWT)

```ts
const stopAuth = db.onAuthStateChanged((user) => {
  console.log(user ? `Signed in as ${user.id}` : "Signed out");
});

const signInRes = await db.signInWithEmailAndPassword("ada@example.com", "correct-horse-battery");
if ("mfaRequired" in signInRes) {
  await db.verifyMfaChallenge(signInRes.mfaTicket, "123456", "totp");
}

// Proactive 45s refresh + single-flight reactive 401 refresh are automatic.
// Live WebSocket connections re-authenticate automatically on token rotation.
await db.signOut();
stopAuth();
```

---

## Caching, Read Coalescing & Security Hardening

- **Bounded Read Cache**: Enable via `cache: { enabled: true, ttlMs: 30_000, maxEntries: 1_000 }`. Automatically invalidated on local writes (`create`, `set`, `upsert`, `update`, `delete`, `batchWrite`, `runTransaction`, `deleteWhere`, `clearCollection`, `deleteCollection`, `importDocuments`) and incoming realtime mutations. Bypass per call with `doc.get({ bypassCache: true })`, or purge manually with `db.clearCache()`.
- **Single-Flight GET Coalescing**: Set `dedupeReads: true` (or `doc.get({ dedupe: true })`) so concurrent identical reads share one HTTP request while returning independent defensive clones.
- **Prototype-Pollution & Path-Traversal Defense**: Every response is parsed through `safeJsonParse` (stripping `__proto__`, `constructor`, `prototype`), and every resource path is validated and URI-encoded by `encodePathSegment` / `encodeResourcePath`.

---

## Documentation

- [JavaScript / TypeScript SDK Full Guide](../../docs/08-sdk-js-guide.md)
- [JavaScript SDK API Reference](../../docs/guides/sdks/javascript.md)
- [Quickstart](../../docs/guides/quickstart.md) | [Querying](../../docs/guides/query.md) | [Pagination](../../docs/guides/pagination.md) | [Realtime](../../docs/guides/realtime.md) | [Batch & Transactions](../../docs/guides/batch-and-transactions.md) | [Production Checklist](../../docs/guides/production-checklist.md)

## Modular Architecture & Tamper-Proofing

`@vellumdb/sdk-js` is organized into focused domain folders under `src/` (`core/`, `cache/`, `auth/`, `realtime/`, `references/`, `batch/`, `client/`) exported cleanly from `src/index.ts`. Public facades, `fieldOp` sentinels, and snapshots are frozen with `Object.freeze`, credentials and caches are encapsulated behind `private readonly` fields with redacted `toJSON()`/`toString()`, and reads return prototype-safe defensive clones.

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
