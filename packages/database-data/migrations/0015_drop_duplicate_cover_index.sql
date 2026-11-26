-- idx_docs_collection_cover_active has the same keys, order and predicate as
-- idx_docs_collection_updated_active (project_id, collection_path, updated_at DESC, document_id)
-- WHERE deleted_at IS NULL. Measured on 1M rows it costs ~100 MB and a share of every
-- insert and update for no read benefit: the planner uses either one for the same queries.
-- DROP INDEX takes a short ACCESS EXCLUSIVE lock and no table rewrite.
--
-- Rollback: CREATE INDEX idx_docs_collection_cover_active
--   ON documents (project_id, collection_path, updated_at DESC, document_id) WHERE deleted_at IS NULL;
DROP INDEX IF EXISTS idx_docs_collection_cover_active;
