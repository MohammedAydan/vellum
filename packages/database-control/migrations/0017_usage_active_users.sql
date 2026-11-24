-- 0017_usage_active_users.sql — Control plane
--
-- Additive only. Monthly active auth users were counted per API process, so two instances
-- serving the same project double counted and lost counts on restart. Distinct users now live
-- here, one row per (project, month, user), so the count is exact across instances.
CREATE TABLE IF NOT EXISTS usage_active_users (
  org_id        UUID NOT NULL,
  project_id    UUID NOT NULL,
  billing_month TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id, billing_month, user_id)
);
