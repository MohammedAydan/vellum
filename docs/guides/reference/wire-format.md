---
title: Tagged Wire Format & Path Grammar
order: 4
group: Reference
description: Canonical $t/$v tagged types, $op field transforms, path grammar and the locked v1 size/depth limits.
---

# Tagged Wire Format & Path Grammar

Source of truth: `packages/core/src/{wire-format,paths,limits,sort-key}.ts`, `packages/api-contract/src/schemas/documents.ts`, and `docs/02-wire-format-and-paths.md`. This is the authoritative compact reference; for design rationale see [Canonical Paths & Tagged Wire Format](../../02-wire-format-and-paths.md).

## Why tags

JSON has no native int64, timestamp, byte, reference or geopoint type. VELLUM uses a reserved wrapper `{"$t": "<tag>", "$v": <value>}` so extended types never collide with user maps. Primitives (`null`, boolean, string, finite number, array, plain map) are stored **untagged** so PostgreSQL `jsonb` GIN indexes can address them directly. TypeScript constructors live in `WireValue` (`@vellum/core`); the Dart SDK exposes `VellumWire`.

## Canonical tagged types

| Logical type | `$t` | `$v` | Validation |
| :--- | :--- | :--- | :--- |
| int64 | `"int"` | decimal string, e.g. `"-9007199254740993"` | Must match `/^-?\d+$/` and lie in `[-2^63, 2^63−1]` |
| timestamp | `"ts"` | ISO-8601 UTC string, e.g. `"2026-11-15T14:30:00.123Z"` | `Date.parse` must succeed. Optional `$ms` (finite epoch ms). On write, `$ms` is always added/normalized via `new Date(ms).toISOString()`. |
| reference | `"ref"` | document path string, e.g. `"users/u_123"` | Must pass `parseDocumentPath` |
| bytes | `"bytes"` | standard Base64 string, e.g. `"SGVsbG8="` | Must match RFC 4648 Base64 regex |
| geopoint | `"geo"` | `{ "lat": 30.0444, "lng": 31.2357 }` | Finite `lat ∈ [−90,90]`, `lng ∈ [−180,180]` |
| escaped user map | `"map"` | plain object | Automatic when a user object literally contains key `$t`; wraps it as `{"$t":"map","$v":{...}}` |

Examples:

```json
{ "big": { "$t": "int", "$v": "9007199254740993" } }
{ "when": { "$t": "ts", "$v": "2026-11-15T14:30:00.123Z", "$ms": 1794753000123 } }
{ "owner": { "$t": "ref", "$v": "users/u_123" } }
{ "blob": { "$t": "bytes", "$v": "SGVsbG8=" } }
{ "loc": { "$t": "geo", "$v": { "lat": 30.0444, "lng": 31.2357 } } }
{ "$t": "user_custom" }  →  { "$t": "map", "$v": { "$t": "user_custom" } }
```

:::note Legacy aliases accepted on input
`@vellum/api-contract` normalizes pre-v1 aliases before validation: `$t: "time"` → `$t: "ts"`, and geopoint `$v.latitude` / `$v.longitude` → `$v.lat` / `$v.lng`. Validated and returned documents always use the canonical form.
:::

### Validation & normalization

- `validateWireValue(value, depth, allowFieldOps)` recurses through every value. Non-finite numbers (`NaN`, `Infinity`) → `INVALID_ARGUMENT`.
- Any object containing `$t` is treated as a tagged wrapper; unknown tags → `INVALID_ARGUMENT`. Any object containing `$op` is treated as a field transform; `allowFieldOps:false` → `INVALID_ARGUMENT`.
- Plain map keys are validated with `validateFieldName`: non-empty, ≤256 chars, no control chars → `INVALID_FIELD_NAME`.
- `canonicalizeTimestamps` ensures every `ts` value carries a consistent `$v`/`$ms` pair.
- `normalizeAndValidateDocumentData` enforces top-level data must be a plain map (no `$t`/`$op` at root), validates depth, then measures `Buffer.byteLength(JSON.stringify(normalized))` against the 1 MiB cap → `DOCUMENT_TOO_LARGE`.

## Atomic field transforms (`$op`)

Accepted only where the engine opts in — `PATCH`, `PUT` with `merge:true`, `batchWrite` and `transactions:commit`. A bare `POST` create rejects them.

| `$op` | Parameters | Effect | Error on bad input |
| :--- | :--- | :--- | :--- |
| `serverTimestamp` | — | Replaced with the current server transaction timestamp (`$t:"ts"`) | — |
| `inc` (alias `increment`) | `by` (or `value`), finite number | Adds to existing finite number; initializes to `by` if missing | `INVALID_ARGUMENT`; `FAILED_PRECONDITION` (412) if existing field is non-numeric |
| `arrayUnion` | `elements: any[]` | Appends elements not already present (deep wire-value equality) | `INVALID_ARGUMENT` if `elements` missing |
| `arrayRemove` | `elements: any[]` | Removes all occurrences matching any element | `INVALID_ARGUMENT` if `elements` missing |
| `deleteField` | — | Removes the target property from its parent map | — |

