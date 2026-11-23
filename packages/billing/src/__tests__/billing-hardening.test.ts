import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyStripeWebhook,
  calculateMonthlyBill,
  invoiceNumberFor,
  UsageMeteringEngine,
  QuotaGuard,
} from "../index.js";

function signStripe(rawBody: string, secret: string, tsSec: number): string {
  const sig = createHmac("sha256", secret).update(`${tsSec}.${rawBody}`).digest("hex");
  return `t=${tsSec},v1=${sig}`;
}

describe("@vellum/billing hardening", () => {
  describe("Webhook signature verification", () => {
    const secret = "whsec_test_secret_123";
    const nowMs = 1_700_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    const body = JSON.stringify({ id: "evt_123", type: "invoice.paid" });

    it("accepts valid signature within 300s tolerance", () => {
      const header = signStripe(body, secret, nowSec - 60);
      const res = verifyStripeWebhook(body, header, secret, nowMs);
      expect(res).toEqual({ ok: true, eventId: "evt_123", eventType: "invoice.paid" });
    });

    it("rejects empty secret, replay outside 300s window, and NaN nowMs", () => {
      const header = signStripe(body, secret, nowSec);
      expect(verifyStripeWebhook(body, header, "", nowMs).ok).toBe(false);
      expect(verifyStripeWebhook(body, header, secret, Number.NaN).ok).toBe(false);

      const staleHeader = signStripe(body, secret, nowSec - 301);
      expect(verifyStripeWebhook(body, staleHeader, secret, nowMs)).toEqual({
        ok: false,
        code: "SIGNATURE_TIMESTAMP_OUT_OF_TOLERANCE",
      });
    });

    it("rejects prototype-polluted webhook JSON payloads", () => {
      const polluted = '{"id":"evt_1","type":"invoice.paid","__proto__":{"admin":true}}';
      const header = signStripe(polluted, secret, nowSec);
      expect(verifyStripeWebhook(polluted, header, secret, nowMs)).toEqual({
        ok: false,
        code: "INVALID_EVENT_PAYLOAD",
      });
    });
  });

  describe("NaN / Infinity / negative / overflow guards", () => {
    const plan = {
      id: "pro",
      name: "Pro",
      monthlyBasePriceCents: 2900,
      includedDocReads: 1_000_000,
      includedDocWrites: 500_000,
      includedDocDeletes: 500_000,
      includedStorageBytes: 1_073_741_824,
      includedEgressBytes: 1_073_741_824,
      includedAuthMau: 10_000,
      maxConcurrentWs: 100,
      overageReadPer100kCents: 10,
      overageWritePer100kCents: 20,
      overageDeletePer100kCents: 5,
      overageStoragePerGbCents: 25,
      overageEgressPerGbCents: 15,
      overageMauPer1kCents: 50,
      hardLimitEnforced: true,
    };

    it("clamps NaN, Infinity, and negative usage to safe integers in calculateMonthlyBill", () => {
      const bill = calculateMonthlyBill(plan as never, {
        docReads: Number.NaN,
        docWrites: Number.POSITIVE_INFINITY,
        docDeletes: -500,
        storageBytes: Number.NEGATIVE_INFINITY,
        egressBytes: 0,
        authMau: 0,
        peakConcurrentWs: 0,
      });
      expect(Number.isSafeInteger(bill.totalAmountCents)).toBe(true);
      expect(bill.baseAmountCents).toBe(2900);
      expect(bill.overageAmountCents).toBe(0);
    });

    it("validates calendar month 01-12 in invoiceNumberFor", () => {
      expect(() => invoiceNumberFor("org_1", "2026-13")).toThrow();
      expect(() => invoiceNumberFor("org_1", "2026-00")).toThrow();
      expect(invoiceNumberFor("org_1", "2026-11")).toMatch(/^INV-202611-\d{6}$/);
    });

    it("guards UsageMeteringEngine against NaN storage delta poisoning", () => {
      const engine = new UsageMeteringEngine({ billing: {} as never });
      engine.recordWrites("org_1", "proj_1", 1, 1024);
      engine.recordWrites("org_1", "proj_1", Number.NaN, Number.NaN);
      engine.recordReads("org_1", "proj_1", Number.POSITIVE_INFINITY);
      const totals = engine.totalsFor("org_1");
      expect(totals.storageBytes).toBe(1024);
      expect(totals.docWrites).toBe(1);
      expect(totals.docReads).toBe(0);
    });

    it("prevents external mutation of cached subscription in QuotaGuard", () => {
      const sub = {
        orgId: "org_1",
        planId: "pro",
        status: "suspended" as const,
        monthlySpendCapCents: null,
      };
      const guard = new QuotaGuard({
        billing: { getPlan: () => plan } as never,
      });
      guard.refreshFromStore([sub as never]);
      (sub as { status: string }).status = "active";
      const decision = guard.checkQuota("org_1", "read");
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe("SUBSCRIPTION_SUSPENDED");
    });
  });
});
