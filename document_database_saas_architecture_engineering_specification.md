# Document Database SaaS — Production Architecture & Engineering Specification

> ## ⚠ SUPERSEDED BY NO-ENVIRONMENTS CONTRACT
>
> This document is the **frozen v1 blueprint** and is kept for historical context only.
> The environment model below (three environments per project, environment switcher UI,
> `dev`/`stg` key formats) is **revoked** by the locked decision in
> Note:
> **the tenant is the project** (`tenant == project`). There are no environments, no
> `envs/:env` URL segments, no environment-tagged keys, and no environment switcher. Where
> a line below still describes environments, the contract governs. The Redis broker
> language in this blueprint is likewise superseded by the Zero-Redis doctrine in `AGENTS.md`.

**Status:** Production-Ready Execution Blueprint (100% Locked for v1 Implementation)\
**Version:** 2.0\
**Date:** 15 November 2026\
**Primary language:** TypeScript (`strict: true`)\
**Initial hosting:** Vercel (Stateless Functions + WebSockets) with OCI Docker Portability\
**Initial PostgreSQL provider:** Neon Serverless PostgreSQL\
**Primary goal:** Build a developer-first, Firestore-inspired multi-tenant document database service with a clean, deterministic path from immediate implementation to high-scale production.

---

## 1. Executive Summary

This specification defines the complete product scope, system architecture, database schemas, wire protocols, query compilation rules, security AST, deployment strategy, and execution roadmap for a hosted Document Database SaaS.

The product is a **dedicated document database service**, not a bloated Backend-as-a-Service suite. Developers interact with collections, documents, typed values, structured queries, references, atomic transactions, and realtime listeners rather than raw SQL tables. PostgreSQL (`JSONB` + B-Tree/GIN indexing) powers the initial storage engine as an internal implementation detail encapsulated behind a strict Storage Adapter contract.

The v1 release delivers:

1. A working, deterministic, multi-tenant document database engine.
2. A predictable HTTP/REST + WebSocket API and a Firestore-like developer experience.
3. First-class TypeScript/JavaScript and Flutter/Dart SDKs built on a unified OpenAPI and Wire Format contract.
4. A customer developer dashboard and a strictly isolated platform-owner administration dashboard.
5. Neon PostgreSQL and Vercel for rapid initial delivery, paired with Upstash/Managed Redis for cross-instance realtime fan-out and rate limiting.
6. Standard OCI Docker packaging so any service can run locally or migrate to long-running container hosts (Fly.io, Cloud Run, AWS ECS, Kubernetes, or bare metal) with zero domain-code changes.
7. A modular monolith architecture with hard internal boundaries ready for service extraction only when empirical metrics justify it.

### 1.1 Dual Data-Plane Architecture (Bootstrap-Safe Design)

The platform operates across **two strictly separated logical and physical data planes**:

- **Control Plane Database (`control_db`):** Stores platform accounts, sessions, organizations, memberships, projects, API key hashes, security rulesets, billing subscriptions, usage aggregates, feature flags, and audit logs in a dedicated Neon PostgreSQL database.
- **Document Data Plane Database (`data_db_01..N`):** Stores customer documents, index entries, and transactional realtime outbox events managed by the document engine.

**No Circular Dependency Rule:** The platform dogfoods its own document database via a dedicated internal organization and project (`org_internal` / `proj_dogfood`) for non-critical telemetry, activity feeds, and SDK verification. However, starting the platform, authenticating operators, rotating keys, or recovering from an outage must **never** depend on the public document API. The Control Plane is the sole bootstrap authority.

---

## 2. Product Vision, Scope, and Hard v1 Limits

### 2.1 In-Scope for v1

- Multi-tenant Organizations and Projects (the project is the sole tenant).
- Hierarchical Collections, Documents, Nested Paths, and Subcollections.
- Versioned Tagged Wire Format for rich document types (`string`, `boolean`, `int64`, `double`, `null`, `timestamp`, `bytes`, `geo`, `reference`, `array`, `map`).
- Full Document CRUD (`create`, `get`, `set`, `update`, `delete`, `list`).
- Deterministic Query Engine (`where`, `orderBy`, `limit`, `select`, cursor pagination `startAfter` / `startAt`).
- Tenant-isolated Composite Index Management without cross-tenant schema locking.
- Atomic Batch Writes, Field Transforms (`$inc`, `$serverTimestamp`, `$arrayUnion`, `$arrayRemove`, `$deleteField`), and Optimistic/Interactive Transactions.
- Realtime Document & Query Subscriptions over WebSockets with Transactional Outbox continuity.
- Declarative JSON AST Security Rules evaluated server-side + Project API Key Scopes.
- Customer Developer Dashboard + Platform Owner Admin Dashboard.

### 2.2 Explicitly Out of Scope for v1

- End-user Authentication-as-a-Service (customers bring their own JWT/Auth provider or verify tokens via custom claims).
- Binary object/file blob storage (documents store structured data up to $1\text{ MiB}$, not media files).
- Arbitrary user-supplied JavaScript/Cloud Functions execution.
- Push notification gateways (FCM/APNs).
- Direct SQL console access for end customers.
- Custom storage engines or distributed consensus protocols (Raft/Paxos).

### 2.3 Locked v1 System Limits & Quotas

All validation schemas (Zod), query compilers, and storage adapters must enforce these exact constants:

