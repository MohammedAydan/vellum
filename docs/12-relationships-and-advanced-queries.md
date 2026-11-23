# 12 — Relationships & Advanced Queries (V2)

> **Status:** current as of the V2 engine (Phases 1–4). Every signature, endpoint and
> limit below is taken from the shipped code. All examples use methods that actually
> exist in `@vellum/sdk-js`, `vellum_flutter` and the `/v1` REST API.
>
> Companion guides: [03 — Query Compiler](./03-query-and-indexing.md),
> [13 — Security Rules DSL](./13-security-rules-dsl.md),
> [14 — Smart Indexing & Performance](./14-smart-indexing-and-performance.md).

V2 adds four families of capability on top of the v1 query engine:

1. **Eager-loaded relationships** via `.include()` with `$ref` values, batched fetches and
   rules-aware redaction.
2. **Server-side aggregation** (`count`, `sum`, `avg`, `min`, `max`, `groupBy`) and bulk
   delete (`deleteWhere`).
3. **Advanced predicates** — dot-path `select`, disjunctive `or` groups, and the
   case-insensitive / full-text operators `contains_ci`, `starts_with_ci`, `text_search`.
4. **Write controls** — idempotent `upsert` and per-document **TTL** (`expiresAt` /
   `ttlSeconds`) with a bounded sweeper.

---

## 1. Relationships with `.include()`

### 1.1 The shape of an include

A relation is declared on a document field that holds a reference. The canonical wire
shape is `IncludeSpec`:

```ts
interface IncludeSpec {
  field: string;        // field on the parent holding the reference (dot paths allowed)
  collection?: string;  // target collection; inferred from the $ref or field name if absent
  as?: string;          // attach under this key (also written into doc.data[as])
  select?: string[];    // dot-path projection applied to the resolved target
  include?: IncludeSpec[]; // nested relations, max depth 3
  onDelete?: "cascade" | "set_null" | "restrict"; // referential action (see §2)
}
```

The JS SDK accepts a **string shorthand** — `"author"` is normalized to
`{ field: "author" }` — or a full object (`IncludeSpecInput`). Nested `include` entries
may themselves be strings. Both SDKs normalize includes before sending them:

| SDK | Call | Notes |
| :-- | :--- | :---- |
| JS / TS | `query.include(["author", { field: "editor", as: "editorDoc", select: ["name"] }])` | `include()` is additive; a bare string becomes `{ field }`. |
| Flutter / Dart | `query.include(['author', VellumInclude(field: 'editor', as: 'editorDoc', select: ['name']))])` | `VellumInclude` mirrors the wire shape; raw `Map`s pass through for forward-compatible fields such as `onDelete`. |

On a single document read the includes travel as a JSON-encoded query parameter, on a
query as a body field:

- `GET /v1/projects/:projectId/documents/:path?include=[...]&select=[...]`
- `POST /v1/projects/:projectId/query` with `"include": [...]`

Both forms are parsed with `JSON.parse` on the server and validated against the
recursive `IncludeSpecSchema`.

### 1.2 Reference formats (`$ref`)

`parseReference` accepts four value shapes on the parent field:

```text
{ "$ref": "users/u_123" }              // shorthand object
{ "$t": "ref", "$v": "users/u_123" }   // tagged wire reference
"users/u_123"                          // plain canonical path string
"u_123"                                // bare id, resolved with spec.collection or inferred from field
```

Collection inference strips trailing `id`/`ref`/`key` suffixes (`authorId` → `authors`,
`owner_ref` → `owners`, `category` → `categories`) and falls back to `documents`. Every
resulting path is validated by `parseDocumentPath`; invalid values are ignored rather
than throwing.

### 1.3 Depth, batching and cycles

`MAX_RELATION_DEPTH = 3` is hard-capped in the engine, and the API contract rejects a
fourth `include` level outright (the leaf schema is `strict()`). Resolution is staged so
the number of storage round trips is **one logical batch per depth**:

1. **Collect** every referenced path across *all* parent documents at the current depth,
   dedupe and sort them.
2. **Fetch once** with `getDocumentBatch(paths)`. In production this maps to a single
   `tx.batchGetDocuments` call — no N+1. Test doubles that only expose `getDocument`
   are wrapped in `Promise.all` and still count as one logical batch.
