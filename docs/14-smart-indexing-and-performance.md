# 14 — Smart Indexing & Performance Architecture

> **Scope:** Authoritative engineering reference for the E→S→R Smart Index Advisor, commutative composite index selection, PostgreSQL query/storage optimizations, bounded in-process caching, and Zero-Redis performance design.  
> **Grounded in:** `packages/query-engine/src/compiler.ts`, `packages/storage/src/tx-context.ts`, `packages/storage/src/pg-adapter.ts`, `packages/storage/src/cache.ts`, `packages/database-data/migrations/0007_performance_and_ttl.sql`, `0008_drop_redundant_gin.sql`, `0010_engine_hardening.sql`.

VELLUM combines proactive **E→S→R index guidance** with PostgreSQL-native execution optimizations so multi-tenant queries run on single B-Tree or GIN scans without requiring per-tenant DDL or external Redis clusters.

---

## 1. The E→S→R Smart Index Advisor

Every query and collection read is analyzed by `analyzeQueryIndexCoverage()` (`@vellum/core`). The advisor is pure, deterministic (zero I/O), and strictly advisory—it never alters query semantics.

### 1.1 Canonical Field Ordering (`E → S → R`)
1. **E — Equality fields** (sorted alphabetically): `==`, `in`, `array-contains`, `array-contains-any`.
2. **S — Sort fields** (in exact `orderBy` sequence, preserving `asc`/`desc`): fields already present in `E` are skipped.
3. **R — Range fields** (deduplicated, sorted alphabetically): `<`, `<=`, `>`, `>=`, `!=`, `not-in`, `starts_with_ci`. Fields already in `E` or `S` are skipped.

```text
Equality (E)         Sort (S)                     Range (R)
[status]      ──▶    [priority DESC, createdAt]   ──▶   [score]
```

Operators that do not map to B-Tree prefix ordering (`contains_ci`, `text_search`) are intentionally excluded from E/S/R classification.

### 1.2 Coverage Detection, Prefix Matching & Reverse Scans
A `ready` composite index covers a query when its field list starts with the full canonical sequence:
- **Exact prefix match:** Leading index fields match the canonical sequence directly (extra trailing fields are permitted).
- **Full reverse scan:** Inverting every field direction (`asc` ↔ `desc`) matches the canonical sequence, allowing PostgreSQL to walk the B-Tree backwards.
- **Single-field fast path:** Queries touching at most one distinct field are covered by built-in indexes (`documentId`, `__name__`, `createdAt`, `updatedAt`, or `idx_docs_data_gin_active`) and emit no composite suggestion.

### 1.3 Fingerprints, Advisory Headers & One-Click Apply
When no ready index covers a query:
- A deterministic `fingerprint` (`SHA-256` over project, collection path, and canonical fields) deduplicates repeated slow queries.
- The HTTP response includes two CORS-exposed headers:
  - `x-vellum-index-url`: `${VELLUM_DASHBOARD_BASE_URL}/orgs/${orgId}/projects/${projectId}/indexes?suggest=${base64url}`
  - `x-vellum-index-suggestion`: Decoded JSON `IndexSuggestionPayload` (validated strictly up to 8 KiB by `decodeSuggestPayload()`).
- Both `@vellum/sdk-js` and `vellum_flutter` inspect `x-vellum-index-*` headers before consuming response bodies and print a deduplicated clickable console warning (configurable via `warnOnMissingIndexes` and `onIndexSuggestion`).
- Fire-and-forget recording persists hit counts and timing stats to `control_db.project_index_recommendations` (migration `0006`), surfaced in the dashboard's **Smart Index Advisor** queue:

| Method | Endpoint | Purpose |
| :--- | :--- | :--- |
| `GET` | `/v1/projects/:projectId/indexes/recommendations` | List pending/applied/dismissed recommendations sorted by `hitCount` |
| `POST` | `/v1/projects/:projectId/indexes/recommendations/:id/apply` | Register the composite index and mark recommendation `applied` |
| `POST` | `/v1/projects/:projectId/indexes/recommendations/:id/dismiss` | Mark recommendation `dismissed` |

