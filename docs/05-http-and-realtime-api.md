# 05 — Public HTTP REST API & Realtime WebSocket Wire Protocol

> **Scope:** Authoritative wire-level reference for the VELLUM `/v1` HTTP REST API and native RFC 6455 `/v1/realtime` WebSocket protocol.  
> **Grounded in:** `apps/api/src/app.ts`, `apps/api/src/node-server.ts`, `apps/api/src/ws-rfc6455.ts`, `apps/api/src/routes/health.ts`, `packages/realtime/src/hub.ts`, `packages/realtime/src/pg-realtime.ts`.

All HTTP endpoints return JSON, attach `X-Request-Id` to every response, enforce a `5 MiB` (`5,242,880` bytes) raw transport body cap (both via `Content-Length` and chunked stream inspection), and execute under a `30,000 ms` request timeout.

---

## 1. Public HTTP REST API

### 1.1 Health, Readiness & OpenAPI Endpoints

| Method | Endpoint | Auth | Purpose |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Public | Fast non-leaking liveness probe for Kubernetes/Docker/LBs. Never touches PostgreSQL. |
| `GET` | `/ready` | Public | Non-leaking readiness probe (`200 ready` or `503 unready`/`draining`). Uses a 3 s coalesced single-flight probe cache. |
| `GET` | `/v1/health/live` | Public | Detailed event-loop liveness probe (`status: "alive"`, `version`, `mode`, `uptimeMs`). Never touches PostgreSQL. |
| `GET` | `/v1/health/ready` | Public | Full readiness check running real SQL probes against `control_db`, `data_db`, both `schema_migrations` tables (detecting missing migrations or checksum drift), and the dedicated `LISTEN` endpoint. Immediately returns `503` (`status: "draining"`) during graceful shutdown. |
| `GET` | `/v1/health` | Public | Deprecated compatibility probe (prefer `/v1/health/live` + `/v1/health/ready`). |
| `GET` | `/v1/openapi.json` | Public | Machine-readable OpenAPI 3.1 specification. |

### 1.2 Document Data Plane Endpoints (`/v1/projects/:projectId/...`)

Data Plane requests authenticate via `x-vellum-api-key` (or legacy `x-project-key`) carrying a project-scoped `pk_` (public, rules-enforced) or `sk_` (server, scope-enforced) key, plus an optional `Authorization: Bearer <Ed25519 JWT>` for end-user identity (`auth.uid`).

