-- Project Collections Registry (`data_db`) — Collections Lifecycle Phase 1
--
-- Introduces a durable, tenant-scoped registry of collections so that empty
-- collections (and their metadata: description, TTL, validation, etc.) survive
-- F5/restarts instead of living in client-only state.
--
-- Follows the exact RLS pattern from 0002_rls_hardening.sql:
--   * ENABLE + FORCE ROW LEVEL SECURITY (table owner is subject to policies).
--   * Four per-command policies named tenant_rls_project_collections_* that
--     compare project_id/environment_id against the transaction-local GUCs set
--     by packages/storage. Missing context => NULL => fail closed.
--   * Least-privilege grants to `docdb_app` (guarded: the role is created in
--     0002, but the guard keeps this migration safe in isolated environments).
--
-- Idempotency: CREATE TABLE/INDEX IF NOT EXISTS, an explicit DO block that drops
-- this migration's policy names before recreating them (PostgreSQL has no
-- CREATE POLICY IF NOT EXISTS), and ON CONFLICT DO NOTHING on the backfill.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Table ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  default_ttl_seconds INT CHECK (default_ttl_seconds IS NULL OR default_ttl_seconds > 0),
  schema_validation JSONB,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, environment_id, name)
);

CREATE INDEX IF NOT EXISTS idx_project_collections_env_name
  ON project_collections (project_id, environment_id, name ASC);

-- 2. Backfill existing legacy collections ---------------------------------------------
-- Deliberately runs BEFORE FORCE ROW LEVEL SECURITY so the table owner (this
-- migration's connection) is not subjected to the tenant WITH CHECK policies
-- while copying rows. Source column is `collection_path`, not a split of `path`.
INSERT INTO project_collections (project_id, environment_id, name, created_at, updated_at)
SELECT project_id, environment_id, collection_path, MIN(created_at), MAX(updated_at)
FROM documents
WHERE collection_path IS NOT NULL AND collection_path <> ''
GROUP BY project_id, environment_id, collection_path
ON CONFLICT (project_id, environment_id, name) DO NOTHING;

-- 3. Defense-in-depth RLS -------------------------------------------------------------
ALTER TABLE project_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_collections FORCE  ROW LEVEL SECURITY;

-- Idempotency for this migration's own policy names.
DO $drop$
DECLARE
  p text;
BEGIN
  FOREACH p IN ARRAY ARRAY['select','insert','update','delete'] LOOP
    -- Quote the *whole* policy name as one identifier (same as 0002).
    EXECUTE format('DROP POLICY IF EXISTS %I ON project_collections', 'tenant_rls_project_collections_' || p);
  END LOOP;
END
$drop$;

CREATE POLICY tenant_rls_project_collections_select ON project_collections
  FOR SELECT USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_project_collections_insert ON project_collections
  FOR INSERT WITH CHECK (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_project_collections_update ON project_collections
  FOR UPDATE USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  ) WITH CHECK (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_project_collections_delete ON project_collections
  FOR DELETE USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );

-- 4. Least-privilege application grants ------------------------------------------------
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'docdb_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON project_collections TO docdb_app;
  END IF;
END
$grant$;
