# Operations Runbook — Automated DR Drill (TASK-904)

**Script:** `scripts/dr-drill.ts`
**Related:** `docs/operations/disaster-recovery.md`

---

## 1. Purpose

Prove that a `pg_dump`/`pg_restore` of the Data Plane (`data_db`) is restorable and byte-faithful
without ever touching production rows. The drill compares the live source with a restored
**disposable** database on exact row counts, SHA-256 content checksums, RLS policies and
migration history.

## 2. Safety model

- The source is opened read-only (`pg_dump` + `SELECT`). No DDL/DML is issued against it.
- The target must be a **different** database whose name contains `dr_`, `restore_` or
  `recovery_`. `data_db`, `control_db`, `postgres` and the template databases are rejected.
- Destructive mode additionally requires `--allow-target-reset` (or `DR_ALLOW_TARGET_RESET=1`).
- Only the target's `public` schema is reset (`DROP SCHEMA public CASCADE; CREATE SCHEMA public`).
- Connection strings come from `.env.phase5.local` through **dotenv**. Child processes receive
  discrete `PGHOST/PGUSER/PGPASSWORD/PGDATABASE` variables, so no URL or password ever appears
  in argv, stdout or the archive filename. Printed identity is `db=… user=… sslmode=…` only.
- Temporary custom-format archives are written under `/tmp/opencode/` and deleted on success
  unless `--keep-dump` is passed.

## 3. Commands

```bash
# 0. Preflight — read-only baseline, no writes
corepack pnpm exec tsx scripts/dr-drill.ts --dry-run

# 1. Full drill against the disposable validation database
corepack pnpm exec tsx scripts/dr-drill.ts --execute --allow-target-reset

# 2. Re-verify an already-restored target without dumping again
corepack pnpm exec tsx scripts/dr-drill.ts --verify-only
```

Options: `--env-file=<path>`, `--target-db=<name>` (default `$DR_RESTORE_DATABASE` or
`phase5_restore`), `--keep-dump`. Binary discovery: `PG_DUMP_BIN` / `PG_RESTORE_BIN`, else
`/usr/lib/postgresql/{18,16}/bin`, else `PATH`.

## 4. Verification contract

For each of `documents`, `document_indexes`, `document_index_entries`, `realtime_outbox`:

1. `count(*)` must match exactly.
2. A SHA-256 over every row (`SELECT * … ORDER BY <primary key>`, `JSON.stringify(row) + "\n"`)
   must match exactly. This detects value drift even when counts are equal.
3. **The four data-plane isolation policies must be present on both sides:**
   `count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN (the 4 tables)
   AND policyname LIKE 'tenant%' = 4`. Total policy names and `pg_class.relrowsecurity` /
   `relforcerowsecurity` flags are compared too.
4. `schema_migrations` filenames must match.

Any mismatch sets exit code 1 and prints `DR DRILL FAILED` with per-check detail.

> Note: the live schema currently carries 8 policies (4 `tenant_isolation_*` on the data-plane
> tables plus 4 `tenant_rls_transactions_*` on `transactions`). The required constant is the
> **4 isolation policies**, which the script asserts explicitly while also checking full parity.

## 5. Schedule & ownership

- Run quarterly and after every PostgreSQL major upgrade or migration change.
- Run in the staging/maintenance window; the source is read-only so no maintenance mode is
  strictly required, but avoid peak write load so the baseline snapshot is stable.
- Keep the `pg_dump` archive in the encrypted backup bucket for 30 days when
  `--keep-dump` is used; move it out of `/tmp/opencode/` immediately.
