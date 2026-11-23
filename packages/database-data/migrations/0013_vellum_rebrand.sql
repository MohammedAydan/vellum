-- 0013_vellum_rebrand.sql — Data plane
--
-- Hard-break rebrand of runtime database objects from docdb_* to vellum_*.
-- The historical migration files that created the old objects are
-- intentionally left untouched (applied migrations are checksum-verified);
-- this forward migration performs the rename on live databases. Fresh
-- databases run 0002/0003/0011 first (creating the docdb_* objects) and then
-- immediately rename them here, so every environment converges on vellum_*.

-- Shared-cluster-safe convergence. Roles are cluster-global: never rename,
-- drop, or change attributes/memberships of a role another database may use.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vellum_app') THEN
    CREATE ROLE vellum_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $role$;

GRANT USAGE ON SCHEMA public TO vellum_app;
-- Deliberate allowlist, not ALL TABLES: future administrative tables must not
-- silently become accessible to the runtime role. RLS policies are TO PUBLIC
-- and remain enforced for the new role without copying an old role's powers.
DO $grants$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'documents','document_indexes','document_index_entries','realtime_outbox',
    'transactions','project_auth_users','project_auth_identities',
    'project_auth_sessions','project_auth_mfa','project_auth_tokens',
    'project_collections','batch_idempotency_keys'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO vellum_app', t);
    END IF;
  END LOOP;
  IF to_regclass('public.realtime_outbox_seq_id_seq') IS NOT NULL THEN
    GRANT USAGE, SELECT ON SEQUENCE public.realtime_outbox_seq_id_seq TO vellum_app;
  END IF;
END $grants$;

-- 2. Realtime outbox wake-up channel: docdb_outbox -> vellum_outbox, with the
--    trigger function and trigger renamed to match. LISTEN/NOTIFY is only a
--    wake-up hint — the outbox poller reads durable rows from
--    realtime_outbox — so rows inserted on the old channel during the
--    switchover are still delivered by the first poll after deploy.
CREATE OR REPLACE FUNCTION vellum_notify_outbox_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM pg_notify(
    'vellum_outbox',
    json_build_object(
      'seqId', NEW.seq_id,
      'projectId', NEW.project_id
    )::text
  );
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_docdb_outbox_notify ON realtime_outbox;
DROP FUNCTION IF EXISTS docdb_notify_outbox_insert();

DROP TRIGGER IF EXISTS trg_vellum_outbox_notify ON realtime_outbox;
CREATE TRIGGER trg_vellum_outbox_notify
AFTER INSERT ON realtime_outbox
FOR EACH ROW
EXECUTE FUNCTION vellum_notify_outbox_insert();