3. **Security-filter** each target with the caller's `canRead` check (the engine closes
   over `authorizeOperation(..., operation: "get")`), schedule nested includes, then
   **attach** projected targets at depth + 1.

A `visitedPaths` set refuses to expand any path already expanded at a shallower or equal
depth, so reference cycles terminate and are represented as minimal stubs.

### 1.4 Security redaction — `_redactedRefs`

A relation is never a way around Security Rules. Every resolved target is checked with a
`get` authorization. If the check fails (or throws), the target is **not** attached; the
attachment key is recorded in the parent's `_redactedRefs` array and the value is
`null`. Redaction never leaks document data and never fails the request.

The SDK exposes these as snapshot fields:

```ts
interface DocumentSnapshot<T> {
  data(): T;
  included?: Record<string, unknown>; // server's _included
  redactedRefs?: string[];            // server's _redactedRefs
}
```

### 1.5 Runnable examples

**JavaScript / TypeScript**

```ts
import { createClient } from "@vellum/sdk-js";

const db = createClient({
  projectId: "proj_01JCK9X2P8",
  apiKey: "pk_a1b2c3d4...",
  getAuthToken: async () => currentUserJwt(), // populates auth.uid for rules
});

// Shorthand + detailed include, nested one level, with projection and alias.
const posts = await db
  .collection("posts")
  .where("published", "==", true)
  .include([
    "author",                                             // { field: "author" }
    {
      field: "editorId",
      collection: "users",
      as: "editor",
      select: ["name", "email"],
      include: [{ field: "avatarRef", as: "avatar" }],
    },
  ])
  .select("title", "authorRef", "createdAt")
  .limit(25)
  .get();

for (const post of posts.docs) {
  console.log(post.data().title);
  console.log(post.included?.["author"]);   // resolved author document (or null)
  console.log(post.redactedRefs);           // e.g. ["editor"] if rules denied it
}

// The same on a single document read:
const one = await db.doc("posts/p_1").get({ include: ["author"], select: ["title"] });
```

**Flutter / Dart**

```dart
import 'package:vellum_flutter/vellum_flutter.dart';

final client = VellumClient(
  projectId: '<YOUR_PROJECT_ID>',
  apiKey: '<YOUR_API_KEY>',
);

final page = await client.collection('posts')
  .where('published', '==', true)
  .include([
    'author',
    VellumInclude(
      field: 'editorId',
      collection: 'users',
      as: 'editor',
      select: ['name', 'email'],
      include: [VellumInclude(field: 'avatarRef', as: 'avatar')],
    ),
  ])
  .select(['title', 'createdAt'])
  .limit(25)
  .get();

for (final post in page.docs) {
  print(post.included['author']);
}
```

**REST**

```bash
# Query with includes + dot-path select.
curl -s -X POST \
  "https://api.example.com/v1/projects/$PROJECT_ID/query" \
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{
    "collectionPath": "posts",
    "where": [{ "field": "published", "op": "==", "value": true }],
    "select": ["title", "authorRef", "createdAt"],
    "include": [
      { "field": "author" },
      { "field": "editorId", "collection": "users", "as": "editor",
        "select": ["name", "email"] }
    ],
    "limit": 25
  }'

# Single document read (includes/select are URL-encoded JSON query params).
curl -s -G \
  "https://api.example.com/v1/projects/$PROJECT_ID/documents/posts/p_1" \
  -H "x-vellum-api-key: $API_KEY" \
  --data-urlencode 'include=[{"field":"author"}]' \
  --data-urlencode 'select=["title"]'
```

---

## 2. Referential actions — `onDelete`

`onDelete` declares what happens to *dependent* documents when a referenced document is
deleted. It is evaluated inside `batchWrite`, in the same tenant transaction as the
original delete, in deterministic `path ASC` order — never as an asynchronous cascade.

```ts
interface RelationRule {
  collection: string;                                  // dependent collection to scan
  field: string;                                       // reference field on the dependent
  onDelete: "cascade" | "set_null" | "restrict";
}
```

