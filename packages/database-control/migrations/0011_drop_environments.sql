-- 0011_drop_environments.sql
-- FULL CUTOVER: the project is the only tenant boundary in the control plane.
--
-- This migration removes the environment concept from the *effective* schema:
-- every `environment_id` column is dropped (CASCADE also removes the foreign
-- keys, constraints and indexes that depended on it), the auth-config table is
-- renamed to a project-only name, and every uniqueness rule is rebuilt on
-- `project_id` alone. The legacy table is dropped last.
--
-- Legacy identifiers necessarily appear as SQL string literals below because
-- PostgreSQL requires the old names in order to DROP/RENAME them. After this
-- migration the effective schema contains no environment table, column,
-- constraint or index. Applied migrations 0001-0010 are immutable and untouched.
--
-- Idempotent: every statement is guarded, so re-running is a no-op.

-- ---------------------------------------------------------------------------
-- 1. Drop every environment-scoping column. CASCADE removes dependent
--    constraints / indexes / foreign keys automatically.
-- ---------------------------------------------------------------------------
ALTER TABLE api_keys                     DROP COLUMN IF EXISTS environment_id CASCADE;
ALTER TABLE security_rulesets            DROP COLUMN IF EXISTS environment_id CASCADE;
ALTER TABLE project_usage_daily          DROP COLUMN IF EXISTS environment_id CASCADE;
ALTER TABLE project_index_recommendations DROP COLUMN IF EXISTS environment_id CASCADE;
ALTER TABLE security_audit_logs          DROP COLUMN IF EXISTS environment_id CASCADE;
ALTER TABLE usage_daily_rollups          DROP COLUMN IF EXISTS environment_id CASCADE;
ALTER TABLE usage_monthly_rollups        DROP COLUMN IF EXISTS environment_id CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Rename the auth-config table to its project-only name, then drop the
--    scoping column. The guarded rename is safe on a fresh database where
--    0004 created the legacy name and on one already renamed by a prior run.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.project_environment_auth_configs') IS NOT NULL
     AND to_regclass('public.project_auth_configs') IS NULL THEN
    ALTER TABLE project_environment_auth_configs RENAME TO project_auth_configs;
  END IF;
END $$;

ALTER TABLE project_auth_configs DROP COLUMN IF EXISTS environment_id CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Rebuild constraints on project_id only.
-- ---------------------------------------------------------------------------

-- One ruleset version per project; at most one active ruleset per project.
-- Defensive cleanup: keep only the newest active ruleset per project before
-- creating the partial unique index (a no-op on a healthy 0010 database).
UPDATE security_rulesets r
   SET is_active = FALSE
  FROM (
    SELECT id, ROW_NUMBER() OVER (
             PARTITION BY project_id ORDER BY version DESC, id DESC
           ) AS rn
      FROM security_rulesets
     WHERE is_active = TRUE
  ) ranked
 WHERE r.id = ranked.id AND ranked.rn > 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'security_rulesets_project_id_version_key'
       AND conrelid = 'public.security_rulesets'::regclass
  ) THEN
    ALTER TABLE security_rulesets
      ADD CONSTRAINT security_rulesets_project_id_version_key
      UNIQUE (project_id, version);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ruleset_project_version
  ON security_rulesets (project_id, version);

CREATE UNIQUE INDEX IF NOT EXISTS idx_active_ruleset_per_project
  ON security_rulesets (project_id) WHERE is_active = TRUE;

-- The old uniqueness keys included environment_id, so the same project/month
-- could legally have one row per legacy environment. Collapse those rows into
-- a single project-scoped row, summing the counters before rebuilding UNIQUE.
WITH grouped AS (
  SELECT org_id, project_id, billing_month, min(id::text)::uuid AS keeper_id,
         sum(doc_reads)::bigint AS s_reads, sum(doc_writes)::bigint AS s_writes,
         sum(doc_deletes)::bigint AS s_deletes, sum(storage_bytes)::bigint AS s_storage,
         sum(egress_bytes)::bigint AS s_egress, sum(auth_mau)::bigint AS s_mau,
         max(peak_concurrent_ws) AS s_peak, max(updated_at) AS s_updated
    FROM usage_monthly_rollups
   GROUP BY org_id, project_id, billing_month HAVING count(*) > 1
)
UPDATE usage_monthly_rollups u
   SET doc_reads = g.s_reads, doc_writes = g.s_writes, doc_deletes = g.s_deletes,
       storage_bytes = g.s_storage, egress_bytes = g.s_egress, auth_mau = g.s_mau,
       peak_concurrent_ws = g.s_peak, updated_at = g.s_updated
  FROM grouped g WHERE u.id = g.keeper_id;

