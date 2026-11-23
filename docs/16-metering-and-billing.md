# 16 — Metering, Quotas & Billing (Security Fortress)

> **Status:** current as of the Security Fortress build (contract locked in
> Locked billing and security-metering behavior).
> The threat model, hash-chain primitive and shared middleware order are described in
> [15 — Security, Threat Detection & Defense in Depth](./15-security-and-defense.md).

The billing subsystem has one hard performance rule: **no synchronous database write is allowed in the
hot path** (`getDocument`, `queryDocuments`, `setDocument`, `deleteDocument`, WS frames). Metering is
O(1) `Map` delta accumulation; quota checks are O(1) in-memory reads. PostgreSQL is the only stateful
service — there is no Redis, broker or external cache — and all money is integer cents, never floats.

---

## 1. O(1) in-memory metering

`UsageMeteringEngine` (`@vellum/billing`) exposes only synchronous `record*` methods on the request
path:

```ts
recordReads(orgId, projectId, projectId, count): void;
recordWrites(orgId, projectId, projectId, count, storageDeltaBytes): void;
recordDeletes(orgId, projectId, projectId, count, storageDeltaBytes): void;
recordEgress(orgId, projectId, projectId, bytes): void;
recordActiveAuthUser(orgId, projectId, projectId, userId): void;   // dedup per month/project
recordWsConnectionDelta(orgId, projectId, projectId, delta: 1 | -1): void;
```

Each call mutates a `PendingDelta` entry plus a realtime org total and returns — no I/O, no `await`.
The `Map` key is `${orgId}|${projectId}|${projectId}|${YYYY-MM}`. A `PendingDelta` holds
`docReads`, `docWrites`, `docDeletes`, `storageBytes`, `egressBytes`, `peakWs` and an
`authUsers: Set<string>` for monthly-active-user deduplication. The engine's own `totalsFor(orgId)`
serves the live usage cards in the customer dashboard.

### 1.1 Atomic Map swap + 5 s async batch flush

```ts
flush(): Promise<FlushResult>;   // FlushResult = { flushedGroups, ledgerSeq }
start(intervalMs = 5000): void;
stop(): Promise<void>;           // final flush on SIGINT/SIGTERM
```

`flush()` **swaps `pendingDeltas` to a fresh `Map` before any DB I/O**. Request handlers therefore
never block on a flush: any delta recorded after the swap lands in the new map and is picked up by
the next cycle. The flush performs batched `UPSERT`s into `usage_monthly_rollups` and
`usage_daily_rollups`, then appends one hash-chained row to `billing_ledger_entries`
(`entry_type = 'usage_flush'`). The default interval is **5,000 ms**; `stop()` guarantees a final
flush on shutdown.

---

## 2. Quota snapshot cache & O(1) QuotaGuard

`QuotaGuard.checkQuota(orgId, op)` is a pure in-memory read over a snapshot cache, refreshed on a
**10 s TTL** with push invalidation (`invalidate(orgId)` on plan or cap changes).
`refreshFromStore(rows)` accepts `SubscriptionSnapshot[]`. Operations:
`read | write | delete | ws_connect | auth_signup`.

**Enforcement order (locked):**

1. `status === 'suspended'` → `{ allowed: false, statusCode: 402, code: 'SUBSCRIPTION_SUSPENDED' }`.
2. `hardLimitEnforced && used >= included` → `{ allowed: false, statusCode: 429, code: 'QUOTA_EXCEEDED', metric, used, limit }`.
3. `monthlySpendCapCents !== null && calculateBillCents(...) >= cap` →
   `{ allowed: false, statusCode: 402, code: 'MONTHLY_SPEND_CAP_REACHED', currentCents, capCents }`.
4. Otherwise allowed; at 80 %/95 % of a quota attach `warningHeader: '80%' | '95%'` and the
   `x-vellum-quota-warning` response header.

The guard is step 7 of the fortress middleware, before the handler and post-handler metering.

---

## 3. Locked plan table

`billing_plans` is seeded exactly (`ON CONFLICT (id) DO NOTHING`) by migration `0008`. Storage and
egress are byte counts (GB = 1,073,741,824 bytes). "Base" is the monthly base price in **cents**.

