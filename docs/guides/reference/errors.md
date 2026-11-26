---
title: Canonical Error Codes & Retry Guidance
order: 5
group: Reference
description: Every canonical VELLUM error code, its HTTP status, when it occurs and whether it is safe to retry.
---

# Canonical Error Codes & Retry Guidance

All errors use one envelope. `VellumError.toEnvelope(requestId)` and the HTTP error middleware (`apps/api/src/middleware/error-handler.ts`) produce:

```json
{
  "error": {
    "code": "FAILED_PRECONDITION",
    "message": "Version conflict on users/u_123",
    "requestId": "req_...",
    "details": { "path": "users/u_123" }
  }
}
```

`details` is optional (omitted when empty). `requestId` echoes `X-Request-Id` (or `req_unknown`). Source of truth: `packages/core/src/errors.ts` (`ERROR_HTTP_STATUS`, `VellumError`), `packages/api-contract/src/schemas/errors.ts` (`ErrorCodeEnum`), AGENTS.md §4.

## Errors raised by the SDK itself

When the request never reaches the server (device offline, DNS failure, connection refused), the SDKs throw an error with `code: "NETWORK_ERROR"` and `status: 0` instead of the platform's raw error (`TypeError: Failed to fetch` in browsers). `details.reason` carries the original message. Idempotent requests are retried first; the error is thrown when the retries run out. A request that times out keeps `REQUEST_TIMEOUT`. Check for it to show an "offline" state and retry later:

```ts
try { await db.doc("posts/a").set({ title: "x" }); }
catch (e) { if ((e as { code?: string }).code === "NETWORK_ERROR") showOfflineBanner(); else throw e; }
```

In a browser the realtime connection also follows the window `offline` and `online` events: `db.connectionState` becomes `reconnecting` right away when the network drops and reconnects as soon as it returns.

## Status mapping (authoritative)

| Code | HTTP | Typical trigger | Retry? |
| :--- | :--- | :--- | :--- |
| `INVALID_DOCUMENT_PATH` | 400 | Bad path grammar (parity, empty/relative/reserved segments, >1,500-byte segment) | **No** |
| `INVALID_FIELD_NAME` | 400 | Empty / >256-char / control-character field key | **No** |
| `MAX_NESTING_EXCEEDED` | 400 | Document data nested deeper than 20 levels | **No** |
| `BATCH_SIZE_EXCEEDED` | 400 | Batch/transaction has >100 operations | **No** — split the batch |
| `INVALID_CURSOR` | 400 | Malformed, tampered or expired HMAC cursor | **No** — restart pagination from the beginning |
| `QUERY_TOO_COMPLEX` | 400 | >10 `where`, >3 `orderBy`, or >30 disjunctive values | **No** — simplify or add an index |
| `LIMIT_EXCEEDED` | 400 | `limit` >500 (a `limit` below 1 or not a whole number is `INVALID_ARGUMENT`) | **No** |
| `SUBSCRIPTION_LIMIT_EXCEEDED` | 400 | >25 subscriptions on one WebSocket connection | **No** — unsubscribe or open another connection |
| `UNAUTHENTICATED` | 401 | Missing/invalid API key, missing/invalid/expired JWT, MFA code wrong, WS auth timeout | **No** — refresh credentials, then retry once |
| `PERMISSION_DENIED` | 403 | Key/project mismatch, rules denial, cross-tenant access, suspended project/account | **No** — authorization will not change on retry |
| `NOT_FOUND` | 404 | Document, API key, tenant, feature flag or route missing | **No** |
| `TRANSACTION_TIMEOUT` | 408 | OCC window (5,000 ms) elapsed before commit | **Yes** — restart transaction with a fresh token |
| `ALREADY_EXISTS` | 409 | Duplicate sign-up / setup-owner / MFA enrollment, or document create when present | **No** — use `set`/`put` instead |
| `ABORTED_CONFLICT` | 409 | OCC read-set version mismatch at commit | **Yes** — retry whole transaction with full-jitter backoff (SDKs do this automatically, default 5 attempts) |
| `FAILED_PRECONDITION` | 412 | `ifVersion` mismatch, non-numeric `inc` target, MFA setup/verify state error | **No** (unless re-reading state first) |
| `DOCUMENT_TOO_LARGE` | 413 | Serialized document >1 MiB | **No** |
| `PAYLOAD_TOO_LARGE` | 413 | Batch payload >5 MiB or oversized WS frame | **No** — split the payload |
| `RESPONSE_TOO_LARGE` | 413 | Query response >4 MiB | **No** — reduce `limit`/`select` |
| `RATE_LIMITED` | 429 | Per-key RPS limit, throttled project, or MFA attempt throttle | **Yes** — after `Retry-After`/backoff; never tight-loop |
| `QUOTA_EXCEEDED` | 429 | Plan/tenant quota exhausted | **No** until quota is raised or usage resets |
| `SLOW_CONSUMER_DISCONNECT` | 429 | WebSocket outbound buffer >1 MiB | **No** — consumer must drain faster; connection is closed |
| `INTERNAL_ERROR` | 500 | Server-side invariant/integrity failure (e.g. MFA secret integrity) | **Retry once** with backoff; if persistent, report with `requestId` |
| `SERVICE_UNAVAILABLE` | 503 | Dependency/probe failure (e.g. readiness probe failed) | **Yes** — after backoff, with a deadline |
| `QUERY_DEADLINE_EXCEEDED` | 504 | Query exceeded `MAX_QUERY_EXECUTION_MS` (5,000 ms) | **Yes** — narrow the query / add an index |

