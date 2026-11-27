-- Data Plane: xid8 commit-order safety column on the realtime outbox — P0-2 (0.0.9)
--
-- A row's seq_id is assigned at INSERT (bigserial), but the row only becomes
-- visible at COMMIT, and concurrent transactions commit in a different order
-- than they took their seq_ids. A poller that advances its watermark to the
-- highest *visible* seq can therefore permanently skip a row whose transaction
-- committed late. Recording the inserting transaction's xid8 lets readers gate
-- delivery on `xid8 < pg_snapshot_xmin(pg_current_snapshot())`: rows below the
-- snapshot's xmin belong to transactions that were already resolved (committed
-- or aborted) when the snapshot was taken, so the watermark can never advance
-- past a row that is still in flight.
--
-- The DEFAULT evaluates `pg_current_xact_id()` per INSERT, so every new row
-- records its own writing transaction with no trigger and no write-path change.
-- Rows that predate this migration read back the catalog value captured at
-- ALTER time (PostgreSQL 11+ fast default), which is below every future
-- snapshot xmin: they stay deliverable, exactly as before.
--
-- Forward-only and idempotent: safe to run once; never rolled back.

ALTER TABLE realtime_outbox
  ADD COLUMN IF NOT EXISTS xid8 xid8 NOT NULL DEFAULT pg_current_xact_id();