Client helpers: JS `fieldOp` (`@vellumdb/sdk-js`) and Dart `FieldOp` / `FieldValue` (`vellum_flutter`). The Zod schema (`TaggedFieldTransformSchema`) uses `$v` for the payload (`increment`/`arrayUnion`/`arrayRemove`) while the core validator accepts `by`/`value` and `elements`; the wire examples above follow the core validator used by the engine.

## Path grammar

| Rule | Document path | Collection path |
| :--- | :--- | :--- |
| Segment count | Even: 2, 4, 6, 8 or 10 | Odd: 1, 3, 5, 7 or 9 |
| Depth meaning | Up to 5 nested collections | Up to 5 collection levels |
| Start/end | No leading or trailing `/` | No leading or trailing `/` |
| Empty segments | Rejected | Rejected |
| Relative/reserved | `.`, `..`, `%2e%2e`, `%2f` rejected | Same |
| System-reserved | Any segment matching `^__.*__$` rejected | Same |
| Control chars | `0x00`–`0x1F` rejected | Same |
| Segment size | ≤1,500 UTF-8 bytes | ≤1,500 UTF-8 bytes |

Error for all violations: `400 INVALID_DOCUMENT_PATH`.

**Deterministic decomposition** — `users/u_123/orders/ord_456`:

| Property | Value |
| :--- | :--- |
| `path` | `users/u_123/orders/ord_456` |
| `collectionPath` | `users/u_123/orders` |
| `collectionGroup` | `orders` |
| `documentId` | `ord_456` |
| `pathDepth` | `4` |

## Locked v1 limits

From `SYSTEM_LIMITS` (`@vellum/core`).

| Constant | Value | breach code / status |
| :--- | :--- | :--- |
| `MAX_DOCUMENT_BYTES` | 1,048,576 (1 MiB) | `DOCUMENT_TOO_LARGE` / 413 |
| `MAX_PATH_DEPTH` | 10 segments | `INVALID_DOCUMENT_PATH` / 400 |
| `MAX_PATH_SEGMENT_BYTES` | 1,500 | `INVALID_DOCUMENT_PATH` / 400 |
| `MAX_OBJECT_NESTING_DEPTH` | 20 | `MAX_NESTING_EXCEEDED` / 400 |
| `MAX_FIELD_NAME_LENGTH` | 256 | `INVALID_FIELD_NAME` / 400 |
| `MAX_BATCH_OPERATIONS` | 100 | `BATCH_SIZE_EXCEEDED` / 400 |
| `MAX_BATCH_PAYLOAD_BYTES` | 5,242,880 (5 MiB) | `PAYLOAD_TOO_LARGE` / 413 |
| `MAX_TRANSACTION_DURATION_MS` | 5,000 | `TRANSACTION_TIMEOUT` / 408 |
| `MAX_WHERE_CLAUSES` | 10 | `QUERY_TOO_COMPLEX` / 400 |
| `MAX_DISJUNCTIVE_VALUES` | 30 | `QUERY_TOO_COMPLEX` / 400 |
| `MAX_ORDER_BY_FIELDS` | 3 | `QUERY_TOO_COMPLEX` / 400 |
| `DEFAULT_QUERY_LIMIT` / `MAX_QUERY_LIMIT` | 50 / 500 | `LIMIT_EXCEEDED` / 400 |
| `MAX_QUERY_RESPONSE_BYTES` | 4,194,304 (4 MiB) | `RESPONSE_TOO_LARGE` / 413 |
| `MAX_QUERY_EXECUTION_MS` | 5,000 | `QUERY_DEADLINE_EXCEEDED` / 504 |
| `MAX_WS_SUBSCRIPTIONS_PER_CONN` | 50 | `SUBSCRIPTION_LIMIT_EXCEEDED` / 400 |
| `MAX_WS_OUTBOUND_BUFFER_BYTES` | 1,048,576 (1 MiB) | `SLOW_CONSUMER_DISCONNECT` / 429 |
| `RULES_AST_MAX_DEPTH` / `RULES_AST_MAX_NODES` | 10 / 100 | `INVALID_ARGUMENT` / 400 |
| `MAX_COMPOSITE_INDEXES_FREE` / `_PRO` | 50 / 200 | plan enforcement |

## Binary sort keys (internal)

Tenant-defined composite indexes never issue `CREATE INDEX`. `@vellum/core` encodes each field into an order-preserving `sort_key BYTEA` with type tags (`MISSING 0x05`, `NULL 0x0a`, `BOOLEAN 0x10`, `NUMBER 0x20`, `STRING 0x30`, `TIMESTAMP 0x40`, `REFERENCE 0x50`, `BYTES 0x60`, `GEOPOINT 0x70`). Floats and int64s use sign-flipped big-endian encodings so byte order matches numeric order.

## Quick cross-reference

- HTTP usage: [REST Data Plane](./rest-data-plane.md)
- Frames carrying `DocumentPayload`: [Realtime Protocol](./realtime-protocol.md)
- Canonical error statuses: [Errors](./errors.md)
- Dart wire helpers: [Flutter SDK](../sdks/flutter.md)