| id | name | base | reads | writes | deletes | storage B | egress B | MAU | WS | read¢/100k | write¢/100k | delete¢/100k | storage¢/GB | egress¢/GB | MAU¢/1k | hard |
| :-- | :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | :-- |
| `free` | Starter (Free) | 0 | 1,500,000 | 600,000 | 600,000 | 1,073,741,824 | 10,737,418,240 | 10,000 | 50 | 0 | 0 | 0 | 0 | 0 | 0 | true |
| `pro` | Pro (Pay-as-you-go) | 2500 | 5,000,000 | 2,000,000 | 1,000,000 | 21,474,836,480 | 107,374,182,400 | 100,000 | 1000 | 6 | 18 | 2 | 18 | 12 | 500 | false |
| `enterprise` | Enterprise | 29900 | 50,000,000 | 20,000,000 | 10,000,000 | 214,748,364,800 | 1,099,511,627,776 | 1,000,000 | 10000 | 4 | 12 | 1 | 14 | 9 | 300 | false |

- **free / Starter:** $0 base, hard limits enforced (`hard_limit_enforced = true`), zero overage rates —
  exceeding a quota yields `429 QUOTA_EXCEEDED`.
- **pro:** $25.00 base, soft quotas with metered overage (`hard_limit_enforced = false`).
- **enterprise:** $299.00 base, higher quotas and lower overage rates.

`org_subscriptions` is keyed by `org_id`, defaults to `plan_id = 'free'`, carries
`status` (`active`/`past_due`/`suspended`/`canceled`), `monthly_spend_cap_cents` (`NULL` = no cap),
`quota_override` JSONB, the current billing period and the 80 %/95 % alert timestamps. There is no
pre-existing `plans` table — `billing_plans` is new and `org_subscriptions` references it.

---

## 4. Hard spend cap behaviour

`PATCH /v1/console/orgs/:orgId/billing/subscription` lets an owner switch plans, set the hard monthly
spend cap (dollars in the UI, integer cents on the wire), and update the billing email. A cap is
evaluated in step 3 of `QuotaGuard`, **after** suspension and hard-quota checks. When the projected
bill (`calculateMonthlyBill(...).totalAmountCents`) reaches or exceeds `monthly_spend_cap_cents`,
further data-plane operations are refused with:

```json
{
  "error": {
    "code": "MONTHLY_SPEND_CAP_REACHED",
    "status": 402,
    "currentCents": 2499,
    "capCents": 2500
  }
}
```

The customer dashboard renders a **Hard Monthly Spend Cap** toggle plus dollar input; toggling it
writes the cap through the subscription endpoint. Plan/cap changes call `QuotaGuard.invalidate(orgId)`.

---

## 5. Integer-cent overage formulas

`calculateMonthlyBill(plan, usage)` returns `BillResult` with
`baseAmountCents`, `overageAmountCents`, `totalAmountCents` and `lineItems`. Every division is
**ceiling division on integers** — no floating point anywhere:

```text
overageReads    = max(0, usage.docReads    - plan.includedDocReads)
readCostCents   = ceil(overageReads    * plan.overageReadPer100kCents   / 100_000)

overageWrites   = max(0, usage.docWrites   - plan.includedDocWrites)
writeCostCents  = ceil(overageWrites   * plan.overageWritePer100kCents  / 100_000)

overageDeletes  = max(0, usage.docDeletes  - plan.includedDocDeletes)
deleteCostCents = ceil(overageDeletes  * plan.overageDeletePer100kCents / 100_000)

overageStorage  = max(0, usage.storageBytes - plan.includedStorageBytes)
storageGB       = ceil(overageStorage / 1_073_741_824)
storageCostCents= storageGB * plan.overageStoragePerGbCents

overageEgress   = max(0, usage.egressBytes  - plan.includedEgressBytes)
egressGB        = ceil(overageEgress / 1_073_741_824)
egressCostCents = egressGB * plan.overageEgressPerGbCents

overageMau      = max(0, usage.authMau     - plan.includedAuthMau)
mauCostCents    = ceil(overageMau * plan.overageMauPer1kCents / 1_000)

totalAmountCents = baseAmountCents + overageAmountCents
```