DELETE FROM usage_monthly_rollups u
 USING (SELECT org_id, project_id, billing_month, min(id::text)::uuid AS keeper_id
          FROM usage_monthly_rollups GROUP BY 1,2,3 HAVING count(*) > 1) g
 WHERE u.org_id = g.org_id AND u.project_id = g.project_id
   AND u.billing_month = g.billing_month AND u.id <> g.keeper_id;

WITH grouped AS (
  SELECT org_id, project_id, usage_date, min(id::text)::uuid AS keeper_id,
         sum(doc_reads)::bigint AS s_reads, sum(doc_writes)::bigint AS s_writes,
         sum(doc_deletes)::bigint AS s_deletes, sum(egress_bytes)::bigint AS s_egress,
         max(updated_at) AS s_updated
    FROM usage_daily_rollups
   GROUP BY org_id, project_id, usage_date HAVING count(*) > 1
)
UPDATE usage_daily_rollups u
   SET doc_reads = g.s_reads, doc_writes = g.s_writes, doc_deletes = g.s_deletes,
       egress_bytes = g.s_egress, updated_at = g.s_updated
  FROM grouped g WHERE u.id = g.keeper_id;

DELETE FROM usage_daily_rollups u
 USING (SELECT org_id, project_id, usage_date, min(id::text)::uuid AS keeper_id
          FROM usage_daily_rollups GROUP BY 1,2,3 HAVING count(*) > 1) g
 WHERE u.org_id = g.org_id AND u.project_id = g.project_id
   AND u.usage_date = g.usage_date AND u.id <> g.keeper_id;

-- Daily metering counters: one row per project per day.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_usage_daily_pkey'
       AND conrelid = 'public.project_usage_daily'::regclass
  ) THEN
    ALTER TABLE project_usage_daily
      ADD CONSTRAINT project_usage_daily_pkey PRIMARY KEY (project_id, usage_date);
  END IF;
END $$;

-- Billing rollups: unique on the remaining columns (see 0008).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'usage_monthly_rollups_unique'
       AND conrelid = 'public.usage_monthly_rollups'::regclass
  ) THEN
    ALTER TABLE usage_monthly_rollups
      ADD CONSTRAINT usage_monthly_rollups_unique
      UNIQUE (org_id, project_id, billing_month);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'usage_daily_rollups_unique'
       AND conrelid = 'public.usage_daily_rollups'::regclass
  ) THEN
    ALTER TABLE usage_daily_rollups
      ADD CONSTRAINT usage_daily_rollups_unique
      UNIQUE (org_id, project_id, usage_date);
  END IF;
END $$;

-- Index recommendations: dedupe by project fingerprint only.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_index_recommendations_project_fingerprint_key'
       AND conrelid = 'public.project_index_recommendations'::regclass
  ) THEN
    ALTER TABLE project_index_recommendations
      ADD CONSTRAINT project_index_recommendations_project_fingerprint_key
      UNIQUE (project_id, fingerprint);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_index_recs_project_status
  ON project_index_recommendations (project_id, status);

CREATE INDEX IF NOT EXISTS idx_index_recs_collection
  ON project_index_recommendations (project_id, collection_path);

-- Auth configuration: one row per project.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_auth_configs_project_id_key'
       AND conrelid = 'public.project_auth_configs'::regclass
  ) THEN
    ALTER TABLE project_auth_configs
      ADD CONSTRAINT project_auth_configs_project_id_key UNIQUE (project_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Drop the legacy table last. All dependent objects are already detached.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS project_environments CASCADE;

-- ---------------------------------------------------------------------------
-- 5. Document project-only tenancy for future operators.
-- ---------------------------------------------------------------------------
COMMENT ON TABLE projects IS
  'The sole tenant boundary in the control plane. All metadata, keys, rulesets, metering and auth configuration are keyed by project_id.';
COMMENT ON COLUMN api_keys.project_id IS
  'Owning project; API keys are project-scoped and carry no narrower tenant dimension.';
COMMENT ON COLUMN security_rulesets.project_id IS
  'Project that owns this ruleset; versions and the active flag are unique per project.';
COMMENT ON COLUMN project_usage_daily.project_id IS
  'Project this daily counter belongs to; one counter row per project and day.';
COMMENT ON TABLE project_auth_configs IS
  'End-user authentication configuration, one row per project; secrets remain AES-256-GCM encrypted at rest.';
COMMENT ON COLUMN project_auth_configs.project_id IS
  'Owning project; authentication configuration is strictly project-scoped.';
COMMENT ON TABLE project_index_recommendations IS
  'Deduplicated missing-index suggestions keyed by project and fingerprint.';
COMMENT ON TABLE security_audit_logs IS
  'Append-only, hash-chained security audit log; the project_id column is the finest tenant dimension.';
COMMENT ON TABLE usage_daily_rollups IS
  'Aggregated daily billing usage, unique per organization, project and date.';
COMMENT ON TABLE usage_monthly_rollups IS
  'Aggregated monthly billing usage, unique per organization, project and billing month.';