| Parameter | v1 Hard Limit | Enforcement Layer | Error Code on Violation |
| :--- | :--- | :--- | :--- |
| Max Document Payload Size (serialized UTF-8) | $1,048,576\text{ bytes}$ ($1\text{ MiB}$) | API + Engine | `DOCUMENT_TOO_LARGE` |
| Max Path Depth (alternating `collection/doc`) | $10\text{ segments}$ ($5\text{ nested collections}$) | Path Validator | `INVALID_DOCUMENT_PATH` |
| Max Single Path Segment Length | $1,500\text{ bytes}$ | Path Validator | `INVALID_DOCUMENT_PATH` |
| Max JSON Object Nesting Depth (inside `data`) | $20\text{ levels}$ | Value Validator | `MAX_NESTING_EXCEEDED` |
| Max Field Name Length | $256\text{ chars}$ | Value Validator | `INVALID_FIELD_NAME` |
| Max Operations per Atomic Batch / Transaction | $100\text{ operations}$ | Transaction Engine | `BATCH_SIZE_EXCEEDED` |
| Max Total Payload per Batch / Transaction | $5,242,880\text{ bytes}$ ($5\text{ MiB}$) | API Gateway | `PAYLOAD_TOO_LARGE` |
| Max Interactive Transaction Duration | $5,000\text{ ms}$ | Transaction Engine | `TRANSACTION_TIMEOUT` |
| Max `where` Clauses per Query | $10\text{ filters}$ | Query Compiler | `QUERY_TOO_COMPLEX` |
| Max Disjunctive Elements (`in` / `not-in` / `array-contains-any`) | $30\text{ values}$ | Query Compiler | `QUERY_TOO_COMPLEX` |
| Max `orderBy` Fields per Query | $3\text{ fields}$ | Query Compiler | `QUERY_TOO_COMPLEX` |
| Max Documents Returned per Query Page (`limit`) | $500\text{ documents}$ (Default: $50$) | Query Compiler | `LIMIT_EXCEEDED` |
| Max Query Response Size | $4,194,304\text{ bytes}$ ($4\text{ MiB}$) | Query Engine | `RESPONSE_TOO_LARGE` |
| Max Single Query Execution Time | $5,000\text{ ms}$ (`statement_timeout`) | Storage Adapter | `QUERY_DEADLINE_EXCEEDED` |
| Max Composite Indexes per Project | $50\text{ indexes}$ (Free) / $200$ (Pro) | Index Manager | `QUOTA_EXCEEDED` |
| Max Active Subscriptions per WebSocket Connection | $50\text{ subscriptions}$ | Realtime Gateway | `SUBSCRIPTION_LIMIT_EXCEEDED` |
| Max Outbound WebSocket Buffer per Client | $1,048,576\text{ bytes}$ ($1\text{ MiB}$) | Realtime Gateway | `SLOW_CONSUMER_DISCONNECT` |
| Soft-Delete Tombstone Retention Window | $7\text{ days}$ ($604,800\text{ s}$) | Compaction Worker | N/A |

---

## 3. Technology Stack & Driver Strategy

| Layer | Technology Choice | Pinned Target / Mode | Engineering Justification |
| :--- | :--- | :--- | :--- |
| Language | TypeScript | `^5.7.x` (`strict: true`, `noUncheckedIndexedAccess: true`) | End-to-end type safety across engine, API, dashboard, and JS SDK |
| Runtime | Node.js LTS | `>=22.x LTS` | Native Web Streams, stable `fetch`, `crypto`, and Docker compatibility |
| Package Manager | `pnpm` | `^9.x` Workspaces | Strict dependency isolation and fast deterministic installs |
| Customer & Admin Apps | Next.js (App Router) | `^15.x` | Server Components, strong Vercel integration, clean route groups |
| HTTP & WS API Adapter | Hono + `@hono/zod-openapi` | `^4.x` | Zero-bloat Web Standards router; runs identically on Vercel and Node.js |
| Validation & Contracts | Zod | `^3.24.x` | Single source of truth for runtime validation, TypeScript types, and OpenAPI |
| Database Provider | Neon PostgreSQL | PostgreSQL `16` / `17` | Branching, serverless connection pooling, and JSONB performance |
| SQL Toolkit & Migrations | Drizzle ORM + Drizzle Kit | `^0.38.x` | Transparent SQL generation, zero hidden ORM overhead |
| Serverless DB Driver | `@neondatabase/serverless` | HTTP + WebSocket Pool | HTTP for single-shot queries; WS `Pool` for interactive transactions |
| Standard Node DB Driver | `pg` (`node-postgres`) | `^8.x` | Used automatically when running inside standard Docker containers |
| Dashboard Auth | Better Auth | `^1.x` + Drizzle Adapter | Self-hosted session/organization management stored in Control Plane DB |
| Ephemeral State & Pub/Sub | Upstash Redis / Redis 7 | HTTP + TCP Redis client | Cross-instance WebSocket event fan-out and sliding-window rate limits |
| Logging | Pino | `^9.x` | High-throughput structured JSON logs with automatic secret redaction |
| Testing | Vitest + Playwright + k6 | Latest stable | Unit/Integration (Vitest), E2E UI (Playwright), Load/Concurrency (k6) |

### 3.1 Dual-Mode PostgreSQL Connection Strategy

Every database instance exposes two connection URLs per plane:

- `CONTROL_DATABASE_URL` (Pooled `-pooler` endpoint) and `CONTROL_DATABASE_URL_DIRECT` (Direct endpoint for migrations).
- `DATA_DATABASE_URL` (Pooled `-pooler` endpoint) and `DATA_DATABASE_URL_DIRECT` (Direct endpoint for migrations and index builds).
- `REDIS_URL` (Managed Redis / Upstash endpoint for distributed rate limiting and realtime pub/sub fan-out).

**Driver Selection Rules inside `packages/storage`:**
1. **Single-Query Read/Write Operations:** Execute via Neon HTTP driver or pooled connection with zero session state dependence.
2. **Atomic Batch Writes & Interactive Transactions:** Execute inside a dedicated transaction connection (`db.transaction(...)` over Neon WebSocket `Pool` or standard `pg.Pool`) where `SET LOCAL statement_timeout = '5000ms'` and `SET LOCAL app.current_project_id = '<uuid>'` are bound strictly to the transaction lifecycle (`BEGIN ... COMMIT`).
3. **DDL & Migrations:** Execute exclusively via `*_DATABASE_URL_DIRECT` inside CI/CD deployment pipelines—never on Function cold starts.

---

## 4. High-Level System Architecture

