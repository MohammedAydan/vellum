-- Reverse lookup uses recursive JSONPath equality. jsonb_path_ops does not
-- index .** accessors; retain the smaller existing containment index and add
-- jsonb_ops for recursive exact-path searches. Both exclude tombstones.
-- This transactional build can block writers on a large existing installation:
-- prebuild this named index CONCURRENTLY in the operator's maintenance flow,
-- then run migrations (IF NOT EXISTS is intentionally safe for that flow).
CREATE INDEX IF NOT EXISTS idx_docs_reverse_reference_gin_active
  ON documents USING GIN (data jsonb_ops)
  WHERE deleted_at IS NULL;

-- Rollback (after stopping callers of documents:referencedBy):
-- DROP INDEX IF EXISTS idx_docs_reverse_reference_gin_active;