| Action | Behavior |
| :----- | :------- |
| `restrict` | Aborts the whole batch with `RELATION_RESTRICT_VIOLATION` (412). The error is deliberately generic: it never echoes the blocking document's path, the deleted path, or the field, so a caller without read access to the dependent cannot probe for the existence of documents it may not see. |
| `set_null` | Writes `null` into the dependent's reference field, increments its `version`, appends an `updated` outbox event and counts toward document *updates*. |
| `cascade` | Tombstones the dependent (emits a `deleted` outbox event) and enqueues further cascade work, depth-limited by `MAX_RELATION_DEPTH = 3`. |

The active rules are resolved per operation: an explicit `EngineContext.relationRules`
passed by trusted server code (tests, internal tooling) always wins; otherwise the
document engine reads the project's persisted rules from the control plane
(`getRelationRules`). The wire `IncludeSpec` schema also carries an optional `onDelete`
field for forward compatibility. A delete with no configured rules simply tombstones the
target document as in v1.

### 2.1 Managing rules — `GET/PUT /v1/projects/:projectId/relation-rules`

Rules are customer data, persisted in `control_db.project_relation_rules` (migration
0012) and managed through the control plane:

- `GET /v1/projects/:projectId/relation-rules` returns `{ projectId, version, rules }`.
- `PUT /v1/projects/:projectId/relation-rules` replaces the full rule set atomically:
  `{ rules: [...], expectedVersion? }`. `expectedVersion` (or an integer `If-Match`
  header) enables optimistic concurrency; a mismatch fails with `ABORTED_CONFLICT`
  (409) instead of silently dropping a concurrent edit. Every replacement bumps the
  version — including replacement with an empty set — and writes an audit-log entry
  (`relation_rules.replaced`).
- Validation is shared across stores: at most 50 rules per project (the engine's own
  cap), non-empty `collection`/`field`, `onDelete` in `cascade | set_null | restrict`,
  optional non-empty `targetCollection`, and no duplicate `(collection, field)` pairs.
- A rule with `targetCollection` only fires when the deleted document lives in that
  collection; omitting it applies the rule to references to any collection.
- Cross-instance propagation publishes a `relation_rules` invalidation on the existing
  `vellum_cache_invalidate` LISTEN/NOTIFY bus; the control-plane read mirror re-hydrates
  from PostgreSQL on its regular refresh as a fallback.

The same G1.5 side-channel rule applies to reads of rules as to `restrict` errors:
rule definitions describe collections and fields, never document contents.

---

## 3. Aggregations — `count`, `sum`, `avg`, `min`, `max`, `groupBy`

Aggregation is a terminal query operation executed in SQL inside the tenant transaction;
the documents themselves are never loaded into the application. The request shape is
`AggregateRequest`:

```ts
interface AggregateRequest {
  collectionPath: string;
  where?: WhereClause[];          // same filters as a query, max 10
  or?: WhereClause[][];           // disjunctive groups
  groupBy?: string[];             // dot paths, max 3
  metrics: Record<string, { op: "count" | "sum" | "avg" | "min" | "max"; field?: string }>;
}
```

Every metric is **named**. `count` needs no `field`; `sum`/`avg`/`min`/`max` require a
dot-path `field` (validated at the API boundary). Without `groupBy`, the SDK helpers
resolve the numeric value of the first named metric in the first row; with a non-empty
`groupBy`, the full `rows` array is returned so every group is visible.

### 3.1 SDK examples

**JavaScript / TypeScript** — convenience helpers plus the general form:

```ts
const orders = db.collection("orders").where("status", "==", "paid");

const total   = await orders.count();         // number (0 when no rows)
const revenue = await orders.sum("total");    // number
const average = await orders.avg("total");    // number
const smallest = await orders.min("total");
const largest  = await orders.max("total");

// Named metrics + grouping returns rows.
const byStatus = await orders.aggregate({
  groupBy: ["status", "currency"],
  metrics: {
    orders:  { op: "count" },
    revenue: { op: "sum", field: "total" },
    average: { op: "avg", field: "total" },
  },
});
// byStatus: Array<{ status, currency, orders, revenue, average }>
```

**Flutter / Dart** — `count`/`sum`/`avg` are convenience helpers; `min`, `max` and
`groupBy` go through `aggregate()` with `AggregateMetric`:

```dart
final orders = client.collection('orders').where('status', '==', 'paid');

final int total = await orders.count();
final num? revenue = await orders.sum('total');
final num? average = await orders.avg('total');

final grouped = await orders.aggregate(
  groupBy: ['status', 'currency'],
  metrics: {
    'orders': const AggregateMetric.count(),
    'revenue': AggregateMetric.sum('total'),
    'smallest': AggregateMetric.min('total'),
    'largest': AggregateMetric.max('total'),
  },
);
final rows = grouped['rows'] as List; // every group
```

### 3.2 REST

```bash
# POST /v1/projects/:projectId/documents:aggregate
curl -s -X POST \
  "https://api.example.com/v1/projects/$PROJECT_ID/documents:aggregate" \
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{
    "collectionPath": "orders",
    "where": [{ "field": "status", "op": "==", "value": "paid" }],
    "groupBy": ["status", "currency"],
    "metrics": {
      "orders":  { "op": "count" },
      "revenue": { "op": "sum", "field": "total" },
      "average": { "op": "avg", "field": "total" }
    }
  }'
# → { "rows": [ { "status": "paid", "currency": "USD", "orders": 42, ... } ],
#     "executionTimeMs": 1.8 }
```

Rules are enforced before execution: the request must be allowed at the `list`/`read`
level for the target collection, exactly like a normal query.

---

## 4. Dot-path `select`

`select` projects fields from each document. V2 extends it to **dot paths**, rebuilding
nested objects on the response. The compiler emits a flat `projectedData` map keyed by
the full dot path, and `projectDocumentFields` reconstructs the nested shape using
`getFieldByPath`.

```ts
// JS: variadic, flattened
const page = await db.collection("users").select("name", "author.profile.name", "meta.score").get();
// → data: { name, author: { profile: { name } }, meta: { score } }

// Dart: list argument
await client.collection('users').select(['name', 'author.profile.name', 'meta.score']).get();
```

```bash
curl -s -X POST \
  "https://api.example.com/v1/projects/$PROJECT_ID/query" \
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"collectionPath":"users","select":["name","author.profile.name"],"limit":50}'
```

`select` inside an `include` uses the same dot-path rule and applies to the *resolved*
target only.

---

## 5. Disjunctive `or` groups

`or` takes an array of groups. Clauses **within** a group are ANDed; groups are ORed;
the result is ANDed with the base `where` predicates. At most 10 groups are accepted
(`OrGroupsSchema`); normal `where` limits still apply inside each group.

```ts
// JS: (role == "admin") OR (role == "editor" AND verified == true)
const page = await db
  .collection("users")
  .where("active", "==", true)                 // base predicate, ANDed with the OR
  .or([
    [{ field: "role", op: "==", value: "admin" }],
    [
      { field: "role", op: "==", value: "editor" },
      { field: "verified", op: "==", value: true },
    ],
  ])
  .get();
```

```dart
final page = await client.collection('users')
  .where('active', '==', true)
  .or([
    [
      {'field': 'role', 'op': '==', 'value': 'admin'},
    ],
    [
      {'field': 'role', 'op': '==', 'value': 'editor'},
      {'field': 'verified', 'op': '==', 'value': true},
    ],
  ])
  .get();
```

```bash
curl -s -X POST \
  "https://api.example.com/v1/projects/$PROJECT_ID/query" \
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{
    "collectionPath": "users",
    "where": [{ "field": "active", "op": "==", "value": true }],
    "or": [
      [{ "field": "role", "op": "==", "value": "admin" }],
      [{ "field": "role", "op": "==", "value": "editor" },
       { "field": "verified", "op": "==", "value": true }]
    ]
  }'
```

The same `or` field is accepted by `/documents:aggregate` and `/documents:bulk-delete`.
`or` compiles to `((group1) OR (group2) …)` with fully parameterized values.

---

## 6. Case-insensitive & text operators

V2 extends `QueryOperator` with three operators. They pass through both SDK `where()`
methods unchanged — validation happens at the API boundary, not in the builders.