Example — `pro` with 5,150,000 reads and 2,000,000 writes: 150,000 overage reads × 6¢ / 100,000 =
9¢; 0 overage writes = 0¢. Total = 2,500 + 9 = **2,509¢** ($25.09) before other metrics. The
integration suite asserts exact integer-cent invoices.

---

## 6. Immutable double-entry ledger & invoices

### 6.1 `billing_ledger_entries` (append-only, hash-chained)

Migration `0008` creates the ledger with `seq bigserial PK`, `id UUID UNIQUE`, `org_id`,
`billing_month` (`YYYY-MM`), `entry_type` (`usage_flush`, `plan_charge`, `overage_charge`,
`credit_grant`, `payment_received`, `refund`, `admin_adjustment`), `amount_cents`, `metric_snapshot`
JSONB, `idempotency_key TEXT UNIQUE`, `description`, `prev_hash`, `entry_hash` and `created_at`.
Trigger `trg_immutable_billing_ledger` reuses `prevent_immutable_table_mutation()` from migration
`0007`, so `UPDATE`/`DELETE` raise `SECURITY_VIOLATION`. Every entry is hash-chained with the
**`billing-ledger-v1`** HKDF domain (distinct from `security-audit-v1`):

```text
key        = hkdfSync('sha256', masterKey, 'vellum-chain-salt-v1', 'billing-ledger-v1', 32)
entry_hash = hex(HMAC-SHA256(key, `${seq}|${prevHash}|${timestampIso}|${canonicalSerialize(payload)}`))
genesis    = '0'.repeat(64)
```

The `idempotency_key` makes flushes and administrative adjustments safe to retry. Verification uses
`timingSafeEqual` and reports `firstCorruptedSeq` on a tampered row.

### 6.2 Rollups and invoices

`usage_monthly_rollups` (unique per org/project/month) is the billing source of truth;
the pre-existing `project_usage_daily` operational counter coexists but is not the billing record.
`usage_daily_rollups` is org-keyed and written only by the flusher. `billing_invoices` has
`invoice_numberINV-YYYYMM-0001`, `base_amount_cents`, `overage_amount_cents`,
`credits_applied_cents`, `total_amount_cents`, `line_items` JSONB and `status`
(`draft`/`open`/`paid`/`void`/`uncollectible`), unique per `(org_id, billing_month)`.
`generateMonthlyInvoice(orgId, billingMonth)` finalizes one from the ledger and usage rollups.

---

## 7. Stripe webhook HMAC + replay protection

`verifyStripeWebhook(rawBody, header, secret, nowMs?)` parses the `Stripe-Signature` header
` t=<unix>,v1=<hex hmac-sha256>`, recomputes `HMAC-SHA256(secret, `${t}.${rawBody}`)` with
`timingSafeEqual`, and rejects timestamps older than **300 seconds**. On success it returns
`{ ok: true, eventId, eventType }`; the handler then inserts `event_id` into
`billing_webhook_events` (primary key) — a duplicate is rejected as replay before any ledger write.
`POST /v1/webhooks/billing/stripe` is the only billing endpoint that does not require a session; it
is verified purely by signature + replay guard. The integration suite rejects both an invalid
signature and a replayed valid event.

---

## 8. Customer & admin endpoints

### 8.1 Customer console (customer session + org membership; owner-only where noted)

| Method | Path | Purpose |
| :-- | :-- | :-- |
| `GET` | `/v1/console/orgs/:orgId/billing/summary` | plan, live usage vs quotas, projected cost, daily series, cap |
| `GET` | `/v1/console/orgs/:orgId/billing/plans` | list plans |
| `PATCH` | `/v1/console/orgs/:orgId/billing/subscription` | owner: plan switch, spend cap, billing email |
| `GET` | `/v1/console/orgs/:orgId/billing/invoices` | invoice list |
| `GET` | `/v1/console/orgs/:orgId/billing/invoices/:invoiceId` | invoice detail |
| `POST` | `/v1/webhooks/billing/stripe` | HMAC + replay verified only |

### 8.2 Super admin (super-admin session only; customers get `403`)

