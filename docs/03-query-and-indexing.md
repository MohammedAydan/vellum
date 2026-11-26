# 03 — Query Compiler, Order-Preserving Sort Keys & Cursor Pagination

> **Scope:** Authoritative reference for the `@vellum/query-engine` SQL compiler, composite index matcher, binary sort-key encoding, and HMAC-SHA256 cursor pagination.  
> **Grounded in:** `packages/query-engine/src/compiler.ts`, `packages/query-engine/src/cursor.ts`, `packages/core/src/limits.ts`, `packages/core/src/sort-key.ts`.

Every query in VELLUM compiles to 100% parameterized SQL executed inside the tenant's RLS-enforced PostgreSQL transaction (`statement_timeout = 5000ms`). No operator ever silently degrades to `TRUE`, and no PostgreSQL query path loads an entire collection into Node.js memory.

---

## 1. Query Structure & Enforced Limits

Queries target a single `collectionPath` within a `projectId` namespace and support base `where` filters, disjunctive `or` groups (each group ANDed internally, groups ORed together), `orderBy`, field projection (`select`), bounded `limit`, and opaque keyset cursors (`startAt` or `startAfter`—mutually exclusive).

### 1.1 Compiler & System Limits

| Constant | Value | Source | Behavior on Breach |
| :--- | --: | :--- | :--- |
| `SYSTEM_LIMITS.MAX_WHERE_CLAUSES` | `10` | `packages/core/src/limits.ts` | `400 QUERY_TOO_COMPLEX` (also caps `or` group count) |
| `SYSTEM_LIMITS.MAX_DISJUNCTIVE_VALUES` | `30` | `packages/core/src/limits.ts` | `400 QUERY_TOO_COMPLEX` (`in`, `not-in`, `array-contains-any`) |
| `MAX_TOTAL_DISJUNCTIVE_EXPANSIONS` | `120` | `packages/query-engine/src/compiler.ts` | `400 QUERY_TOO_COMPLEX` (cumulative `array-contains-any` branches) |
| `SYSTEM_LIMITS.MAX_ORDER_BY_FIELDS` | `3` | `packages/core/src/limits.ts` | `400 QUERY_TOO_COMPLEX` (`documentId ASC` appended if absent) |
| `SYSTEM_LIMITS.DEFAULT_QUERY_LIMIT` | `50` | `packages/core/src/limits.ts` | Applied when `limit` is omitted |
| `SYSTEM_LIMITS.MAX_QUERY_LIMIT` | `500` | `packages/core/src/limits.ts` | `400 LIMIT_EXCEEDED` |
| `MAX_SELECT_FIELDS` | `50` | `packages/query-engine/src/compiler.ts` | `400 QUERY_TOO_COMPLEX` (matches PG's 100-arg `jsonb_build_object` cap) |
| `MAX_FIELD_DEPTH` | `16` | `packages/query-engine/src/compiler.ts` | `400 QUERY_TOO_COMPLEX` (dot-path nesting cap) |
| `MAX_TEXT_FILTER_LENGTH` | `1,024` chars | `packages/query-engine/src/compiler.ts` | `400 QUERY_TOO_COMPLEX` (`contains_ci`, `starts_with_ci`, `text_search`) |
| `MAX_CURSOR_TOKEN_BYTES` | `16,384` bytes | `packages/query-engine/src/cursor.ts` | `400 INVALID_CURSOR` (enforced before base64url decode) |
| `UNINDEXED_SCAN_CAP` | `1,000` rows | `packages/query-engine/src/compiler.ts` | Safety ceiling for unindexed fallback scans (never silently truncates) |
| `VELLUM_UNINDEXED_QUERY_MAX_DOCS` | `50,000` documents (env; `0` disables) | `packages/query-engine/src/compiler.ts` | A query no index can serve (range, `!=`, `not-in`, text filters, `search`, or an order on a non-system field) is refused with `FAILED_PRECONDITION` and a `suggestedIndex` when its collection has more live documents than this. Below the limit it runs as before. `UNINDEXED_SCAN_CAP` only limits returned rows; it never limited how many rows the database read. |
| `SYSTEM_LIMITS.MAX_QUERY_EXECUTION_MS` | `5,000` ms | `packages/core/src/limits.ts` | Transaction-local `statement_timeout` |

All field paths reject prototype-pollution segments (`__proto__`, `constructor`, `prototype`), empty segments, and invalid field names. Every live query automatically injects `d.deleted_at IS NULL AND (d.expires_at IS NULL OR d.expires_at > now())` so soft-deleted and TTL-expired rows are never returned.

---

## 2. All 13 Supported Query Operators

`compileWhereClause()` in `packages/query-engine/src/compiler.ts` is the single compiler shared by `/query`, native aggregations, and `compileDeleteSelectQuery` (bulk deletes).

| # | Operator | Operand Type | PostgreSQL Compilation & Index Path |
| :-: | :--- | :--- | :--- |
| 1 | `==` | Primitive, object, array, tagged `ts`/`int`, `null` | **System fields:** native `d.created_at = $n::timestamptz` or `d.document_id = $n::text` (B-Tree). **Primitives:** `d.data @> $n::jsonb` (GIN `jsonb_path_ops`). **Objects/Arrays:** `d.data @> $n::jsonb AND (d.data #> $path) = $exact::jsonb` (GIN pre-filter + exact structural equality so `{a:1}` never matches `{a:1,b:2}`). |
| 2 | `!=` | Primitive, object, array, tagged `ts`/`int`, `null` | Field must exist (`IS NOT NULL`). Uses `<>` on native system columns/objects, or `NOT (d.data @> $n::jsonb)` for primitives. |
| 3 | `<` | Finite `number`, `string`, tagged `int`, tagged `ts` | Native `d.created_at < $n::timestamptz` / `d.document_id COLLATE "C" < $n::text`. For JSONB fields: strict `jsonb_typeof` or `$t` discriminator guard so cross-type ordering is impossible. |
| 4 | `<=` | Finite `number`, `string`, tagged `int`, tagged `ts` | Same type-guarded compilation as `<`. |
| 5 | `>` | Finite `number`, `string`, tagged `int`, tagged `ts` | Same type-guarded compilation as `<`. |
| 6 | `>=` | Finite `number`, `string`, tagged `int`, tagged `ts` | Same type-guarded compilation as `<`. |
| 7 | `in` | Non-empty array (`1..30` deduplicated values) | Native `= ANY($n::timestamptz[])` / `ANY($n::text[])` for system fields; `d.data @> ANY($n::jsonb[])` for primitives; `(d.data #> $path) = ANY($n::jsonb[])` for complex values. |
| 8 | `not-in` | Non-empty array (`1..30` deduplicated values) | Field must exist (`IS NOT NULL`) and `NOT (...)` of the `in` predicate. |
| 9 | `array-contains` | Any valid wire value | `d.data @> $n::jsonb` (wrapping target in a 1-element array) — accelerated by GIN `jsonb_path_ops`. |
| 10 | `array-contains-any` | Non-empty array (`1..30` deduplicated values) | Disjunction `(d.data @> $1::jsonb OR d.data @> $2::jsonb ...)` bounded by `MAX_TOTAL_DISJUNCTIVE_EXPANSIONS = 120`. |
| 11 | `contains_ci` | String (`<= 1,024` chars) | `jsonb_typeof(...) = 'string' AND (d.data #>> $path) ILIKE '%' || $escaped || '%' ESCAPE '\'` (`%`, `_`, `\` escaped before binding). |
| 12 | `starts_with_ci` | String (`<= 1,024` chars) | `jsonb_typeof(...) = 'string' AND (d.data #>> $path) ILIKE $escaped || '%' ESCAPE '\'`. |
| 13 | `text_search` | String (`<= 1,024` chars) | `to_tsvector('simple', coalesce(d.data::text, '')) @@ plainto_tsquery('simple', $n)`. |

### Disjunctive `or` Groups
Queries may combine top-level `where` clauses with an `or` array of clause groups. Each group is ANDed internally, groups are ORed together, and the resulting disjunction is ANDed with `where`:

```json
{
  "collectionPath": "orders",
  "where": [{ "field": "status", "op": "==", "value": "open" }],
  "or": [
    [{ "field": "priority", "op": ">=", "value": 8 }],
    [{ "field": "vip", "op": "==", "value": true }, { "field": "total", "op": ">", "value": 500 }]
  ],
  "orderBy": [{ "field": "createdAt", "dir": "desc" }],
  "limit": 25
}
```

---

## 3. Dual-Path Indexing & Commutative Composite Index Selection

### 3.1 Path A — Built-in Zero-Config Partial Indexes
Every collection automatically uses partial indexes on `documents WHERE deleted_at IS NULL`:
1. `idx_docs_collection_id_active`: `(project_id, collection_path, document_id ASC)`
2. `idx_docs_collection_updated_active`: `(project_id, collection_path, updated_at DESC, document_id ASC)`
3. `idx_docs_collection_created_active`: `(project_id, collection_path, created_at DESC, document_id ASC)`
4. `idx_docs_data_gin_active`: `USING GIN (data jsonb_path_ops)` for `@>` containment (`==`, `in`, `array-contains`)
5. `idx_docs_expires_at`: `(project_id, expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL`

### 3.2 Path B — Multi-Tenant Composite Indexes (`document_index_entries`)
To avoid per-tenant `CREATE INDEX` DDL locks and catalog bloat on the shared `documents` table, tenant-defined composite indexes store order-preserving binary sort keys (`sort_key BYTEA`) in `document_index_entries` with `PRIMARY KEY (index_id, sort_key, document_id)`:

| Type Prefix | Wire Type | Binary Encoding (`packages/core/src/sort-key.ts`) |
| :---: | :--- | :--- |
| `0x05` | Missing / `undefined` | Single tag byte |
| `0x0A` | `null` | Single tag byte |
| `0x10` | `boolean` | `0x00` (`false`) or `0x01` (`true`) |
| `0x20` | `number` / `int64` | IEEE-754 big-endian 64-bit float with sign-bit flip (`^ 0xFFFFFFFFFFFFFFFF` if negative, `^ 0x8000000000000000` if `>= 0`) |
| `0x30` | `string` | UTF-8 bytes (`0x00` escaped as `0x00 0xFF`), terminated by `0x00 0x00` |
| `0x40` | `timestamp` (`$t: "ts"`) | Big-endian signed 64-bit `$ms` with MSB sign-bit flip (`^ 0x8000000000000000`) |
| `0x50` | `reference` (`$t: "ref"`) | UTF-8 path bytes terminated by `0x00 0x00` |
| `0x60` | `bytes` (`$t: "bytes"`) | Raw bytes escaped + terminated by `0x00 0x00` |

For any field with `dir: "desc"`, every encoded byte in that segment is bitwise-inverted (`byte ^ 0xFF`). PostgreSQL compares `BYTEA` left-to-right, enabling a single B-Tree scan ordered by `ie.sort_key ASC, ie.document_id ASC`.

### 3.3 Commutative Cost-Ranked Composite Index Matcher
`selectCompositeIndexForQuery()` in `packages/query-engine/src/compiler.ts` selects the optimal `ready` composite index in three phases:

1. **Commutative Equality Prefix:** Leading `==` filter fields may appear in **any permutation** at the front of the index (if an equality field also appears in `orderBy`, its direction is enforced).
2. **Strict Ordered Suffix:** Remaining `orderBy` fields (or a single non-equality range field) must immediately follow the equality prefix in exact order and direction.
3. **Cost Ranking (Tightest Width Wins):** Among all qualifying indexes, the matcher picks the index with the fewest unused trailing fields (`extraFields = idx.fields.length - requiredCount`), short-circuiting immediately when `extraFields === 0`.

Index definition hashes (`computeIndexDefinitionHash`) and dot-path splits (`splitFieldPath`) are memoized in bounded LRU caches (`LRU_CACHE_LIMIT = 512`).

---

## 4. Row-Value Tuple Keyset Pagination & Signed Cursors

VELLUM does **not** expose SQL `OFFSET`. All pagination uses deterministic keyset cursors with `documentId` as the final tie-breaker.

### 4.1 Row-Value Tuple Predicates (`buildCursorPredicate`)
To unlock direct PostgreSQL B-Tree Index Scans and preserve exact tie-breaker semantics for both `startAt` (inclusive) and `startAfter` (exclusive):

- **Composite-indexed query:**
  ```sql
  -- startAfter uses '>', startAt uses '>='
  (ie.sort_key, ie.document_id) > ($k::bytea, $id)
  ```
- **Native system timestamp (`createdAt` / `updatedAt`) with matching tie-breaker direction:**
  ```sql
  -- Direct B-Tree tuple seek on idx_docs_collection_{created,updated}_active
  (d.created_at, d.document_id) < ($ts::timestamptz, $id)
  ```
- **Mixed sort directions** (e.g., `createdAt DESC, documentId ASC`): Uses a strict primary inequality paired with an explicit tie-breaker branch (`d.created_at < $ts OR (d.created_at = $ts AND d.document_id > $id)`) so `startAt` never leaks rows with equal timestamps and earlier tie-breaker IDs.

### 4.2 HMAC-SHA256 Signed Opaque Cursor Codec (`packages/query-engine/src/cursor.ts`)

```text
Cursor Token = base64url(JSON({ qHash, vals, docId, sortKey?, sig }))
  where:
    qHash = SHA-256(canonical({ projectId, collectionPath, where, orderBy, or }))
    sig   = HMAC-SHA256(CURSOR_HMAC_SECRET, JSON({ qHash, vals, docId, sortKey? }))
```

Security guarantees enforced by `decodeAndVerifyQueryCursor()`:
- **Pre-decode size cap:** Rejects tokens exceeding `MAX_CURSOR_TOKEN_BYTES = 16,384` bytes before base64url decoding or `JSON.parse`.
- **Constant-time verification:** Both `sig` (strictly 64 hex chars) and `qHash` are verified using `crypto.timingSafeEqual`.
- **Key rotation support:** Accepts `string | readonly string[]` secrets so cursors signed by a previous key remain valid during secret rotation.
- **Whitelisted reconstruction:** Rejects any unknown or prototype-polluting keys (`ALLOWED_CURSOR_KEYS = { qHash, vals, docId, sortKey, sig }`) and validates `sortKey` as even-length hex.
- **Query-shape binding:** Replaying a cursor against a different `projectId`, `collectionPath`, `where`, `or`, or `orderBy` fails immediately with `400 INVALID_CURSOR`.

---

## Related Guides

- [12 — Relationships & Advanced Queries (V2)](./12-relationships-and-advanced-queries.md)
- [14 — Smart Indexing & Performance](./14-smart-indexing-and-performance.md)
- [05 — Public HTTP REST API & Realtime WebSocket Wire Protocol](./05-http-and-realtime-api.md)
