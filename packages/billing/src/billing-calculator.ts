/**
 * `packages/billing/src/billing-calculator.ts`
 *
 * Integer-cent-only monthly bill calculation and invoice generation
 * (contract §4). Every rate multiplication uses BigInt ceiling division with
 * safe integer saturation so no floating-point, NaN, Infinity, or negative
 * value ever enters a monetary field.
 */

import { createHash } from "node:crypto";
import type {
  BillingPlanRecord,
  BillingRepository,
  InvoiceRecord,
  UsageMonthlyRecord,
} from "@vellum/database-control";
import { computeChainHash, deriveChainKey } from "@vellum/security";
import type { InvoiceGeneratorPort } from "./contracts/billing-port.js";
import type { UsageTotals } from "./metering-engine.js";

const GENESIS_HASH = "0".repeat(64);
const DEFAULT_LEDGER_MASTER_KEY = "vellum-billing-ledger-master-key-v1";
const BYTES_PER_GB = 1_073_741_824;
const BILLING_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export interface BillLineItem {
  metric: string;
  overageUnits: number;
  rateCents: number;
  costCents: number;
}

export interface BillResult {
  baseAmountCents: number;
  overageAmountCents: number;
  totalAmountCents: number;
  lineItems: BillLineItem[];
}

/** Dependencies required to persist and chain an invoice. */
export interface InvoiceGeneratorOptions {
  billing: BillingRepository;
  chainKey?: Buffer | undefined;
  masterKey?: string | undefined;
}

interface RateSpec {
  metric: string;
  overageUnits: number;
  rateCents: number;
  divisor: number;
}

