-- V2 follow-up: migration 0007 added `idx_docs_data_gin` (jsonb_path_ops) for
-- containment queries, but migration 0001 already provides the canonical
-- `idx_docs_data_gin_active` GIN index used by the query compiler and verified
-- by the EXPLAIN ANALYZE gate. Keeping both wastes write throughput and storage,
-- and causes the planner to choose the non-canonical name. Drop the duplicate.
DROP INDEX IF EXISTS idx_docs_data_gin;
