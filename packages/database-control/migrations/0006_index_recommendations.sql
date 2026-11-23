-- Control Plane: index recommendations (V2 Phase 1B).
--
-- Stores deduplicated "missing composite index" suggestions observed on the
-- public query path. This table lives strictly in control_db; it never stores
-- customer document payloads (only a bounded sample query and field specs).
-- All DDL is idempotent, matching the migration runner's re-run guarantees.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS project_index_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  fingerprint TEXT NOT NULL,
  collection_path TEXT NOT NULL,
  recommended_fields JSONB NOT NULL,
  sample_query JSONB,
  reason TEXT NOT NULL,
  hit_count BIGINT NOT NULL DEFAULT 0,
  total_duration_ms BIGINT NOT NULL DEFAULT 0,
  max_duration_ms BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT project_index_recommendations_status_check
      CHECK (status IN ('pending', 'applied', 'dismissed')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT project_index_recommendations_tenant_fingerprint_key
    UNIQUE (project_id, environment_id, fingerprint)
);

-- Dashboard / worker lookups: recommendations for an environment by status.
CREATE INDEX IF NOT EXISTS idx_index_recs_env_status
  ON project_index_recommendations (environment_id, status);

-- Convenience index for listing suggestions of a collection in a tenant.
CREATE INDEX IF NOT EXISTS idx_index_recs_collection
  ON project_index_recommendations (project_id, environment_id, collection_path);
