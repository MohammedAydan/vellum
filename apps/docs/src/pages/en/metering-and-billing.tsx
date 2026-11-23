import {
  Api,
  Badge,
  Callout,
  Code,
  Doc,
  H3,
  P,
  PageLink,
  Section,
  Table,
  UL,
} from "../../ui";

const formulas = `overageReads    = max(0, usage.docReads    - plan.includedDocReads)
readCostCents   = ceil(overageReads    * plan.overageReadPer100kCents   / 100_000)
overageWrites   = max(0, usage.docWrites   - plan.includedDocWrites)
writeCostCents  = ceil(overageWrites   * plan.overageWritePer100kCents  / 100_000)
overageDeletes  = max(0, usage.docDeletes  - plan.includedDocDeletes)
deleteCostCents = ceil(overageDeletes  * plan.overageDeletePer100kCents / 100_000)

GB              = 1_073_741_824 bytes
storageGB       = ceil(max(0, usage.storageBytes - plan.includedStorageBytes) / GB)
storageCostCents= storageGB * plan.overageStoragePerGbCents
egressGB        = ceil(max(0, usage.egressBytes  - plan.includedEgressBytes)  / GB)
egressCostCents = egressGB  * plan.overageEgressPerGbCents

mauCostCents    = ceil(max(0, usage.authMau - plan.includedAuthMau)
                       * plan.overageMauPer1kCents / 1_000)

totalAmountCents = baseAmountCents + overageAmountCents   // integer cents only`;

const chain = `key        = hkdfSync('sha256', masterKey, 'vellum-chain-salt-v1', 'billing-ledger-v1', 32)
entry_hash = hex(HMAC-SHA256(key, \`\${seq}|\${prevHash}|\${timestampIso}|\${canonicalSerialize(payload)}\`))
genesis    = '0'.repeat(64)
idempotency_key TEXT NOT NULL UNIQUE   // safe retries for flushes + adjustments`;

const curl = `BASE=http://localhost:8080
ORG=<org-uuid>

# Customer view (console session).
curl -s "$BASE/v1/console/orgs/$ORG/billing/summary" \\
  -H "Authorization: Bearer $CONSOLE_SESSION_TOKEN"
curl -s "$BASE/v1/console/orgs/$ORG/billing/plans" \\
  -H "Authorization: Bearer $CONSOLE_SESSION_TOKEN"
curl -s "$BASE/v1/console/orgs/$ORG/billing/invoices" \\
  -H "Authorization: Bearer $CONSOLE_SESSION_TOKEN"

# Owner: switch plan / set the hard spend cap (integer cents).
curl -s -X PATCH "$BASE/v1/console/orgs/$ORG/billing/subscription" \\
  -H "Authorization: Bearer $CONSOLE_SESSION_TOKEN" -H "content-type: application/json" \\
  -d '{"planId":"pro","monthlySpendCapCents":5000}'

# Admin (super-admin session only): revenue view + ledger proof.
curl -s "$BASE/v1/admin/billing/overview" \\
  -H "Authorization: Bearer $ADMIN_SESSION_TOKEN"
curl -s -X POST "$BASE/v1/admin/billing/ledger/verify-chain" \\
  -H "Authorization: Bearer $ADMIN_SESSION_TOKEN"
# → { "valid": true, "totalChecked": N, "firstCorruptedSeq": null, "reason": null }

# Generate/finalize invoices for a month.
curl -s -X POST "$BASE/v1/admin/billing/invoices/generate" \\
  -H "Authorization: Bearer $ADMIN_SESSION_TOKEN" -H "content-type: application/json" \\
  -d '{"billingMonth":"2026-11"}'`;