| Method | Path | Purpose |
| :-- | :-- | :-- |
| `GET` | `/v1/admin/billing/overview` | MRR, projected overage, top orgs, near-cap orgs |
| `GET` | `/v1/admin/billing/orgs` | org billing table |
| `PATCH` | `/v1/admin/billing/orgs/:orgId/override` | plan/status/quota override or credit/adjustment ledger entry |
| `POST` | `/v1/admin/billing/invoices/generate` | generate/finalize invoices for month |
| `POST` | `/v1/admin/billing/ledger/verify-chain` | `verifyHashChain` proof |

The customer dashboard route `/orgs/$orgId/billing` shows plan/usage cards (reads, writes, deletes,
storage GB, egress GB, auth MAU, peak WS), a 14/30-day usage chart, the spend-cap control, the plan
selector and the invoice table. The admin SPA route `/billing` (served at `/admin/billing`) shows
MRR/overage/read-write-egress KPIs, the org quota table and suspend/credit/override/invoice-generate
actions. Both ship complete EN + AR translations. As with all admin endpoints, no customer
`documents.data` is ever returned.

---

## 9. How to verify

With the API running against the two PostgreSQL planes, the real endpoint paths are:

```bash
BASE=http://localhost:8080
ORG=<org-uuid>
PROJECT=<project-uuid>

# Customer view (session cookie / console bearer).
curl -s "$BASE/v1/console/orgs/$ORG/billing/summary" \
  -H "Authorization: Bearer $CONSOLE_SESSION_TOKEN"
curl -s "$BASE/v1/console/orgs/$ORG/billing/plans" \
  -H "Authorization: Bearer $CONSOLE_SESSION_TOKEN"
curl -s "$BASE/v1/console/orgs/$ORG/billing/invoices" \
  -H "Authorization: Bearer $CONSOLE_SESSION_TOKEN"

# Owner: switch plan / set the hard spend cap (integer cents).
curl -s -X PATCH "$BASE/v1/console/orgs/$ORG/billing/subscription" \
  -H "Authorization: Bearer $CONSOLE_SESSION_TOKEN" -H "content-type: application/json" \
  -d '{"planId":"pro","monthlySpendCapCents":5000}'

# Admin (super-admin session only): revenue view and ledger proof.
curl -s "$BASE/v1/admin/billing/overview" \
  -H "Authorization: Bearer $ADMIN_SESSION_TOKEN"
curl -s "$BASE/v1/admin/billing/orgs" \
  -H "Authorization: Bearer $ADMIN_SESSION_TOKEN"
curl -s -X POST "$BASE/v1/admin/billing/ledger/verify-chain" \
  -H "Authorization: Bearer $ADMIN_SESSION_TOKEN"
# → { "valid": true, "totalChecked": N, "firstCorruptedSeq": null, "reason": null }

# Generate/finalize invoices for a month.
curl -s -X POST "$BASE/v1/admin/billing/invoices/generate" \
  -H "Authorization: Bearer $ADMIN_SESSION_TOKEN" -H "content-type: application/json" \
  -d '{"billingMonth":"2026-11"}'
```

Expected behaviours: after the 5 s flush, `billing/summary` reflects the same counts that a
metering engine `totalsFor()` reported; a free-plan org receives `429 QUOTA_EXCEEDED`; a pro-plan org
with a cap receives `402 MONTHLY_SPEND_CAP_REACHED`; and the ledger and audit verify-chain endpoints
both return `valid: true` until a row is tampered with (at which point `firstCorruptedSeq` is exact).

Automated evidence: `tests/integration/billing-metering-and-quotas.test.ts` (exact counts after flush,
free-plan hard quota 429, pro-plan hard cap 402, exact integer-cent invoice, duplicate/invalid Stripe
webhook rejected) and `tests/load/security-metering-overhead.ts` (< 0.5 ms added in-process hot-path
overhead).

Continue with [15 — Security, Threat Detection & Defense in Depth](./15-security-and-defense.md)
for the shared hash-chain primitive and middleware order, and
[14 — Smart Indexing & Performance](./14-smart-indexing-and-performance.md) for the performance
methodology behind the load gate.
