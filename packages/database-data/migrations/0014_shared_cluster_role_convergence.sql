-- Forward repair for databases that already applied the historical 0013.
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
