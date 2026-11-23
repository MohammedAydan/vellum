-- V2 Performance + TTL migration (data plane)
--
-- Adds an optional per-document expiry timestamp and three covering indexes.
-- Migrations execute inside a transaction, so CREATE INDEX CONCURRENTLY is
-- deliberately NOT used here (it cannot run inside a transaction block).
-- Every statement is idempotent so a retried migration run is safe.

-- 1. Optional document TTL. NULL means "never expires". A document is expired
--    when expires_at <= now(); live reads filter with
--    (expires_at IS NULL OR expires_at > now()).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- 2. TTL sweeper / expiry-aware scans. Partial index keeps tombstoned rows out
--    of the index so purge + expiry workers scan only live candidates.
CREATE INDEX IF NOT EXISTS idx_docs_expires_at
  ON documents (project_id, environment_id, expires_at)
  WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

-- 3. Covering index for the default collection listing / cursor pagination
--    shape (project, environment, collection, updated_at DESC, document_id).
CREATE INDEX IF NOT EXISTS idx_docs_collection_cover_active
  ON documents (project_id, environment_id, collection_path, updated_at DESC, document_id)
  WHERE deleted_at IS NULL;

-- 4. GIN index on the JSON payload for `data @>` / array-contains operators.
--    jsonb_path_ops keeps the index small (no per-key entries).
CREATE INDEX IF NOT EXISTS idx_docs_data_gin
  ON documents USING GIN (data jsonb_path_ops);
