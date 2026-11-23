-- Control Plane: end-user authentication configuration & Super Admin overrides.
--
-- All secrets live here (control_db), encrypted at rest with AES-256-GCM using a
-- key derived from MASTER_ENCRYPTION_KEY. End-user identities, credentials,
-- sessions, MFA factors and tokens live strictly in data_db (5 auth tables).
-- No public document API dependency: auth config is read by the API directly
-- from the Control Plane repository mirror.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS project_environment_auth_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  environment_id UUID NOT NULL UNIQUE,
  -- Super Admin Controls
  auth_service_suspended BOOLEAN NOT NULL DEFAULT FALSE,
  suspension_reason TEXT,
  max_users_quota INTEGER NOT NULL DEFAULT 50000,
  max_signups_per_hour INTEGER NOT NULL DEFAULT 1000,
  -- Customer Project Controls
  enable_email_password BOOLEAN NOT NULL DEFAULT TRUE,
  require_email_verification BOOLEAN NOT NULL DEFAULT FALSE,
  enable_anonymous_auth BOOLEAN NOT NULL DEFAULT FALSE,
  enable_totp_mfa BOOLEAN NOT NULL DEFAULT TRUE,
  enable_user_projection BOOLEAN NOT NULL DEFAULT TRUE,
  projection_collection_path TEXT NOT NULL DEFAULT 'users',
  -- Password Policy
  password_min_length INTEGER NOT NULL DEFAULT 8,
  password_require_uppercase BOOLEAN NOT NULL DEFAULT FALSE,
  password_require_number BOOLEAN NOT NULL DEFAULT TRUE,
  password_require_symbol BOOLEAN NOT NULL DEFAULT FALSE,
  -- Token Lifetimes
  access_token_ttl_seconds INTEGER NOT NULL DEFAULT 3600,
  refresh_token_ttl_days INTEGER NOT NULL DEFAULT 30,
  -- Asymmetric Signing Keys (Ed25519 / EdDSA) per environment
  jwt_key_id TEXT NOT NULL,
  jwt_public_key_pem TEXT NOT NULL,
  jwt_private_key_encrypted TEXT NOT NULL,
  -- OAuth providers (client secrets encrypted inside the JSONB document)
  oauth_providers JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Per-project SMTP override (encrypted); falls back to platform SMTP
  custom_smtp_config_encrypted TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_configs_project
  ON project_environment_auth_configs (project_id);

CREATE TABLE IF NOT EXISTS platform_auth_global_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  global_signups_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  default_max_users_per_free_project INTEGER NOT NULL DEFAULT 10000,
  default_max_users_per_pro_project INTEGER NOT NULL DEFAULT 250000,
  platform_smtp_host TEXT,
  platform_smtp_port INTEGER,
  platform_smtp_user TEXT,
  platform_smtp_pass_encrypted TEXT,
  platform_smtp_from_email TEXT NOT NULL DEFAULT 'noreply@docdb.dev',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO platform_auth_global_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