```text
                       ┌────────────────────────────────────────┐
                       │              Client SDKs               │
                       │  @vellumdb/sdk-js   │   vellum_flutter     │
                       └────────┬─────────┴──────────┬──────────┘
                                │ HTTPS (REST)       │ WSS (Realtime)
                       ┌────────▼────────────────────▼──────────┐
                       │         Edge / API Entry Layer         │
                       │   TLS, Rate Limiter, Request ID, CORS  │
                       └────────┬────────────────────┬──────────┘
                                │                    │
              ┌─────────────────▼──────┐    ┌────────▼─────────────────┐
              │   Document HTTP API    │    │    Realtime Gateway      │
              │  (Hono OpenAPI Routes) │    │ (WebSocket Multiplexer)  │
              └─────────────────┬──────┘    └────────┬─────────────────┘
                                │                    │
                                └─────────┬──────────┘
                                          │
                       ┌──────────────────▼─────────────────────┐
                       │       Core Application Modules         │
                       │  AuthZ AST │ Query Compiler │ Engine   │
                       │  Tx Manager│ Index Manager  │ Metering │
                       └────────┬────────────────────┬──────────┘
                                │                    │
          ┌─────────────────────▼──────┐    ┌────────▼─────────────────────┐
          │   Control Plane Adapter    │    │     Data Plane Adapter       │
          │  (Projects, Keys, Rules)   │    │ (Documents, Indexes, Outbox) │
          └─────────────┬──────────────┘    └────────┬───────────┬─────────┘
                        │                            │           │
          ┌─────────────▼──────────────┐    ┌────────▼────────┐  ┌▼────────────────┐
          │   Control Plane Neon DB    │    │ Data Plane Neon │  │ Redis Pub/Sub   │
          │       (PostgreSQL)         │    │  (PostgreSQL)   │  │ (Event Fan-Out) │
          └────────────────────────────┘    └─────────────────┘  └─────────────────┘
```

### 4.1 Modular Monolith Boundaries

All business logic resides in framework-agnostic packages under `packages/*`. `apps/api`, `apps/dashboard`, and `apps/admin` are thin delivery adapters.

- `packages/core`: Domain primitives, error classes, limits, Path parser, Tagged Wire Format serializer/deserializer, and sortable byte-key encoder.
- `packages/api-contract`: All Zod request/response schemas, WebSocket frame schemas, and OpenAPI spec generator.
- `packages/authorization`: API key verifier, End-User JWT context extractor, and deterministic Security Rules AST Evaluator.
- `packages/query-engine`: Filter AST parser, index selector, parameterized SQL compiler, and HMAC cursor encoder.
- `packages/document-engine`: CRUD orchestration, atomic field transforms, batch/transaction coordinator, and outbox writer.
- `packages/storage`: Abstract storage interfaces + PostgreSQL/Neon implementation.
- `packages/realtime`: Subscription registry, query matcher, outbox poller/publisher, and WebSocket protocol state machine.

---

## 5. Control-Plane Data Model (Complete SQL Specification)

The Control Plane database (`control_db`) manages identity, tenancy, credentials, rulesets, and quotas.

```sql
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Platform Users (Managed with Better Auth + Platform Role Extension)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  platform_role TEXT NOT NULL DEFAULT 'customer'
    CHECK (platform_role IN ('customer', 'support_readonly', 'admin', 'owner')),
  is_suspended BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Customer Organizations
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'),
  name TEXT NOT NULL,
  billing_email TEXT NOT NULL,
  plan_id TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'past_due', 'suspended', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Organization Memberships
CREATE TABLE organization_members (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'billing_viewer')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

-- 4. Projects
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'Throttled', 'suspended', 'deleting', 'deleted')),
  cluster_id TEXT NOT NULL DEFAULT 'cluster_shared_01',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);

-- 5. REMOVED BY THE NO-ENVIRONMENTS CUTOVER:
-- the former `project_environments` table and its legacy three-value CHECK
-- no longer exist. Retention, JWT issuer/audience/JWKS and all other per-tenant
-- configuration now live directly on `projects`, keyed by project_id only.
-- The original DDL is retained below purely as historical blueprint context
-- and is NOT the effective schema:
--
-- CREATE TABLE project_environments (
--   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--   project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
--   name TEXT NOT NULL,  -- legacy three-value CHECK revoked
--   jwt_jwks_url TEXT,
--   jwt_issuer TEXT,
--   jwt_audience TEXT,
--   soft_delete_retention_days INT NOT NULL DEFAULT 7 CHECK (soft_delete_retention_days BETWEEN 0 AND 30),
--   created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
--   UNIQUE (project_id)
-- );

-- 6. API Keys (Prefix + SHA-256 Hash; plaintext never stored)
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_type TEXT NOT NULL CHECK (key_type IN ('public', 'server')),
  key_prefix TEXT NOT NULL UNIQUE, -- e.g., pk_a1b2c3d4 or sk_x9y8z7w6
  secret_hash TEXT NOT NULL,       -- SHA-256 hex digest of full key with server pepper
  scopes TEXT[] NOT NULL DEFAULT ARRAY['documents:read', 'documents:write'],
  rate_limit_rps INT NOT NULL DEFAULT 100,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_keys_lookup ON api_keys (key_prefix) WHERE revoked_at IS NULL;

-- 7. Declarative Security Rulesets (Versioned per Project)
CREATE TABLE security_rulesets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INT NOT NULL,
  rules_ast JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);

CREATE UNIQUE INDEX idx_active_ruleset_per_project
  ON security_rulesets (project_id) WHERE is_active = TRUE;

-- 8. Daily Usage & Metering Counter Table
CREATE TABLE project_usage_daily (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  document_reads BIGINT NOT NULL DEFAULT 0,
  document_writes BIGINT NOT NULL DEFAULT 0,
  document_deletes BIGINT NOT NULL DEFAULT 0,
  realtime_messages_sent BIGINT NOT NULL DEFAULT 0,
  egress_bytes BIGINT NOT NULL DEFAULT 0,
  storage_bytes BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, usage_date)
);

-- 9. Immutable Security & Admin Audit Log
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'platform_admin', 'system')),
  organization_id UUID REFERENCES organizations(id),
  project_id UUID REFERENCES projects(id),
  action TEXT NOT NULL, -- e.g., 'api_key.created', 'ruleset.published', 'admin.project.suspended'
  target_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_project ON audit_logs (project_id, created_at DESC);
```

