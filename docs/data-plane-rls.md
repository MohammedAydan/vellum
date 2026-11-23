# Data Plane Row-Level Security (RLS) & Multi-Tenant Isolation

> **Scope:** Authoritative engineering specification for PostgreSQL Row-Level Security (RLS), single-round-trip tenant context binding, and multi-tenant isolation in `data_db`.  
> **Grounded in:** `packages/database-data/src/rls.ts`, `packages/storage/src/tx-context.ts`, `packages/database-data/migrations/0001_init_data_plane.sql` through `0011_drop_environments.sql`.

---

## 1. Architectural Philosophy: Fail-Closed Defense in Depth

Relying exclusively on application-layer `WHERE project_id = $1` predicates is fragile—a single omitted filter or ad-hoc SQL statement could expose another tenant's data. VELLUM enforces **two independent isolation barriers** on every Data Plane operation:

1. **Application & Compiler Layer:** Every query compiled by `@vellum/query-engine` and every statement in `@vellum/storage` explicitly binds `project_id = $1::uuid`.
2. **PostgreSQL Engine Layer (`FORCE ROW LEVEL SECURITY`):** All **12** tenant-scoped tables in `data_db` enforce `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` (so even the table owner cannot accidentally bypass RLS).

The **project** (`project_id` UUID) is the sole tenant and the only RLS dimension (`app.current_project_id`). If any query runs without binding `app.current_project_id`, PostgreSQL evaluates the policy to `NULL` (falsy in SQL 3-valued logic) and **fails closed**: `SELECT` returns zero rows, and `INSERT`/`UPDATE`/`DELETE` raises an RLS policy violation.

---

## 2. All 12 Protected Data Plane Tables (`RLS_TENANT_TABLES`)

Defined canonically in `packages/database-data/src/rls.ts`:

| # | Table | Purpose | Least-Privilege Role Grant |
| :-: | :--- | :--- | :--- |
| 1 | `documents` | Customer JSONB documents, versions, tombstones, and TTL (`expires_at`) | `SELECT, INSERT, UPDATE, DELETE` to `vellum_app` |
| 2 | `document_indexes` | Tenant-defined composite index definitions and build statuses | `SELECT, INSERT, UPDATE, DELETE` to `vellum_app` |
| 3 | `document_index_entries` | Order-preserving `sort_key BYTEA` entries for composite B-Tree scans | `SELECT, INSERT, UPDATE, DELETE` to `vellum_app` |
| 4 | `realtime_outbox` | Transactional mutation log (`seq_id BIGSERIAL`) for WebSocket fan-out | `SELECT, INSERT, UPDATE, DELETE` to `vellum_app` |
| 5 | `project_collections` | Registered collection metadata and lifecycle state | `SELECT, INSERT, UPDATE, DELETE` to `vellum_app` |
| 6 | `project_auth_users` | Project end-user accounts (`project_end_user` realm) | `SELECT, INSERT, UPDATE, DELETE` to `vellum_app` |
| 7 | `project_auth_identities` | Linked OAuth/provider identities for project end users | `SELECT, INSERT, UPDATE, DELETE` to `vellum_app` |
| 8 | `project_auth_sessions` | End-user refresh sessions and rotation grace windows | `SELECT, INSERT, UPDATE, DELETE` to `vellum_app` |
| 9 | `project_auth_mfa` | End-user TOTP/MFA enrollment secrets | `SELECT, INSERT, UPDATE, DELETE` to `vellum_app` |
| 10 | `project_auth_tokens` | Email verification, password reset, and magic-link tokens | `SELECT, INSERT, UPDATE, DELETE` to `vellum_app` |
| 11 | `transactions` | Durable OCC interactive transaction state and read-set versions | `SELECT, INSERT, UPDATE, DELETE` to `vellum_app` |
| 12 | `batch_idempotency_keys` | 24-hour durable idempotency replay ledger for `batchWrite` | `SELECT, INSERT, UPDATE, DELETE` to `vellum_app` |

---

## 3. Fail-Closed RLS Policy Template

Applied idempotently across all 12 tables by `INIT_DATA_PLANE_SQL` / `ensureRlsPolicies()` (`packages/database-data/src/rls.ts`) and migrations `0002` / `0010` / `0011`:

```sql
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_rls_documents ON documents;
CREATE POLICY tenant_rls_documents ON documents FOR ALL
  USING (project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid)
  WITH CHECK (project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid);
```

### Why `NULLIF(current_setting('app.current_project_id', true), '')::uuid`?
- `missing_ok = true` prevents an unhandled PostgreSQL error if the GUC was never set in the session.
- `NULLIF(..., '')` converts an empty string (e.g., after `resetTenantContext()`) into `NULL` instead of throwing an invalid UUID cast error.
- Because `project_id = NULL` evaluates to `UNKNOWN` in SQL, every `USING` and `WITH CHECK` clause fails closed.

---

## 4. Single-Round-Trip Transaction Context Binding

VELLUM eliminates multi-statement GUC setup overhead and guarantees zero cross-tenant leakage across pooled connections (PgBouncer / Neon transaction pooling).

