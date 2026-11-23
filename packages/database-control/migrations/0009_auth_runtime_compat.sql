-- Control Plane: reconcile the schema with the runtime auth/audit call sites.
--
-- 0001_init_control_plane.sql never created `users.password_hash` even though
-- both the customer and admin sign-in routes read/write it in Postgres mode,
-- and its `audit_logs.actor_type` check only allowed ('user', 'platform_admin',
-- 'system') while the API emits 'customer', 'operator' and 'owner'. Both only
-- surfaced on a clean database (older environments had been patched by hand).
-- All DDL is idempotent so this migration is safe to re-run.

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_type_check;
ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_actor_type_check
  CHECK (actor_type IN (
    'user', 'customer', 'operator', 'owner', 'platform_admin', 'system', 'api_key'
  ));
