/**
 * @vellum/billing - Canonical Billing & Metering Port Contracts
 */

import type {
  BillingPlanRecord,
  BillingRepository,
  InvoiceRecord,
  OrgSubscriptionRecord,
} from "@vellum/database-control";
import type { BillResult } from "../billing-calculator.js";
import type { FlushResult, UsageTotals } from "../metering-engine.js";
import type { QuotaDecision, QuotaOperation } from "../quota-guard.js";
import type { WebhookVerificationResult } from "../webhook-verifier.js";

/** Outbound port for O(1) hot-path usage metering and background rollup flushing. */
export interface MeteringPort {
  recordReads(orgId: string, projectId: string, count: number): void;
  recordWrites(orgId: string, projectId: string, count: number, storageDeltaBytes: number): void;
  recordDeletes(orgId: string, projectId: string, count: number, storageDeltaBytes: number): void;
  recordEgress(orgId: string, projectId: string, bytes: number): void;
  recordActiveAuthUser(orgId: string, projectId: string, userId: string): void;
  recordWsConnectionDelta(orgId: string, projectId: string, delta: 1 | -1): void;
  totalsFor(orgId: string): Readonly<UsageTotals>;
  flush(): Promise<FlushResult>;
  start(intervalMs?: number): void;
  stop(): Promise<void>;
}

/** Outbound port for O(1) synchronous quota and spend-cap enforcement. */
export interface QuotaGuardPort {
  refreshFromStore(rows: readonly OrgSubscriptionRecord[]): void;
  refreshPlans(): Promise<void>;
  invalidate(orgId: string): void;
  checkQuota(orgId: string, op: QuotaOperation): QuotaDecision;
}

/** Outbound port for integer-cent bill calculation and hash-chained invoice generation. */
export interface InvoiceGeneratorPort {
  calculateMonthlyBill(plan: BillingPlanRecord, usage: UsageTotals): BillResult;
  calculateBillCents(plan: BillingPlanRecord, usage: UsageTotals): number;
  invoiceNumberFor(orgId: string, billingMonth: string): string;
  generateMonthlyInvoice(orgId: string, billingMonth: string): Promise<InvoiceRecord>;
}

/** Outbound port for Stripe-compatible webhook signature verification and replay consumption. */
export interface WebhookVerifierPort {
  verifyStripeWebhook(
    rawBody: string | Buffer,
    header: string | null | undefined,
    secret: string,
    nowMs?: number
  ): WebhookVerificationResult;
  consumeWebhookEvent(
    billing: BillingRepository,
    eventId: string,
    provider: string,
    eventType: string
  ): Promise<boolean>;
}
