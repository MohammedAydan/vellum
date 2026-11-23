# Operations Runbook — Container Startup & Migrations (TASK-903)

**Scope:** `apps/api` container (`docker/Dockerfile.api`) and both PostgreSQL planes.
**Doctrine:** PostgreSQL is the only stateful runtime service. There is no broker/cache container.

---

## 1. Invariant: migrations run BEFORE the container serves traffic

The API process (`node apps/api/dist/node-server.js`) assumes the schema already exists.
Migrations are therefore **never** triggered by request handling. The required boot order is:

```
1. control_db + data_db reachable (session-mode URLs)
2. runMigrationsOnClient() under a PostgreSQL advisory lock
3. schema_migrations verified (filename + sha256 checksum)
4. API process starts, binds :8080
5. /v1/health/live (no DB) for Docker HEALTHCHECK
   /v1/health/ready (DB + migrations + LISTEN) for LB / orchestrator
```

Doing it the other way round (lazy migration on first request) would let two replicas race
on DDL and would make a half-migrated pod look healthy.

## 2. What the runner guarantees

`packages/database-control/src/migrations-runner.ts`:

| Guarantee | Mechanism |
|---|---|
| Only one migrator at a time | Session-scoped `pg_advisory_lock(key1, 903)`; key1 = FNV-1a of `vellum:migrations`; released in `finally`. Acquisition itself bounded by `statement_timeout` (default 15 s, override `advisoryLockTimeoutMs`). |
| Idempotent re-runs | `schema_migrations(filename PK, checksum, applied_at)` — applied filenames are skipped. |
| Immutable history | sha256 of file contents is compared to the recorded checksum; drift is a hard error. |
| Atomic per file | Each migration runs in its own `BEGIN … COMMIT`, with `ROLLBACK` on failure. |
| Ordered | Lexical filename order. |

**Session-mode requirement:** a session-level advisory lock needs a non-pooled connection.
Neon's `-pooler` endpoint uses transaction pooling and cannot hold one (it also cannot carry
`LISTEN`). Always supply `CONTROL_DATABASE_URL_DIRECT` / `DATA_DATABASE_URL_DIRECT`, or a URL
whose host does not contain `-pooler.`. `scripts/migrate.ts` already prefers the `*_DIRECT`
variables. A pooled run can appear to succeed while providing no mutual exclusion.

## 3. Applying migrations

Preferred CI/CD step (before `docker compose up` / rollout):

```bash
corepack pnpm db:migrate                       # both planes
corepack pnpm db:migrate --status              # read-only audit
corepack pnpm db:migrate --dry-run             # list pending, change nothing
corepack pnpm db:migrate --only=data           # one plane
```

Optional pre-boot container entrypoint is provided at `scripts/docker-entrypoint.sh`. It runs
the migration CLI when `DATABASE_MODE=postgres` and then `exec "$@"` (the original CMD).

### 3.1 Required Dockerfile wiring (DevOps-owned — NOT applied by this role)

The Dockerfile `CMD` was intentionally left unchanged. To activate the entrypoint, DevOps must
add these two lines to `docker/Dockerfile.api` in the runner stage, before `USER vellum`:

```dockerfile
COPY --from=build --chown=vellum:vellum /app/scripts ./scripts
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "apps/api/dist/node-server.js"]   # unchanged
```

Without the `COPY`, the entrypoint cannot find `scripts/migrate.ts`; without the `ENTRYPOINT`,
the script is inert and migrations must be performed by the deployment pipeline (§3).
This is reported as a required follow-up rather than silently changing DevOps-owned startup.

## 4. Health semantics

| Endpoint | DB access | Purpose | Status |
|---|---|---|---|
| `/v1/health/live` | none | Container liveness (Docker HEALTHCHECK now points here) | 200 |
| `/v1/health/ready` | yes | LB/orchestrator readiness: `SELECT 1` on both planes, `schema_migrations` + drift, dedicated LISTEN session | 200 ready / 503 unready |
| `/v1/health` | legacy | Compatibility alias; deprecated, will report plane flags from real probes | 200 |

`/ready` returns the **exact** SQL rows (e.g. `{"probe_ok": 1}`, the applied migration rows,
`pg_backend_pid()` and `server_version`) and never a hard-coded "connected" string. Failures
expose only error codes such as `ECONNREFUSED` or a SQLSTATE — never URLs or credentials.

Observed on the current Neon data plane: `/ready` correctly returns **503** because
`0002_rls_hardening.sql`, `0003_outbox_notify.sql` and `0004_transactions.sql` are on disk but
not recorded in `data_db.schema_migrations`. This is expected drift, not a false negative; the
owner must apply migrations at the next supervised maintenance window before routing traffic.