function nonNegative(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function safeAdd(a: number, b: number): number {
  const lhs = nonNegative(a);
  const rhs = nonNegative(b);
  if (lhs >= Number.MAX_SAFE_INTEGER - rhs) return Number.MAX_SAFE_INTEGER;
  return lhs + rhs;
}

/** Exact ceiling division of (units * rate) / divisor using saturated BigInt arithmetic. */
function ceilRate(units: number, rateCents: number, divisor: number): number {
  const u = nonNegative(units);
  const r = nonNegative(rateCents);
  const div = nonNegative(divisor);
  if (u === 0 || r === 0 || div === 0) return 0;
  const d = BigInt(div);
  const result = (BigInt(u) * BigInt(r) + d - 1n) / d;
  return result >= MAX_SAFE_BIGINT ? Number.MAX_SAFE_INTEGER : Number(result);
}

/**
 * Calculates the monthly bill with exact integer-cent math.
 * Line items are emitted in a deterministic order for all six billable metrics.
 */
export function calculateMonthlyBill(
  plan: BillingPlanRecord,
  usage: UsageTotals
): BillResult {
  const specs: readonly RateSpec[] = [
    {
      metric: "docReads",
      overageUnits: Math.max(0, nonNegative(usage.docReads) - nonNegative(plan.includedDocReads)),
      rateCents: nonNegative(plan.overageReadPer100kCents),
      divisor: 100_000,
    },
    {
      metric: "docWrites",
      overageUnits: Math.max(0, nonNegative(usage.docWrites) - nonNegative(plan.includedDocWrites)),
      rateCents: nonNegative(plan.overageWritePer100kCents),
      divisor: 100_000,
    },
    {
      metric: "docDeletes",
      overageUnits: Math.max(
        0,
        nonNegative(usage.docDeletes) - nonNegative(plan.includedDocDeletes)
      ),
      rateCents: nonNegative(plan.overageDeletePer100kCents),
      divisor: 100_000,
    },
    {
      metric: "storageBytes",
      overageUnits: Math.max(
        0,
        nonNegative(usage.storageBytes) - nonNegative(plan.includedStorageBytes)
      ),
      rateCents: nonNegative(plan.overageStoragePerGbCents),
      divisor: BYTES_PER_GB,
    },
    {
      metric: "egressBytes",
      overageUnits: Math.max(
        0,
        nonNegative(usage.egressBytes) - nonNegative(plan.includedEgressBytes)
      ),
      rateCents: nonNegative(plan.overageEgressPerGbCents),
      divisor: BYTES_PER_GB,
    },
    {
      metric: "authMau",
      overageUnits: Math.max(0, nonNegative(usage.authMau) - nonNegative(plan.includedAuthMau)),
      rateCents: nonNegative(plan.overageMauPer1kCents),
      divisor: 1_000,
    },
  ];

  const lineItems: BillLineItem[] = specs.map((spec) => ({
    metric: spec.metric,
    overageUnits: spec.overageUnits,
    rateCents: spec.rateCents,
    costCents: ceilRate(spec.overageUnits, spec.rateCents, spec.divisor),
  }));

  const overageAmountCents = lineItems.reduce((sum, item) => safeAdd(sum, item.costCents), 0);
  const baseAmountCents = nonNegative(plan.monthlyBasePriceCents);
  return {
    baseAmountCents,
    overageAmountCents,
    totalAmountCents: safeAdd(baseAmountCents, overageAmountCents),
    lineItems,
  };
}

/** Convenience alias used by the quota guard's spend-cap check. */
export function calculateBillCents(plan: BillingPlanRecord, usage: UsageTotals): number {
  return calculateMonthlyBill(plan, usage).totalAmountCents;
}

/** Deterministic `INV-YYYYMM-NNNNNN` number; suffix derived from the org id. */
export function invoiceNumberFor(orgId: string, billingMonth: string): string {
  if (typeof orgId !== "string" || orgId.trim().length === 0) {
    throw new Error("Invalid orgId (expected non-empty string)");
  }
  if (typeof billingMonth !== "string" || !BILLING_MONTH_PATTERN.test(billingMonth)) {
    throw new Error(`Invalid billing month '${billingMonth}' (expected YYYY-MM)`);
  }
  const yyyymm = billingMonth.slice(0, 7).replace("-", "");
  const digest = createHash("sha256").update(orgId).digest("hex").slice(0, 16);
  const suffix = (BigInt(`0x${digest}`) % 1_000_000n).toString().padStart(6, "0");
  return `INV-${yyyymm}-${suffix}`;
}

function aggregateUsage(rows: readonly UsageMonthlyRecord[]): UsageTotals {
  const totals: UsageTotals = {
    docReads: 0,
    docWrites: 0,
    docDeletes: 0,
    storageBytes: 0,
    egressBytes: 0,
    authMau: 0,
    peakConcurrentWs: 0,
  };
  for (const row of rows) {
    totals.docReads = safeAdd(totals.docReads, row.docReads);
    totals.docWrites = safeAdd(totals.docWrites, row.docWrites);
    totals.docDeletes = safeAdd(totals.docDeletes, row.docDeletes);
    totals.storageBytes = safeAdd(totals.storageBytes, row.storageBytes);
    totals.egressBytes = safeAdd(totals.egressBytes, row.egressBytes);
    totals.authMau = safeAdd(totals.authMau, row.authMau);
    totals.peakConcurrentWs = Math.max(totals.peakConcurrentWs, nonNegative(row.peakConcurrentWs));
  }
  return totals;
}

function resolveChainKey(options: InvoiceGeneratorOptions): Buffer {
  if (options.chainKey !== undefined) return Buffer.from(options.chainKey);
  const masterKey =
    options.masterKey ??
    process.env["VELLUM_BILLING_LEDGER_MASTER_KEY"] ??
    process.env["VELLUM_BILLING_LEDGER_MASTER_KEY"] ??
    DEFAULT_LEDGER_MASTER_KEY;
  return deriveChainKey(masterKey, "billing-ledger-v1");
}

async function nextSequence(billing: BillingRepository): Promise<number> {
  const rows = await billing.listLedger();
  let maxSeq = 0;
  for (const row of rows) {
    if (Number.isFinite(row.seq) && row.seq > maxSeq) maxSeq = row.seq;
  }
  return maxSeq + 1;
}

/**
 * Dependency-injected invoice generator implementing `InvoiceGeneratorPort`.
 * Encapsulates billing repository and HKDF chain key state with zero module-level globals.
 */
export class BillingCalculator implements InvoiceGeneratorPort {
  private readonly billing: BillingRepository;
  private readonly chainKey: Buffer;

  constructor(options: InvoiceGeneratorOptions) {
    this.billing = options.billing;
    this.chainKey = resolveChainKey(options);
  }

  public calculateMonthlyBill(plan: BillingPlanRecord, usage: UsageTotals): BillResult {
    return calculateMonthlyBill(plan, usage);
  }

  public calculateBillCents(plan: BillingPlanRecord, usage: UsageTotals): number {
    return calculateBillCents(plan, usage);
  }

  public invoiceNumberFor(orgId: string, billingMonth: string): string {
    return invoiceNumberFor(orgId, billingMonth);
  }

  /**
   * Reads the subscription, plan and monthly rollups, computes the bill, upserts
   * the invoice and appends idempotent, hash-chained plan/overage ledger entries.
   */
  public async generateMonthlyInvoice(
    orgId: string,
    billingMonth: string
  ): Promise<InvoiceRecord> {
    const invoiceNumber = invoiceNumberFor(orgId, billingMonth);
    const billing = this.billing;

    const subscription = await billing.getSubscription(orgId);
    if (!subscription) throw new Error(`No subscription found for org '${orgId}'`);
    const plan = await billing.getPlan(subscription.planId);
    if (!plan) throw new Error(`Unknown billing plan '${subscription.planId}'`);

    const rows = await billing.listMonthly(orgId, billingMonth);
    const bill = calculateMonthlyBill(plan, aggregateUsage(rows));

    const invoice = await billing.upsertInvoice({
      invoiceNumber,
      orgId,
      billingMonth,
      planId: plan.id,
      baseAmountCents: bill.baseAmountCents,
      overageAmountCents: bill.overageAmountCents,
      creditsAppliedCents: 0,
      totalAmountCents: bill.totalAmountCents,
      lineItems: bill.lineItems.map((item) => ({ ...item })),
      status: "draft",
    });

    let prevHash = (await billing.getLastLedgerHash()) ?? GENESIS_HASH;
    let seq = await nextSequence(billing);

    const charges: readonly { type: "plan_charge" | "overage_charge"; amountCents: number }[] = [
      { type: "plan_charge", amountCents: bill.baseAmountCents },
      { type: "overage_charge", amountCents: bill.overageAmountCents },
    ];

    for (const charge of charges) {
      const timestampIso = new Date().toISOString();
      const payload: Record<string, unknown> = {
        kind: charge.type,
        orgId,
        billingMonth,
        planId: plan.id,
        invoiceNumber: invoice.invoiceNumber,
        amountCents: charge.amountCents,
      };
      const entryHash = computeChainHash(this.chainKey, seq, prevHash, timestampIso, payload);
      const entry = await billing.appendLedgerEntry({
        orgId,
        billingMonth,
        entryType: charge.type,
        amountCents: charge.amountCents,
        metricSnapshot: { ...payload, timestampIso },
        idempotencyKey: `invoice:${billingMonth}:${orgId}:${invoice.invoiceNumber}:${charge.type}`,
        description: `${charge.type} ${billingMonth} for ${orgId}`,
        prevHash,
        entryHash,
      });
      prevHash = entry.entryHash;
      seq = entry.seq + 1;
    }

    return invoice;
  }
}

/** Explicit DI factory for creating a `BillingCalculator` instance. */
export function createBillingCalculator(options: InvoiceGeneratorOptions): BillingCalculator {
  return new BillingCalculator(options);
}

/**
 * Backward-compatible factory alias. Returns a `BillingCalculator` instance without
 * mutating module-level state.
 */
export function configureBillingCalculator(options: InvoiceGeneratorOptions): BillingCalculator {
  return createBillingCalculator(options);
}

/**
 * Backward-compatible function export that delegates to `createBillingCalculator(options)`.
 */
export async function generateMonthlyInvoice(
  orgId: string,
  billingMonth: string,
  options?: InvoiceGeneratorOptions
): Promise<InvoiceRecord> {
  if (!options) {
    throw new Error("generateMonthlyInvoice requires explicit InvoiceGeneratorOptions or createBillingCalculator(options)");
  }
  return createBillingCalculator(options).generateMonthlyInvoice(orgId, billingMonth);
}