export default function Page() {
  return (
    <Doc
      title="Metering, quotas & billing"
      description="O(1) in-memory metering with an atomic Map swap and 5 s flush, a 10 s quota snapshot cache, locked plans and hard spend cap, integer-cent overages, an immutable hash-chained ledger, invoices and Stripe webhook verification."
      eyebrow="Operations"
    >
      <Section id="overview" title="Overview">
        <P>
          The billing subsystem has one hard performance rule: <strong>no synchronous database write
          in the hot path</strong> (<code>getDocument</code>, <code>queryDocuments</code>,{" "}
          <code>setDocument</code>, <code>deleteDocument</code>, WS frames). Metering is O(1){" "}
          <code>Map</code> delta accumulation; quota checks are O(1) in-memory reads. PostgreSQL is the
          only stateful service, and all money is integer cents—never floats.
        </P>
        <Callout tone="info" title="Shared foundations">
          The hash-chain primitive, immutability trigger and middleware order are shared with{" "}
          <PageLink slug="security-and-defense">Security &amp; defense in depth</PageLink>. Quotas and
          limits in general are covered by <PageLink slug="errors-and-limits">Quotas &amp; limits</PageLink>.
        </Callout>
      </Section>

      <Section id="metering" title="O(1) in-memory metering">
        <P>
          <code>UsageMeteringEngine</code> (<code>@vellum/billing</code>) exposes only synchronous{" "}
          <code>record*</code> methods on the request path. Each call mutates a{" "}
          <code>PendingDelta</code> plus a realtime org total and returns—no I/O, no{" "}
          <code>await</code>. The Map key is{" "}
          <code>{"`${orgId}|${projectId}|${envId}|${YYYY-MM}`"}</code>. An{" "}
          <code>authUsers: Set</code> deduplicates monthly-active users.
        </P>
        <Code
          lang="typescript"
          title="Request-path API (all void, all synchronous)"
          code={`recordReads(orgId, projectId, envId, count): void
recordWrites(orgId, projectId, envId, count, storageDeltaBytes): void
recordDeletes(orgId, projectId, envId, count, storageDeltaBytes): void
recordEgress(orgId, projectId, envId, bytes): void
recordActiveAuthUser(orgId, projectId, envId, userId): void
recordWsConnectionDelta(orgId, projectId, envId, delta: 1 | -1): void
totalsFor(orgId): Readonly<UsageTotals>   // live dashboard cards`}
        />
        <H3 id="flush">Atomic Map swap + 5 s async flush</H3>
        <P>
          <code>flush()</code> <strong>swaps <code>pendingDeltas</code> to a fresh Map before any DB
          I/O</strong>. Request handlers never block on a flush: deltas recorded after the swap land in
          the new map for the next cycle. The flush performs batched <code>UPSERT</code>s into the
          monthly/daily rollups, then appends a hash-chained <code>usage_flush</code> ledger row. The
          default interval is <strong>5,000 ms</strong>; <code>stop()</code> guarantees a final flush on
          SIGINT/SIGTERM.
        </P>
      </Section>

      <Section id="quota-guard" title="Quota snapshot cache & O(1) QuotaGuard">
        <P>
          <code>QuotaGuard.checkQuota(orgId, op)</code> is a pure in-memory read over a snapshot cache
          refreshed on a <strong>10 s TTL</strong> with push invalidation. Operations:{" "}
          <code>read</code>, <code>write</code>, <code>delete</code>, <code>ws_connect</code>,{" "}
          <code>auth_signup</code>. Enforcement order is locked:
        </P>
        <UL
          items={[
            <><code>status === 'suspended'</code> → <code>402 SUBSCRIPTION_SUSPENDED</code>.</>,
            <><code>hardLimitEnforced &amp;&amp; used &gt;= included</code> → <code>429 QUOTA_EXCEEDED</code> (with metric/used/limit).</>,
            <><code>monthlySpendCapCents !== null &amp;&amp; calculateBillCents(...) &gt;= cap</code> → <code>402 MONTHLY_SPEND_CAP_REACHED</code> (currentCents/capCents).</>,
            <>Otherwise allowed; at 80 %/95 % attach <code>x-vellum-quota-warning: 80% | 95%</code>.</>,
          ]}
        />
        <P>
          The guard is step 7 of the fortress middleware, before the handler and post-handler metering.
        </P>
      </Section>

      <Section id="plans" title="Locked plan table">
        <P>
          <code>billing_plans</code> is seeded exactly by migration <code>0008</code>. Storage and
          egress are byte counts (GB = 1,073,741,824 bytes); prices are monthly cents.
        </P>
        <Table
          head={["Plan", "Base", "Reads", "Writes", "Deletes", "Storage", "Egress", "MAU", "WS"]}
          rows={[
            [<><Badge tone="info">free</Badge> Starter</>, "$0", "1,500,000", "600,000", "600,000", "1 GiB", "10 GiB", "10,000", "50"],
            [<><Badge tone="success">pro</Badge> Pay-as-you-go</>, "$25.00", "5,000,000", "2,000,000", "1,000,000", "20 GiB", "100 GiB", "100,000", "1000"],
            [<><Badge tone="warning">enterprise</Badge></>, "$299.00", "50,000,000", "20,000,000", "10,000,000", "200 GiB", "1024 GiB", "1,000,000", "10000"],
          ]}
        />
        <Table
          head={["Plan", "read¢/100k", "write¢/100k", "delete¢/100k", "storage¢/GB", "egress¢/GB", "MAU¢/1k", "Hard limits"]}
          rows={[
            ["free", "0", "0", "0", "0", "0", "0", "true"],
            ["pro", "6", "18", "2", "18", "12", "500", "false"],
            ["enterprise", "4", "12", "1", "14", "9", "300", "false"],
          ]}
        />
        <P>
          Free enforces hard quotas (<code>429</code>) with zero overage rates. Pro and enterprise use
          soft quotas with metered overage. <code>org_subscriptions</code> is keyed by{" "}
          <code>org_id</code>, defaults to <code>free</code>, carries status,{" "}
          <code>monthly_spend_cap_cents</code> (<code>NULL</code> = no cap), <code>quota_override</code>{" "}
          JSONB and the 80 %/95 % alert timestamps.
        </P>
      </Section>

      <Section id="spend-cap" title="Hard spend cap behaviour">
        <P>
          An owner patches the subscription with a plan, spend cap and billing email. The cap is
          evaluated in step 3, after suspension and hard-quota checks. When the projected bill reaches
          or exceeds <code>monthlySpendCapCents</code>, further data-plane operations are refused:
        </P>
        <Code
          lang="json"
          title="402 MONTHLY_SPEND_CAP_REACHED"
          code={`{
  "error": {
    "code": "MONTHLY_SPEND_CAP_REACHED",
    "status": 402,
    "currentCents": 2499,
    "capCents": 2500
  }
}`}
        />
        <P>
          The dashboard renders a Hard Monthly Spend Cap toggle plus dollar input; plan/cap changes
          call <code>QuotaGuard.invalidate(orgId)</code>.
        </P>
      </Section>

      <Section id="formulas" title="Integer-cent overage formulas">
        <P>
          <code>calculateMonthlyBill(plan, usage)</code> uses <strong>ceiling division on
          integers</strong>—no floating point anywhere:
        </P>
        <Code lang="text" title="Exact formulas" code={formulas} />
        <P>
          Example—pro with 5,150,000 reads and 2,000,000 writes: 150,000 overage reads × 6¢ / 100,000
          = 9¢; 0 overage writes. Total = 2,500 + 9 = <strong>2,509¢ ($25.09)</strong> before other
          metrics. The integration suite asserts exact integer-cent invoices.
        </P>
      </Section>

      <Section id="ledger" title="Immutable double-entry ledger & invoices">
        <P>
          <code>billing_ledger_entries</code> (migration <code>0008</code>) is append-only:
          <code>seq</code>, <code>org_id</code>, <code>billing_month</code>,{" "}
          <code>entry_type</code> (<code>usage_flush</code>, <code>plan_charge</code>,{" "}
          <code>overage_charge</code>, <code>credit_grant</code>, <code>payment_received</code>,{" "}
          <code>refund</code>, <code>admin_adjustment</code>), <code>amount_cents</code>,{" "}
          <code>metric_snapshot</code>, <code>idempotency_key UNIQUE</code>, <code>prev_hash</code> and{" "}
          <code>entry_hash</code>. Trigger <code>trg_immutable_billing_ledger</code> reuses{" "}
          <code>prevent_immutable_table_mutation()</code> from migration <code>0007</code>, so{" "}
          <code>UPDATE</code>/<code>DELETE</code> raise <code>SECURITY_VIOLATION</code>.
        </P>
        <Code lang="text" title="Ledger hash chain (billing-ledger-v1 domain)" code={chain} />
        <P>
          <code>usage_monthly_rollups</code> is the billing source of truth; the existing{" "}
          <code>project_usage_daily</code> operational counter coexists but is not the billing record.
          <code>billing_invoices</code> uses <code>INV-YYYYMM-0001</code> numbers, stores base/overage/
          credits/total in cents plus <code>line_items</code> JSONB, and is unique per org and month.
          <code>generateMonthlyInvoice()</code> finalizes one from the ledger and rollups.
        </P>
      </Section>

      <Section id="webhook" title="Stripe webhook HMAC + replay protection">
        <P>
          <code>verifyStripeWebhook(rawBody, header, secret)</code> parses{" "}
          <code>t=&lt;unix&gt;,v1=&lt;hex hmac-sha256&gt;</code>, recomputes{" "}
          <code>{"HMAC-SHA256(secret, `${t}.${rawBody}`)"}</code> with{" "}
          <code>timingSafeEqual</code>, and rejects timestamps older than <strong>300 seconds</strong>.
          On success it inserts <code>event_id</code> into <code>billing_webhook_events</code> (primary
          key)—a duplicate is rejected as replay before any ledger write.{" "}
          <code>POST /v1/webhooks/billing/stripe</code> is verified purely by signature + replay guard.
        </P>
      </Section>

      <Section id="endpoints" title="Customer & admin endpoints">
        <H3 id="customer">Customer console (session + org membership)</H3>
        <Api method="GET" path="/v1/console/orgs/:orgId/billing/summary">
          <P>Plan, live usage vs quotas, projected cost, daily series and cap.</P>
        </Api>
        <Api method="GET" path="/v1/console/orgs/:orgId/billing/plans">
          <P>List plans.</P>
        </Api>
        <Api method="PATCH" path="/v1/console/orgs/:orgId/billing/subscription">
          <P>Owner-only: plan switch, spend cap, billing email.</P>
        </Api>
        <Api method="GET" path="/v1/console/orgs/:orgId/billing/invoices">
          <P>Invoice list; detail at <code>/invoices/:invoiceId</code>.</P>
        </Api>
        <H3 id="admin">Super admin (customers get 403)</H3>
        <Api method="GET" path="/v1/admin/billing/overview">
          <P>MRR, projected overage, top orgs and near-cap orgs.</P>
        </Api>
        <Api method="GET" path="/v1/admin/billing/orgs">
          <P>Org billing table; <code>PATCH /orgs/:orgId/override</code> changes plan/status/quota or posts an adjustment.</P>
        </Api>
        <Api method="POST" path="/v1/admin/billing/invoices/generate">
          <P>Generate/finalize invoices for a month.</P>
        </Api>
        <Api method="POST" path="/v1/admin/billing/ledger/verify-chain">
          <P>Live <code>verifyHashChain</code> proof over <code>billing_ledger_entries</code>.</P>
        </Api>
        <P>
          The customer dashboard route <code>/orgs/$orgId/billing</code> shows plan/usage cards
          (reads, writes, deletes, storage GB, egress GB, auth MAU, peak WS), a 14/30-day chart, the
          spend-cap control, plan selector and invoice table. The admin route <code>/billing</code>{" "}
          (served at <code>/admin/billing</code>) shows KPIs, the org quota table and
          suspend/credit/override/invoice-generate actions. No customer <code>documents.data</code> is
          ever returned to admin.
        </P>
      </Section>

      <Section id="verify" title="How to verify">
        <P>With the API running against both PostgreSQL planes, use the real endpoint paths:</P>
        <Code lang="bash" title="Verification walkthrough" code={curl} />
        <P>
          Expected: after the 5 s flush, <code>billing/summary</code> matches the engine{" "}
          <code>totalsFor()</code>; a free-plan org gets <code>429 QUOTA_EXCEEDED</code>; a pro org with
          a cap gets <code>402 MONTHLY_SPEND_CAP_REACHED</code>; and both verify-chain endpoints return{" "}
          <code>valid: true</code> until a row is tampered with. Automated evidence lives in{" "}
          <code>tests/integration/billing-metering-and-quotas.test.ts</code> and{" "}
          <code>tests/load/security-metering-overhead.ts</code> (&lt;0.5 ms added hot-path overhead;
          <code>PHASE5_REAL=1</code> results in <code>docs/evidence/SECURITY-BILLING-PERFORMANCE.md</code>).
        </P>
      </Section>
    </Doc>
  );
}
