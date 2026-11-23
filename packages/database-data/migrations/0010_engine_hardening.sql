-- Engine Hardening (`data_db`) — Phase 1A ( migrations + Drizzle schema )
--
-- Adds the durable state required to harden the document engine without
-- introducing any new stateful service (Zero-Redis doctrine):
--
--   * `transactions` gains `committed_at` / `rolled_back_at` so the terminal
--     state of an OCC ledger row is itself durable, plus two indexes: a UNIQUE
--     index on `token_hash` (a signed token can only ever be begun once) and a
--     tenant/status/expiry index for cleanup + status lookups.
--   * `batch_idempotency_keys` is a durable, tenant-scoped cache of a committed
--     batchWrite response. The (project, environment, key) triple is the PK, so
--     a retried batch after a client timeout cannot be applied twice; the
--     stored response hash/payload lets the gateway replay the original result.
--     Rows self-expire via `expires_at` (24h default) and the expiry index keeps
--     the reaper O(expired).
--
-- `batch_idempotency_keys` follows the exact FORCE ROW LEVEL SECURITY pattern
-- from 0009_project_collections.sql: ENABLE + FORCE RLS, four per-command
-- policies named tenant_rls_batch_idempotency_keys_* that compare the tenant
-- columns against the transaction-local GUCs set by packages/storage
-- (app.current_project_id / app.current_environment_id). Missing context
-- evaluates to NULL and RLS fails closed for the least-privilege `docdb_app`
-- role. Least-privilege grants are guarded so this migration is safely
-- applicable to a plane that has not yet run 0002.
--
-- Idempotency: every DDL is IF NOT EXISTS; policies have no CREATE IF NOT EXISTS
-- in PostgreSQL, so an explicit DO block drops this migration's policy names
-- before recreating them.

-- 1. OCC transaction ledger columns + indexes --------------------------------------
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_token_hash
  ON transactions (token_hash);

CREATE INDEX IF NOT EXISTS idx_tx_tenant_status_exp
  ON transactions (project_id, environment_id, status, expires_at);

-- 2. Durable batch idempotency ledger ------------------------------------------------
CREATE TABLE IF NOT EXISTS batch_idempotency_keys (
  project_id      UUID NOT NULL,
  environment_id  UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  response_hash   TEXT NOT NULL,
  response_payload JSONB NOT NULL,
  committed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (project_id, environment_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires
  ON batch_idempotency_keys (expires_at);

-- 3. Defense-in-depth RLS (ENABLE + FORCE, same template as 0009) --------------------
ALTER TABLE batch_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_idempotency_keys FORCE  ROW LEVEL SECURITY;

DO $drop$
DECLARE
  p text;
BEGIN
  FOREACH p IN ARRAY ARRAY['select','insert','update','delete'] LOOP
    -- Quote the *whole* policy name as one identifier (same as 0009).
    EXECUTE format('DROP POLICY IF EXISTS %I ON batch_idempotency_keys', 'tenant_rls_batch_idempotency_keys_' || p);
  END LOOP;
END
$drop$;

CREATE POLICY tenant_rls_batch_idempotency_keys_select ON batch_idempotency_keys
  FOR SELECT USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_batch_idempotency_keys_insert ON batch_idempotency_keys
  FOR INSERT WITH CHECK (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_batch_idempotency_keys_update ON batch_idempotency_keys
  FOR UPDATE USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  ) WITH CHECK (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_batch_idempotency_keys_delete ON batch_idempotency_keys
  FOR DELETE USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );

-- 4. Least-privilege application grants (guarded, same as 0009) ----------------------
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'docdb_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON batch_idempotency_keys TO docdb_app;
  END IF;
END
$grant$;
