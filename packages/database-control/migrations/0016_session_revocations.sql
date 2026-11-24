-- 0016_session_revocations.sql — Control plane
--
-- Additive only. Session revocations were held in process memory, so a sign-out on one API
-- instance was invisible to the others. They now live in the database.
CREATE TABLE IF NOT EXISTS session_revocations (
  jti        TEXT        PRIMARY KEY,
  realm      TEXT        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_session_revocations_expires ON session_revocations (expires_at);

-- Organization membership is read on every console/admin request by user id; the primary key
-- starts with organization_id, so the user lookup needs its own index.
CREATE INDEX IF NOT EXISTS idx_organization_members_user ON organization_members (user_id);
