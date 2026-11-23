-- 0010_single_environment.sql
-- Collapse every project to ONE canonical environment named `production`.
--
-- See docs/SINGLE-ENVIRONMENT-CONTRACT.md (D1/D2/D3): `development` and
-- `staging` are legacy aliases resolved in application code, never extra rows.
-- API keys are re-pointed (never dropped); all other legacy rows are deleted
-- (clean start, never merged). 0001 is immutable — its CHECK constraint already
-- accepts `production`, so no constraint change is required here.
--
-- Idempotent: on a second run the legacy CTEs are empty and every statement is
-- a no-op, so re-applying this migration is safe.

-- (a) Ensure a production env exists for every project.
INSERT INTO project_environments (project_id, name)
SELECT p.id, 'production' FROM projects p
WHERE NOT EXISTS (
  SELECT 1 FROM project_environments e
  WHERE e.project_id = p.id AND e.name = 'production'
)
ON CONFLICT DO NOTHING;

-- (b) Re-point ALL api_keys from legacy envs to the project's production env.
--     key_prefix is globally UNIQUE, so there is no name collision.
WITH canonical AS (
  SELECT project_id, id AS env_id FROM project_environments WHERE name = 'production'
)
UPDATE api_keys k
SET environment_id = c.env_id
FROM canonical c
WHERE k.project_id = c.project_id AND k.environment_id <> c.env_id;

-- (c) CLEAN START: DELETE (not merge) legacy rows from every dependent table.
--     The legacy CTE is re-declared per statement; after (b) no API key points
--     at a legacy env, so deleting these rows cannot cascade away live keys.
WITH legacy AS (
  SELECT id FROM project_environments WHERE name <> 'production'
)
DELETE FROM security_rulesets
WHERE environment_id IN (SELECT id FROM legacy);

WITH legacy AS (
  SELECT id FROM project_environments WHERE name <> 'production'
)
DELETE FROM project_environment_auth_configs
WHERE environment_id IN (SELECT id FROM legacy);

WITH legacy AS (
  SELECT id FROM project_environments WHERE name <> 'production'
)
DELETE FROM project_usage_daily
WHERE environment_id IN (SELECT id FROM legacy);

WITH legacy AS (
  SELECT id FROM project_environments WHERE name <> 'production'
)
DELETE FROM project_index_recommendations
WHERE environment_id IN (SELECT id FROM legacy);

-- security_audit_logs.environment_id is nullable; only legacy-env rows are removed.
WITH legacy AS (
  SELECT id FROM project_environments WHERE name <> 'production'
)
DELETE FROM security_audit_logs
WHERE environment_id IN (SELECT id FROM legacy);

WITH legacy AS (
  SELECT id FROM project_environments WHERE name <> 'production'
)
DELETE FROM usage_daily_rollups
WHERE environment_id IN (SELECT id FROM legacy);

WITH legacy AS (
  SELECT id FROM project_environments WHERE name <> 'production'
)
DELETE FROM usage_monthly_rollups
WHERE environment_id IN (SELECT id FROM legacy);

-- (d) Delete the legacy environment rows themselves (production is preserved).
DELETE FROM project_environments WHERE name <> 'production';

-- (e) Document the collapse for future operators inspecting the schema.
COMMENT ON TABLE project_environments IS
  'Exactly one canonical environment per project, named production. development/staging are legacy aliases resolved in application code, not rows.';
COMMENT ON COLUMN project_environments.name IS
  'Canonical value is production; legacy development/staging rows were removed by 0010_single_environment.';
COMMENT ON COLUMN api_keys.environment_id IS
  'Always points at the project''s single production environment; legacy dev/staging keys were re-pointed by 0010_single_environment.';