### 5.1 API Key Format & Verification Contract

- **Public Key (`pk_<32_random_base62>`):** Identifies `project_id`. Grants **zero** implicit data access; every operation using a `public` key is unconditionally evaluated against the active `security_rulesets.rules_ast`.
- **Server Key (`sk_<48_random_base62>`):** Secret server-only credential. Bypasses end-user security rules **only** for the explicit scopes granted in `api_keys.scopes` (`documents:read`, `documents:write`, `indexes:manage`).
- **Verification Caching:** Verified key metadata and the active `rules_ast` for a project may be cached in memory/Redis for at most $30\text{ seconds}$ with immediate pub/sub invalidation upon key revocation or ruleset deployment.

---

## 6. Document Data Plane & Tagged Wire Format Specification

### 6.1 Canonical Path Rules

1. A document path is an even-numbered sequence of `/`‑separated segments:
   `collection_1/doc_1` (depth 2) up to `c1/d1/c2/d2/c3/d3/c4/d4/c5/d5` (depth 10).
2. A collection path is an odd-numbered sequence of segments:
   `collection_1` (depth 1) or `c1/d1/c2` (depth 3).
3. **Allowed Segment Characters:** UTF-8 characters excluding `/`, null bytes `\0`, and control characters (`0x00`–`0x1F`). Segments `.` and `..` and prefixes `__.*__` are strictly reserved and rejected.
4. **Decomposition:** For document path `users/u_123/orders/ord_456`:
   - `path` = `"users/u_123/orders/ord_456"`
   - `collection_path` = `"users/u_123/orders"`
   - `collection_group` = `"orders"` (always the final collection segment, enabling future collection-group queries)
   - `document_id` = `"ord_456"`
   - `path_depth` = `4`

### 6.2 Canonical Tagged Wire Format (v1)

To prevent ambiguity between user maps and system types while keeping standard JSON primitives (`string`, `boolean`, `null`, finite `number`, `array`) fast and readable inside PostgreSQL `JSONB`, special types use a single reserved wrapper key `$t` and value `$v`.

| Logical Data Type | JSON Wire & Storage Representation | Validation Rules |
| :--- | :--- | :--- |
| `null` | `null` | Standard JSON `null` |
| `boolean` | `true` or `false` | Standard JSON boolean |
| `string` | `"hello"` | Valid UTF-8 string |
| `number` (IEEE 754 float) | `42` or `3.14159` | Finite JSON number (`NaN` / `±Infinity` rejected) |
| `int64` (Exact 64-bit integer) | `{"$t": "int", "$v": "-9007199254740993"}` | Base-10 string within signed 64-bit range; also writes numeric sort value |
| `timestamp` | `{"$t": "ts", "$v": "2026-11-15T14:30:00.123456Z", "$ms": 1794753000123}` | ISO-8601 UTC string + epoch milliseconds `$ms` for fast numeric range indexing |
| `reference` | `{"$t": "ref", "$v": "users/u_123"}` | Valid canonical document path within the same `project_id` |
| `bytes` | `{"$t": "bytes", "$v": "SGVsbG8="}` | Standard Base64 encoded binary payload |
| `geopoint` | `{"$t": "geo", "$v": {"lat": 30.0444, "lng": 31.2357}}` | `lat` $\in [-90, 90]$, `lng` $\in [-180, 180]$ |
| `array` | `[ ...values ]` | Standard JSON array (nested arrays permitted up to depth limit) |
| `map` (Plain Object) | `{"name": "Alex"}` | Any JSON object not containing reserved `$t` key |
| Escaped User Object with `$t` | `{"$t": "map", "$v": {"$t": "custom_user_value"}}` | Automatic SDK/Engine escaping when user stores literal key `"$t"` |

### 6.3 Data Plane SQL Schema (`data_db`)

```sql
-- 1. Primary Documents Table
CREATE TABLE documents (
  project_id UUID NOT NULL,
  path TEXT NOT NULL,
  collection_path TEXT NOT NULL,
  collection_group TEXT NOT NULL,
  document_id TEXT NOT NULL,
  path_depth SMALLINT NOT NULL CHECK (path_depth >= 2 AND path_depth <= 10 AND path_depth % 2 = 0),
  data JSONB NOT NULL,
  size_bytes INT NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 1048576),
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, path)
);

-- Core B-Tree Indexes for Collection Listing, Ordering, and Cursor Pagination
CREATE INDEX idx_docs_collection_id_active
  ON documents (project_id, collection_path, document_id ASC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_docs_collection_updated_active
  ON documents (project_id, collection_path, updated_at DESC, document_id ASC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_docs_collection_created_active
  ON documents (project_id, collection_path, created_at DESC, document_id ASC)
  WHERE deleted_at IS NULL;

-- GIN Index with jsonb_path_ops for fast equality & array-contains queries without per-key bloat
CREATE INDEX idx_docs_data_gin_active
  ON documents USING GIN (data jsonb_path_ops)
  WHERE deleted_at IS NULL;

-- Partial Index for Soft-Delete Tombstone Garbage Collection
CREATE INDEX idx_docs_tombstones
  ON documents (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- 2. Tenant-Isolated Composite Index Definitions
CREATE TABLE document_indexes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  collection_path TEXT NOT NULL,
  fields JSONB NOT NULL, -- e.g. [{"path": "status", "dir": "asc"}, {"path": "createdAt", "dir": "desc"}]
  definition_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'building'
    CHECK (status IN ('building', 'ready', 'failed', 'deleting')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, collection_path, definition_hash)
);

-- 3. Multi-Tenant Composite Index Entries Table (Avoids Global DDL Locks per Customer)
CREATE TABLE document_index_entries (
  index_id UUID NOT NULL REFERENCES document_indexes(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  collection_path TEXT NOT NULL,
  sort_key BYTEA NOT NULL, -- Order-preserving binary encoding of composite field values
  document_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (index_id, sort_key, document_id)
);

CREATE INDEX idx_index_entries_doc_cleanup
  ON document_index_entries (project_id, path);

-- 4. Transactional Realtime Outbox
CREATE TABLE realtime_outbox (
  seq_id BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL,
  collection_path TEXT NOT NULL,
  path TEXT NOT NULL,
  document_id TEXT NOT NULL,
  op_type TEXT NOT NULL CHECK (op_type IN ('created', 'updated', 'deleted')),
  version BIGINT NOT NULL,
  before_data JSONB,
  after_data JSONB,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_outbox_project_seq
  ON realtime_outbox (project_id, seq_id ASC);

CREATE INDEX idx_outbox_cleanup
  ON realtime_outbox (committed_at);
```

