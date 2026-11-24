/**
 * `packages/billing/src/quota-guard.ts`
 *
 * Quota enforcement (contract §4). The subscription, plan and month-to-date usage are read
 * from the database on every check (one round trip), so every API instance enforces the same
 * state at once: a suspension, plan change or cap change takes effect on the next request.
 */

import type {
  BillingPlanRecord,
  BillingRepository,
  OrgSubscriptionRecord,
} from "@vellum/database-control";
import { calculateBillCents } from "./billing-calculator.js";
import type { QuotaGuardPort } from "./contracts/billing-port.js";
import type { UsageTotals } from "./metering-engine.js";


export type QuotaOperation = "read" | "write" | "delete" | "ws_connect" | "auth_signup";

export interface QuotaDecision {
  allowed: boolean;
  statusCode?: number;
  code?: string;
  metric?: string;
  used?: number;
  limit?: number;
  currentCents?: number;
  capCents?: number;
  warningHeader?: "80%" | "95%";
}

export interface QuotaGuardOptions {
  billing: BillingRepository;
  /** Accepted for ledger-configuration parity; quota checks never write a ledger. */
  chainKey?: Buffer | undefined;
  /** Accepted for ledger-configuration parity; quota checks never write a ledger. */
  masterKey?: string | undefined;
}

interface MetricView {
  metric: string;
  used: number;
  limit: number;
}

const EMPTY_USAGE: Readonly<UsageTotals> = Object.freeze({
  docReads: 0,
  docWrites: 0,
  docDeletes: 0,
  storageBytes: 0,
  egressBytes: 0,
  authMau: 0,
  peakConcurrentWs: 0,
});

function safeNonNegativeInt(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function sanitizeUsage(usage: UsageTotals | undefined): Readonly<UsageTotals> {
  if (!usage) return EMPTY_USAGE;
  return {
    docReads: safeNonNegativeInt(usage.docReads),
    docWrites: safeNonNegativeInt(usage.docWrites),
    docDeletes: safeNonNegativeInt(usage.docDeletes),
    storageBytes: safeNonNegativeInt(usage.storageBytes),
    egressBytes: safeNonNegativeInt(usage.egressBytes),
    authMau: safeNonNegativeInt(usage.authMau),
    peakConcurrentWs: safeNonNegativeInt(usage.peakConcurrentWs),
  };
}

function metricView(op: QuotaOperation, usage: Readonly<UsageTotals>, plan: BillingPlanRecord | null): MetricView {
  switch (op) {
    case "read":
      return { metric: "docReads", used: usage.docReads, limit: safeNonNegativeInt(plan?.includedDocReads ?? 0) };
    case "write":
      return { metric: "docWrites", used: usage.docWrites, limit: safeNonNegativeInt(plan?.includedDocWrites ?? 0) };
    case "delete":
      return { metric: "docDeletes", used: usage.docDeletes, limit: safeNonNegativeInt(plan?.includedDocDeletes ?? 0) };
    case "ws_connect":
      return { metric: "peakConcurrentWs", used: usage.peakConcurrentWs, limit: safeNonNegativeInt(plan?.maxConcurrentWs ?? 0) };
    case "auth_signup":
      return { metric: "authMau", used: usage.authMau, limit: safeNonNegativeInt(plan?.includedAuthMau ?? 0) };
  }
}

export class QuotaGuard implements QuotaGuardPort {
  private readonly billing: BillingRepository;

  constructor(options: QuotaGuardOptions) {
    this.billing = options.billing;
  }

  /**
   * Authoritative decision from the database. An org with no subscription row is allowed (it
   * has no plan to enforce). Database errors propagate so the caller chooses fail-open or
   * fail-closed explicitly.
   */
  public async checkQuota(orgId: string, op: QuotaOperation): Promise<QuotaDecision> {
    const month = new Date().toISOString().slice(0, 7);
    const state = await this.billing.getQuotaState(orgId, month);
    if (state === null) return { allowed: true };
    return decide(state.subscription, state.plan, sanitizeUsage(state.usage), op);
  }
}

/** Enforcement order is locked: suspension, hard quota, monthly spend cap, then 80%/95% warnings. */
function decide(
  subscription: OrgSubscriptionRecord,
  plan: BillingPlanRecord | null,
  usage: Readonly<UsageTotals>,
  op: QuotaOperation
): QuotaDecision {
  if (subscription.status === "suspended") {
    return { allowed: false, statusCode: 402, code: "SUBSCRIPTION_SUSPENDED" };
  }
  const view = metricView(op, usage, plan);

  if (plan !== null && plan.hardLimitEnforced && view.limit > 0 && view.used >= view.limit) {
    return {
      allowed: false,
      statusCode: 429,
      code: "QUOTA_EXCEEDED",
      metric: view.metric,
      used: view.used,
      limit: view.limit,
    };
  }

  if (
    plan !== null &&
    subscription.monthlySpendCapCents !== null &&
    Number.isFinite(subscription.monthlySpendCapCents) &&
    subscription.monthlySpendCapCents >= 0
  ) {
    const capCents = safeNonNegativeInt(subscription.monthlySpendCapCents);
    const currentCents = calculateBillCents(plan, usage);
    if (currentCents >= capCents) {
      return {
        allowed: false,
        statusCode: 402,
        code: "MONTHLY_SPEND_CAP_REACHED",
        currentCents,
        capCents,
      };
    }
  }

  // Overflow-safe BigInt integer percentage comparisons; no floating-point thresholds.
  if (plan !== null && view.limit > 0) {
    const usedBig = BigInt(view.used);
    const limitBig = BigInt(view.limit);
    if (usedBig * 100n >= limitBig * 95n) return { allowed: true, warningHeader: "95%" };
    if (usedBig * 100n >= limitBig * 80n) return { allowed: true, warningHeader: "80%" };
  }
  return { allowed: true };
}
