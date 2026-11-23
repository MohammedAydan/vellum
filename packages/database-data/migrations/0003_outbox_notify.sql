-- Data Plane: transactional outbox NOTIFY trigger (`data_db`) — EPIC-5 / TASK-502
--
-- Publishes a *tiny* wake-up notification after each committed outbox INSERT.
-- The payload intentionally contains only the keys needed to locate the row;
-- the poller always fetches full rows from `realtime_outbox` (never from the
-- notification) so document data is never broadcast through NOTIFY.
--
-- NOTIFY is transactional: it is delivered only when the inserting transaction
-- COMMITs, so subscribers never observe uncommitted document mutations.
--
-- Idempotent: safe to re-run against a database that already has the trigger.

CREATE OR REPLACE FUNCTION docdb_notify_outbox_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM pg_notify(
    'docdb_outbox',
    json_build_object(
      'seqId', NEW.seq_id,
      'projectId', NEW.project_id,
      'environmentId', NEW.environment_id
    )::text
  );
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_docdb_outbox_notify ON realtime_outbox;

CREATE TRIGGER trg_docdb_outbox_notify
AFTER INSERT ON realtime_outbox
FOR EACH ROW
EXECUTE FUNCTION docdb_notify_outbox_insert();