### 6.4 Defense-in-Depth Row-Level Security (RLS)

Every Data Plane query executes under a non-superuser role (`vellum_runtime`) and sets transaction-local tenant context:

```sql
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_indexes ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_index_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime_outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_documents ON documents
  USING (
    project_id = current_setting('app.current_project_id', true)::uuid
  );
```

If a code path ever omits `SET LOCAL app.current_project_id`, `current_setting(..., true)` returns `NULL`, causing PostgreSQL to fail closed and return zero rows.

---

## 7. Query Engine & Multi-Tenant Indexing Specification

### 7.1 Supported v1 Query Operators

| Operator | Syntax | Supported Field Types | SQL Compilation Strategy |
| :--- | :--- | :--- | :--- |
| Equality | `==` | All scalar types, `timestamp`, `ref`, `null` | `data @> '{"field": value}'::jsonb` (uses `jsonb_path_ops` GIN index) |
| Inequality | `!=` | All scalar types, `timestamp`, `ref`, `null` | `NOT (data @> '{"field": value}'::jsonb) AND data ? 'field'` |
| Less Than / Equal | `<`, `<=` | `number`, `int64`, `string`, `timestamp` | Typed extraction or `document_index_entries.sort_key` range scan |
| Greater Than / Equal | `>`, `>=` | `number`, `int64`, `string`, `timestamp` | Typed extraction or `document_index_entries.sort_key` range scan |
| In Array | `in` | Up to 30 scalar/`ref`/`ts` values | `Boolean OR` of `@>` predicates or `ANY($1)` |
| Not In Array | `not-in` | Up to 30 scalar/`ref`/`ts` values | Conjunction of `!=` predicates |
| Array Membership | `array-contains` | Scalar, `ref`, `ts` inside array field | `data @> '{"tags": ["urgent"]}'::jsonb` (uses GIN index) |
| Array Any Membership | `array-contains-any` | Up to 30 elements | Disjunction of `data @> '{"tags": [val]}'::jsonb` |

### 7.2 Why `document_index_entries` Solves Multi-Tenant Composite Indexing

In a shared-table multi-tenant database, running `CREATE INDEX ON documents ((data->>'customField'))` for every customer project creates thousands of PostgreSQL system catalog entries, degrades write performance for all tenants, and risks table locks.

Instead, our engine uses a ** dual-path indexing model**:
1. **Zero-Config Single-Field & Equality Queries:** Served immediately by `(project_id, collection_path, document_id/updated_at/created_at)` B-Tree indexes plus the `data jsonb_path_ops` GIN index.
2. **Custom Composite Range + Sort Queries:** When a project defines a composite index (e.g., `status ASC, priority DESC, createdAt DESC` on `tickets`), the engine registers a row in `document_indexes`. Whenever a document in `tickets` is written, the engine computes a canonical **Order-Preserving Lexicographical Byte Key (`sort_key BYTEA`)** inside the same transaction and upserts it into `document_index_entries`.
   - Type tags (`0x00` Null, `0x10` Boolean, `0x20` IEEE-754 Float with sign-bit flipping, `0x30` UTF-8 String terminated with `0x00`, `0x40` Timestamp `$ms`) guarantee exact binary sort order.
   - For `DESC` fields, every byte of the encoded value is bitwise inverted (`byte ^ 0xFF`).
   - Querying any composite index is then a single index-only B-Tree scan on `document_index_entries (index_id, sort_key, document_id)` joined by primary key to `documents`!

### 7.3 Deterministic Cursor Pagination

Offset pagination (`OFFSET N`) is forbidden in the public API because its cost scales linearly $O(N)$. All pagination uses opaque cursors:

1. Every query automatically appends `document_id ASC` as the final tie-breaker sort field if not already present.
2. The cursor token is a Base64URL-encoded payload signed with `HMAC-SHA256`:
   ```json
   {
     "qHash": "sha256_of_collection_filters_and_orders",
     "vals": ["active", 1794753000123],
     "docId": "user_987",
     "sig": "hmac_signature"
   }
   ```
3. If a client modifies filters or sort order while passing an existing cursor, `qHash` mismatches and the API immediately returns `INVALID_CURSOR`.

---

## 8. Transactions & Atomic Field Operations

### 8.1 Atomic Field Transforms

Update and Set-Merge operations accept declarative transform sentinels inside field values:

- `{"$op": "serverTimestamp"}` $\rightarrow$ Replaced on server with current transaction UTC timestamp `{"$t": "ts", "$v": "...", "$ms": ...}`.
- `{"$op": "inc", "by": 5}` $\rightarrow$ Atomically adds `by` to existing numeric value (initializes to `by` if missing; fails with `FAILED_PRECONDITION` if existing field is non-numeric).
- `{"$op": "arrayUnion", "elements": [...]}` $\rightarrow$ Appends elements not already present (deep equality).
- `{"$op": "arrayRemove", "elements": [...]}` $\rightarrow$ Removes all matching elements.
- `{"$op": "deleteField"}` $\rightarrow$ Removes the key from the parent JSONB object.

### 8.2 Transaction Modes

1. **Atomic Batch Write (`POST /v1/.../documents:batchWrite`):**
   - Accepts up to $100$ mutations (`create`, `set`, `update`, `delete`) with optional per-document preconditions (`ifVersion: number`, `exists: boolean`).
   - Executes in a single non-interactive database transaction (`BEGIN ... COMMIT`), writing mutations, updating `document_index_entries`, and inserting `realtime_outbox` records atomically.
