---
title: Errors & Limits
order: 12
group: Reference
description: Canonical error codes with HTTP statuses, and the locked v1 quotas enforced by @vellum/core.
---

# Errors & Limits

All failures use one canonical envelope and one set of error codes, defined in `@vellum/core` (`SYSTEM_LIMITS` and `VellumError`). Every HTTP response also carries an `X-Request-Id` header.

## Scenario

You are wiring up client-side error handling and want retries only for transient failures: a version conflict should re-read and retry, a rate limit should back off using `Retry-After`, while a permissions error should surface to the user. You branch on the canonical `code` from the error envelope.

```ts
import { VellumError } from "@vellum/core";

try {
  await db.collection("users").doc("u_123").update({ name: "Ada" }, { ifVersion: 4 });
} catch (err) {
  const e = err as { code?: string; status?: number; details?: Record<string, unknown> };
  switch (e.code) {
    case "FAILED_PRECONDITION": // re-read and retry with the current version
      break;
    case "ABORTED_CONFLICT": // retry the whole transaction
      break;
    case "PERMISSION_DENIED": // check scopes or rules
      break;
    default:
      throw err;
  }
}
```

## Error envelope

```json
{
  "error": {
    "code": "FAILED_PRECONDITION",
    "message": "Version precondition failed on 'users/u_123' (expected 4, actual 5)",
    "requestId": "req_01JCK9X2P8...",
    "details": {
      "path": "users/u_123",
      "expectedVersion": 4,
      "actualVersion": 5
    }
  }
}
```

In the SDK, failed requests throw an `Error` with `code`, `status`, `details`, and `requestId` copied from the envelope. The `details` object is typed as a record and its keys vary by code; do not rely on a fixed shape.

## Canonical error codes

| Code | HTTP | Typical cause |
| :--- | :--- | :--- |
| `INVALID_ARGUMENT` | 400 | Malformed request, disallowed sentinel, bad config value. |
| `INVALID_DOCUMENT_PATH` | 400 | Bad path depth, over-long or reserved segment. |
| `INVALID_FIELD_NAME` | 400 | Empty, over-long, control-character, or prototype-pollution field name. |
| `MAX_NESTING_EXCEEDED` | 400 | Document nesting deeper than 20 levels. |
| `BATCH_SIZE_EXCEEDED` | 400 | More than 100 batch operations. |
| `INVALID_CURSOR` | 400 | Tampered, malformed, or wrong-shape pagination cursor. |
| `QUERY_TOO_COMPLEX` | 400 | Too many filters/order fields, or rules AST over depth/node bounds. |
| `LIMIT_EXCEEDED` | 400 | Query `limit` above 500. |
| `SUBSCRIPTION_LIMIT_EXCEEDED` | 400 | More than 25 WebSocket subscriptions on one connection. |
| `UNAUTHENTICATED` | 401 | Missing, malformed, invalid, expired, or revoked API key / token. |
| `PERMISSION_DENIED` | 403 | Missing server-key scope, or security rules denied the operation. |
| `NOT_FOUND` | 404 | Reading or deleting a document that does not exist. |
| `TRANSACTION_TIMEOUT` | 408 | Transaction exceeded 15 seconds. |
| `ALREADY_EXISTS` | 409 | `create` on an occupied path, or duplicate composite index. |
| `ABORTED_CONFLICT` | 409 | OCC read-set version changed before commit. |
| `FAILED_PRECONDITION` | 412 | `ifVersion` / `exists` mismatch, invalid increment target, or missing required index. |
| `DOCUMENT_TOO_LARGE` | 413 | Serialized document exceeds 1 MiB. |
| `PAYLOAD_TOO_LARGE` | 413 | Batch payload exceeds 5 MiB. |
| `RESPONSE_TOO_LARGE` | 413 | Query response exceeds 4 MiB. |
| `RATE_LIMITED` | 429 | Per-key RPS limit exceeded; `Retry-After` header is set. |
| `QUOTA_EXCEEDED` | 429 | Plan quota exceeded. |
| `SLOW_CONSUMER_DISCONNECT` | 429 | WebSocket outbound buffer exceeded 1 MiB. |
| `INTERNAL_ERROR` | 500 | Unexpected server failure. |
| `SERVICE_UNAVAILABLE` | 503 | Dependency or plane unavailable. |
| `QUERY_DEADLINE_EXCEEDED` | 504 | Query exceeded its 5-second execution budget. |

:::note
`ABORTED` and a few other  appear in the api-contract enum, but the runtime error hierarchy above is the authoritative set. Client code should branch on the codes in this table.
:::

```ts
// Rate limits carry a Retry-After hint; back off before retrying.
if (e.code === "RATE_LIMITED") {
  const retryAfterMs = Number((e.details as Record<string, unknown>)?.retryAfterMs ?? 1000);
  await new Promise((r) => setTimeout(r, retryAfterMs));
}
```

