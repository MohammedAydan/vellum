-- Full-text indexes.
--
-- A full-text index is a document_indexes row whose single field has dir "text". Its entries carry a
-- tsvector of that field, so text_search over a large collection is served by a GIN lookup instead of a
-- scan. Ordinary composite-index entries leave tsv NULL, and the partial GIN index below skips them, so
-- the added storage is proportional to the full-text indexes a project actually creates.
--
-- Adding a nullable column is metadata-only. Pre-0.0.10 code ignores the column, so the migration can run
-- before or after the deploy; 0.0.10 code needs it, so run it first (the deploy runs migrations before
-- traffic moves).

ALTER TABLE document_index_entries ADD COLUMN IF NOT EXISTS tsv tsvector;

CREATE INDEX IF NOT EXISTS idx_index_entries_tsv
  ON document_index_entries USING gin (tsv)
  WHERE tsv IS NOT NULL;
