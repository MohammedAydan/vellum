---
title: Documentation Home
order: 1
group: Getting started
description: What VELLUM is, how its two PostgreSQL data planes fit together, and where to begin.
---

# VELLUM Documentation

VELLUM is a multi-tenant document database built entirely on PostgreSQL/JSONB. You get hierarchical collections, typed JSON documents, structured queries with cursor pagination, atomic field transforms, optimistic-concurrency transactions, and realtime WebSocket streams — through a small TypeScript SDK (`@vellumdb/sdk-js`) or plain HTTP.

There is **one stateful runtime dependency: PostgreSQL**. No Redis, no message broker, and no separate cache service. Realtime is built on PostgreSQL `LISTEN/NOTIFY` plus a durable outbox; caching and rate limits use short-lived in-process state with PostgreSQL backing where durability matters; transactions are native PostgreSQL transactions.

:::note
VELLUM's public document API is scoped by API key with an optional EdDSA end-user bearer. End-user credentials are fully isolated from every other surface and share only crypto primitives — see [End-User Authentication](./end-user-auth.md).
:::

## Scenario

Imagine you are building a multi-tenant task manager. Each customer (tenant) gets its own project with one project, and you need to store tasks, query the open ones, react to changes live, and keep a strict audit trail — all without operating a separate cache or message broker. VELLUM gives you one PostgreSQL-backed document API that handles those concerns and scopes every request to a `(projectId)` pair.

```ts
// One client, one tenant scope: every request carries projectId.
import { createClient } from "@vellumdb/sdk-js";

const db = createClient({
  projectId: "<YOUR_PROJECT_ID>",
  apiKey: "<YOUR_API_KEY>", // pk_ for browser/mobile, sk_ on a trusted server
});

// Data-plane reads and writes are always scoped to that (project).
await db.collection("tasks").doc("task_123").set({ title: "Ship v1", done: false });
const snap = await db.collection("tasks").doc("task_123").get();
console.log(snap.data());
```

## Architecture in 60 seconds

The platform splits its storage into two physically and logically separate databases:

| Plane | Database | What lives there |
| :--- | :--- | :--- |
| **Control plane** | `control_db` | Users, organizations, memberships, projects, a single project, API-key prefixes and hashes (`pk_`/`sk_`), versioned security rulesets, MFA secrets, daily usage counters, immutable audit logs. |
| **Data plane** | `data_db` | Customer documents, composite index definitions and entries, the transactional `realtime_outbox`, and the OCC `transactions` table. |

Three invariants follow from this split:

1. **Bootstrap never depends on customer data.** Starting the service, authenticating operators, verifying API keys, and recovering from an outage read only `control_db`. There is no circular dependency on the public document API.
2. **Every data-plane operation is tenant-scoped.** Each request carries `(projectId)`, and every transaction binds `SET LOCAL app.current_project_id`, and `statement_timeout = '5000ms'`. PostgreSQL Row-Level Security fails closed if that context is missing. With one project, `projectId` is a single UUID — it is kept as a deliberate defense-in-depth dimension, not separate projects.
3. **Tenant indexes never take DDL locks.** Composite indexes are rows in `document_indexes` with order-preserving binary sort keys in `document_index_entries` — never `CREATE INDEX` on the shared `documents` table.

### Zero-Redis doctrine

The original 2.0 design named Redis as a mandatory realtime broker. That requirement is **revoked**. In the current design:

- Each mutation writes a `realtime_outbox` row in the *same* database transaction as the document change.
- An `AFTER INSERT` trigger emits a small `NOTIFY` containing only the sequence id and tenant ids — never document data.
- A single dedicated PostgreSQL client reserved for `LISTEN` wakes a gap-detecting outbox poller, which fetches full rows through the tenant-scoped adapter and fans them out over WebSockets.
- Verified-key caches and session revocation are in-process TTL structures with cross-instance invalidation through `NOTIFY vellum_cache_invalidate`. Authentication throttles (sign-in, sign-up, MFA) are counted in PostgreSQL and shared by every instance.

See [Realtime](./realtime.md) and the [Production checklist](./production-checklist.md) for the operational details.

## Where to start

- **Using the SDK for the first time:** [Quickstart](./quickstart.md) → [CRUD](./crud.md) → [Query](./query.md).
- **Using the SDKs:** [JavaScript SDK](./sdks/javascript.md) · [Flutter SDK](./sdks/flutter.md) — both include auth façades and silent refresh.
- **Building interactive apps:** [Realtime](./realtime.md) and [Batch & transactions](./batch-and-transactions.md).
- **Operating a deployment:** [Errors & limits](./errors-and-limits.md) and the [Production checklist](./production-checklist.md).
- **Calling the API directly:** [REST API orientation](./rest-api.md) and the full HTTP reference under `./reference/`.

## About the examples

Every guide may embed an example block, written as the example directive followed by a registered id. The static-site generator expands each one into **a static source block plus captured real-run output**. The examples are verified by actually running them against the codebase; the docs show only the recorded source and output.

:::warning
The documentation **never executes code in the browser**. Example blocks are inert, pre-rendered artifacts. Never paste real API keys, session tokens, or database URLs into documentation or source control — all snippets here use placeholders such as `<YOUR_API_KEY>`.
:::

## Common pitfalls

- **Do not add a broker or cache service.** PostgreSQL is the only stateful runtime dependency; realtime and short-lived caches are built from it.
- **A public key is not an access grant.** Every document operation still runs through the project's security rules.
- **Never run `CREATE INDEX` on `documents`.** Composite indexes are managed as rows through the index API, so tenant DDL never takes a lock on the shared table.

## What to read next

- [Quickstart](./quickstart.md) — install the SDK and write your first document.
- [Authentication](./authentication.md) — `pk_` / `sk_` keys and end-user tokens.
- [End-user auth](./end-user-auth.md) — three realms, refresh rotation, projection, WS auth, rate limits.
- [REST API](./rest-api.md) — endpoint families and the full reference.
