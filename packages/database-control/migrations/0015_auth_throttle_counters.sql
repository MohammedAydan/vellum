-- 0015_auth_throttle_counters.sql — Control plane
--
-- Additive only. Authentication throttles (sign-in/sign-up rate limits, the
-- per-project hourly signup budget) and MFA bad-code lockouts used to live in
-- per-process Maps, which made them per-instance on serverless and lost on
-- every cold start. They now live in PostgreSQL, shared by every API instance.
--
-- Bucket keys are always opaque hashes (ip|email digests, hashed MFA tickets
-- or user ids, project ids) — never raw credentials, emails or addresses.

CREATE TABLE IF NOT EXISTS auth_throttle_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Window counts scan one (scope, subject) bucket ordered by recency.
CREATE INDEX IF NOT EXISTS idx_auth_throttle_events_scope_subject_created
  ON auth_throttle_events (scope, subject, created_at DESC);

-- Retention pruning scans by age alone.
CREATE INDEX IF NOT EXISTS idx_auth_throttle_events_created_at
  ON auth_throttle_events (created_at);

CREATE TABLE IF NOT EXISTS auth_failure_counters (
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  failures INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope, subject)
);

-- Retention pruning of expired counters.
CREATE INDEX IF NOT EXISTS idx_auth_failure_counters_expires_at
  ON auth_failure_counters (expires_at);

-- Atomic sliding-window slot reservation. A per-bucket advisory transaction
-- lock serializes concurrent reservers; because READ COMMITTED gives every
-- command inside a VOLATILE function its own snapshot, the count below sees
-- every reservation committed before the lock was taken, so parallel callers
-- cannot all pass one free slot. Returns count_before (events already inside
-- the window) and, when under the limit, the id of the reserved event row;
-- the caller deletes that row to release a slot that must not count (a
-- successful sign-in in failure-only mode, a failed sign-up).
CREATE OR REPLACE FUNCTION auth_throttle_acquire(
  p_scope TEXT,
  p_subject TEXT,
  p_window_ms INTEGER,
  p_max INTEGER
) RETURNS TABLE(count_before INTEGER, event_id BIGINT)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  n INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_scope), hashtext(p_subject));
  SELECT count(*)::integer INTO n
    FROM auth_throttle_events
   WHERE scope = p_scope
     AND subject = p_subject
     AND created_at > now() - make_interval(secs => p_window_ms / 1000.0);
  IF n < p_max THEN
    INSERT INTO auth_throttle_events (scope, subject)
    VALUES (p_scope, p_subject)
    RETURNING id INTO event_id;
  END IF;
  count_before := n;
  RETURN NEXT;
END;
$$;
