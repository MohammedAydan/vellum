-- Control Plane: three-realm auth isolation.
--
-- Adds a platform-super-admin flag to users (only the seeded owner/backfill and the
-- explicit, trusted `setPlatformSuperAdmin` repository method may grant it) and a
-- dedicated refresh-session table for the two control-plane realms:
--   customer_console  -> CONSOLE_JWT_SECRET  / docdb+console+jwt
--   super_admin       -> SUPER_ADMIN_JWT_SECRET / docdb+superadmin+jwt
--
-- Refresh/access token hashes are SHA-256 hex strings computed by callers; no raw
-- tokens, JWTs or secrets are ever stored here. This table lives in control_db and
-- is independent of the public document API (no circular bootstrap dependency).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Platform super-admin flag. Signup always forces FALSE; the only ways to set
--    it TRUE are this idempotent seed backfill and the trusted repository method.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE users SET is_platform_super_admin = TRUE
 WHERE LOWER(email) = 'visual-admin@docdb.dev'
   AND platform_role IN ('owner', 'admin');

-- 2. Durable refresh sessions for the two control-plane realms. The data-plane
--    (project_end_user) sessions live in data_db.project_auth_sessions instead.
CREATE TABLE IF NOT EXISTS control_plane_refresh_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  realm TEXT NOT NULL CHECK (realm IN ('customer_console', 'super_admin')),
  access_token_hash TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  previous_refresh_token_hash TEXT,
  rotated_at TIMESTAMPTZ,
  rotation_counter INTEGER NOT NULL DEFAULT 0,
  ip_address TEXT,
  user_agent TEXT,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_reason TEXT,
  access_expires_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cp_sessions_user_realm
  ON control_plane_refresh_sessions (user_id, realm)
  WHERE revoked = FALSE;

CREATE INDEX IF NOT EXISTS idx_cp_sessions_refresh
  ON control_plane_refresh_sessions (refresh_token_hash);

CREATE INDEX IF NOT EXISTS idx_cp_sessions_prev_refresh
  ON control_plane_refresh_sessions (previous_refresh_token_hash)
  WHERE previous_refresh_token_hash IS NOT NULL;