---

## 2. Hardened PostgreSQL Query & Storage Optimizations

### 2.1 Commutative Cost-Ranked Composite Index Matching (`compiler.ts`)
`selectCompositeIndexForQuery()` matches queries to `ready` composite indexes in `document_indexes` using three rules:
1. **Commutative Equality Prefix:** Any permutation of leading `==` filter fields satisfies the B-Tree prefix (enforcing direction if an equality field also appears in `orderBy`).
2. **Strict Suffix Ordering:** Remaining `orderBy` fields (or a single non-equality range field) must follow immediately in exact order and direction.
3. **Narrowest-Width Cost Ranking:** Chooses the matching index with the fewest unused trailing columns (`extraFields = idx.fields.length - requiredCount`), stopping immediately on an exact-width match (`extraFields === 0`).

### 2.2 Row-Value Tuple Keyset Pagination & Native System-Field Filters
- **Row-Value Tuples (`buildCursorPredicate`):** Composite-indexed cursors compile to `(ie.sort_key, ie.document_id) > ($k::bytea, $id)` (`>=` for `startAt`), unlocking direct PostgreSQL B-Tree Index Scans instead of `OR`-expanded predicates that degrade to bitmap scans.
- **Native `timestamptz` & `document_id` Predicates:** Filters on `createdAt`, `updatedAt`, `documentId`, and `__name__` compile directly to `d.created_at >= $n::timestamptz` and `d.document_id COLLATE "C" > $n::text`—hitting `idx_docs_collection_{created,updated,id}_active` without JSONB extraction overhead.
- **GIN Pre-Filter + Structural Equality:** Object/array `==` filters emit `d.data @> $literal::jsonb AND (d.data #> $path) = $exact::jsonb`, combining fast GIN `jsonb_path_ops` candidate narrowing with exact structural equality.
- **Bounded Compiler LRU Caches:** `computeIndexDefinitionHash` and `splitFieldPath` use bounded LRU caches (`LRU_CACHE_LIMIT = 512`).

### 2.3 Single-Round-Trip Transactions, `UNNEST` Batching & Atomic CTEs
| Optimization | Implementation | Impact |
| :--- | :--- | :--- |
| **Single-Round-Trip RLS Binding** | `buildPgTenantSetupSql()` / `buildTenantContextQuery()` (`set_config(..., true)`) | Cuts per-transaction setup from 4 sequential round-trips to 1 (`pg`) or 2 (`Neon` parameterized). |
| **Named Prepared Statements** | `runPrepared()` on `PgStorageAdapter` (`vellum_get_document_*`, `vellum_insert_documents`, etc.) | Eliminates repeated SQL parse/plan overhead on hot paths. |
| **Batched `UNNEST` Writes** | `SQL_INSERT_DOCUMENTS_UNNEST`, `SQL_CONDITIONAL_PUT_DOCUMENTS_UNNEST`, `SQL_INSERT_INDEX_ENTRIES`, `SQL_INSERT_OUTBOX_UNNEST` | Collapses multi-document batches, CAS flushes, index backfills, and outbox appends into 1 statement per table instead of N+1 loops. |
| **Atomic `WITH deleted AS` CTEs** | `sqlClearCollectionDocuments()` & `sqlDeleteCollection()` (`packages/storage/src/pg-adapter.ts`) | Computes `COUNT(*)` and `SUM(size_bytes)` directly from `DELETE ... RETURNING size_bytes` in one statement—zero `SELECT`-then-`DELETE` race and half the table scans. |
| **N+1-Free `.include()` Relations** | `SQL_BATCH_GET_DOCUMENTS` (`path = ANY($2::text[])`) | Resolves all referenced documents at each relation depth in one SQL round-trip. |
| **Nested `SAVEPOINT`s & Retries** | `activeTxStorage` (`AsyncLocalStorage`) + `RETRYABLE_PG_CODES` (`40001`, `40P01`) | Reuses active tenant connections for nested operations and auto-retries transient serialization/deadlock errors up to 3x with jitter. |

