-- Document Data Plane Complete SQL Schema (`data_db`)
-- Specification Sections 6.3 & 6.4

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Primary Documents Table
CREATE TABLE IF NOT EXISTS documents (
  project_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  path TEXT NOT NULL,
  collection_path TEXT NOT NULL,
  collection_group TEXT NOT NULL,
  document_id TEXT NOT NULL,
  path_depth SMALLINT NOT NULL CHECK (path_depth >= 2 AND path_depth <= 10 AND path_depth % 2 = 0),
  data JSONB NOT NULL,
  size_bytes INT NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 1048576),
  version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, environment_id, path)
);

-- Core B-Tree Indexes for Collection Listing, Ordering, and Cursor Pagination
CREATE INDEX IF NOT EXISTS idx_docs_collection_id_active
  ON documents (project_id, environment_id, collection_path, document_id ASC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_docs_collection_updated_active
  ON documents (project_id, environment_id, collection_path, updated_at DESC, document_id ASC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_docs_collection_created_active
  ON documents (project_id, environment_id, collection_path, created_at DESC, document_id ASC)
  WHERE deleted_at IS NULL;

-- GIN Index with jsonb_path_ops for fast equality & array-contains queries without per-key bloat
CREATE INDEX IF NOT EXISTS idx_docs_data_gin_active
  ON documents USING GIN (data jsonb_path_ops)
  WHERE deleted_at IS NULL;

-- Partial Index for Soft-Delete Tombstone Garbage Collection
CREATE INDEX IF NOT EXISTS idx_docs_tombstones
  ON documents (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- 2. Tenant-Isolated Composite Index Definitions
CREATE TABLE IF NOT EXISTS document_indexes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  collection_path TEXT NOT NULL,
  fields JSONB NOT NULL,
  definition_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'building'
    CHECK (status IN ('building', 'ready', 'failed', 'deleting')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, environment_id, collection_path, definition_hash)
);

-- 3. Multi-Tenant Composite Index Entries Table (Avoids Global DDL Locks per Customer)
CREATE TABLE IF NOT EXISTS document_index_entries (
  index_id UUID NOT NULL REFERENCES document_indexes(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  collection_path TEXT NOT NULL,
  sort_key BYTEA NOT NULL,
  document_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (index_id, sort_key, document_id)
);

CREATE INDEX IF NOT EXISTS idx_index_entries_doc_cleanup
  ON document_index_entries (project_id, environment_id, path);

-- 4. Transactional Realtime Outbox
CREATE TABLE IF NOT EXISTS realtime_outbox (
  seq_id BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  collection_path TEXT NOT NULL,
  path TEXT NOT NULL,
  document_id TEXT NOT NULL,
  op_type TEXT NOT NULL CHECK (op_type IN ('created', 'updated', 'deleted')),
  version BIGINT NOT NULL,
  before_data JSONB,
  after_data JSONB,
  committed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_project_seq
  ON realtime_outbox (project_id, environment_id, seq_id ASC);

CREATE INDEX IF NOT EXISTS idx_outbox_cleanup
  ON realtime_outbox (committed_at);

-- 5. Defense-in-Depth Row-Level Security (RLS)
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_indexes ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_index_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_documents ON documents;
CREATE POLICY tenant_isolation_documents ON documents
  USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );

DROP POLICY IF EXISTS tenant_isolation_indexes ON document_indexes;
CREATE POLICY tenant_isolation_indexes ON document_indexes
  USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );

DROP POLICY IF EXISTS tenant_isolation_index_entries ON document_index_entries;
CREATE POLICY tenant_isolation_index_entries ON document_index_entries
  USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );

DROP POLICY IF EXISTS tenant_isolation_outbox ON realtime_outbox;
CREATE POLICY tenant_isolation_outbox ON realtime_outbox
  USING (
    project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid
    AND environment_id = NULLIF(current_setting('app.current_environment_id', true), '')::uuid
  );
