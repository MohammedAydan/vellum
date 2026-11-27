-- Per-project per-IP sign-up limit (auth config) and the development-key flag
-- used by the localhost CORS development bypass (P1-3).
ALTER TABLE project_auth_configs
  ADD COLUMN IF NOT EXISTS signup_per_ip_limit INTEGER NOT NULL DEFAULT 30;

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS is_dev BOOLEAN NOT NULL DEFAULT FALSE;
