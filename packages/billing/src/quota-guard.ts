/**
 * `packages/billing/src/quota-guard.ts`
 *
 * O(1), pure, synchronous quota enforcement (contract §4). All state comes
 * from a bounded, TTL-stamped subscription/plan snapshot cache with defensive
 * copies; `checkQuota` never touches the database and never awaits.
 */

import type {
  BillingPlanRecord,
  BillingRepository,
  OrgSubscriptionRecord,
} from "@vellum/database-control";
import { calculateBillCents } from "./billing-calculator.js";
import type { QuotaGuardPort } from "./contracts/billing-port.js";
import type { UsageTotals } from "./metering-engine.js";

const SNAPSHOT_TTL_MS = 10_000;
const MAX_SNAPSHOTS = 10_000;
const MAX_PLANS = 1_000;

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
  /** Real-time usage source, normally `UsageMeteringEngine.totalsFor`. */
  usageProvider?: ((orgId: string) => UsageTotals) | undefined;
}

interface SubscriptionSnapshot {
  subscription: OrgSubscriptionRecord;
  plan: BillingPlanRecord | null;
  fetchedAt: number;
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

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

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
  private readonly usageProvider: ((orgId: string) => UsageTotals) | undefined;
  private readonly snapshots = new Map<string, SubscriptionSnapshot>();
  private readonly plans = new Map<string, BillingPlanRecord>();

  constructor(options: QuotaGuardOptions) {
    this.billing = options.billing;
    this.usageProvider = options.usageProvider;
  }

  /**
   * Replaces subscription snapshots with fresh store rows. Plan records are
   * taken from the bounded plan cache; missing plans are fetched in the
   * background (synchronously for the in-memory store) and patched in place.
   */
  public refreshFromStore(rows: readonly OrgSubscriptionRecord[]): void {
    const now = Date.now();
    this.pruneExpired(now);

    for (const row of rows) {
      const clonedRow: OrgSubscriptionRecord = { ...row };
      this.snapshots.delete(clonedRow.orgId);
      this.snapshots.set(clonedRow.orgId, {
        subscription: clonedRow,
        plan: this.plans.get(clonedRow.planId) ?? null,
        fetchedAt: now,
      });
      if (!this.plans.has(clonedRow.planId)) {
        const maybePlan = this.billing.getPlan(clonedRow.planId);
        if (isThenable(maybePlan)) {
          void maybePlan
            .then((plan) => this.applyPlan(clonedRow.orgId, clonedRow.planId, plan))
            .catch(() => undefined);
        } else {
          this.applyPlan(clonedRow.orgId, clonedRow.planId, maybePlan);
        }
      }
    }
    this.enforceSnapshotCap();
  }

  /** Primes the plan cache from the store; call once at startup by Phase 3. */
  public async refreshPlans(): Promise<void> {
    const plans = await this.billing.listPlans();
    for (const plan of plans) {
      const clonedPlan: BillingPlanRecord = { ...plan };
      this.putPlan(clonedPlan);
      for (const [orgId, snapshot] of this.snapshots) {
        if (snapshot.subscription.planId === clonedPlan.id) {
          this.snapshots.set(orgId, { ...snapshot, plan: clonedPlan });
        }
      }
    }
  }

  /** Push invalidation on plan/status/cap changes. */
  public invalidate(orgId: string): void {
    this.snapshots.delete(orgId);
  }

  /**
   * Pure O(1) decision. Enforcement order is locked: suspension, hard quota,
   * monthly spend cap, then 80%/95% warning headers.
   */
  public checkQuota(orgId: string, op: QuotaOperation): QuotaDecision {
    const snapshot = this.snapshots.get(orgId);
    if (!snapshot) return { allowed: true };

    const { subscription, plan } = snapshot;
    if (subscription.status === "suspended") {
      return { allowed: false, statusCode: 402, code: "SUBSCRIPTION_SUSPENDED" };
    }

    const usage = sanitizeUsage(this.usageProvider?.(orgId));
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

  // -------------------------------------------------------------------------
  // Internal cache management
  // -------------------------------------------------------------------------

  private applyPlan(orgId: string, planId: string, plan: BillingPlanRecord | null): void {
    const clonedPlan = plan !== null ? { ...plan } : null;
    if (clonedPlan !== null) this.putPlan(clonedPlan);
    const snapshot = this.snapshots.get(orgId);
    if (snapshot && snapshot.subscription.planId === planId) {
      this.snapshots.set(orgId, { ...snapshot, plan: clonedPlan });
    }
  }

  private putPlan(plan: BillingPlanRecord): void {
    const cloned: BillingPlanRecord = { ...plan };
    if (this.plans.has(cloned.id)) this.plans.delete(cloned.id);
    this.plans.set(cloned.id, cloned);
    while (this.plans.size > MAX_PLANS) {
      const oldest = this.plans.keys().next();
      if (oldest.done) break;
      this.plans.delete(oldest.value);
    }
  }

  private pruneExpired(now: number): void {
    for (const [orgId, snapshot] of this.snapshots) {
      if (now - snapshot.fetchedAt > SNAPSHOT_TTL_MS) this.snapshots.delete(orgId);
    }
  }

  private enforceSnapshotCap(): void {
    while (this.snapshots.size > MAX_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next();
      if (oldest.done) break;
      this.snapshots.delete(oldest.value);
    }
  }
}