---

## 3. Bounded In-Process Caches & `NOTIFY` Invalidation (Zero-Redis)

`packages/storage/src/cache.ts` provides `createTtlCache<V>()`—a bounded `O(1)` LRU/TTL cache with zero external dependencies:

- **Defaults & Bounds:** Configurable `maxEntries` (default `1,024`), `ttlMs` (default `30,000 ms`), lazy expiry on `get()`, and an `.unref()`'d periodic sweep timer (`5,000 ms`).
- **Stampede Protection (`getOrLoad`):** Concurrent callers for the same key share a single in-flight promise. Per-key generation counters (`keyVersions`) guarantee that if a key is invalidated while loading, the stale result is **never** written back to cache.
- **Prefix Invalidation & Diagnostics:** Supports `deleteByPrefix(prefix)` for tenant-scoped eviction and exposes `{ hits, misses, evictions, expirations, size }` via `stats()`.
- **Cross-Instance Invalidation:** Multi-replica deployments broadcast invalidations over PostgreSQL `NOTIFY vellum_cache_invalidate` on a dedicated `LISTEN` client (never returned to a request pool).
- **Verified API Key Cache (`packages/authorization/src/api-keys.ts`):** Bounded to `10,000` entries with a `30 s` TTL, caching pre-decoded `secretHashBuf` and parsed `expiresAtMs` while **always** checking live revocation state and executing `crypto.timingSafeEqual` on every request.

---

## 4. Physical Data Plane Indexes (`migrations/0001`, `0007`, `0008`, `0010`)

| Index / Column | Table | Purpose |
| :--- | :--- | :--- |
| `PRIMARY KEY (project_id, path)` | `documents` | Point lookups, CAS updates, and `batchGetDocuments`. |
| `idx_docs_collection_id_active` | `documents` | `(project_id, collection_path, document_id ASC) WHERE deleted_at IS NULL` — default listing & tie-breaking. |
| `idx_docs_collection_created_active` / `updated_active` | `documents` | Native `timestamptz` sorting and row-value tuple pagination. |
| `idx_docs_data_gin_active` | `documents` | `USING GIN (data jsonb_path_ops) WHERE deleted_at IS NULL` (migration `0008` dropped the duplicate GIN copy). |
| `idx_docs_expires_at` | `documents` | `(project_id, expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL` — bounded TTL sweeper. |
| `PRIMARY KEY (index_id, sort_key, document_id)` | `document_index_entries` | Single B-Tree range/sort scan for all tenant composite indexes. |
| `idx_outbox_project_seq` | `realtime_outbox` | `(project_id, seq_id ASC)` — fast cursor replay and gap catch-up. |

---

## 5. Reproducible Performance & `EXPLAIN` Verification

Run the shipped benchmarking and plan-regression harnesses against a live PostgreSQL instance:

```bash
# Seed realistic dataset
corepack pnpm db:seed

# Run micro-benchmarks
corepack pnpm bench

# Verify EXPLAIN (ANALYZE, BUFFERS) plans do not regress to sequential scans
corepack pnpm bench:explain

# Run k6 concurrent read/write throughput & latency (p50/p95/p99) load test
corepack pnpm test:load
```

---

## Related Guides

- [03 — Query Compiler, Order-Preserving Sort Keys & Cursor Pagination](./03-query-and-indexing.md)
- [12 — Relationships & Advanced Queries (V2)](./12-relationships-and-advanced-queries.md)
- [Data Plane Row-Level Security (RLS) & Multi-Tenant Isolation](./data-plane-rls.md)
