-- Data Plane: end-user authentication tables (`data_db`) — EPIC-AUTH.
--
-- RUNTIME CONTRACT: packages/storage MUST issue, inside every transaction that
-- touches these tables:
--   BEGIN;
--   SET LOCAL statement_timeout = '5000ms';
--   SELECT set_config('app.current_project_id', $1, true);
--   SELECT set_config('app.current_environment_id', $2, true);
-- Missing context -> current_setting(...,true) returns NULL -> every policy
-- evaluates NULL/false -> RLS fails closed, including for the table owner.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Project End-Users
CREATE TABLE IF NOT EXISTS project_auth_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  email TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash TEXT,
  display_name TEXT,
  photo_url TEXT,
  phone_number TEXT,
  phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
  is_disabled BOOLEAN NOT NULL DEFAULT FALSE,
  is_anonymous BOOLEAN NOT NULL DEFAULT FALSE,
  custom_claims JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sign_in_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_email
  ON project_auth_users (project_id, environment_id, LOWER(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_auth_users_phone
  ON project_auth_users (project_id, environment_id, phone_number)
  WHERE phone_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_auth_users_created
  ON project_auth_users (project_id, environment_id, created_at DESC, id DESC);

-- 2. Federated Identities (OAuth / Social / Password)
CREATE TABLE IF NOT EXISTS project_auth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES project_auth_users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  provider TEXT NOT NULL, -- 'password', 'google', 'github', 'apple', 'oidc'
  provider_user_id TEXT NOT NULL,
  identity_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_sign_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, environment_id, provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_identities_user
  ON project_auth_identities (project_id, environment_id, user_id);

-- 3. Sessions & Refresh Tokens (Replay detection via previous_refresh_token_hash)
CREATE TABLE IF NOT EXISTS project_auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES project_auth_users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  previous_refresh_token_hash TEXT UNIQUE,
  rotation_counter INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT,
  ip_address TEXT,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_reason TEXT,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
  ON project_auth_sessions (project_id, environment_id, user_id)
  WHERE revoked = FALSE;

-- 4. Multi-Factor Authentication (TOTP)
CREATE TABLE IF NOT EXISTS project_auth_mfa (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES project_auth_users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  factor_type TEXT NOT NULL DEFAULT 'totp',
  secret_encrypted TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  recovery_codes_hashed JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ,
  UNIQUE (project_id, environment_id, user_id, factor_type)
);

-- 5. Action & Verification Tokens
CREATE TABLE IF NOT EXISTS project_auth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES project_auth_users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_type TEXT NOT NULL, -- email_verification, password_reset, magic_link, mfa_challenge
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_lookup
  ON project_auth_tokens (project_id, environment_id, token_hash)
  WHERE consumed_at IS NULL;

-- Fail-closed RLS on all five tables. FORCE also applies policies to the table
-- owner (the migration role), so no code path can accidentally bypass them.
DO $rls$
DECLARE
  t text;
  p text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'project_auth_users', 'project_auth_identities', 'project_auth_sessions',
    'project_auth_mfa', 'project_auth_tokens'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    FOREACH p IN ARRAY ARRAY['select','insert','update','delete'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS tenant_rls_%s_%s ON %I', t, p, t);
    END LOOP;
  END LOOP;
END
$rls$;

-- Per-command policies with USING and WITH CHECK on every table.
DO $policies$
DECLARE
  t text;
  p text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'project_auth_users', 'project_auth_identities', 'project_auth_sessions',
    'project_auth_mfa', 'project_auth_tokens'
  ] LOOP
    FOREACH p IN ARRAY ARRAY['select','insert','update','delete'] LOOP
      CASE p
        WHEN 'select' THEN
          EXECUTE format(
            'CREATE POLICY tenant_rls_%s_select ON %I FOR SELECT USING ('
            'project_id = NULLIF(current_setting(''app.current_project_id'', true), '''')::uuid '
            'AND environment_id = NULLIF(current_setting(''app.current_environment_id'', true), '''')::uuid)',
            t, t);
        WHEN 'insert' THEN
          EXECUTE format(
            'CREATE POLICY tenant_rls_%s_insert ON %I FOR INSERT WITH CHECK ('
            'project_id = NULLIF(current_setting(''app.current_project_id'', true), '''')::uuid '
            'AND environment_id = NULLIF(current_setting(''app.current_environment_id'', true), '''')::uuid)',
            t, t);
        WHEN 'update' THEN
          EXECUTE format(
            'CREATE POLICY tenant_rls_%s_update ON %I FOR UPDATE USING ('
            'project_id = NULLIF(current_setting(''app.current_project_id'', true), '''')::uuid '
            'AND environment_id = NULLIF(current_setting(''app.current_environment_id'', true), '''')::uuid) '
            'WITH CHECK ('
            'project_id = NULLIF(current_setting(''app.current_project_id'', true), '''')::uuid '
            'AND environment_id = NULLIF(current_setting(''app.current_environment_id'', true), '''')::uuid)',
            t, t);
        WHEN 'delete' THEN
          EXECUTE format(
            'CREATE POLICY tenant_rls_%s_delete ON %I FOR DELETE USING ('
            'project_id = NULLIF(current_setting(''app.current_project_id'', true), '''')::uuid '
            'AND environment_id = NULLIF(current_setting(''app.current_environment_id'', true), '''')::uuid)',
            t, t);
      END CASE;
    END LOOP;
  END LOOP;
END
$policies$;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'docdb_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      project_auth_users, project_auth_identities, project_auth_sessions,
      project_auth_mfa, project_auth_tokens TO docdb_app;
  END IF;
END
$grant$;