| Method | Endpoint | Auth / Scope | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/v1/projects/:projectId/documents/*path` | `documents:read` or Rules `get`/`list` | Read a single document (even segments) or list a collection (odd segments). |
| `POST` | `/v1/projects/:projectId/documents/*path` | `documents:write` or Rules `create` | Create a new document (fails with `409 ALREADY_EXISTS` if present). |
| `PUT` | `/v1/projects/:projectId/documents/*path` | `documents:write` or Rules `create`/`update` | Overwrite (`merge: false`) or deep-merge (`merge: true`) a document. |
| `PATCH` | `/v1/projects/:projectId/documents/*path` | `documents:write` or Rules `update` | Partial update with dot-paths and atomic field transforms (`$op`). |
| `DELETE` | `/v1/projects/:projectId/documents/*path` | `documents:write` or Rules `delete` | Soft-delete a document (writes tombstone + `realtime_outbox` event). |
| `POST` | `/v1/projects/:projectId/query` | `documents:read` or Rules `list` | Execute structured query (`where`, `or`, `orderBy`, `limit`, `select`, `startAt`/`startAfter`, `include`). |
| `POST` | `/v1/projects/:projectId/batchWrite` | `documents:write` + Rules | Atomic multi-document batch (up to `100` operations, `5 MiB` cap, optional `Idempotency-Key` with 24 h durable replay). Also aliased at `/documents:batchWrite`. |
| `POST` | `/v1/projects/:projectId/transactions:begin` | `documents:read` | Begin an OCC transaction and issue an HMAC-SHA256 `transactionToken` (`15,000 ms` window). |
| `POST` | `/v1/projects/:projectId/transactions:commit` | `documents:write` + Rules | Lock transaction row + read-set (`ORDER BY path ASC FOR UPDATE`), verify versions, and commit atomically (`409 ABORTED_CONFLICT` / `ALREADY_COMMITTED` / `ALREADY_ROLLED_BACK`). |
| `POST` | `/v1/projects/:projectId/transactions:rollback` | `documents:write` | Body `{ "transactionToken" }`. Ends the transaction at once (`200 {"status":"rolled_back"}`); a later commit with that token fails with `ALREADY_ROLLED_BACK`. Optional: unused transactions still expire on their own. |

### 1.3 Collections & Composite Indexes

| Method | Endpoint | Auth / Scope | Description |
| :--- | :--- | :--- | :--- |
| `GET` / `POST` | `/v1/projects/:projectId/collections` | `documents:read` / `documents:write` | List or register project collections. |
| `GET` / `PATCH` / `DELETE` | `/v1/projects/:projectId/collections/:name` | `documents:read` / `documents:write` | Inspect, update metadata, or atomically delete a collection (`WITH deleted AS` CTE). |
| `POST` | `/v1/projects/:projectId/collections/:name/clear` | `documents:write` | Atomically clear active documents in a collection and purge derived index entries. |
| `POST` / `GET` | `/v1/projects/:projectId/collections/:name/import` · `/export` | `documents:write` / `documents:read` | Bulk collection import and export. |
| `GET` / `POST` | `/v1/projects/:projectId/indexes` | `indexes:manage` (`sk_` or console) | List or register a composite index (starts in `building`, backfills asynchronously to `ready`). |
| `DELETE` | `/v1/projects/:projectId/indexes/:indexId` | `indexes:manage` | Delete a composite index and cascade-delete its `document_index_entries`. |
| `GET` | `/v1/projects/:projectId/indexes/recommendations` | `indexes:manage` | List Smart Index Advisor recommendations (`apply` / `dismiss` via `POST .../recommendations/:id/{apply,dismiss}`). |

### 1.4 Three-Realm Auth, Console & Admin Surfaces

| Surface | Route Prefix | Auth Realm |
| :--- | :--- | :--- |
| End-User Auth | `/v1/projects/:projectId/auth/*` | `project_end_user` (Ed25519 JWTs, per-project keys) |
| Customer Console & Usage | `/v1/console/*`, `/v1/auth/*`, `/v1/orgs/*` | `customer_console` (HS256 session + HttpOnly refresh cookie + CSRF check) |
| Super-Admin & Fortress | `/v1/admin/*`, `/v1/admin/security/*`, `/v1/admin/billing/*` | `super_admin` (`CONSOLE_JWT_SECRET` != `SUPER_ADMIN_JWT_SECRET`, `isPlatformSuperAdmin === true`) |

---

## 2. Atomic Field Transforms (`$op`)

Inside `PUT` (`merge: true`), `PATCH`, `batchWrite`, and `transactions:commit`, field values may contain transform sentinels:

| Sentinel | Behavior |
| :--- | :--- |
| `{"$op": "serverTimestamp"}` | Replaced with the transaction's UTC timestamp `{"$t": "ts", "$v": "...", "$ms": ...}`. |
| `{"$op": "inc", "by": 5}` | Adds `by` to an existing finite number (initializes to `by` if missing; throws `412 FAILED_PRECONDITION` if existing value is non-numeric). |
| `{"$op": "arrayUnion", "elements": [...]}` | Appends elements not already present using deep wire-value equality. |
| `{"$op": "arrayRemove", "elements": [...]}` | Removes all occurrences matching any element in `elements`. |
| `{"$op": "deleteField"}` | Removes the property from its parent map. |

---

## 3. Native RFC 6455 Realtime WebSocket Protocol (`/v1/realtime`)

VELLUM implements a hardened, zero-dependency RFC 6455 WebSocket server (`apps/api/src/ws-rfc6455.ts`) coupled to `RealtimeGatewayHub` (`packages/realtime/src/hub.ts`) and backed by **PostgreSQL `LISTEN/NOTIFY` + `OutboxPoller`** (`packages/realtime/src/pg-realtime.ts`)—no Redis or external message broker.

### 3.1 Connection & Transport Hardening Limits

| Protection | Enforced Limit | Source / Behavior |
| :--- | :--- | :--- |
| **Origin Allowlist** | Exact match against `CORS_ALLOWED_ORIGINS` | Browser upgrades with disallowed/wildcard/`null` origins receive `403 Forbidden`; native clients without `Origin` are permitted. |
| **Connection Caps** | `10,000` global · `50` per IP · `1,000` per tenant | Excess connections rejected with `503` (global) or `429` (per IP). |
| **Frame Size Cap** | `65,536` bytes (`64 KiB`) · `125` bytes control frames | Enforced **before** buffer allocation; violation closes with `1008 Policy Violation`. |
| **Auth Timeout** | `5,000 ms` (`DEFAULT_AUTH_TIMEOUT_MS`) | Unauthenticated sockets are closed if no valid `auth` frame arrives in 5 s. |
| **Heartbeat & Idle** | `30,000 ms` ping/pong + `30,000 ms` idle timeout | Automatically cleans up dead/half-open sockets. |
| **Inbound Rate Limit** | `60` messages/minute/socket (rolling 60 s window) | Violation closes with `1008 Policy Violation` and records a `ws_flood` threat event. |
| **Subscriptions / Conn** | `25` (`MAX_WS_SUBSCRIPTIONS_PER_CONN`) | Excess subscribe frames receive `SUBSCRIPTION_LIMIT_EXCEEDED`. |
| **Outbound Backpressure** | `1 MiB` (`MAX_WS_OUTBOUND_BUFFER_BYTES`) | Uses real `socket.writableLength`; slow consumers receive `SLOW_CONSUMER_DISCONNECT` and disconnect. |
| **Replay & Memory Caps** | `5,000` replay events · `10,000` pending live · `50,000` matched paths · `10,000` seen seq IDs | Prevents replay/memory exhaustion; mid-replay live events buffer and flush in strict ascending `seqId` order. |
| **Graceful Shutdown** | RFC 6455 `1001 Going Away` | Sent to all active clients during `SIGTERM`/`SIGINT` drain. |

### 3.2 Wire Protocol Sequence

```mermaid
sequenceDiagram
    participant C as Client (SDK / WS)
    participant WS as ws-rfc6455 + RealtimeGatewayHub
    participant PG as PostgreSQL (data_db + LISTEN/NOTIFY)

    C->>WS: HTTP Upgrade GET /v1/realtime (Sec-WebSocket-Version: 13)
    WS-->>C: 101 Switching Protocols
    C->>WS: { "type": "auth", "projectId": "...", "apiKey": "pk_...", "authToken?": "<Ed25519 JWT>" }
    Note right of WS: Verifies API key (timingSafeEqual) & EdDSA JWT<br/>Clears prior subs on re-auth; indexes O(tenant)
    WS-->>C: { "type": "auth_ack", "status": "authenticated", "connectionId": "conn_..." }

    C->>WS: { "type": "subscribe", "subId": "sub_1", "query": {...}, "resumeSeqId?": 1042 }
    Note right of WS: Authorizes get/list via active Security Ruleset
    alt Fresh Subscription (no resumeSeqId)
        WS->>PG: Tenant-scoped snapshot read
        WS-->>C: { "type": "initial_sync", "subId": "sub_1", "seqId": 1050, "documents": [...] }
    else Resumed Subscription (resumeSeqId provided)
        WS->>PG: queryOutboxSince(projectId, resumeSeqId) in 500-row batches (cap 5,000)
        WS-->>C: { "type": "mutation", "subId": "sub_1", "seqId": 1043, "operation": "update", "document": {...} }
        WS-->>C: { "type": "resume_complete", "subId": "sub_1", "seqId": "1050", "count": 8, "truncated": false }
    end

    PG-->>WS: NOTIFY vellum_outbox_events (fallback: 1,000 ms OutboxPoller + gap catch-up)
    Note right of WS: Re-checks JWT exp, API key revocation, & live Security Ruleset<br/>O(tenant_connections) fan-out with structuredClone isolation
    WS-->>C: { "type": "mutation", "subId": "sub_1", "seqId": 1051, "operation": "create|update|delete", "document": {...} }

    C->>WS: { "type": "ping", "ts": 1732145600000 }
    WS-->>C: { "type": "pong", "ts": 1732145600000, "serverTs": 1732145600004 }
```

### 3.3 Client & Server Frame Reference

| Direction | Frame `type` | Key Fields |
| :--- | :--- | :--- |
| Client → Server | `auth` | `projectId`, `apiKey`, optional `authToken` (Ed25519 JWT only; no HS256 fallback) |
| Client → Server | `subscribe` | `subId`, `path` **or** `query`, optional `resumeSeqId` (non-negative safe integer) |
| Client → Server | `unsubscribe` | `subId` |
| Client → Server | `ping` | `ts` |
| Server → Client | `auth_ack` | `status: "authenticated"`, `connectionId` |
| Server → Client | `initial_sync` | `subId`, `seqId`, `documents[]` |
| Server → Client | `resume_complete` | `subId`, `seqId`, `count`, `truncated` |
| Server → Client | `mutation` | `subId`, `seqId`, `operation: "create" \| "update" \| "delete"`, `document` |
| Server → Client | `pong` | `ts`, `serverTs` |
| Server → Client | `error` | optional `subId`, `code` (`ErrorCode`), `message` |

### 3.4 Exactly-Once Delivery & Security Guarantees on Fan-Out
- **`O(tenant_connections)` Indexing:** `RealtimeGatewayHub` indexes sessions in `connectionsByProject` so a write in Project A never iterates over sockets belonging to Project B.
- **Continuous Credential & Rules Enforcement:** Before delivering any live event, the hub verifies that neither the session's API key nor its Ed25519 JWT has expired or been revoked, and re-evaluates the project's **live active security ruleset** so policy revocations take effect immediately without waiting for disconnect.
- **Gap Detection & Deduplication:** `notifyCommittedEvents` tracks per-project sequence watermarks; if `incomingSeq > prevSeq + 1`, it queries `realtime_outbox` to recover missed rows before advancing. Each subscription tracks `seenSeqIds` (pruned at `10,000`) so overlapping `NOTIFY`, poller, and replay streams never emit duplicate mutations.

---

## Related Guides

- [07 — End-User Authentication & the Three Realms](./07-end-user-auth.md)
- [08 — JavaScript / TypeScript SDK Guide](./08-sdk-js-guide.md)
- [09 — Flutter / Dart SDK Guide](./09-sdk-flutter-guide.md)
- [15 — Security, Threat Detection & Defense in Depth](./15-security-and-defense.md)
