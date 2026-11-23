# VELLUM Documentation Index

> Deployment entry point: [primary Vercel runbook and optional adapters](./deployment/README.md).

> Authoritative index of the `docs/` engineering specification.  
> The rendered bilingual (EN/AR) developer documentation site lives in [`apps/docs`](../apps/docs/README.md) and is served at `/docs/` (English) and `/docs/ar/` (Arabic) on the unified frontend origin.

---


## 1. Core Architecture & Storage Engine

| # | Document | Coverage |
| :-: | :--- | :--- |
| 01 | **[System Architecture & Dual Data-Plane Design](./01-architecture.md)** | PostgreSQL-only (Zero-Redis) doctrine, Control Plane vs. Data Plane bootstrap safety, single-round-trip transactions, `SAVEPOINT`s, `40001`/`40P01` retries, `UNNEST` batches, atomic CTEs, and monorepo map. |
| 02 | **[Canonical Document Paths & Tagged Wire Format](./02-wire-format-and-paths.md)** | Canonical collection/document path rules (`2..10` segments), tagged wire types (`$t`: `ts`, `int`, `ref`, `bytes`), and `$op` field transform sentinels. |
| — | **[Data Plane Row-Level Security (RLS) & Multi-Tenant Isolation](./data-plane-rls.md)** | `ENABLE`/`FORCE ROW LEVEL SECURITY` across all 12 tenant tables (`RLS_TENANT_TABLES`), fail-closed `NULLIF(current_setting(...))` policy, single-round-trip `set_config(..., true)`, `vellum_app` least-privilege grants, and tainted-socket destruction. |

---

## 2. Querying, Indexing & Performance

| # | Document | Coverage |
| :-: | :--- | :--- |
| 03 | **[Query Compiler, Order-Preserving Sort Keys & Cursor Pagination](./03-query-and-indexing.md)** | All 13 SQL operators, `or` groups, exact compiler limits (`MAX_SELECT_FIELDS = 50`, `MAX_FIELD_DEPTH = 16`, `MAX_TEXT_FILTER_LENGTH = 1024`, `MAX_CURSOR_TOKEN_BYTES = 16384`, `UNINDEXED_SCAN_CAP = 1000`), `sort_key BYTEA` encoding, commutative cost-ranked composite index selection, row-value tuple keyset pagination, and HMAC-SHA256 cursor codec. |
| 12 | **[Relationships & Advanced Queries (V2)](./12-relationships-and-advanced-queries.md)** | `.include()` with `$ref`, batched depth fetches, `_redactedRefs`, `onDelete` actions, native SQL `count`/`sum`/`avg`/`min`/`max`/`groupBy`, dot-path `select`, `or` groups, `upsert`, `deleteWhere`, and document TTL. |
| 14 | **[Smart Indexing & Performance Architecture](./14-smart-indexing-and-performance.md)** | E→S→R Smart Index Advisor, prefix/reverse scans, fingerprints & `?suggest=` deep links, SDK console warnings, dashboard advisor queue, bounded LRU/TTL caches with `NOTIFY vellum_cache_invalidate`, migrations `0007`/`0008`/`0010`, and `EXPLAIN`/k6 benchmarking methodology. |

---

## 3. APIs, Realtime & Client SDKs

| # | Document | Coverage |
| :-: | :--- | :--- |
| 05 | **[Public HTTP REST API & Realtime WebSocket Wire Protocol](./05-http-and-realtime-api.md)** | Complete `/v1` REST endpoint reference, `/health` & `/ready` probes, `$op` transforms, native RFC 6455 `/v1/realtime` wire frames (`auth_ack`, `initial_sync`, `resume_complete`, `mutation`, `ping`/`pong`), PostgreSQL `LISTEN/NOTIFY` + `OutboxPoller`, and backpressure/rate-limit caps. |
| 08 | **[JavaScript / TypeScript SDK Guide](./08-sdk-js-guide.md)** | `@vellum/sdk-js`: `AuthStorage`, `db.auth`, silent refresh, CRUD, queries/cursors, batch/OCC, realtime subscriptions, and index warnings. |
| 09 | **[Flutter / Dart SDK Guide](./09-sdk-flutter-guide.md)** | `vellum_flutter`: `AuthTokenStorage`, `authStateChanges`, MFA, 45 s refresh + single-flight, CRUD/query/watch, and index warnings. |

