-- Phase 5 · Control Plane additive migration
-- 0002_control_plane_feature_flags.sql
--
-- Ground truth §2.5: `apps/admin` exposes a "Feature Flags" surface with no backing table.
-- This migration makes the feature real at the data layer.
--
-- Additive only. Never edit 0001_init_control_plane.sql in place.

CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  description TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  rollout_percent INT NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feature_flags_enabled ON feature_flags (enabled) WHERE enabled = TRUE;
