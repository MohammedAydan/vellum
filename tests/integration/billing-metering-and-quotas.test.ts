/**
 * Billing metering, quotas, invoices and webhook idempotency
 * (contract §8). Uses the deterministic in-memory control plane and the real
 * `@vellum/billing` implementations: no mocked crypto, no invented numbers.
 * Every expected value is derived independently in the test.
 */
import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type LedgerEntryRecord } from "@vellum/database-control";
import { ControlPlaneStore } from "@vellum/database-control/adapters";
import {
  QuotaGuard,
  UsageMeteringEngine,
  calculateMonthlyBill,
  consumeWebhookEvent,
  verifyStripeWebhook,
} from "@vellum/billing";
import { deriveChainKey, verifyHashChain, type ChainRow } from "@vellum/security";

const CHAIN_MASTER_KEY = "billing-test-ledger-master-key-v1";

function newHarness() {
  const control = new ControlPlaneStore();
  const billing = control.billing;
  const chainKey = deriveChainKey(CHAIN_MASTER_KEY, "billing-ledger-v1");
  const metering = new UsageMeteringEngine({ billing, chainKey });
  const quota = new QuotaGuard({
    billing,
    chainKey,
    usageProvider: (orgId) => metering.totalsFor(orgId),
  });
  return {
    control,
    billing,
    chainKey,
    metering,
    quota,
    orgId: randomUUID(),
    projectId: randomUUID(),
  };
}

/**
 * Ledger writers hash the payload WITHOUT the `timestampIso` they also stash
 * inside `metricSnapshot` for timestamp recovery. Reconstruct the exact hashed
 * payload before verifying, so this proves real chain integrity rather than
 * re-hashing a field that was never signed.
 */
function toChainRow(row: LedgerEntryRecord): ChainRow {
  const snapshot: Record<string, unknown> = { ...row.metricSnapshot };
  const embedded = snapshot["timestampIso"];
  delete snapshot["timestampIso"];
  return {
    seq: row.seq,
    prevHash: row.prevHash,
    entryHash: row.entryHash,
    timestampIso: typeof embedded === "string" ? embedded : row.createdAt,
    payload: snapshot,
  };
}