## Locked v1 quotas

These constants come from `@vellum/coreSYSTEM_LIMITS` and are enforced at the engine boundaries.

| Limit | Value | Exceeded error |
| :--- | :--- | :--- |
| `MAX_DOCUMENT_BYTES` | 1,048,576 (1 MiB) | `DOCUMENT_TOO_LARGE` (413) |
| `MAX_PATH_DEPTH` | 10 segments (5 nested collections) | `INVALID_DOCUMENT_PATH` (400) |
| `MAX_PATH_SEGMENT_BYTES` | 1,500 bytes | `INVALID_DOCUMENT_PATH` (400) |
| `MAX_OBJECT_NESTING_DEPTH` | 20 levels | `MAX_NESTING_EXCEEDED` (400) |
| `MAX_FIELD_NAME_LENGTH` | 256 characters | `INVALID_FIELD_NAME` (400) |
| `MAX_BATCH_OPERATIONS` | 100 operations | `BATCH_SIZE_EXCEEDED` (400) |
| `MAX_BATCH_PAYLOAD_BYTES` | 5,242,880 (5 MiB) | `PAYLOAD_TOO_LARGE` (413) |
| `MAX_TRANSACTION_DURATION_MS` | 15,000 ms | `TRANSACTION_TIMEOUT` (408) |
| `MAX_WHERE_CLAUSES` | 10 filters | `QUERY_TOO_COMPLEX` (400) |
| `MAX_DISJUNCTIVE_VALUES` | 30 elements | `QUERY_TOO_COMPLEX` (400) |
| `MAX_ORDER_BY_FIELDS` | 3 fields | `QUERY_TOO_COMPLEX` (400) |
| `DEFAULT_QUERY_LIMIT` | 50 | — |
| `MAX_QUERY_LIMIT` | 500 | `LIMIT_EXCEEDED` (400) |
| `MAX_QUERY_RESPONSE_BYTES` | 4,194,304 (4 MiB) | `RESPONSE_TOO_LARGE` (413) |
| `MAX_QUERY_EXECUTION_MS` | 5,000 ms | `QUERY_DEADLINE_EXCEEDED` (504) |
| `MAX_WS_SUBSCRIPTIONS_PER_CONN` | 25 | `SUBSCRIPTION_LIMIT_EXCEEDED` (400) |
| `MAX_WS_OUTBOUND_BUFFER_BYTES` | 1,048,576 (1 MiB) | `SLOW_CONSUMER_DISCONNECT` (429) |
| `RULES_AST_MAX_DEPTH` | 10 | `QUERY_TOO_COMPLEX` (400) |
| `RULES_AST_MAX_NODES` | 100 per rule | `QUERY_TOO_COMPLEX` (400) |
| Composite indexes per free / pro plan | 50 / 200 | `QUOTA_EXCEEDED` (429) |
| Tombstone retention | 7 days (default) | — |
| Outbox retention | 24 hours | — |

## Handling errors

The example at the top of this guide shows branching on `e.code`. In raw HTTP clients, read the `error.code` field from the JSON envelope and the `X-Request-Id` header.

:::tip
Always include `X-Request-Id` (or `error.requestId`) in bug reports. Logs are redacted, so the request id is the safe way to correlate an incident without sharing secrets.
:::

## Common pitfalls

- **Branching on HTTP status alone.** Multiple codes share a status (e.g. 400); branch on the canonical `code`.
- **Retrying every error.** Only transient codes such as `ABORTED_CONFLICT` and `RATE_LIMITED` are safe to retry; a permissions error will not fix itself.
- **Assuming a fixed `details` shape.** Its keys vary by code — treat it as a record.
- **Ignoring the request id.** Without it, support cannot correlate a redacted incident to your request.

## Verified example

:::example-tabs errors

## What to read next

- [Query](./query.md) — query-specific errors and index suggestions.
- [Batch & transactions](./batch-and-transactions.md) — conflict and timeout behavior.
- [Production checklist](./production-checklist.md) — rate limiting, redaction, and health probes.

## Throttled auth requests (429)

Sign-in and sign-up endpoints limit attempts per IP, for example 30 end-user sign-ups per IP per 15 minutes. A throttled request fails with `TOO_MANY_REQUESTS` and a `Retry-After` header. In the SDKs the error carries `retryAfter` (seconds): `err.retryAfter` in JavaScript and `VellumException.retryAfter` in Dart. Wait that long before retrying.

For load tests and end-to-end test runs on a server you control, set `AUTH_RATE_LIMIT_SCALE` to a number above 1 (for example `20`) to multiply every auth limit. It is off by default and capped at 1000. Never set it on a production deployment: it weakens brute-force protection.