| Operator | SQL compilation | Use |
| :------- | :-------------- | :-- |
| `contains_ci` | `ILIKE '%' || escapeLike(value) || '%'` | Case-insensitive substring match |
| `starts_with_ci` | `ILIKE escapeLike(value) || '%'` | Case-insensitive prefix match |
| `text_search` | `to_tsvector('simple', coalesce(d.data::text,'')) @@ plainto_tsquery('simple', value)` | Full-text search over the document payload |

```ts
const byEmail = await db.collection("users").where("email", "contains_ci", "@example.com").get();
const byName  = await db.collection("users").where("name", "starts_with_ci", "mo").get();
const search  = await db.collection("posts").where("data", "text_search", "postgres index").get(); // field is ignored
```

```dart
await client.collection('users').where('email', 'contains_ci', '@example.com').get();
await client.collection('posts').where('data', 'text_search', 'postgres index').get(); // field is ignored
```

> **Indexing note:** `contains_ci` and `text_search` are not classified into the
> advisor's E/S/R model, so they do not trigger a composite-index suggestion; they rely
> on the built-in GIN index for containment-style predicates and on sequential scanning
> for `text_search`. See [14 — Smart Indexing](./14-smart-indexing-and-performance.md).

---

## 7. Idempotent writes — `upsert`

`upsert` sends an `INSERT … ON CONFLICT DO UPDATE` write, so the operation is safe to
retry and never fails just because the document already exists.

| SDK | Call |
| :-- | :--- |
| JS / TS | `await ref.upsert(data, options)` or `await ref.set(data, { upsert: true, ... })` |
| Flutter / Dart | `await ref.upsert(value, merge: true, ttlSeconds: 60)` (alias for `set(..., upsert: true)`) |
| REST | `PUT /v1/projects/:projectId/documents/:path` with `"upsert": true` in the body |

```ts
await db.doc("counters/visits").upsert({ count: 1 });
// equivalent to: db.doc("counters/visits").set({ count: 1 }, { upsert: true })
```

```bash
curl -s -X PUT \
  "https://api.example.com/v1/projects/$PROJECT_ID/documents/counters/visits" \
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{ "data": { "count": 1 }, "upsert": true }'
```

`upsert` composes with `merge`, `ifVersion` and the TTL options below.

---

## 8. Bulk delete — `deleteWhere`

`deleteWhere` deletes every document matching the builder's collection, `where` and `or`
in one server-side operation. It enforces `list`/`read` Security Rules first, appends an
outbox event per deleted row, and counts the work as `documentDeletes` metering.

| SDK | Call | Returns |
| :-- | :--- | :------ |
| JS / TS | `await query.deleteWhere({ limit: 500 })` | `{ deletedCount: number }` |
| Flutter / Dart | `await query.deleteWhere(limit: 500)` | `int` |
| REST | `POST /v1/projects/:projectId/documents:bulk-delete` | `{ "deletedCount": n }` |

The `limit` is an integer in `[1, 5000]` and defaults to `1000` (the engine's 5,000-row
hard ceiling, distinct from the 500-row query limit).

```ts
const removed = await db
  .collection("sessions")
  .where("lastSeenAt", "<", "2026-01-01T00:00:00.000Z")
  .deleteWhere({ limit: 2000 });
console.log(removed.deletedCount);
```

```dart
final removed = await client.collection('sessions')
  .where('lastSeenAt', '<', '2026-01-01T00:00:00.000Z')
  .deleteWhere(limit: 2000);
```

```bash
curl -s -X POST \
  "https://api.example.com/v1/projects/$PROJECT_ID/documents:bulk-delete" \
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{
    "collectionPath": "sessions",
    "where": [{ "field": "lastSeenAt", "op": "<", "value": "2026-01-01T00:00:00.000Z" }],
    "limit": 2000
  }'
# → { "deletedCount": 137 }
```

---

## 9. Document TTL

Every document may carry an optional expiry. The data-plane migration adds
`expires_at timestamptz NULL` to `documents`; `NULL` means "never expires".

- **`expiresAt`** — an explicit ISO-8601 timestamp (`INVALID_ARGUMENT` if unparseable).
- **`ttlSeconds`** — a relative lifetime (positive, finite, `<= 2^31`).