## Codes present in `ErrorCodeEnum` without a core status mapping

The Zod `ErrorCodeEnum` (api-contract) additionally declares `ABORTED`, `RESOURCE_EXHAUSTED`, `DEADLINE_EXCEEDED`, `UNAVAILABLE`, and `INTERNAL`. These are **not** keys of `ERROR_HTTP_STATUS` in `@vellum/core` and are not constructible as `VellumError` codes. If one reaches the HTTP error middleware it falls through the `?? 500` branch (status 500); an uncaught generic error is serialized as `code:"INTERNAL"`, status 500. Prefer the mapped equivalents above (`ABORTED_CONFLICT`, `RATE_LIMITED`/`QUOTA_EXCEEDED`, `QUERY_DEADLINE_EXCEEDED`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`) in new code.

:::note `INTERNAL` vs `INTERNAL_ERROR`
Both can appear on the wire with status 500. `INTERNAL_ERROR` is the canonical `VellumError` code (has an explicit 500 mapping); `INTERNAL` is the fallback envelope code for unexpected exceptions. Treat both as "server fault, retry sparingly and include the `requestId` in any report."
:::

## Quota → error mapping

| Limit | Value | Error / status |
| :--- | :--- | :--- |
| Document bytes | 1 MiB | `DOCUMENT_TOO_LARGE` / 413 |
| Path depth | 10 segments | `INVALID_DOCUMENT_PATH` / 400 |
| Path segment bytes | 1,500 | `INVALID_DOCUMENT_PATH` / 400 |
| Object nesting | 20 | `MAX_NESTING_EXCEEDED` / 400 |
| Field name length | 256 | `INVALID_FIELD_NAME` / 400 |
| Batch operations | 100 | `BATCH_SIZE_EXCEEDED` / 400 |
| Batch payload | 5 MiB | `PAYLOAD_TOO_LARGE` / 413 |
| Transaction duration | 5,000 ms | `TRANSACTION_TIMEOUT` / 408 |
| Where clauses | 10 | `QUERY_TOO_COMPLEX` / 400 |
| Disjunctive values | 30 | `QUERY_TOO_COMPLEX` / 400 |
| Order-by fields | 3 | `QUERY_TOO_COMPLEX` / 400 |
| Query limit | 500 (default 50) | `LIMIT_EXCEEDED` / 400 |
| Query response | 4 MiB | `RESPONSE_TOO_LARGE` / 413 |
| WS subscriptions/connection | 25 | `SUBSCRIPTION_LIMIT_EXCEEDED` / 400 |
| WS outbound buffer | 1 MiB | `SLOW_CONSUMER_DISCONNECT` / 429 |

## Retry policy at a glance

| Safe to retry (with backoff) | Retry only after changing something | Never retry blindly |
| :--- | :--- | :--- |
| `TRANSACTION_TIMEOUT`, `ABORTED_CONFLICT`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `QUERY_DEADLINE_EXCEEDED`, `INTERNAL_ERROR` (once) | `UNAUTHENTICATED` (refresh token), `FAILED_PRECONDITION` (re-read state), `QUOTA_EXCEEDED` (wait for reset) | 4xx validation/authz errors: `INVALID_ARGUMENT`, `INVALID_DOCUMENT_PATH`, `INVALID_FIELD_NAME`, `MAX_NESTING_EXCEEDED`, `BATCH_SIZE_EXCEEDED`, `INVALID_CURSOR`, `QUERY_TOO_COMPLEX`, `LIMIT_EXCEEDED`, `PERMISSION_DENIED`, `NOT_FOUND`, `ALREADY_EXISTS`, `DOCUMENT_TOO_LARGE`, `PAYLOAD_TOO_LARGE`, `RESPONSE_TOO_LARGE`, `SLOW_CONSUMER_DISCONNECT` |

Full-jitter backoff used by both SDKs for reconnects and OCC retries: `sleep = random(0, min(tMax, t0 · 2^attempt))` with `t0 = 500 ms`, `tMax = 30,000 ms` (`computeReconnectBackoffMs` / `computeReconnectBackoffMs`). OCC commit retry uses `t0 = 25 ms`, `tMax = 500 ms` in the JS SDK.

## Quick cross-reference

- Endpoint-specific error tables: [REST Data Plane](./rest-data-plane.md)
- WebSocket error frames: [Realtime Protocol](./realtime-protocol.md)
- Limit constants and tagged-value validation: [Wire Format](./wire-format.md)
