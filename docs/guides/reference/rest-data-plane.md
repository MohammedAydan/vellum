---
title: Public Data Plane REST API
order: 2
group: Reference
description: API-key-only document CRUD, query, batchWrite, OCC transactions, indexes and the full collections lifecycle under /v1/projects/:projectId.
---

# Public Data Plane REST API

The public document plane is implemented directly in `apps/api/src/app.ts`. It is the **only** surface that reads/writes customer documents. Every operation is scoped by `(projectId)` from the URL and authenticated by an API key. Business logic (validation, rules evaluation, SQL) lives in `@vellum/query-engine`, `@vellum/document-engine`, and `@vellum/storage` — never in the route handlers.

## Tenant scoping and authentication

Every route in this section has the shape:

```text
/v1/projects/:projectId/...
```

| Requirement | Detail |
| :--- | :--- |
| `:projectId` | Project UUID. Resolved via `controlStore.getProject`. |
| API key | **Mandatory.** `X-Project-Key` header. Missing → `401 UNAUTHENTICATED`. The key must belong to the addressed project, otherwise `403 PERMISSION_DENIED`. |
| End-user JWT | Optional `Authorization: Bearer <JWT>`. When present it must be a valid signed JWT (`verifyEndUserJwtSync`); otherwise `401`. Its claims become the `authContext` used by security rules. |
| Project state | `suspended` → `403 PERMISSION_DENIED`; `throttled` → `429 RATE_LIMITED`. |
| Rate limit | Enforced per key prefix via the sliding-window limiter at the key's `rateLimitRps`. |

:::warning
A raw API key (`pk_…` / `sk_…`) is a secret. Never place it in a URL query string, log, or client-side bundle that is visible to untrusted users. Send it only in the `X-Project-Key` header over TLS.
:::

## Endpoint summary