2. **Interactive Read-Write Transaction (`beginTransaction` $\rightarrow$ reads $\rightarrow$ `commit`):**
   - Uses Optimistic Concurrency Control (OCC) by default to avoid holding open PostgreSQL connections across network roundtrips from untrusted clients:
     - `beginTransaction` issues a signed `transactionToken` containing a start timestamp and snapshot watermark.
     - Reads executed with `transactionToken` record each read document's `(path, version)` in a signed read-set state or short-lived Redis key (`ttl = 5s`).
     - `commit` opens a single PostgreSQL transaction, locks all target rows (`SELECT path, version FROM documents WHERE ... FOR UPDATE`), verifies that every document in the read-set still matches its observed `version`, applies all writes, and commits. If any version changed, the transaction aborts and returns `ABORTED_CONFLICT` so the SDK automatically retries with exponential backoff.

---

## 9. Realtime Architecture & WebSocket Wire Protocol

### 9.1 Hybrid Transactional Outbox + Pub/Sub Fan-Out

Because Vercel Functions are ephemeral and do not share memory:

1. **Durable Commit:** Every document write transaction inserts a row into `realtime_outbox` with a monotonically increasing `seq_id`.
2. **Immediate Push (Fast Path):** Immediately after `COMMIT` succeeds, the API instance a dedicated PostgreSQL `LISTEN/NOTIFY` client publishes a compact notification `{projectId, collectionPath, path, seqId}` to the channel `rt:{projectId}` (Zero-Redis doctrine).
3. **Outbox Catch-Up Poller (Reliability Path):** Each active Realtime Gateway instance maintains a high-water `last_seq_id` per active `project_id`. If a Pub/Sub gap is detected (`incoming.seqId > local.lastSeqId + 1`) or every $1,500\text{ ms}$ as a fallback sweep, the gateway queries `SELECT * FROM realtime_outbox WHERE project_id = $1 AND seq_id > $2 ORDER BY seq_id ASC` to guarantee zero missed events.
4. **Reconnect Continuity:** Clients track the latest `seqId` received on each subscription. On reconnect, the client sends `resumeFromSeqId`. If `resumeFromSeqId` is still within the `realtime_outbox` retention window ($24\text{ hours}$), the server replays only the missed deltas; otherwise, it sends a `reset` frame followed by a fresh snapshot.

### 9.2 WebSocket Frame Protocol (`/v1/realtime`)

All frames are UTF-8 JSON objects with a discriminated `type` field.

**Client $\rightarrow$ Server Frames:**
```ts
type ClientFrame =
  | { type: "auth"; projectId: string; apiKey: string; userToken?: string }
  | { type: "subscribe"; subId: string; path?: string; query?: QuerySpec; resumeSeqId?: string }
  | { type: "unsubscribe"; subId: string }
  | { type: "ping"; ts: number };
```

**Server $\rightarrow$ Client Frames:**
```ts
type ServerFrame =
  | { type: "auth_ok"; connectionId: string; heartbeatIntervalMs: 25000 }
  | { type: "sub_ack"; subId: string; mode: "initial_sync" | "resumed"; watermarkSeqId: string }
  | { type: "change"; subId: string; seqId: string; changeType: "added" | "modified" | "removed"; doc: DocumentPayload }
  | { type: "sync_complete"; subId: string; watermarkSeqId: string }
  | { type: "sub_error"; subId: string; code: string; message: string }
  | { type: "pong"; ts: number }
  | { type: "disconnect"; reason: "TOKEN_EXPIRED" | "SLOW_CONSUMER" | "SERVER_ROTATION" };
```

### 9.3 Reconnection & Backoff Formula

SDKs must implement exponential backoff with full jitter on disconnect:

$$t_{\text{sleep}} = \text{random}\left(0, \min\left(t_{\max}, t_0 \cdot 2^{\text{attempt}}\right)\right)$$

where $t_0 = 500\text{ ms}$ and $t_{\max} = 30,000\text{ ms}$.

---

## 10. Security Model & Declarative Rules AST

### 10.1 Declarative Security Rules AST Schema (v1)

Instead of unsafe `eval()` or custom parser vulnerabilities, security rules are compiled and stored as a strict JSON Abstract Syntax Tree validated by Zod.

```json
{
  "version": 1,
  "rules": [
    {
      "match": "users/{userId}",
      "allow": {
        "get": {
          "op": "==",
          "left": { "var": "auth.uid" },
          "right": { "var": "path.userId" }
        },
        "list": { "op": "==", "left": { "var": "auth.claims.role" }, "right": { "val": "admin" } },
        "create": {
          "op": "all",
          "conditions": [
            { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } },
            { "op": "==", "left": { "var": "request.data.ownerId" }, "right": { "var": "auth.uid" } }
          ]
        },
        "update": {
          "op": "all",
          "conditions": [
            { "op": "==", "left": { "var": "resource.data.ownerId" }, "right": { "var": "auth.uid" } },
            { "op": "==", "left": { "var": "request.data.ownerId" }, "right": { "var": "resource.data.ownerId" } }
          ]
        },
        "delete": { "op": "==", "left": { "var": "auth.claims.role" }, "right": { "val": "admin" } }
      }
    }
  ]
}
```

### 10.2 Supported AST Context Variables & Operators

- **Context Variables (`var`):**
  - `auth.uid` (`string | null`)
  - `auth.claims.<key>` (verified JWT custom claim)
  - `path.<wildcardName>` (segment extracted from `match` pattern)
  - `resource.data.<fieldPath>` (existing document state in DB before mutation)
  - `request.data.<fieldPath>` (incoming document state after mutation)
  - `request.time` (current server epoch ms)
