---
title: Composite Indexes
order: 8
group: Core concepts
description: Tenant composite indexes as rows, order-preserving sort keys, creation and status, when an index is needed, and duplicate conflicts.
---

# Composite Indexes

Composite indexes accelerate queries that filter or sort on custom document fields. In a multi-tenant service, running `CREATE INDEX` per customer on the shared `documents` table would cause catalog bloat and DDL locks. VELLUM therefore stores indexes as **rows**, never as customer DDL.

## Scenario

Your reporting screen filters users by `status` and sorts by `priority desc`, and the query starts failing with `FAILED_PRECONDITION` and a `suggestedIndex`. You register that index with a server key, poll until its status is `ready`, and then the query runs as a single B-tree range scan.

## How tenant indexes work

| Table | Role |
| :--- | :--- |
| `document_indexes` | Index definition: collection path, ordered field list, definition hash, build status. |
| `document_index_entries` | One row per document in the index, keyed by an order-preserving `sort_key BYTEA`. |

An index definition names up to **3 fields**, each with a path and a direction:

```json
{
  "collectionPath": "users",
  "fields": [
    { "path": "status", "dir": "asc" },
    { "path": "priority", "dir": "desc" }
  ]
}
```

The sort key encodes each field value with a type-prefix byte (missing, null, boolean, numeric, string, timestamp, reference, bytes), then escapes delimiters so the key preserves the natural ordering of the logical values. For a `desc` field, every byte of that segment is inverted so a single ascending B-tree scan yields descending order. Because PostgreSQL compares `BYTEA` byte-by-byte, the primary key `(index_id, sort_key, document_id)` answers a multi-field range-and-sort query with **one index scan**.

## Creation and status

Indexes are managed with a server key holding the `indexes:manage` scope (public keys cannot manage indexes):

| Method | Endpoint | Purpose |
| :--- | :--- | :--- |
| `GET` | `/v1/projects/:projectId/indexes` | List indexes and their statuses. |
| `POST` | `/v1/projects/:projectId/indexes` | Register and backfill a new index. |
| `DELETE` | `/v1/projects/:projectId/indexes/:indexId` | Delete an index and its entries. |

```bash
curl -X POST "https://api.example.com/v1/projects/<PROJECT_ID>/indexes" \
  -H "x-project-key: <YOUR_SERVER_KEY>" \
  -H "content-type: application/json" \
  -d '{
    "collectionPath": "users",
    "fields": [
      { "path": "status", "dir": "asc" },
      { "path": "priority", "dir": "desc" }
    ]
  }'
```

Status values:

| Status | Meaning |
| :--- | :--- |
| `building` | Registered; the backfill worker is populating entries. |
| `ready` | Fully built and used by the query planner. |
| `failed` | Build failed; `errorMessage` explains why. |
| `deleting` | Being removed. |

The backfill worker claims `building` rows and scans active documents in deterministic batches of 500 ordered by `document_id ASC`, computing each `sort_key` and upserting entries until the index is `ready`. Subsequent writes maintain index entries transactionally.

:::note
Registration returns immediately with status `building`. Poll `GET .../indexes` until the index is `ready` before relying on it for queries.
:::

```bash
# Poll until the index is ready before depending on it in queries.
curl -s "https://api.example.com/v1/projects/<PROJECT_ID>/indexes" \
  -H "x-project-key: <YOUR_SERVER_KEY>" | jq '.indexes[] | {id, status, errorMessage}'
```

## Duplicate creation (409)

Index definitions are deduplicated by a hash of `(project, collection path, fields)` enforced by a unique database constraint. Creating an identical index returns `ALREADY_EXISTS` (409) with the existing `collectionPath` and `definitionHash` in the error details. Reuse the existing index instead of retrying.

## When an index is needed

- **No index needed:** equality filters (`==`, `in`) and single-field ordering on built-in fields (`documentId`, `createdAt`, `updatedAt`) use built-in B-tree / GIN indexes.
- **Index needed:** combining a range filter (`<`, `<=`, `>`, `>=`) with additional filters, or ordering by one or more custom document fields, requires a composite index.

If a query needs an index that does not exist, the server returns `FAILED_PRECONDITION` (412) with a `suggestedIndex` field list. Create that index, wait for `ready`, and retry. See [Query](./query.md).

:::warning
Each document's composite index entries count toward storage. Keep index definitions narrow — only the fields a real query needs — and delete unused indexes.
:::

## Common pitfalls

- **Using a public key to manage indexes.** Only a server key with `indexes:manage` can create or delete indexes.
- **Querying before the index is `ready`.** Registration returns `building`; poll until `ready` first.
- **Retrying a duplicate index blindly.** An identical definition returns `ALREADY_EXISTS` (409); reuse the existing index.
- **Indexing every field "just in case".** Entries consume storage and slow writes; index only fields real queries use.

## Verified example

:::example-tabs indexes

## What to read next

- [Query](./query.md) — which query shapes require a composite index.
- [Pagination](./pagination.md) — how indexed keyset cursors carry the signed sort key.
- [Production checklist](./production-checklist.md) — index health in readiness probes.
