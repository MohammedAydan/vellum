-- 0012_project_relation_rules.sql
-- Per-project referential-integrity rules consumed by the document engine
-- (`EngineContext.relationRules`). Managed via
-- `GET/PUT /v1/projects/:projectId/relation-rules` and hydrated into the
-- control-plane read mirror on refresh().
--
-- Rollback (manual, verified in CI alongside the forward path):
--   DROP TABLE IF EXISTS project_relation_rules;
--   DROP TABLE IF EXISTS project_relation_rules_meta;

-- One row per project: the monotonically increasing rule-set version. Kept
-- separate so replacing the rules with an EMPTY set still bumps (and keeps)
-- the version for optimistic concurrency.
CREATE TABLE IF NOT EXISTS project_relation_rules_meta (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  version INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_relation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Dependent side: the collection + field holding the reference.
  collection TEXT NOT NULL,
  field TEXT NOT NULL,
  -- Optional guard: rule only fires when the deleted document lives in this
  -- collection. NULL means the rule applies to references to any collection.
  target_collection TEXT,
  on_delete TEXT NOT NULL CHECK (on_delete IN ('cascade', 'set_null', 'restrict')),
  -- All rows of one project share a single monotonically increasing version;
  -- it backs optimistic concurrency (expectedVersion / If-Match) on PUT.
  version INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, collection, field)
);

CREATE INDEX IF NOT EXISTS idx_project_relation_rules_project
  ON project_relation_rules (project_id);