| Method | Path | Required scope / rules | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/v1/projects/:projectId/documents/*` | `documents:read` + rules `get`/`list` | Read a document (even segments) or list a collection (odd segments) |
| `POST` | `/v1/projects/:projectId/documents/*` | `documents:write` + rules `create` | Create a document (fails `409 ALREADY_EXISTS` if present) |
| `PUT` | `/v1/projects/:projectId/documents/*` | `documents:write` + rules `create`/`update` | Overwrite (`merge:false`) or deep-merge (`merge:true`) |
| `PATCH` | `/v1/projects/:projectId/documents/*` | `documents:write` + rules `update` | Patch fields and apply atomic `$op` transforms |
| `DELETE` | `/v1/projects/:projectId/documents/*` | `documents:write` + rules `delete` | Soft-delete (tombstone + outbox event) |
| `POST` | `/v1/projects/:projectId/query` | `documents:read` + rules `list` | Structured query with `where`, `orderBy`, `limit`, `select`, cursor |
| `POST` | `/v1/projects/:projectId/batchWrite` | `documents:write` + rules | Up to 100 atomic mutations |
| `POST` | `/v1/projects/:projectId/documents:batchWrite` | `documents:write` + rules | Alias for `batchWrite` |
| `POST` | `/v1/projects/:projectId/transactions:begin` | `documents:read` | Issue a signed OCC `transactionToken` |
| `POST` | `/v1/projects/:projectId/transactions:commit` | `documents:write` + rules | Verify read-set versions, commit atomically |
| `GET` | `/v1/projects/:projectId/indexes` | `sk_` with `indexes:manage` | List composite indexes and build statuses |
| `POST` | `/v1/projects/:projectId/indexes` | `sk_` with `indexes:manage` | Register/backfill a composite index |
| `DELETE` | `/v1/projects/:projectId/indexes/:indexId` | `sk_` with `indexes:manage` | Delete index and its entries |
| `GET` | `/v1/projects/:projectId/collections` | `documents:read` | List distinct collection paths (Studio helper) |

The path after `/documents/` is `decodeURIComponent`-decoded from the URL. Segment parity decides document vs collection automatically.

## Canonical path rules

Document and collection paths follow the grammar in [Wire Format & Path Grammar](./wire-format.md). Enforced by `parseDocumentPath` / `parseCollectionPath` in `@vellum/core`:

| Rule | Document path | Collection path |
| :--- | :--- | :--- |
| Segment count | Even, 2–10 | Odd, 1–9 |
| Examples | `users/u_123`, `users/u_123/orders/ord_456` | `users`, `users/u_123/orders` |
| Leading/trailing `/` | Rejected | Rejected |
| Empty segment | Rejected | Rejected |
| `.`, `..`, `%2e%2e`, `%2f` | Rejected | Rejected |
| Reserved `__…__` segments | Rejected | Rejected |
| ASCII control chars `0x00`–`0x1F` | Rejected | Rejected |
| Max segment length | 1,500 UTF-8 bytes | 1,500 UTF-8 bytes |

Violations → `400 INVALID_DOCUMENT_PATH`. Parse decomposition for `users/u_123/orders/ord_456`: `path` = itself, `collectionPath` = `users/u_123/orders`, `collectionGroup` = `orders`, `documentId` = `ord_456`, `pathDepth` = 4.

## Document CRUD

Request/response shapes come from `packages/api-contract/src/schemas/documents.ts`:

- `CreateDocumentRequestSchema`: `{ data: object }`
- `SetDocumentRequestSchema`: `{ data: object, merge?: boolean }`
- `UpdateDocumentRequestSchema`: `{ data: object, preconditions?: { exists?, version?, lastUpdateTime? } }`
- `DocumentPayloadSchema` (returned document): `{ path, collectionPath, collectionGroup, documentId, data, sizeBytes?, version, createdAt, updatedAt }`

The route handlers accept `{ data }` **or a bare data object** (`body.data ?? body`).

| Method | Request | Response | Notable errors |
| :--- | :--- | :--- | :--- |
| `GET` | `?limit=<n>&startAfter=<cursor>` (collection only), or `?transactionToken=`/`?txToken=`/`x-transaction-token` (document only) | Document object, or query result `{ documents, nextCursor, hasMore, executionStats? }` | `INVALID_DOCUMENT_PATH`, `NOT_FOUND`, rules denial |
| `POST` | `{ data }` | `201` created document | `ALREADY_EXISTS`, `INVALID_DOCUMENT_PATH`, `DOCUMENT_TOO_LARGE` |
| `PUT` | `{ data, merge?, ifVersion? }` | `200` saved document | `FAILED_PRECONDITION` (412) if `ifVersion` mismatch, `MAX_NESTING_EXCEEDED`, `INVALID_FIELD_NAME` |
| `PATCH` | `{ data, ifVersion? }` | `200` updated document | `FAILED_PRECONDITION`, `INVALID_ARGUMENT` (bad `$op`) |
| `DELETE` | `?ifVersion=<n>` | `200` deletion result | `FAILED_PRECONDITION`, `NOT_FOUND` |

Atomics transforms (`$op`: `serverTimestamp`, `inc`/`increment`, `arrayUnion`, `arrayRemove`, `deleteField`) are accepted in `PUT` (merge), `PATCH`, `batchWrite`, and `transactions:commit`, but rejected in plain `POST` creation contexts. See [Wire Format](./wire-format.md) and the [REST API narrative guide](../rest-api.md).

## Query (`POST …/query`)

`QuerySpecSchema` (`packages/api-contract/src/schemas/queries.ts`):

| Field | Type | Rules |
| :--- | :--- | :--- |
| `collectionPath` | string (canonical collection path) | Mutually exclusive with `collectionGroup`; one of the two is required |
| `collectionGroup` | string (min 1) | Mutually exclusive with `collectionPath` |
| `where` | `{field, op, value}[]` | Max 10; `op` ∈ `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not-in`, `array-contains`, `array-contains-any` |
| `orderBy` | `{field, direction:"asc"\|"desc"}[]` | Max 3 |
| `limit` | int | 1–500, default 50 |
| `cursor`, `startAt`, `startAfter`, `endAt`, `endBefore` | string / array | Opaque HMAC-SHA256 cursors or bound arrays; `document_id ASC` is the final tie-breaker |
| `select` | string[] | Project selected fields |

Response `QueryResponseSchema`: `{ documents: object[], nextCursor: string|null, hasMore: boolean, executionStats?: { scannedCount?, matchedCount?, executionDurationMs?, indexUsed? } }`.

Errors: `QUERY_TOO_COMPLEX` (>10 `where`, >3 `orderBy`, >30 disjunctive values), `LIMIT_EXCEEDED` (limit >500), `INVALID_CURSOR` (malformed or tampered cursor), `RESPONSE_TOO_LARGE` (>4 MiB), `QUERY_DEADLINE_EXCEEDED` (>5 s, 504). Cursor pagination is the only pagination mode — no SQL `OFFSET` is exposed.

## Batch write

`POST …/batchWrite` (or `…/documents:batchWrite`). Body: `{ writes }` or `{ operations }` — an array of `BatchOperationSchema`:

```json
{
  "operations": [
    { "type": "create", "path": "users/u_1", "data": { "name": "Ada" } },
    { "type": "update", "path": "counters/c_1", "data": { "n": { "$op": "inc", "by": 1 } } }
  ]
}
```

`type` ∈ `create` / `set` / `update` / `delete`; write types require `data`. `options?: { merge?: boolean }` and `precondition?: { exists?, version?, lastUpdateTime? }` are supported. Max 100 operations, 5 MiB total payload. Response `{ results:[{path,version,updatedAt}], commitTimestamp }`. Errors: `BATCH_SIZE_EXCEEDED`, `PAYLOAD_TOO_LARGE`, `ABORTED_CONFLICT`.

## OCC transactions

1. `POST …/transactions:begin` → `{ transactionToken, expiresAt }`. Token validity window: 5,000 ms (`MAX_TRANSACTION_DURATION_MS`).
2. Read within the snapshot: `GET …/documents/*?transactionToken=<token>`.
3. `POST …/transactions:commit` with `{ transactionToken, writes }` (route also accepts `mutations`, and per-write `ifVersion`/`preconditions`/`precondition`). Reads may be supplied as `reads:[{path,readVersion}]` in the contract schema.

Commit verifies read-set versions with `SELECT … FOR UPDATE` in deterministic `path ASC` order. Errors: `TRANSACTION_TIMEOUT` (408) if the window expired, `ABORTED_CONFLICT` (409) on version mismatch — retry the whole transaction with jittered backoff. See [OCC ADR](../../decisions/ADR-002-occ-transaction-tokens.md).

## Composite indexes

| Method | Request | Response | Errors |
| :--- | :--- | :--- | :--- |
| `GET` | — | `{ indexes: CompositeIndex[] }` | `PERMISSION_DENIED` (scope) |
| `POST` | `{ collectionPath, fields:[{fieldPath, order?}], name? }` | `201CompositeIndex` | `INVALID_ARGUMENT`, `INVALID_DOCUMENT_PATH` |
| `DELETE` | — (`/:indexId`) | `{ deleted:true, indexId }` | `NOT_FOUND` |

Endpoints require `indexes:manage` scope, which only server (`sk_`) keys carry. Tenant indexes are stored as rows in `document_indexes` and maintained in `document_index_entries` via binary sort keys — **no `CREATE INDEX` is issued on the shared `documents` table**.

## Collections lifecycle

Collections are durable registry rows in `data_db.project_collections` (RLS `ENABLE` + `FORCE`), not an emergent `DISTINCT` view. A collection exists even when it holds zero documents, and its settings survive document deletes, F5 and process restarts. Existing legacy data was backfilled from `documents.collection_path` when migration `0009_project_collections.sql` ran.

There are **two parallel surfaces with an identical wire contract**:

| Surface | Base path | Authentication |
| :--- | :--- | :--- |
| Public data plane | `/v1/projects/:projectId/collections…` | API key in `x-vellum-api-key` (legacy `x-project-key` accepted) |
| Console (Dashboard) | `/v1/console/projects/:projectId/collections…` | `CUSTOMER_CONSOLE` realm session token |

Both are scoped by `(projectId)` and every mutation is audited (`collection.create|update|clear|delete`). The public mutation routes additionally require a **server (`sk_`) key**; public (`pk_`) keys may only perform the three reads (`GET` list, `GET` one, `GET` export). Console writes are authorized by the session and audited with the console `audit()` helper. A missing/wrong key type returns `403 PERMISSION_DENIED`.

### The eight endpoints

Both base paths below accept the same suffixes; `M` marks mutations that need `sk_` on the public surface.

| Method | Suffix | Auth (public / console) | Response |
| :--- | :--- | :--- | :--- |
| `GET` | `/collections` | `pk_` or `sk_` / session | `{ collections: CollectionWithStats[], nextCursor: string \| null }` |
| `POST` | `/collections` | `sk_` (M) / session | `201CollectionRecord` |
| `GET` | `/collections/:name` | `pk_` or `sk_` / session | `CollectionWithStats \| null` (404 → `null` in the SDKs) |
| `PATCH` | `/collections/:name` | `sk_` (M) / session | `CollectionWithStats` |
| `POST` | `/collections/:name/clear` | `sk_` (M) / session | `{ deletedCount, freedBytes }` |
| `DELETE` | `/collections/:name` | `sk_` (M) / session | `{ deletedCollection, deletedDocuments, freedBytes }` |
| `POST` | `/collections/:name/import` | `sk_` (M) / session | `{ importedCount, skippedCount, errors: [{ index, message }] }` |
| `GET` | `/collections/:name/export` | `pk_` or `sk_` / session | `{ documents: ExportedDocument[], nextCursor: string \| null }` |

`CollectionWithStats` extends the registry row with `documentCount`, `storageBytes` and `lastDocumentAt`:

```json
{
  "id": "col_01J9F5K2M8",
  "projectId": "prj_…",
  "projectId": "env_…",
  "name": "users",
  "description": "Customer accounts",
  "defaultTtlSeconds": 86400,
  "schemaValidation": { "requiredFields": ["email"], "strict": false },
  "isSystem": false,
  "metadata": {},
  "createdAt": "2026-11-19T10:00:00.000Z",
  "updatedAt": "2026-11-19T10:05:00.000Z",
  "documentCount": 12,
  "storageBytes": 4096,
  "lastDocumentAt": "2026-11-19T10:04:00.000Z"
}
```

### List query parameters

`GET …/collections` accepts `search`, `limit` and `cursor`:

- `search` — optional substring match on the collection name (max 256 characters).
- `limit` — integer 1–500, **default 50**. Set `limit=500` to see all collections when more than 50 exist; follow `nextCursor` via `cursor=` for further pages. The Dashboard Data Explorer always sends `limit=500`.
- `cursor` — opaque continuation token returned as `nextCursor`; never construct or edit it.

### Collection names and settings

`name` is trimmed and must be 1–128 characters matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` — no leading/trailing `/`, no `..`, no whitespace/control characters and no reserved `__internal__` prefix. Duplicate creation is idempotent with `{"ifNotExists": true}`.

`POST` / `PATCH` bodies accept only these settings (unknown keys are rejected with `400 INVALID_ARGUMENT`):

| Field | Type | Meaning |
| :--- | :--- | :--- |
| `description` | `string` (≤ 2048 chars), nullable on PATCH | Human-readable note; `null` clears it. |
| `defaultTtlSeconds` | positive integer ≤ 2,147,483,647, nullable on PATCH | Expiry applied to documents that do not already carry `expiresAt` / `ttlSeconds`. |
| `schemaValidation` | `{ requiredFields?: string[], strict?: boolean }`, nullable on PATCH | `requiredFields` (each 1–256 chars) is enforced on write with `400 INVALID_ARGUMENT`. |
| `metadata` | object | Caller-defined key/value bag. |
| `ifNotExists` | boolean, `POST` only | Return the existing row instead of `409 ALREADY_EXISTS`. |

```json
{
  "name": "users",
  "description": "Customer accounts",
  "defaultTtlSeconds": 86400,
  "schemaValidation": { "requiredFields": ["email"], "strict": false },
  "ifNotExists": true
}
```

### Clear vs delete

- **Clear** (`POST …/:name/clear`) soft-deletes every document in the collection (tombstones + realtime outbox events) but **keeps the collection row and all of its settings**. Returns `{ "deletedCount": 12, "freedBytes": 4096 }`.
- **Delete** (`DELETE …/:name`) removes the collection registration **and** all of its documents. Returns `{ "deletedCollection": true, "deletedDocuments": 12, "freedBytes": 4096 }`.

Both operations meter the freed storage (`recordDeletes`) and append a hash-chained audit entry. Neither is a recovery operation — deletions are permanent from the collection's perspective.

### Import and export formats

`POST …/:name/import` takes **either** a JSON array of at most 500 objects, each `{ "id"?: string, "data": { … } }`, **or** the SDK/Dashboard envelope `{ "documents": […], "mode": "upsert" | "insert_only" }`. `id` becomes the document id; when omitted the server generates a UUID. Invalid entries are skipped rather than aborting the batch, and each failure is reported by zero-based index with a safe message (no headers, keys or secrets):

```json
[
  { "id": "u_1", "data": { "name": "Ada", "email": "ada@example.com" } },
  { "data": { "name": "Grace" } }
]
```

```json
{ "importedCount": 2, "skippedCount": 0, "errors": [] }
```

`GET …/:name/export` pages deterministically in `path ASC` order and returns each document with `id`, `path`, `data`, `version`, `createdAt` and `updatedAt`, plus `nextCursor` (null when the collection is exhausted). There is no SQL `OFFSET`:

```json
{
  "documents": [
    {
      "id": "u_1",
      "path": "users/u_1",
      "data": { "name": "Ada" },
      "version": 3,
      "createdAt": "2026-11-19T10:00:00.000Z",
      "updatedAt": "2026-11-19T10:05:00.000Z"
    }
  ],
  "nextCursor": null
}
```

The official SDKs wrap these calls as `importDocuments(collection, docs, { mode })` and `exportDocuments(collection, { limit, cursor })` (`mode` is `upsert` by default, or `insert_only`); see [JS SDK](../../08-sdk-js-guide.md#10-collections-lifecycle) and [Flutter SDK](../../09-sdk-flutter-guide.md#9-collections-lifecycle).

## Quick cross-reference

- Console equivalents (session-authenticated): [Control Plane & Console REST](./rest-control-plane.md)
- WebSocket subscribe/snapshots/resume: [Realtime Protocol](./realtime-protocol.md)
- Canonical codes and statuses: [Errors](./errors.md)
- Tagged values, field transforms, path grammar: [Wire Format](./wire-format.md)
- Query/indexing narrative: [Query & Indexing](../../03-query-and-indexing.md)
