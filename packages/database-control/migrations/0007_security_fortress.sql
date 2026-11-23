-- Control Plane: Security Fortress (Fortress/Billing plan Phase 1A).
--
-- Creates the append-only, hash-chained security audit log, the threat-event
-- feed, and the active circuit-breaker blocklist. Also extends api_keys with
-- Origin/IP restrictions (expires_at and last_used_at already exist in 0001).
--
-- All DDL is idempotent: the migration runner re-runs files by checksum and
-- each file is wrapped in its own transaction.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Cryptographically hash-chained immutable security audit log -----------------
CREATE TABLE IF NOT EXISTS security_audit_logs (
  seq BIGSERIAL PRIMARY KEY,
  id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  actor_realm TEXT NOT NULL
    CONSTRAINT security_audit_logs_actor_realm_check
      CHECK (actor_realm IN ('super_admin','customer_console','project_end_user','system','anonymous')),
  actor_id TEXT,
  org_id UUID,
  project_id UUID,
  environment_id UUID,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  outcome TEXT NOT NULL
    CONSTRAINT security_audit_logs_outcome_check
      CHECK (outcome IN ('success','denied','error')),
  ip_address TEXT,
  user_agent TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_time
  ON security_audit_logs (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_time
  ON security_audit_logs (action, created_at DESC);

-- Hard immutability: blocks UPDATE and DELETE even from a superuser session.
CREATE OR REPLACE FUNCTION prevent_immutable_table_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'SECURITY_VIOLATION: Table % is strictly append-only and cannot be modified or deleted',
    TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_immutable_security_audit_logs ON security_audit_logs;
CREATE TRIGGER trg_immutable_security_audit_logs
  BEFORE UPDATE OR DELETE ON security_audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

-- 2. Real-time threat & anomaly alerts -----------------------------------------
CREATE TABLE IF NOT EXISTS security_threat_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  severity TEXT NOT NULL
    CONSTRAINT security_threat_events_severity_check
      CHECK (severity IN ('low','medium','high','critical')),
  category TEXT NOT NULL
    CONSTRAINT security_threat_events_category_check
      CHECK (category IN (
        'brute_force','token_replay','prototype_pollution','query_exhaustion',
        'ssrf_attempt','cross_tenant_probe','ws_flood','quota_abuse'
      )),
  source_ip TEXT,
  actor_id TEXT,
  org_id UUID,
  project_id UUID,
  summary TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  auto_mitigated BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'open'
    CONSTRAINT security_threat_events_status_check
      CHECK (status IN ('open','acknowledged','resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_threat_events_status_time
  ON security_threat_events (status, created_at DESC);

-- 3. Active IP / API key / actor blocklist (circuit breaker) --------------------
CREATE TABLE IF NOT EXISTS security_blocklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type TEXT NOT NULL
    CONSTRAINT security_blocklist_target_type_check
      CHECK (target_type IN ('ip','api_key_id','org_id','project_id')),
  target_value TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT security_blocklist_target_key UNIQUE (target_type, target_value)
);

CREATE INDEX IF NOT EXISTS idx_blocklist_active
  ON security_blocklist (target_type, target_value) WHERE active = TRUE;

-- 4. API key Origin / IP restrictions -------------------------------------------
-- expires_at and last_used_at already exist from 0001_init_control_plane.sql.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_origins JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_ips JSONB NOT NULL DEFAULT '[]'::jsonb;