- **Logical Combinators:** `all` (AND), `any` (OR), `not` (NOT).
- **Comparison Operators:** `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `hasKey`, `isType`.
- **Execution Bound:** Maximum AST depth is $10$ levels and maximum node count per rule is $100$ nodes. Evaluation is 100% synchronous and in-memory (no `get()` database calls inside rules in v1), guaranteeing sub-millisecond rule evaluation.

---

## 11. Public HTTP API Contract (`/v1`)

All endpoints require headers:
- `X-Project-Key: <pk_... or sk_...>`
- `Authorization: Bearer <end_user_jwt>` (Optional; provides `auth.uid` and `auth.claims` when using a `pk_` key)
- `X-Request-Id: <optional_client_uuid>`

### 11.1 Core Endpoints

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/v1/health` | Liveness and database connectivity check |
| `GET` | `/v1/projects/:projectId/documents/*path` | Get a single document by full path |
| `PUT` | `/v1/projects/:projectId/documents/*path` | Create or overwrite (`set` / `merge`) a document |
| `PATCH` | `/v1/projects/:projectId/documents/*path` | Update specific fields or apply atomic field transforms |
| `DELETE` | `/v1/projects/:projectId/documents/*path` | Soft-delete a document |
| `POST` | `/v1/projects/:projectId/query` | Execute a structured collection query with filters, sort, and cursor |
| `POST` | `/v1/projects/:projectId/batchWrite` | Execute up to 100 atomic write mutations |
| `POST` | `/v1/projects/:projectId/transactions:begin` | Start an OCC transaction and receive `transactionToken` |
| `POST` | `/v1/projects/:projectId/transactions:commit` | Verify read-set versions and commit mutations atomically |
| `GET` | `/v1/projects/:projectId/indexes` | List composite indexes (`sk_` key with `indexes:manage`) |
| `POST` | `/v1/projects/:projectId/indexes` | Create and asynchronously backfill a composite index |
| `DELETE` | `/v1/projects/:projectId/indexes/:indexId` | Drop a composite index |

### 11.2 Canonical Error Response Envelope

```json
{
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "Security rules denied 'update' on path 'users/u_123'.",
    "requestId": "req_01JCK9X2P8Z7A4M5N6Q7R8S9T0",
    "details": {
      "path": "users/u_123",
      "operation": "update"
    }
  }
}
```

**Standard Error Codes (`HTTP Status`):**
- `INVALID_ARGUMENT` (`400`), `INVALID_DOCUMENT_PATH` (`400`), `INVALID_CURSOR` (`400`), `QUERY_TOO_COMPLEX` (`400`)
- `UNAUTHENTICATED` (`401`)
- `PERMISSION_DENIED` (`403`)
- `NOT_FOUND` (`404`)
- `ALREADY_EXISTS` (`409`), `ABORTED_CONFLICT` (`409`), `FAILED_PRECONDITION` (`412`)
- `DOCUMENT_TOO_LARGE` (`413`), `PAYLOAD_TOO_LARGE` (`413`)
- `RATE_LIMITED` (`429`), `QUOTA_EXCEEDED` (`429`)
- `QUERY_DEADLINE_EXCEEDED` (`504`)
- `INTERNAL_ERROR` (`500`), `SERVICE_UNAVAILABLE` (`503`)

---

## 12. SDK Architecture (TypeScript & Flutter)

### 12.1 TypeScript SDK (`@vellumdb/sdk-js`)

```ts
import { createClient, fieldOp } from "@vellumdb/sdk-js";

const db = createClient({
  projectId: "proj_01J...",
  apiKey: "pk_...",
  getAuthToken: async () => currentUserJwt(),
});

// 1. Write with atomic transform
const userRef = db.collection("users").doc("user_123");
await userRef.set({
  name: "Alex",
  loginCount: fieldOp.increment(1),
  lastLoginAt: fieldOp.serverTimestamp(),
}, { merge: true });

// 2. Structured Query
const snapshot = await db
  .collection("users")
  .where("active", "==", true)
  .where("loginCount", ">=", 5)
  .orderBy("loginCount", "desc")
  .limit(25)
  .get();

// 3. Realtime Listener with automatic resume
const unsubscribe = db
  .collection("users/user_123/notifications")
  .where("read", "==", false)
  .onSnapshot((event) => {
    for (const change of event.changes) {
      console.log(change.type, change.doc.id, change.doc.data());
    }
  });
```

### 12.2 Flutter/Dart SDK (`vellum_flutter`)

Exposes idiomatic Dart streams (`Stream<QuerySnapshot<T>>`), `withConverter<T>()` for type-safe Dart model serialization, automatic connectivity monitoring, and background WebSocket lifecycle management on iOS/Android/Web.

---

## 13. Dashboard Applications

### 13.1 Customer Dashboard (`apps/dashboard`)

1. **Auth & Onboarding:** Sign up, sign in, MFA setup, create organization, create project.
2. **Project Context:** the active project is shown in the header and breadcrumbs; there is no environment switcher.
3. **Database Explorer:** Split-pane 3-column tree browser (`Collection` $\rightarrow$ `Document List` $\rightarrow$ `Typed Field Editor` with visual badges for `timestamp`, `ref`, `int64`, `geo`).
4. **Query Playground:** Constrained visual query builder + execution plan timing badge (`executionTimeMs`, `indexUsed`).
5. **Security Rules Studio:** Visual AST builder + JSON editor with a built-in **Rule Simulator** (test any `auth.uid`, `path`, and `operation` before publishing).
6. **Composite Index Manager:** View index status (`building`, `ready`, `failed`) and one-click creation from missing-index error links.
7. **API Keys & Auth Config:** Generate/rotate `pk_` and `sk_` keys; configure custom JWT JWKS URL and issuer for end-user token verification.
8. **Usage & Billing:** Daily read/write/storage charts, quota alerts, and plan management.

### 13.2 Platform Owner Admin Dashboard (`apps/admin`)

Protected by `users.platform_role IN ('owner', 'admin', 'support_readonly')` enforced in middleware and server actions:
- Global cluster health, connection pool saturation, and outbox lag metrics.
- Tenant lookup, quota override, project throttling/suspension controls (emergency kill-switch for noisy neighbors).
- Full immutable `audit_logs` explorer.
- **Privacy by Default:** Platform operators cannot view customer `documents.data` payloads in the admin UI.

