-- Data Plane RLS Hardening (`data_db`) — TASK-108
--
-- Companion to 0001_init_data_plane.sql. 0001 enabled RLS with a single
-- `FOR ALL ... USING` policy per table and no `WITH CHECK`, which means an
-- INSERT/UPDATE could write rows into another tenant as long as the SELECT
-- side happened to be visible. It also never FORCE'd RLS, so a table owner or
-- superuser connection silently bypassed every policy.
--
-- This migration:
--   1. Creates a dedicated least-privilege `docdb_app` role (NOLOGIN; grant
--      LOGIN via your secret manager / deployment role, never in SQL).
--   2. FORCEs RLS on every tenant-scoped table.
--   3. Replaces the permissive policies with per-command policies carrying an
--      explicit `WITH CHECK` on INSERT and UPDATE.
--
-- RUNTIME WIRING REQUIREMENT (see docs/evidence/TASK-108.md):
--   Every data-plane connection used to serve customer traffic MUST run as
--   `docdb_app` (or another non-owner role), and `packages/storage` MUST issue
--   `SET LOCAL app.current_project_id = '<uuid>'` and
--   `SET LOCAL app.current_environment_id = '<uuid>'` inside every transaction
--   before touching tenant tables. With both in place, a missing tenant
--   context makes `current_setting(..., true)` return NULL and every policy
--   evaluate to NULL/false, so RLS fails closed.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Least-privilege application role -------------------------------------------------
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'docdb_app') THEN
    CREATE ROLE docdb_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$role$;

GRANT USAGE ON SCHEMA public TO docdb_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO docdb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON document_indexes TO docdb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON document_index_entries TO docdb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON realtime_outbox TO docdb_app;

-- BIGSERIAL sequence backing realtime_outbox.seq_id.
DO $seq$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'realtime_outbox_seq_id_seq' AND relkind = 'S') THEN
    GRANT USAGE, SELECT ON SEQUENCE realtime_outbox_seq_id_seq TO docdb_app;
  END IF;
END
$seq$;

-- 2. Force RLS (also subject the table owner to policies) ------------------------------
ALTER TABLE documents              ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents              FORCE  ROW LEVEL SECURITY;
ALTER TABLE document_indexes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_indexes       FORCE  ROW LEVEL SECURITY;
ALTER TABLE document_index_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_index_entries FORCE  ROW LEVEL SECURITY;
ALTER TABLE realtime_outbox        ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime_outbox        FORCE  ROW LEVEL SECURITY;

-- 3. Drop 0001's single-policy-per-table definitions ----------------------------------
DROP POLICY IF EXISTS tenant_isolation_documents       ON documents;
DROP POLICY IF EXISTS tenant_isolation_indexes         ON document_indexes;
DROP POLICY IF EXISTS tenant_isolation_index_entries   ON document_index_entries;
DROP POLICY IF EXISTS tenant_isolation_outbox          ON realtime_outbox;

-- Idempotency for this migration's own policy names.
DO $drop$
DECLARE
  t text;
  p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['documents','document_indexes','document_index_entries','realtime_outbox'] LOOP
    FOREACH p IN ARRAY ARRAY['select','insert','update','delete'] LOOP
      -- Quote the *whole* policy name as one identifier. Quoting each fragment
      -- with %I would produce `tenant_rls_"documents"_"select"` (a syntax error).
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'tenant_rls_' || t || '_' || p, t);
    END LOOP;
  END LOOP;
END
$drop$;

-- 4. Explicit per-command policies ----------------------------------------------------
-- USING   governs which existing rows a command may see/touch.
-- WITH CHECK governs which rows INSERT/UPDATE may create/leave behind.
-- Both compare against the transaction-local GUCs set by packages/storage.

CREATE POLICY tenant_rls_documents_select ON documents
  FOR SELECT USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_documents_insert ON documents
  FOR INSERT WITH CHECK (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_documents_update ON documents
  FOR UPDATE USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  ) WITH CHECK (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_documents_delete ON documents
  FOR DELETE USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );

CREATE POLICY tenant_rls_document_indexes_select ON document_indexes
  FOR SELECT USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_document_indexes_insert ON document_indexes
  FOR INSERT WITH CHECK (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_document_indexes_update ON document_indexes
  FOR UPDATE USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  ) WITH CHECK (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_document_indexes_delete ON document_indexes
  FOR DELETE USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );

CREATE POLICY tenant_rls_document_index_entries_select ON document_index_entries
  FOR SELECT USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_document_index_entries_insert ON document_index_entries
  FOR INSERT WITH CHECK (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_document_index_entries_update ON document_index_entries
  FOR UPDATE USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  ) WITH CHECK (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_document_index_entries_delete ON document_index_entries
  FOR DELETE USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );

CREATE POLICY tenant_rls_realtime_outbox_select ON realtime_outbox
  FOR SELECT USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_realtime_outbox_insert ON realtime_outbox
  FOR INSERT WITH CHECK (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_realtime_outbox_update ON realtime_outbox
  FOR UPDATE USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  ) WITH CHECK (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
CREATE POLICY tenant_rls_realtime_outbox_delete ON realtime_outbox
  FOR DELETE USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
