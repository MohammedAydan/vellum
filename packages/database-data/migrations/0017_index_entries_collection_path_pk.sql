-- document_index_entries: include collection_path in the primary key.
--
-- Wildcard collection-template indexes (a single index definition covering
-- every concrete path that matches a template such as chats/{*}/messages)
-- span many concrete collection paths. Different concrete paths legitimately
-- repeat the same (sort_key, document_id) pair, so the old
-- PRIMARY KEY (index_id, sort_key, document_id) collided across paths and
-- ON CONFLICT DO NOTHING silently dropped entries during backfill and
-- write-path maintenance (e.g. message m000042 in every chat). Keying entries
-- per concrete collection path makes template backfill and write-path
-- upserts lossless while leaving single-path indexes unaffected
-- (collection_path is constant for them).

ALTER TABLE document_index_entries
  DROP CONSTRAINT document_index_entries_pkey;

ALTER TABLE document_index_entries
  ADD PRIMARY KEY (index_id, collection_path, sort_key, document_id);