---

## 14. Monorepo & Docker Deployment Architecture

### 14.1 Repository Structure

```text
vellum/
├── apps/
│   ├── api/                 # Hono HTTP + WebSocket entry point (Vercel & Node server)
│   ├── dashboard/           # Customer developer dashboard (Next.js 15)
│   └── admin/               # Platform owner dashboard (Next.js 15)
├── packages/
│   ├── core/                # Paths, Tagged Wire Format, SortKey encoder, Limits
│   ├── api-contract/        # Zod schemas, OpenAPI spec, WS frame types
│   ├── database-control/    # Drizzle schema & migrations for Control Plane
│   ├── database-data/       # Drizzle schema & migrations for Data Plane
│   ├── storage/             # Storage interfaces + PostgreSQL/Neon adapter
│   ├── authorization/       # Key verification, JWT verifier, Security Rules AST engine
│   ├── query-engine/        # Query validation, index selector, SQL compiler, cursors
│   ├── document-engine/     # CRUD, field transforms, batch & OCC transactions
│   ├── realtime/            # Outbox publisher/poller, WS multiplexer, Redis fan-out
│   ├── sdk-js/              # Public TypeScript/JavaScript SDK
│   └── observability/       # Pino logger, OpenTelemetry helpers, rate limiter
├── sdks/
│   └── flutter/             # First-class Dart/Flutter package (vellum_flutter)
├── docker/
│   ├── Dockerfile.api       # Production Node.js container image for API + Realtime
│   └── docker-compose.yml   # Local PostgreSQL (Control + Data) + Redis stack
├── tests/
│   ├── integration/         # Real Postgres CRUD, query, transaction, and outbox tests
│   ├── security/            # Cross-tenant isolation, RLS, and AST rule bypass tests
│   └── load/                # k6 scripts for CRUD and WebSocket concurrency
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json
```

### 14.2 Production `Dockerfile.api` (Portable Node.js Container)

```dockerfile
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @vellum/api... build
RUN pnpm --filter @vellum/api --prod deploy /prod/api

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 vellum && adduser --system --uid 1001 vellum
COPY --from=build --chown=vellum:vellum /prod/api ./
USER vellum
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/v1/health || exit 1
CMD ["node", "dist/node-server.js"]
```

---

## 15. Background Maintenance & Operational Workers

To keep the Data Plane fast and bounded, run three idempotent background jobs (triggered via Vercel Cron in MVP or an internal worker loop in Docker):

1. **Index Builder Worker (Every 30s or Event-Driven):**
   - Picks up `document_indexes` where `status = 'building'`.
   - Scans existing documents in `collection_path` in batches of $500$ ordered by `document_id`, computes `sort_key`, inserts into `document_index_entries` (`ON CONFLICT DO NOTHING`), and flips status to `'ready'`.
2. **Realtime Outbox Compaction (Every 15m):**
   - Deletes rows from `realtime_outbox` where `committed_at < now() - interval '24 hours'` in bounded batches of $10,000$ rows.
3. **Soft-Delete Tombstone Purge (Every 1h):**
   - Hard-deletes rows from `documents` where `deleted_at < now() - (soft_delete_retention_days || ' days')::interval` in bounded batches of $5,000$ rows.

---

## 16. Step-by-Step Execution Roadmap (Ready to Build)

### Phase 0: Foundation & Dual-Database Setup (Days 1–3)
- Initialize `pnpm` workspace, `tsconfig.base.json`, Vitest, and `docker/docker-compose.yml` (two Postgres instances: `control_db:5432`, `data_db:5433`; no broker or cache service).
- Implement `packages/database-control` and `packages/database-data` with the exact SQL schemas from Sections 5 and 6.3.
- Implement `packages/core` (Path validator, Tagged Wire Format serializer, and Order-Preserving `sort_key` byte encoder with 100% unit test coverage).

### Phase 1: Control Plane, Auth & API Keys (Days 4–7)
- Integrate Better Auth in `apps/dashboard` connected to `control_db`.
- Build organization, project, and `pk_`/`sk_` API key management services.
- Implement `packages/authorization` (API key prefix lookup, SHA-256 verification, JWT verification, and Security Rules AST Evaluator).

### Phase 2: Document Engine & Storage Adapter (Days 8–13)
- Implement `packages/storage` with Neon/Postgres transaction context (`SET LOCAL app.current_project_id`) and RLS policies.
- Implement `packages/document-engine` for `create`, `get`, `set`, `update`, `delete`, atomic field transforms, and batch writes.
- Expose `/v1/projects/:projectId/documents/*` in `apps/api` using Hono + Zod OpenAPI.

### Phase 3: Query Engine & Composite Indexing (Days 14–19)
- Implement `packages/query-engine` (`where`, `orderBy`, `limit`, HMAC cursors, and SQL compiler).
- Implement synchronous `document_index_entries` maintenance on document write + asynchronous index backfill worker.
- Verify query plans with `EXPLAIN (ANALYZE, BUFFERS)` and integration tests.

### Phase 4: SDKs & Interactive OCC Transactions (Days 20–25)
- Build `packages/sdk-js` with typed references, field operations, and automatic OCC transaction retries.
- Build `sdks/flutter` (`vellum_flutter`) matching the Wire Format and REST/WebSocket contracts.

### Phase 5: Realtime Gateway & Customer/Admin Dashboards (Days 26–32)
- Implement `packages/realtime` (WebSocket frame handler, `realtime_outbox` writer, Redis Pub/Sub fan-out, and `seq_id` catch-up poller).
- Complete Customer Dashboard (Database Explorer, Query Playground, Security Rules Studio, Index Manager) and Platform Owner Admin Dashboard.

### Phase 6: Security, Load Testing & Production Launch (Days 33–35)
- Run cross-tenant security suite (`tests/security`) and k6 load test suite (`tests/load`).
- Execute backup/restore drill on Neon branches and verify zero-change container deployment using `docker/Dockerfile.api`.