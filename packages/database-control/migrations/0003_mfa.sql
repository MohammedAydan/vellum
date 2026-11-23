-- Control Plane · TASK-111 · Full TOTP MFA (no Redis, no stubs)
-- 0003_mfa.sql
--
-- One MFA enrollment per platform user. The TOTP secret is stored encrypted
-- (AES-256-GCM, key derived from a server-side secret) together with a keyed
-- integrity hash. Recovery codes are NEVER stored in plaintext: only their
-- HMAC-SHA256 digests and a consumption timestamp live in `recovery_codes`.
--
-- Additive only. Never edit an already-applied migration in place.

CREATE TABLE IF NOT EXISTS mfa_secrets (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc TEXT NOT NULL CHECK (length(secret_enc) > 0),
  secret_hash TEXT NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  recovery_codes JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(recovery_codes) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ,
  CONSTRAINT mfa_verified_implies_enabled CHECK (verified_at IS NULL OR enabled = TRUE)
);

-- Fast partial index for the (rare) "list enabled enrollments" operations.
CREATE INDEX IF NOT EXISTS idx_mfa_secrets_enabled
  ON mfa_secrets (enabled) WHERE enabled = TRUE;
