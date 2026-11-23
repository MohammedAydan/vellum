-- Data Plane: native PostgreSQL OCC transaction ledger (`data_db`) — EPIC-3 / TASK-301..305
--
-- Replaces the process-local `Map<string, ActiveTxState>` that used to live in
-- `DocumentEngine`. An interactive transaction is now a durable row:
--
--   * `token_hash` is SHA-256 of the HMAC-signed opaque transaction token. It is
--     UNIQUE so a token can only ever be begun once (replay-safe).
--   * `read_set` is a JSON object of `{ "<document path>": <observed version> }`.
--     It is merged with `jsonb || jsonb_build_object(...)` on every read that
--     carries a transaction token, so the observed version is persisted and can
--     be shared by two *different* engine instances pointed at the same plane.
--   * `commit` takes `SELECT ... FOR UPDATE` on this row (serialising double
--     commits) and on every read-set document in `path ASC` order, compares the
--     observed versions, then applies writes + outbox rows in the same PG
--     transaction before flipping `status` to 'committed'.
--
-- No Redis, no application-level lock manager: PostgreSQL is the single source
-- of truth for both the read set and the locks.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS transactions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash     TEXT NOT NULL UNIQUE,
  project_id     UUID NOT NULL,
  environment_id UUID NOT NULL,
  read_set       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'committed', 'rolled_back')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL
);

-- Cleanup workers scan for expired *active* rows; the partial index keeps that
-- scan O(expired) instead of O(all transactions).
CREATE INDEX IF NOT EXISTS idx_transactions_expires_at
  ON transactions (expires_at)
  WHERE status = 'active';

-- Tenant-scoped lookups / opportunistic per-tenant cleanup.
CREATE INDEX IF NOT EXISTS idx_transactions_tenant
  ON transactions (project_id, environment_id, created_at DESC);

-- Defense-in-depth: same transaction-local GUC contract as every other tenant
-- table. packages/storage sets app.current_project_id / app.current_environment_id
-- inside every transaction, so a missing context evaluates to NULL and RLS
-- fails closed for the least-privilege `docdb_app` role.
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

DO $drop$
DECLARE
  p text;
BEGIN
  FOREACH p IN ARRAY ARRAY['select','insert','update','delete'] LOOP
    -- %s (not %I): p is a fixed whitelist fragment; %I would quote 'select'
    -- into "select" and produce an invalid composite identifier.
    EXECUTE format('DROP POLICY IF EXISTS tenant_rls_transactions_%s ON transactions', p);
  END LOOP;
END
$drop$;

CREATE POLICY tenant_rls_transactions_select ON transactions
  FOR SELECT USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_transactions_insert ON transactions
  FOR INSERT WITH CHECK (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_transactions_update ON transactions
  FOR UPDATE USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  ) WITH CHECK (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_transactions_delete ON transactions
  FOR DELETE USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );

-- Only meaningful once 0002 has created the least-privilege role; guard it so
-- this migration is independently applicable to a plane still at 0001.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'docdb_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON transactions TO docdb_app;
  END IF;
END
$grant$;
