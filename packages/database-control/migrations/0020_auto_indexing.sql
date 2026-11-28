-- Auto-indexing engine (0.0.11): platform-wide settings, per-project opt-out,
-- hourly hit buckets for repeat detection, and an audit log of engine actions.

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 128),
  value JSONB NOT NULL,
  updated_by UUID NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Default: engine runs in observe (dry-run) mode. Admin flips to "live" or "off".
INSERT INTO platform_settings (key, value) VALUES
  ('auto_indexing.mode', '"observe"'::jsonb),
  ('auto_indexing.budget_pct', '40'::jsonb),
  ('auto_indexing.storage_budget_pct', '20'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS auto_index_project_settings (
  project_id UUID PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auto_index_rec_hourly (
  project_id UUID NOT NULL,
  fingerprint TEXT NOT NULL,
  hour TIMESTAMPTZ NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  total_duration_ms BIGINT NOT NULL DEFAULT 0,
  max_duration_ms BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, fingerprint, hour)
);
CREATE INDEX IF NOT EXISTS idx_auto_index_rec_hourly_hour ON auto_index_rec_hourly (hour);

CREATE TABLE IF NOT EXISTS auto_index_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  fingerprint TEXT NOT NULL,
  collection_path TEXT NOT NULL,
  fields JSONB NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create','drop','retire','skip','ineffective','pin')),
  mode TEXT NOT NULL CHECK (mode IN ('observe','live')),
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  index_id UUID NULL,
  retire_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auto_index_actions_project ON auto_index_actions (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auto_index_actions_fp ON auto_index_actions (project_id, fingerprint, created_at DESC);