When both are supplied, the explicit `expiresAt` wins. Both are accepted on `create`,
`set`/`upsert` (and, where applicable, update) through `EngineContext`:

```ts
await db.collection("sessions").doc("s_1").create({ userId: "u_1" }, { ttlSeconds: 3600 });
await db.collection("otp").doc("o_1").set({ code: "123456" }, { expiresAt: "2026-11-18T12:00:00.000Z" });
```

```dart
await client.collection('sessions').doc('s_1').create({'userId': 'u_1'}, ttlSeconds: 3600);
await client.collection('otp').doc('o_1').upsert({'code': '123456'},
  expiresAt: '2026-11-18T12:00:00.000Z');
```

```bash
curl -s -X PUT \
  "https://api.example.com/v1/projects/$PROJECT_ID/documents/sessions/s_1" \
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{ "data": { "userId": "u_1" }, "ttlSeconds": 3600, "upsert": true }'
```

**Read behavior.** Every compiled query adds
`(d.expires_at IS NULL OR d.expires_at > now())`, so an expired document disappears from
all reads immediately — it is not merely hidden by the UI. Aggregations, bulk deletes and
composite-index scans use the same predicate.

**Sweeper.** Reads filter expired rows, but physical removal is a maintenance task:
`runTtlSweeperWorker(limit = 500)` deletes expired *live* rows in bounded batches (the
batch size is clamped to `[1, 5000]`), using the partial index `idx_docs_expires_at`. The
API maintenance loop calls it alongside tombstone purge. Until the sweeper runs, expired
rows still occupy storage but are invisible to queries.

---

## 10. Quick reference

| Feature | JS / TS | Dart | REST |
| :------ | :------ | :--- | :---- |
| Eager load | `.include([...])`, `.get({ include })` | `.include([...])`, `.get(include:)` | `include` param / body field |
| Referential action | `relationRules` (engine config) | `onDelete` in raw include map | not a public endpoint |
| Count / sum / avg | `.count()`, `.sum(f)`, `.avg(f)` | `.count()`, `.sum(f)`, `.avg(f)` | `POST /documents:aggregate` |
| Min / max / group | `.min(f)`, `.max(f)`, `.aggregate({ groupBy })` | `AggregateMetric.min/max`, `.aggregate(groupBy:)` | `POST /documents:aggregate` |
| Dot-path select | `.select("a.b", ...)` | `.select(['a.b'])` | `select` body field / param |
| OR groups | `.or([[...], [...]])` | `.or([[...]])` | `or` body field |
| Text operators | `.where(f, "contains_ci", v)` | `.where(f, 'text_search', v)` | `where` clause `op` |
| Upsert | `.upsert(data)` | `.upsert(value)` | `PUT` + `"upsert": true` |
| Bulk delete | `.deleteWhere({ limit })` | `.deleteWhere(limit:)` | `POST /documents:bulk-delete` |
| TTL | `ttlSeconds` / `expiresAt` options | `ttlSeconds:` / `expiresAt:` | body `ttlSeconds` / `expiresAt` |


## Reverse references (`referencedBy`)

Use `db.doc("users/u1").referencedBy({ collection: "posts", field: "author", limit: 25 })`
for permission-filtered reverse lookup. The REST endpoint is
`POST /v1/projects/{projectId}/documents:referencedBy`. Continue while `nextCursor`
is non-null, including after an empty page. The caller must be able to get the
target and both get/list each dependent. Includes keep per-target redaction.

Matching uses full stored paths, not inferred bare IDs. Limits, encrypted cursor
semantics, deployment costs, JS examples and the contract-first Dart handoff are
in the reverse reference lookup rules below. The Dart
convenience method is not yet shipped.


## Opt-in realtime includes

Pass `{ resolveIncludes: true, include: ["author"] }` as the third JS
`onSnapshot` argument. Query subscriptions can reuse their `.include()` specs
with `{ resolveIncludes: true }`. Realtime expansion is depth 1, with a shared
reference fetch per live parent event and per-subscriber redaction.

Included targets are snapshots when processing the parent event, not live joins.
Target-only edits do not retrigger the parent; historical replay reads current
target values. See the realtime includes section below
for the exact wire frame, bounds, error handling and Dart handoff.
