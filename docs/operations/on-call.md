# Operations Runbook — On-Call Engineering & Incident Escalation

**Classification:** Standard Operating Procedures (SOP)  
**Applicability:** Primary & Secondary On-Call Platform Engineers

---

## 1. On-Call Escalation Matrix

| Severity | Definition | Response SLA | Primary Contact |
|---|---|:---:|---|
| **P0 (Critical)** | Entire platform outage, data loss risk, active security breach | $\le 5\text{ min}$ | Incident Commander + Lead Infrastructure Engineer |
| **P1 (High)** | High error rates ($> 1\%$), p95 query latency $> 100\text{ ms}$, single tenant suspended | $\le 15\text{ min}$ | Primary On-Call Backend Engineer |
| **P2 (Medium)** | Background worker backlog $> 10,000$ messages, non-blocking rate limiter degradation | $\le 1\text{ hour}$ | On-Call Platform Engineer |
| **P3 (Low)** | Minor dashboard UI glitch, non-urgent billing discrepancies | Next Business Day | Engineering Team Ticket |

---

## 2. Emergency Operational Kill Switches

VELLUM provides deterministic operational kill switches executable via the Admin Console or Platform Admin Service:

### 2.1 Immediate Tenant Suspension
Stops all read/write traffic for an abusive tenant immediately without touching other tenants:
```bash
curl -X POST http://localhost:8080/v1/admin/tenants/:orgId/suspend \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -d '{"reason": "DDoS mitigation / billing default"}'
```

### 2.2 Dynamic Rate Limit Throttling
Dynamically adjust global or per-tenant rate limit threshold from 100 RPS to 10 RPS:
```bash
curl -X POST http://localhost:8080/v1/admin/tenants/:orgId/rate-limit \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -d '{"rps": 10}'
```

### 2.3 Outbox Worker Throttling
Pause background compaction or index builder workers during peak query load:
```bash
curl -X POST http://localhost:8080/v1/admin/workers/pause \
  -H "Authorization: Bearer $ADMIN_SECRET"
```
