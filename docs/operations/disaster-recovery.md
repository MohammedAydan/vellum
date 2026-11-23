# Operations Runbook — Disaster Recovery & Point-in-Time Recovery (PITR)

**Subsystem:** Control Plane (`control_db`) & Data Plane (`data_db`)  
**Targets:** RTO $\le 30\text{ minutes}$ | RPO $\le 5\text{ minutes}$  
**Classification:** Critical Platform Runbook (P0)

---

## 1. Architecture & Recovery Objectives

VELLUM maintains independent physical backup streams for its dual data planes:
1. **Control Plane (`control_db`):** WAL archiving via `pg_dump` snapshots every 4 hours + continuous WAL streaming to S3/GCS.
2. **Data Plane (`data_db`):** Neon instant copy-on-write branching / AWS Aurora continuous storage volume backups with continuous PITR logs.

| Metric | Target | Verification Method |
|---|---|---|
| **Recovery Time Objective (RTO)** | $\le 30\text{ minutes}$ | Measured from disaster declaration to healthy API health checks |
| **Recovery Point Objective (RPO)** | $\le 5\text{ minutes}$ | Maximum WAL lag between primary mutation and archive storage |

---

## 2. Disaster Recovery Procedure (Step-by-Step)

### Step 1: Declare Incident & Activate Maintenance Mode
1. Engage on-call incident commander via PagerDuty / Slack `#war-room-ops`.
2. Enable global API maintenance mode via Platform Admin killswitch or Cloudflare edge rule:
   ```bash
   curl -X POST https://api.vellum.dev/v1/admin/maintenance \
     -H "Authorization: Bearer $PLATFORM_ROOT_KEY" \
     -d '{"enabled": true, "reason": "Active DR Recovery Operation"}'
   ```

### Step 2: Provision Point-in-Time Restore Instance
#### Option A: Neon Serverless Data Plane (Fast Branching)
Create an isolated branch at target timestamp `T`:
```bash
neon branches create \
  --project-id $NEON_PROJECT_ID \
  --name "dr-restore-$(date +%Y%m%d%H%M%S)" \
  --timestamp "2026-11-15T22:30:00Z"
```

#### Option B: Self-Hosted PostgreSQL / Docker
1. Restore base snapshot:
   ```bash
   pg_restore -U vellum -d data_db_recovery /backups/data_db_base.dump
   ```
2. Apply Write-Ahead Logs (WAL) to recovery target:
   ```ini
   # postgresql.conf
   restore_command = 'aws s3 cp s3://vellum-wal-archives/data_db/%f %p'
   recovery_target_time = '2026-11-15 22:30:00 UTC'
   recovery_target_action = 'promote'
   ```

### Step 3: Run Post-Restore Verification Drill
Execute schema and integrity verification script:
```bash
pnpm dev:env-check
pnpm test:security
```

### Step 4: Cutover DNS & Database URLs
1. Update secrets in Kubernetes / Cloud Run:
   ```bash
   kubectl set env deployment/vellum-api DATA_DATABASE_URL="postgres://..."
   ```
2. Disable maintenance mode and monitor p95 latencies and error rates on Datadog/Grafana.

---

## 5. Automated proof (TASK-904)

Do not perform the dump/restore manually. Use the audited drill, which never writes to the
source and validates exact row counts, SHA-256 row checksums, `pg_policies` (including the
required 4 data-plane isolation policies), RLS flags and `schema_migrations`:

```bash
corepack pnpm exec tsx scripts/dr-drill.ts --dry-run
corepack pnpm exec tsx scripts/dr-drill.ts --execute --allow-target-reset
```

See `docs/operations/dr-drill.md` for the safety model, target naming rules and exit criteria.
During cutover, gate traffic on `/v1/health/ready`; `/v1/health/live` is only for process
liveness and deliberately performs no database access (see `docs/operations/container-startup.md`).