---

## 4. Security, Authentication & Billing

| # | Document | Coverage |
| :-: | :--- | :--- |
| 04 | **[Authentication, API Keys & Security Rules AST](./04-security-rules-ast.md)** | `pk_`/`sk_` API key model, declarative JSON AST rulesets, and evaluation semantics. |
| 07 | **[End-User Authentication & the Three Realms](./07-end-user-auth.md)** | Realm isolation, Ed25519 JWTs, refresh rotation & grace windows, profile projection, REST reference, EdDSA-only WS auth, and rate limits. |
| 13 | **[Security Rules DSL (V2)](./13-security-rules-dsl.md)** | Human-readable `rules_version = '2'` DSL, macros, user functions, compile/decompile/simulate endpoints, and dual-mode Rules Studio. |
| 15 | **[Security, Threat Detection & Defense in Depth](./15-security-and-defense.md)** | Three-realm isolation, universal `crypto.timingSafeEqual`, `256`-step Rules AST budgets, spoof-resistant `TRUST_PROXY_HOPS` IP extraction, chunked body limits, strict CORS/HSTS/CSP/CSRF, payload/query-cost/WS/SSRF guards, HKDF HMAC-SHA256 immutable audit chains, threat detector & blocklist, and internal document-engine hardening. |
| 16 | **[Metering, Quotas & Billing](./16-metering-and-billing.md)** | O(1) in-memory metering with atomic Map swap and 5 s flush, 10 s quota cache & `QuotaGuard`, hard spend caps (`402 MONTHLY_SPEND_CAP_REACHED`), integer-cent overages, immutable double-entry ledger, and Stripe webhook HMAC verification. |

---

## 5. Deployment, Operations & Verification

| # | Document | Coverage |
| :-: | :--- | :--- |
| 06 | **[Deployment, Hardened Containers, Probes & Operations](./06-deployment-and-operations.md)** | Hardened Docker Compose (`tini`, `read_only`, `cap_drop: [ALL]`, `127.0.0.1` bindings) + Caddy 2 ACME TLS, Zod fail-fast production config, coalesced `/health` & `/ready` probes, graceful `SIGTERM`/`SIGINT` draining (`1001`), and background maintenance workers. |
| 11 | **[Deployment & Hosting Guide (EN/AR)](./11-deployment-and-hosting.md)** | Unified single-origin frontend (`/`, `/admin/`, `/docs/`), Vercel + Railway/Render, Cloudflare Pages, self-hosted Docker + Caddy, and troubleshooting. |

---

## 6. Local Development & Verification

### Live Testbed Apps & Local Commands
- **Unified local stack:** `corepack pnpm dev:stack` → `http://localhost:3000` (Dashboard `/`, Admin `/admin/`, Docs `/docs/`, `/v1` HTTP+WS proxy) and `http://localhost:8080` (API).
- **Production frontend build:** `corepack pnpm build:frontend` → `node scripts/dev/frontend-gateway.mjs --mode=prod`.
- **JS/TS Testbed:** [`examples/js-testbed-app`](../examples/js-testbed-app/README.md) — `corepack pnpm --filter @vellum/js-testbed-app verify:live`.
- **Flutter/Dart Testbed:** [`examples/flutter_testbed_app`](../examples/flutter_testbed_app/README.md) — `dart run bin/run_live_testbed.dart`.
- **All Examples:** [`examples/README.md`](../examples/README.md) · **Generated Static Docs:** [`docs/site/index.html`](./site/index.html).