describe("billing metering & quotas", () => {
  it("flushes exact reads/writes/deletes/egress/auth counts and a valid usage_flush ledger chain", async () => {
    const { billing, chainKey, metering, orgId, projectId } = newHarness();
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const day = now.toISOString().slice(0, 10);

    for (let i = 0; i < 10; i += 1) {
      metering.recordReads(orgId, projectId, 1);
      metering.recordWrites(orgId, projectId, 1, 0);
      metering.recordDeletes(orgId, projectId, 1, 0);
      metering.recordEgress(orgId, projectId, 256);
      metering.recordActiveAuthUser(orgId, projectId, `user_${i}`);
    }

    const result = await metering.flush();
    expect(result.flushedGroups).toBe(1);
    expect(result.ledgerSeq).not.toBeNull();

    const monthly = await billing.listMonthly(orgId, month);
    expect(monthly).toHaveLength(1);
    expect(monthly[0]).toMatchObject({
      orgId,
      projectId,
      billingMonth: month,
      docReads: 10,
      docWrites: 10,
      docDeletes: 10,
      egressBytes: 2560,
      authMau: 10,
      storageBytes: 0,
    });

    const daily = await billing.listDaily(orgId, day, day);
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({
      usageDate: day,
      docReads: 10,
      docWrites: 10,
      docDeletes: 10,
      egressBytes: 2560,
    });

    const ledger = await billing.listLedger();
    const flushEntry = ledger.find((entry) => entry.entryType === "usage_flush");
    expect(flushEntry).toBeDefined();
    expect(flushEntry?.orgId).toBe(orgId);
    expect(flushEntry?.metricSnapshot).toMatchObject({
      kind: "usage_flush",
      totals: { docReads: 10, docWrites: 10, docDeletes: 10, egressBytes: 2560, authMau: 10 },
    });
    expect(verifyHashChain(chainKey, ledger.map(toChainRow))).toEqual({
      valid: true,
      totalChecked: ledger.length,
      firstCorruptedSeq: null,
      reason: null,
    });
  });

  it("enforces the free plan hard quota with 429 QUOTA_EXCEEDED", async () => {
    const { billing, metering, quota, orgId, projectId } = newHarness();
    await quota.refreshPlans();
    const subscription = await billing.ensureSubscription(orgId);
    expect(subscription.planId).toBe("free");
    quota.refreshFromStore([subscription]);

    const plan = await billing.getPlan("free");
    expect(plan).not.toBeNull();
    const hugeReads = (plan?.includedDocReads ?? 0) + 1_000;
    metering.recordReads(orgId, projectId, hugeReads);

    const decision = quota.checkQuota(orgId, "read");
    expect(decision).toMatchObject({
      allowed: false,
      statusCode: 429,
      code: "QUOTA_EXCEEDED",
      metric: "docReads",
      used: hugeReads,
      limit: plan?.includedDocReads,
    });
  });

  it("enforces the pro plan hard monthly spend cap with 402 MONTHLY_SPEND_CAP_REACHED", async () => {
    const { billing, metering, quota, orgId, projectId } = newHarness();
    await billing.ensureSubscription(orgId);
    await billing.updateSubscription(orgId, { planId: "pro", monthlySpendCapCents: 2500 });
    await quota.refreshPlans();
    const subscription = await billing.getSubscription(orgId);
    expect(subscription).not.toBeNull();
    quota.refreshFromStore([subscription === null ? (await billing.ensureSubscription(orgId)) : subscription]);

    const plan = await billing.getPlan("pro");
    expect(plan?.monthlyBasePriceCents).toBe(2500);
    // 100,000 reads beyond the included 5,000,000 cost 6 cents at 6¢/100k.
    metering.recordReads(orgId, projectId, (plan?.includedDocReads ?? 0) + 100_000);

    const decision = quota.checkQuota(orgId, "read");
    expect(decision).toMatchObject({
      allowed: false,
      statusCode: 402,
      code: "MONTHLY_SPEND_CAP_REACHED",
      currentCents: 2506,
      capCents: 2500,
    });
  });

  it("calculates exact integer-cent overages (pro + 100,000 extra reads = $25.06)", async () => {
    const { billing } = newHarness();
    const plan = await billing.getPlan("pro");
    expect(plan).not.toBeNull();
    if (plan === null) return;

    const usage = {
      docReads: plan.includedDocReads + 100_000,
      docWrites: 0,
      docDeletes: 0,
      storageBytes: 0,
      egressBytes: 0,
      authMau: 0,
      peakConcurrentWs: 0,
    };
    // Independent calculation, not a call into the calculator under test.
    const expectedOverageCents = Math.ceil(
      ((usage.docReads - plan.includedDocReads) * plan.overageReadPer100kCents) / 100_000
    );
    expect(expectedOverageCents).toBe(6);

    const bill = calculateMonthlyBill(plan, usage);
    expect(bill.baseAmountCents).toBe(2500);
    expect(bill.overageAmountCents).toBe(expectedOverageCents);
    expect(bill.totalAmountCents).toBe(2500 + expectedOverageCents);
    expect(bill.totalAmountCents).toBe(2506);
    expect(bill.lineItems.find((item) => item.metric === "docReads")).toMatchObject({
      overageUnits: 100_000,
      rateCents: 6,
      costCents: 6,
    });
  });

  it("verifies a real Stripe signature and rejects replays and invalid signatures", async () => {
    const { billing } = newHarness();
    const secret = "whsec_fortress_test_secret_32_chars";
    const rawBody = JSON.stringify({
      id: "evt_fortress_billing_1",
      type: "invoice.paid",
      data: { object: { id: "in_fortress_1" } },
    });
    const unixSeconds = 1_800_000_000;
    const nowMs = unixSeconds * 1000 + 1000; // within the 300 s tolerance
    const signature = createHmac("sha256", secret)
      .update(`${unixSeconds}.${rawBody}`)
      .digest("hex");
    const header = `t=${unixSeconds},v1=${signature}`;

    const verified = verifyStripeWebhook(rawBody, header, secret, nowMs);
    expect(verified).toEqual({
      ok: true,
      eventId: "evt_fortress_billing_1",
      eventType: "invoice.paid",
    });

    expect(await consumeWebhookEvent(billing, verified.eventId, "stripe", verified.eventType)).toBe(
      true
    );
    expect(await consumeWebhookEvent(billing, verified.eventId, "stripe", verified.eventType)).toBe(
      false
    );

    const forged = verifyStripeWebhook(
      rawBody,
      `t=${unixSeconds},v1=${"0".repeat(64)}`,
      secret,
      nowMs
    );
    expect(forged).toEqual({ ok: false, code: "INVALID_SIGNATURE" });

    const stale = verifyStripeWebhook(rawBody, header, secret, unixSeconds * 1000 + 301_000);
    expect(stale).toEqual({ ok: false, code: "SIGNATURE_TIMESTAMP_OUT_OF_TOLERANCE" });
  });
});
