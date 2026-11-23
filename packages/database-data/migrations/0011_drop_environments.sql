-- FULL CUTOVER: drop the environment concept from the data plane (`data_db`).
--
-- Tenant == project. Every `environment_id` column is dropped; every primary key,
-- unique constraint and index that used it is rebuilt on `project_id` only, and
-- every RLS policy is replaced by a single fail-closed `tenant_rls_<table>`
-- policy keyed on `app.current_project_id` only (ENABLE + FORCE RLS retained).
--
-- This migration is immutable and idempotent: it is safe to re-run against a
-- plane that is already at the post-cutover shape. Existing applied migrations
-- 0001-0010 are never edited.
--
-- Live order (see docs/NO-ENVIRONMENTS-CONTRACT.md): back up, stop the API,
-- apply this migration, restart the API from the new build, run all gates.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Tables that carry tenant data ------------------------------------------------
-- Every one of these is RLS-scoped and must be keyed on project_id only.
DO $tables$
DECLARE
  t text;
  pol record;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'documents',
    'document_indexes',
    'document_index_entries',
    'realtime_outbox',
    'project_collections',
    'project_auth_users',
    'project_auth_identities',
    'project_auth_sessions',
    'project_auth_mfa',
    'project_auth_tokens',
    'transactions',
    'batch_idempotency_keys'
  ] LOOP
    -- 1. Drop EVERY existing policy on the table (0001/0002/0004/0005/0009/0010
    --    named them differently; enumerating pg_policies catches them all).
    --    %I quotes policy and table names as identifiers, never as values.
    FOR pol IN
      SELECT policyname FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
    LOOP
      EXECUTE format('DROP POLICY %I ON %I', pol.policyname, t);
    END LOOP;

    -- 2. Dropping the column CASCADEes away every constraint, primary key,
    --    unique index, plain index and policy that referenced it.
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS environment_id CASCADE', t);

    -- 3. Fail-closed RLS: ENABLE + FORCE (the owner is subject to policies too).
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    -- 4. One policy per table covering all commands, with BOTH sides checked.
    --    A missing/empty GUC makes current_setting(..., true) return NULL, so the
    --    comparison is NULL and RLS fails closed for the least-privilege role.
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL ' ||
      'USING (project_id = NULLIF(current_setting(''app.current_project_id'', true), '''')::uuid) ' ||
      'WITH CHECK (project_id = NULLIF(current_setting(''app.current_project_id'', true), '''')::uuid)',
      'tenant_rls_' || t, t
    );

    -- 5. Least-privilege grants, guarded because docdb_app is created in 0002
    --    and may not exist in an isolated/fresh plane.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'docdb_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO docdb_app', t);
    END IF;
  END LOOP;
END
$tables$;

-- Rebuild primary keys that included environment_id ----------------------------
DO $pk_documents$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public' AND rel.relname = 'documents' AND c.contype = 'p'
  ) THEN
    ALTER TABLE documents ADD CONSTRAINT documents_pkey PRIMARY KEY (project_id, path);
  END IF;
END
$pk_documents$;

DO $pk_idempotency$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public' AND rel.relname = 'batch_idempotency_keys' AND c.contype = 'p'
  ) THEN
    ALTER TABLE batch_idempotency_keys ADD CONSTRAINT batch_idempotency_keys_pkey
      PRIMARY KEY (project_id, idempotency_key);
  END IF;
END
$pk_idempotency$;

-- Rebuild documents indexes (0001 + 0007) on project_id only ------------------
CREATE INDEX IF NOT EXISTS idx_docs_collection_id_active
  ON documents (project_id, collection_path, document_id ASC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_docs_collection_updated_active
  ON documents (project_id, collection_path, updated_at DESC, document_id ASC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_docs_collection_created_active
  ON documents (project_id, collection_path, created_at DESC, document_id ASC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_docs_data_gin_active
  ON documents USING GIN (data jsonb_path_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_docs_tombstones
  ON documents (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_docs_expires_at
  ON documents (project_id, expires_at)
  WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_docs_collection_cover_active
  ON documents (project_id, collection_path, updated_at DESC, document_id)
  WHERE deleted_at IS NULL;

-- Composite index definitions / entries ---------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_indexes_def
  ON document_indexes (project_id, collection_path, definition_hash);

CREATE INDEX IF NOT EXISTS idx_index_entries_doc_cleanup
  ON document_index_entries (project_id, path);

-- The document_index_entries PK (index_id, sort_key, document_id) never carried
-- environment_id and survives the CASCADE; nothing to rebuild there.

-- Realtime outbox --------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_outbox_project_seq
  ON realtime_outbox (project_id, seq_id ASC);

CREATE INDEX IF NOT EXISTS idx_outbox_cleanup
  ON realtime_outbox (committed_at);

-- Kept: the transactional wake-up NOTIFY, with the environmentId JSON member
-- removed. The poller still fetches full rows from realtime_outbox.
CREATE OR REPLACE FUNCTION docdb_notify_outbox_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM pg_notify(
    'docdb_outbox',
    json_build_object(
      'seqId', NEW.seq_id,
      'projectId', NEW.project_id
    )::text
  );
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_docdb_outbox_notify ON realtime_outbox;

CREATE TRIGGER trg_docdb_outbox_notify
AFTER INSERT ON realtime_outbox
FOR EACH ROW
EXECUTE FUNCTION docdb_notify_outbox_insert();

-- Project collections registry (0009) -----------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_collections_name
  ON project_collections (project_id, name);

CREATE INDEX IF NOT EXISTS idx_project_collections_name
  ON project_collections (project_id, name ASC);

-- End-user auth tables (0005/0006) ---------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_email
  ON project_auth_users (project_id, LOWER(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_auth_users_phone
  ON project_auth_users (project_id, phone_number)
  WHERE phone_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_auth_users_created
  ON project_auth_users (project_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_identities_provider
  ON project_auth_identities (project_id, provider, provider_user_id);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user
  ON project_auth_identities (project_id, user_id);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
  ON project_auth_sessions (project_id, user_id)
  WHERE revoked = FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_mfa_factor
  ON project_auth_mfa (project_id, user_id, factor_type);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_lookup
  ON project_auth_tokens (project_id, token_hash)
  WHERE consumed_at IS NULL;

-- OCC transaction ledger (0004/0010) ------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_token_hash
  ON transactions (token_hash);

CREATE INDEX IF NOT EXISTS idx_transactions_expires_at
  ON transactions (expires_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_transactions_tenant
  ON transactions (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tx_tenant_status_exp
  ON transactions (project_id, status, expires_at);

-- Batch idempotency ledger (0010) ----------------------------------------------
CREATE INDEX IF NOT EXISTS idx_idempotency_expires
  ON batch_idempotency_keys (expires_at);

-- Sequence grant for the outbox BIGSERIAL (guarded) -----------------------------
DO $seq$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'docdb_app')
     AND EXISTS (
       SELECT 1 FROM pg_class
        WHERE relname = 'realtime_outbox_seq_id_seq' AND relkind = 'S'
     ) THEN
    GRANT USAGE, SELECT ON SEQUENCE realtime_outbox_seq_id_seq TO docdb_app;
  END IF;
END
$seq$;
