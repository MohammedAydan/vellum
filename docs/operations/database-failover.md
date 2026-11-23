# Operations Runbook — High Availability & Database Failover

**Subsystem:** PostgreSQL Primary-to-Replica Failover  
**Classification:** High Availability Operations (P1)

---

## 1. Overview & Split-Brain Prevention

VELLUM runs high-availability PostgreSQL clusters using physical streaming replication.
To guarantee zero data loss and prevent split-brain scenarios:
1. **Consensus Quorum:** PostgreSQL replication requires `synchronous_commit = on` with quorum replication across at least 2 availability zones.
2. **Fencing (STONITH):** When a primary fails, automated fencing isolates the failed node before promoting the synchronous standby.

---

## 2. Failover Trigger Conditions

Execute failover immediately if any of the following occur for $> 30\text{ seconds}$:
- Primary database heartbeat fails on port 5432 / 5433.
- Primary disk I/O freezes or uncorrectable hardware degradation occurs.
- PostgreSQL error log reports read-only filesystem crash or corrupted WAL segment.

---

## 3. Automated & Manual Failover Procedure

### Step 1: Verify Standby Lag
On the standby node:
```sql
SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(),
       pg_last_xact_replay_timestamp();
```
Ensure replay lag is $\le 100\text{ ms}$.

### Step 2: Promote Standby Node
Promote the replica to new primary:
```bash
pg_ctl promote -D /var/lib/postgresql/data
```
Verify the cluster status:
```sql
SELECT pg_is_in_recovery(); -- Must return FALSE
```

### Step 3: Update PgBouncer / Connection Pool Routing
If using PgBouncer:
```bash
pgbouncer -R -u pgbouncer /etc/pgbouncer/pgbouncer.ini
```
All API instances automatically reconnect within their 5000ms socket timeout window.

### Step 4: Post-Failover Verification
```bash
curl -f http://localhost:8080/v1/health
```
Verify `{"planes":{"controlDb":"connected","dataDb":"connected"}}`.
