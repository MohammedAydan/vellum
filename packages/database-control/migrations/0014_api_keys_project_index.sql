-- 0014_api_keys_project_index.sql — Control plane
--
-- Additive only. Key lists, per-project origin checks and key lookups now read api_keys on
-- every request instead of an in-process copy, so the project lookup needs its own index.
CREATE INDEX IF NOT EXISTS idx_api_keys_project_active ON api_keys (project_id) WHERE revoked_at IS NULL;