### 4.1 Hardened RLS Context Helper (`packages/database-data/src/rls.ts`)

`buildTenantContextQuery()` and `withTenantContext()` validate all inputs **before** acquiring a pooled connection and bind all transaction-local GUCs in **one parameterized round-trip**:

```sql
SELECT
  set_config('app.current_project_id', $1, true),
  set_config('statement_timeout', $2, true),
  set_config('lock_timeout', $3, true),
  set_config('idle_in_transaction_session_timeout', $4, true)
  -- optional: set_config('app.current_user_id', $5, true),
  --           set_config('app.current_role', $6, true),
  --           set_config('app.current_claims', $7, true),
  --           set_config('role', $8, true)
```

| Guard / Default | Value | Enforcement |
| :--- | :--- | :--- |
| `is_local` flag | Literal `true` | Settings exist **only** for the current transaction and vanish automatically on `COMMIT`/`ROLLBACK`. |
| `projectId` validation | Anchored 36-char UUID, nil UUID (`00000000-...`) rejected by default | `assertValidProjectId()` throws `RlsValidationError("INVALID_PROJECT_ID")` before pool checkout. |
| `DEFAULT_STATEMENT_TIMEOUT_MS` | `5,000 ms` (max `300,000 ms`) | Prevents slow-query DoS. |
| `DEFAULT_LOCK_TIMEOUT_MS` | `2,000 ms` (max `300,000 ms`) | Prevents lock-wait pileups. |
| `DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `15,000 ms` (max `300,000 ms`) | Reaps abandoned transactions. |
| `sanitizeRoleName()` | `/^[a-z_][a-z0-9_]{0,62}$/` | Blocks `pg_*` and privileged roles (`postgres`, `superuser`, `admin`, `root`, `neon_superuser`, `rdsadmin`, `rds_superuser`, `cloudsqlsuperuser`, `cloudsqladmin`, `azure_pg_admin`). |
| `sanitizeClaims()` | Max `4,096` bytes, `32` keys, depth `3` | Rejects `__proto__`/`constructor`/`prototype`, non-plain objects, and control chars. |
| Tainted-socket destruction | `client.release(destroyError)` | If `ROLLBACK` fails on a pooled client, the pool destroys the connection instead of reusing it. |

### 4.2 Storage Adapter Execution (`packages/storage/src/tx-context.ts`)

`packages/storage` layers three additional concurrency guarantees onto tenant transactions:
1. **Single-Round-Trip `pg` Path:** `buildPgTenantSetupSql(projectId)` validates the UUID against `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` and issues `BEGIN; SET LOCAL statement_timeout = '5000ms'; SET LOCAL search_path = public; SELECT set_config('app.current_project_id', '<uuid>', true)` in one simple-query round-trip (pinning `search_path = public` for Neon pooler safety). The Neon/parameterized path uses `BEGIN` + `SQL_SET_TENANT_CONTEXT_PARAMETERIZED`.
2. **Nested Re-Entrant `SAVEPOINT`s:** `AsyncLocalStorage` tracks the active transaction frame. Re-entering `withTransaction()` on the same pool and same `projectId` uses `SAVEPOINT vellum_sp_N` / `RELEASE SAVEPOINT` / `ROLLBACK TO SAVEPOINT`; attempting to nest a **different** `projectId` fails closed immediately with `PERMISSION_DENIED`.
3. **Automatic `40001` / `40P01` Retries:** Top-level transactions automatically retry PostgreSQL serialization failures (`40001`) and deadlocks (`40P01`) up to `3` times with jittered backoff (`15 ms` base).

---

## 5. Least-Privilege Runtime Role (`vellum_app`)

- **Migrations & DDL** always run using the privileged `CONTROL_DATABASE_URL` / `DATA_DATABASE_URL` (or `*_DIRECT` unpooled URLs).
- **Request-time traffic** can be isolated to a non-superuser, `NOBYPASSRLS` PostgreSQL role (`vellum_app`) by supplying `DATA_DATABASE_APP_URL` and `CONTROL_DATABASE_APP_URL` in `.env`.
- `INIT_DATA_PLANE_SQL` automatically grants `SELECT, INSERT, UPDATE, DELETE` on all 12 tenant tables to `vellum_app` whenever that role exists, with zero DDL privileges.

---

## 6. Automated Verification

Run the RLS and isolation test suites directly:

```bash
corepack pnpm test:security
corepack pnpm --filter @vellum/database-data test
corepack pnpm --filter @vellum/storage test
```

Verified invariants include:
- Cross-tenant reads and writes return zero rows / `403 PERMISSION_DENIED`.
- Unbound or empty `app.current_project_id` fails closed on all 12 tables.
- Nested cross-tenant transaction attempts throw `PERMISSION_DENIED`; nested same-tenant transactions use `SAVEPOINT`.
- Transient `40001`/`40P01` errors retry cleanly, and failed `ROLLBACK`s destroy the pooled client.
- `resetTenantContext()` explicitly clears all four `app.current_*` GUCs to `''` (fail-closed).
