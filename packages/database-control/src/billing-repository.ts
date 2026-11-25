/**
 * `packages/database-control/src/billing-repository.ts`
 *
 * Control Plane billing/metering persistence repository. Two implementations:
 *  - `createInMemoryBillingRepository()` — deterministic, synchronous, seeded with
 *    the three locked plans from `docs/SECURITY-BILLING-CONTRACT.md` §2.5.
 *  - `createPgBillingRepository(pool)` — PostgreSQL-backed, with the same locked
 *    schema (migration `0008_metering_and_billing.sql`). All statements are
 *    parameterised with `$n`; no user value is ever interpolated into SQL.
 *
 * Methods return `MaybePromise<T>` so that both the synchronous in-memory
 * implementation and the async PostgreSQL implementation satisfy the same
 * contract. Numeric columns that PostgreSQL may return as strings (BIGINT /
 * BIGSERIAL) are normalised with `Number()`; identifiers with `String()`.
 */

import crypto from "node:crypto";
import type pg from "pg";

/** Both the synchronous memory store and the async PG store satisfy this shape. */
type MaybePromise<T> = T | Promise<T>;

// ---------------------------------------------------------------------------
// Public record / input types
// ---------------------------------------------------------------------------

export interface BillingPlanRecord {
  id: string;
  name: string;
  monthlyBasePriceCents: number;
  includedDocReads: number;
  includedDocWrites: number;
  includedDocDeletes: number;
  includedStorageBytes: number;
  includedEgressBytes: number;
  includedAuthMau: number;
  maxConcurrentWs: number;
  overageReadPer100kCents: number;
  overageWritePer100kCents: number;
  overageDeletePer100kCents: number;
  overageStoragePerGbCents: number;
  overageEgressPerGbCents: number;
  overageMauPer1kCents: number;
  hardLimitEnforced: boolean;
  createdAt: string;
}

export interface OrgSubscriptionRecord {
  orgId: string;
  planId: string;
  status: "active" | "past_due" | "suspended" | "canceled";
  monthlySpendCapCents: number | null;
  billingEmail: string | null;
  externalCustomerId: string | null;
  externalSubscriptionId: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  quotaOverride: Record<string, unknown>;
  alert80SentAt: string | null;
  alert95SentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionPatch {
  planId?: string;
  status?: "active" | "past_due" | "suspended" | "canceled";
  monthlySpendCapCents?: number | null;
  billingEmail?: string | null;
  externalCustomerId?: string | null;
  externalSubscriptionId?: string | null;
  quotaOverride?: Record<string, unknown>;
  alert80SentAt?: string | null;
  alert95SentAt?: string | null;
}

export interface UsageMonthlyInput {
  orgId: string;
  projectId: string;
  billingMonth: string;
  docReads: number;
  docWrites: number;
  docDeletes: number;
  storageBytes: number;
  egressBytes: number;
  authMau: number;
  peakConcurrentWs: number;
}

export interface UsageMonthlyRecord extends UsageMonthlyInput {
  id: string;
  updatedAt: string;
}

export interface BillingDailyInput {
  orgId: string;
  projectId: string;
  usageDate: string;
  docReads: number;
  docWrites: number;
  docDeletes: number;
  egressBytes: number;
}

export interface BillingDailyRecord extends BillingDailyInput {
  id: string;
  updatedAt: string;
}

export type LedgerEntryType =
  | "usage_flush"
  | "plan_charge"
  | "overage_charge"
  | "credit_grant"
  | "payment_received"
  | "refund"
  | "admin_adjustment";

export interface LedgerEntryInput {
  orgId: string;
  billingMonth: string;
  entryType: LedgerEntryType;
  amountCents: number;
  metricSnapshot: Record<string, unknown>;
  idempotencyKey: string;
  description: string;
  prevHash: string;
  entryHash: string;
}

export interface LedgerEntryRecord extends LedgerEntryInput {
  seq: number;
  id: string;
  createdAt: string;
}

export interface InvoiceInput {
  invoiceNumber: string;
  orgId: string;
  billingMonth: string;
  planId: string;
  baseAmountCents: number;
  overageAmountCents: number;
  creditsAppliedCents: number;
  totalAmountCents: number;
  lineItems: unknown[];
  status?: "draft" | "open" | "paid" | "void" | "uncollectible";
  issuedAt?: string | null;
  paidAt?: string | null;
}

export interface InvoiceRecord extends InvoiceInput {
  id: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  issuedAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

/** Unflushed usage from one API process. Applied additively so instances never overwrite each other. */
export interface UsageDeltaInput {
  orgId: string;
  projectId: string;
  billingMonth: string;
  usageDate: string;
  docReads: number;
  docWrites: number;
  docDeletes: number;
  storageBytes: number;
  egressBytes: number;
  peakConcurrentWs: number;
  authUserIds: readonly string[];
}

export interface UsageDeltaResult {
  monthly: UsageMonthlyRecord;
  daily: BillingDailyRecord;
}

/** Everything the quota guard needs for one org, read in a single round trip. */
export interface QuotaState {
  subscription: OrgSubscriptionRecord;
  plan: BillingPlanRecord | null;
  usage: {
    docReads: number;
    docWrites: number;
    docDeletes: number;
    storageBytes: number;
    egressBytes: number;
    authMau: number;
    peakConcurrentWs: number;
  };
}

/** Arbitrary constant key for the billing ledger advisory lock. */
const LEDGER_LOCK_KEY = "7269003110";

export interface BillingRepository {
  /** Runs `fn` while holding the cross-instance ledger lock. Optional: single-process stores skip it. */
  withLedgerLock?<T>(fn: () => Promise<T>): Promise<T>;
  applyUsageDelta(input: UsageDeltaInput): MaybePromise<UsageDeltaResult>;
  getQuotaState(orgId: string, billingMonth: string): MaybePromise<QuotaState | null>;
  getPlan(id: string): MaybePromise<BillingPlanRecord | null>;
  listPlans(): MaybePromise<BillingPlanRecord[]>;
  getSubscription(orgId: string): MaybePromise<OrgSubscriptionRecord | null>;
  ensureSubscription(orgId: string): MaybePromise<OrgSubscriptionRecord>;
  updateSubscription(orgId: string, patch: SubscriptionPatch): MaybePromise<OrgSubscriptionRecord | null>;
  upsertMonthly(input: UsageMonthlyInput): MaybePromise<UsageMonthlyRecord>;
  listMonthly(orgId: string, billingMonth?: string): MaybePromise<UsageMonthlyRecord[]>;
  upsertDaily(input: BillingDailyInput): MaybePromise<BillingDailyRecord>;
  listDaily(orgId: string, from?: string, to?: string): MaybePromise<BillingDailyRecord[]>;
  getLastLedgerHash(): MaybePromise<string | null>;
  appendLedgerEntry(input: LedgerEntryInput): MaybePromise<LedgerEntryRecord>;
  listLedger(orgId?: string, billingMonth?: string): MaybePromise<LedgerEntryRecord[]>;
  upsertInvoice(input: InvoiceInput): MaybePromise<InvoiceRecord>;
  getInvoice(orgId: string, billingMonth: string): MaybePromise<InvoiceRecord | null>;
  listInvoices(orgId?: string): MaybePromise<InvoiceRecord[]>;
  recordWebhookEvent(eventId: string, provider: string, eventType: string): MaybePromise<boolean>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_WEBHOOK_EVENTS = 50_000;
const VALID_SUBSCRIPTION_STATUSES = new Set<string>(["active", "past_due", "suspended", "canceled"]);

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return iso(value);
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 16 || value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  const clean: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    clean[key] = sanitizeValue(entry, depth + 1);
  }
  return clean;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return sanitizeValue(value) as Record<string, unknown>;
  }
  return {};
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (sanitizeValue(value) as unknown[]) : [];
}

function finiteNumber(value: number, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`Invalid ${fieldName}: must be a finite number`);
  }
  return value;
}

function clonePlan(plan: BillingPlanRecord): BillingPlanRecord {
  return { ...plan };
}

function cloneSubscription(record: OrgSubscriptionRecord): OrgSubscriptionRecord {
  return { ...record, quotaOverride: asObject(record.quotaOverride) };
}

function cloneMonthly(record: UsageMonthlyRecord): UsageMonthlyRecord {
  return { ...record };
}

function cloneDaily(record: BillingDailyRecord): BillingDailyRecord {
  return { ...record };
}

function cloneLedger(record: LedgerEntryRecord): LedgerEntryRecord {
  return { ...record, metricSnapshot: asObject(record.metricSnapshot) };
}

function cloneInvoice(record: InvoiceRecord): InvoiceRecord {
  return { ...record, lineItems: asUnknownArray(record.lineItems) };
}

function normalizeSubscriptionStatus(value: unknown): OrgSubscriptionRecord["status"] {
  switch (value) {
    case "active":
    case "past_due":
    case "suspended":
    case "canceled":
      return value;
    default:
      return "active";
  }
}

function normalizeInvoiceStatus(value: unknown): InvoiceRecord["status"] {
  switch (value) {
    case "draft":
    case "open":
    case "paid":
    case "void":
    case "uncollectible":
      return value;
    default:
      return "draft";
  }
}

function normalizeLedgerEntryType(value: unknown): LedgerEntryType {
  switch (value) {
    case "usage_flush":
    case "plan_charge":
    case "overage_charge":
    case "credit_grant":
    case "payment_received":
    case "refund":
    case "admin_adjustment":
      return value;
    default:
      return "usage_flush";
  }
}

/** Mirrors `date_trunc('month', now())` .. `+ interval '1 month'` in UTC. */
function currentBillingPeriod(now: Date = new Date()): { start: string; end: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1)).toISOString(),
    end: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
  };
}

/** Locked seed rows from the contract §2.5 / migration 0008. Deterministic createdAt. */
const SEEDED_PLANS: readonly BillingPlanRecord[] = [
  {
    id: "free",
    name: "Starter (Free)",
    monthlyBasePriceCents: 0,
    includedDocReads: 1_500_000,
    includedDocWrites: 600_000,
    includedDocDeletes: 600_000,
    includedStorageBytes: 1_073_741_824,
    includedEgressBytes: 10_737_418_240,
    includedAuthMau: 10_000,
    maxConcurrentWs: 50,
    overageReadPer100kCents: 0,
    overageWritePer100kCents: 0,
    overageDeletePer100kCents: 0,
    overageStoragePerGbCents: 0,
    overageEgressPerGbCents: 0,
    overageMauPer1kCents: 0,
    hardLimitEnforced: true,
    createdAt: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "pro",
    name: "Pro (Pay-as-you-go)",
    monthlyBasePriceCents: 2_500,
    includedDocReads: 5_000_000,
    includedDocWrites: 2_000_000,
    includedDocDeletes: 1_000_000,
    includedStorageBytes: 21_474_836_480,
    includedEgressBytes: 107_374_182_400,
    includedAuthMau: 100_000,
    maxConcurrentWs: 1_000,
    overageReadPer100kCents: 6,
    overageWritePer100kCents: 18,
    overageDeletePer100kCents: 2,
    overageStoragePerGbCents: 18,
    overageEgressPerGbCents: 12,
    overageMauPer1kCents: 500,
    hardLimitEnforced: false,
    createdAt: "1970-01-01T00:00:00.000Z",
  },
  {
    id: "enterprise",
    name: "Enterprise",
    monthlyBasePriceCents: 29_900,
    includedDocReads: 50_000_000,
    includedDocWrites: 20_000_000,
    includedDocDeletes: 10_000_000,
    includedStorageBytes: 214_748_364_800,
    includedEgressBytes: 1_099_511_627_776,
    includedAuthMau: 1_000_000,
    maxConcurrentWs: 10_000,
    overageReadPer100kCents: 4,
    overageWritePer100kCents: 12,
    overageDeletePer100kCents: 1,
    overageStoragePerGbCents: 14,
    overageEgressPerGbCents: 9,
    overageMauPer1kCents: 300,
    hardLimitEnforced: false,
    createdAt: "1970-01-01T00:00:00.000Z",
  },
];

function seededPlans(): BillingPlanRecord[] {
  return SEEDED_PLANS.map(clonePlan);
}

// ---------------------------------------------------------------------------
// PostgreSQL row mappers / column lists
// ---------------------------------------------------------------------------

const PLAN_COLUMNS = `id, name,
  monthly_base_price_cents AS "monthlyBasePriceCents",
  included_doc_reads AS "includedDocReads",
  included_doc_writes AS "includedDocWrites",
  included_doc_deletes AS "includedDocDeletes",
  included_storage_bytes AS "includedStorageBytes",
  included_egress_bytes AS "includedEgressBytes",
  included_auth_mau AS "includedAuthMau",
  max_concurrent_ws AS "maxConcurrentWs",
  overage_read_per_100k_cents AS "overageReadPer100kCents",
  overage_write_per_100k_cents AS "overageWritePer100kCents",
  overage_delete_per_100k_cents AS "overageDeletePer100kCents",
  overage_storage_per_gb_cents AS "overageStoragePerGbCents",
  overage_egress_per_gb_cents AS "overageEgressPerGbCents",
  overage_mau_per_1k_cents AS "overageMauPer1kCents",
  hard_limit_enforced AS "hardLimitEnforced",
  created_at AS "createdAt"`;

const SUBSCRIPTION_COLUMNS = `org_id AS "orgId", plan_id AS "planId", status,
  monthly_spend_cap_cents AS "monthlySpendCapCents",
  billing_email AS "billingEmail",
  external_customer_id AS "externalCustomerId",
  external_subscription_id AS "externalSubscriptionId",
  current_period_start AS "currentPeriodStart",
  current_period_end AS "currentPeriodEnd",
  quota_override AS "quotaOverride",
  alert_80_sent_at AS "alert80SentAt",
  alert_95_sent_at AS "alert95SentAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const MONTHLY_COLUMNS = `id, org_id AS "orgId", project_id AS "projectId",
  billing_month AS "billingMonth",
  doc_reads AS "docReads", doc_writes AS "docWrites", doc_deletes AS "docDeletes",
  storage_bytes AS "storageBytes", egress_bytes AS "egressBytes",
  auth_mau AS "authMau", peak_concurrent_ws AS "peakConcurrentWs",
  updated_at AS "updatedAt"`;

const DAILY_COLUMNS = `id, org_id AS "orgId", project_id AS "projectId",
  usage_date AS "usageDate",
  doc_reads AS "docReads", doc_writes AS "docWrites", doc_deletes AS "docDeletes",
  egress_bytes AS "egressBytes", updated_at AS "updatedAt"`;

const LEDGER_COLUMNS = `seq, id, org_id AS "orgId", billing_month AS "billingMonth",
  entry_type AS "entryType", amount_cents AS "amountCents",
  metric_snapshot AS "metricSnapshot", idempotency_key AS "idempotencyKey",
  description, prev_hash AS "prevHash", entry_hash AS "entryHash",
  created_at AS "createdAt"`;

const INVOICE_COLUMNS = `id, invoice_number AS "invoiceNumber", org_id AS "orgId",
  billing_month AS "billingMonth", plan_id AS "planId",
  base_amount_cents AS "baseAmountCents", overage_amount_cents AS "overageAmountCents",
  credits_applied_cents AS "creditsAppliedCents", total_amount_cents AS "totalAmountCents",
  line_items AS "lineItems", status, issued_at AS "issuedAt", paid_at AS "paidAt",
  created_at AS "createdAt"`;

function mapPlanRow(row: Record<string, unknown>): BillingPlanRecord {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    monthlyBasePriceCents: Number(row["monthlyBasePriceCents"]),
    includedDocReads: Number(row["includedDocReads"]),
    includedDocWrites: Number(row["includedDocWrites"]),
    includedDocDeletes: Number(row["includedDocDeletes"]),
    includedStorageBytes: Number(row["includedStorageBytes"]),
    includedEgressBytes: Number(row["includedEgressBytes"]),
    includedAuthMau: Number(row["includedAuthMau"]),
    maxConcurrentWs: Number(row["maxConcurrentWs"]),
    overageReadPer100kCents: Number(row["overageReadPer100kCents"]),
    overageWritePer100kCents: Number(row["overageWritePer100kCents"]),
    overageDeletePer100kCents: Number(row["overageDeletePer100kCents"]),
    overageStoragePerGbCents: Number(row["overageStoragePerGbCents"]),
    overageEgressPerGbCents: Number(row["overageEgressPerGbCents"]),
    overageMauPer1kCents: Number(row["overageMauPer1kCents"]),
    hardLimitEnforced: Boolean(row["hardLimitEnforced"]),
    createdAt: iso(row["createdAt"]),
  };
}

function mapSubscriptionRow(row: Record<string, unknown>): OrgSubscriptionRecord {
  return {
    orgId: String(row["orgId"]),
    planId: String(row["planId"]),
    status: normalizeSubscriptionStatus(row["status"]),
    monthlySpendCapCents:
      row["monthlySpendCapCents"] === null || row["monthlySpendCapCents"] === undefined
        ? null
        : Number(row["monthlySpendCapCents"]),
    billingEmail: typeof row["billingEmail"] === "string" ? row["billingEmail"] : null,
    externalCustomerId:
      typeof row["externalCustomerId"] === "string" ? row["externalCustomerId"] : null,
    externalSubscriptionId:
      typeof row["externalSubscriptionId"] === "string" ? row["externalSubscriptionId"] : null,
    currentPeriodStart: iso(row["currentPeriodStart"]),
    currentPeriodEnd: iso(row["currentPeriodEnd"]),
    quotaOverride: asObject(row["quotaOverride"]),
    alert80SentAt: isoOrNull(row["alert80SentAt"]),
    alert95SentAt: isoOrNull(row["alert95SentAt"]),
    createdAt: iso(row["createdAt"]),
    updatedAt: iso(row["updatedAt"]),
  };
}

function mapMonthlyRow(row: Record<string, unknown>): UsageMonthlyRecord {
  return {
    id: String(row["id"]),
    orgId: String(row["orgId"]),
    projectId: String(row["projectId"]),
    billingMonth: String(row["billingMonth"]),
    docReads: Number(row["docReads"]),
    docWrites: Number(row["docWrites"]),
    docDeletes: Number(row["docDeletes"]),
    storageBytes: Number(row["storageBytes"]),
    egressBytes: Number(row["egressBytes"]),
    authMau: Number(row["authMau"]),
    peakConcurrentWs: Number(row["peakConcurrentWs"]),
    updatedAt: iso(row["updatedAt"]),
  };
}

function mapDailyRow(row: Record<string, unknown>): BillingDailyRecord {
  return {
    id: String(row["id"]),
    orgId: String(row["orgId"]),
    projectId: String(row["projectId"]),
    usageDate: String(row["usageDate"]),
    docReads: Number(row["docReads"]),
    docWrites: Number(row["docWrites"]),
    docDeletes: Number(row["docDeletes"]),
    egressBytes: Number(row["egressBytes"]),
    updatedAt: iso(row["updatedAt"]),
  };
}

function mapLedgerRow(row: Record<string, unknown>): LedgerEntryRecord {
  return {
    seq: Number(row["seq"]),
    id: String(row["id"]),
    orgId: String(row["orgId"]),
    billingMonth: String(row["billingMonth"]),
    entryType: normalizeLedgerEntryType(row["entryType"]),
    amountCents: Number(row["amountCents"]),
    metricSnapshot: asObject(row["metricSnapshot"]),
    idempotencyKey: String(row["idempotencyKey"]),
    description: String(row["description"]),
    prevHash: String(row["prevHash"]),
    entryHash: String(row["entryHash"]),
    createdAt: iso(row["createdAt"]),
  };
}

function mapInvoiceRow(row: Record<string, unknown>): InvoiceRecord {
  return {
    id: String(row["id"]),
    invoiceNumber: String(row["invoiceNumber"]),
    orgId: String(row["orgId"]),
    billingMonth: String(row["billingMonth"]),
    planId: String(row["planId"]),
    baseAmountCents: Number(row["baseAmountCents"]),
    overageAmountCents: Number(row["overageAmountCents"]),
    creditsAppliedCents: Number(row["creditsAppliedCents"]),
    totalAmountCents: Number(row["totalAmountCents"]),
    lineItems: asUnknownArray(row["lineItems"]),
    status: normalizeInvoiceStatus(row["status"]),
    issuedAt: isoOrNull(row["issuedAt"]),
    paidAt: isoOrNull(row["paidAt"]),
    createdAt: iso(row["createdAt"]),
  };
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

class InMemoryBillingRepository implements BillingRepository {
  private readonly plans = new Map<string, BillingPlanRecord>();
  private readonly subscriptions = new Map<string, OrgSubscriptionRecord>();
  private readonly monthly = new Map<string, UsageMonthlyRecord>();
  private readonly monthlyByOrg = new Map<string, Set<string>>();
  private readonly daily = new Map<string, BillingDailyRecord>();
  private readonly activeUsers = new Map<string, Set<string>>();
  private readonly dailyByOrg = new Map<string, Set<string>>();
  private readonly ledger: LedgerEntryRecord[] = [];
  private readonly ledgerByOrg = new Map<string, LedgerEntryRecord[]>();
  private readonly ledgerByKey = new Map<string, LedgerEntryRecord>();
  private readonly invoicesById = new Map<string, InvoiceRecord>();
  private readonly invoicesByOrgMonth = new Map<string, InvoiceRecord>();
  private readonly invoicesByNumber = new Map<string, InvoiceRecord>();
  private readonly invoicesByOrg = new Map<string, Set<string>>();
  private readonly webhookEvents = new Set<string>();

  constructor(
    private readonly resolveOrgBillingEmail: (orgId: string) => string | null = () => null
  ) {
    for (const plan of seededPlans()) this.plans.set(plan.id, plan);
  }

  private static monthlyKey(orgId: string, projectId: string, month: string): string {
    return `${orgId}|${projectId}|${month}`;
  }

  private static dailyKey(orgId: string, projectId: string, date: string): string {
    return `${orgId}|${projectId}|${date}`;
  }

  private static orgMonthKey(orgId: string, month: string): string {
    return `${orgId}|${month}`;
  }

  private static addToSetMap(map: Map<string, Set<string>>, groupKey: string, memberKey: string): void {
    let set = map.get(groupKey);
    if (!set) {
      set = new Set<string>();
      map.set(groupKey, set);
    }
    set.add(memberKey);
  }

  private static removeFromSetMap(map: Map<string, Set<string>>, groupKey: string, memberKey: string): void {
    const set = map.get(groupKey);
    if (!set) return;
    set.delete(memberKey);
    if (set.size === 0) map.delete(groupKey);
  }

  public applyUsageDelta(input: UsageDeltaInput): UsageDeltaResult {
    const key = InMemoryBillingRepository.monthlyKey(input.orgId, input.projectId, input.billingMonth);
    const existing = this.monthly.get(key);
    const users = this.activeUsers.get(key) ?? new Set<string>();
    for (const id of input.authUserIds) users.add(id);
    this.activeUsers.set(key, users);
    const monthly = this.upsertMonthly({
      orgId: input.orgId,
      projectId: input.projectId,
      billingMonth: input.billingMonth,
      docReads: (existing?.docReads ?? 0) + input.docReads,
      docWrites: (existing?.docWrites ?? 0) + input.docWrites,
      docDeletes: (existing?.docDeletes ?? 0) + input.docDeletes,
      storageBytes: Math.max(0, (existing?.storageBytes ?? 0) + input.storageBytes),
      egressBytes: (existing?.egressBytes ?? 0) + input.egressBytes,
      authMau: users.size,
      peakConcurrentWs: Math.max(existing?.peakConcurrentWs ?? 0, input.peakConcurrentWs),
    });
    const dKey = `${input.orgId}|${input.projectId}|${input.usageDate}`;
    const prior = this.daily.get(dKey);
    const daily = this.upsertDaily({
      orgId: input.orgId,
      projectId: input.projectId,
      usageDate: input.usageDate,
      docReads: (prior?.docReads ?? 0) + input.docReads,
      docWrites: (prior?.docWrites ?? 0) + input.docWrites,
      docDeletes: (prior?.docDeletes ?? 0) + input.docDeletes,
      egressBytes: (prior?.egressBytes ?? 0) + input.egressBytes,
    });
    return { monthly, daily };
  }

  public getQuotaState(orgId: string, billingMonth: string): QuotaState | null {
    const subscription = this.subscriptions.get(orgId);
    if (!subscription) return null;
    const plan = this.plans.get(subscription.planId);
    const usage = { docReads: 0, docWrites: 0, docDeletes: 0, storageBytes: 0, egressBytes: 0, authMau: 0, peakConcurrentWs: 0 };
    for (const row of this.listMonthly(orgId, billingMonth)) {
      usage.docReads += row.docReads;
      usage.docWrites += row.docWrites;
      usage.docDeletes += row.docDeletes;
      usage.storageBytes += row.storageBytes;
      usage.egressBytes += row.egressBytes;
      usage.authMau += row.authMau;
      usage.peakConcurrentWs = Math.max(usage.peakConcurrentWs, row.peakConcurrentWs);
    }
    return {
      subscription: cloneSubscription(subscription),
      plan: plan ? clonePlan(plan) : null,
      usage,
    };
  }

  public getPlan(id: string): BillingPlanRecord | null {
    const plan = this.plans.get(id);
    return plan ? clonePlan(plan) : null;
  }

  public listPlans(): BillingPlanRecord[] {
    return seededPlans();
  }

  public getSubscription(orgId: string): OrgSubscriptionRecord | null {
    const subscription = this.subscriptions.get(orgId);
    return subscription ? cloneSubscription(subscription) : null;
  }

  public ensureSubscription(orgId: string): OrgSubscriptionRecord {
    const existing = this.subscriptions.get(orgId);
    if (existing) return cloneSubscription(existing);
    const nowIso = new Date().toISOString();
    const period = currentBillingPeriod();
    const record: OrgSubscriptionRecord = {
      orgId,
      planId: "free",
      status: "active",
      monthlySpendCapCents: null,
      billingEmail: this.resolveOrgBillingEmail(orgId),
      externalCustomerId: null,
      externalSubscriptionId: null,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
      quotaOverride: {},
      alert80SentAt: null,
      alert95SentAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.subscriptions.set(orgId, record);
    return cloneSubscription(record);
  }

  public updateSubscription(orgId: string, patch: SubscriptionPatch): OrgSubscriptionRecord | null {
    const existing = this.subscriptions.get(orgId);
    if (!existing) return null;
    if (patch.status !== undefined && !VALID_SUBSCRIPTION_STATUSES.has(patch.status)) {
      throw new RangeError(`Invalid subscription status: ${String(patch.status)}`);
    }
    if (
      patch.monthlySpendCapCents !== undefined &&
      patch.monthlySpendCapCents !== null &&
      (!Number.isFinite(patch.monthlySpendCapCents) || patch.monthlySpendCapCents < 0)
    ) {
      throw new RangeError("monthlySpendCapCents must be null or a non-negative finite number");
    }
    const next: OrgSubscriptionRecord = cloneSubscription(existing);
    if (patch.planId !== undefined) next.planId = patch.planId;
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.monthlySpendCapCents !== undefined) next.monthlySpendCapCents = patch.monthlySpendCapCents;
    if (patch.billingEmail !== undefined) next.billingEmail = patch.billingEmail;
    if (patch.externalCustomerId !== undefined) next.externalCustomerId = patch.externalCustomerId;
    if (patch.externalSubscriptionId !== undefined) {
      next.externalSubscriptionId = patch.externalSubscriptionId;
    }
    if (patch.quotaOverride !== undefined) next.quotaOverride = asObject(patch.quotaOverride);
    if (patch.alert80SentAt !== undefined) next.alert80SentAt = patch.alert80SentAt;
    if (patch.alert95SentAt !== undefined) next.alert95SentAt = patch.alert95SentAt;
    next.updatedAt = new Date().toISOString();
    this.subscriptions.set(orgId, next);
    return cloneSubscription(next);
  }

  public upsertMonthly(input: UsageMonthlyInput): UsageMonthlyRecord {
    const key = InMemoryBillingRepository.monthlyKey(input.orgId, input.projectId, input.billingMonth);
    const nowIso = new Date().toISOString();
    const existing = this.monthly.get(key);
    const next: UsageMonthlyRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      orgId: input.orgId,
      projectId: input.projectId,
      billingMonth: input.billingMonth,
      docReads: finiteNumber(input.docReads, "docReads"),
      docWrites: finiteNumber(input.docWrites, "docWrites"),
      docDeletes: finiteNumber(input.docDeletes, "docDeletes"),
      storageBytes: finiteNumber(input.storageBytes, "storageBytes"),
      egressBytes: finiteNumber(input.egressBytes, "egressBytes"),
      authMau: finiteNumber(input.authMau, "authMau"),
      peakConcurrentWs: finiteNumber(input.peakConcurrentWs, "peakConcurrentWs"),
      updatedAt: nowIso,
    };
    this.monthly.set(key, next);
    InMemoryBillingRepository.addToSetMap(this.monthlyByOrg, input.orgId, key);
    return cloneMonthly(next);
  }

  public listMonthly(orgId: string, billingMonth?: string): UsageMonthlyRecord[] {
    const keys = this.monthlyByOrg.get(orgId);
    if (!keys) return [];
    const rows: UsageMonthlyRecord[] = [];
    for (const key of keys) {
      const record = this.monthly.get(key);
      if (!record) continue;
      if (billingMonth !== undefined && record.billingMonth !== billingMonth) continue;
      rows.push(cloneMonthly(record));
    }
    rows.sort(
      (a, b) =>
        a.billingMonth.localeCompare(b.billingMonth) ||
        a.projectId.localeCompare(b.projectId)
    );
    return rows;
  }

  public upsertDaily(input: BillingDailyInput): BillingDailyRecord {
    const key = InMemoryBillingRepository.dailyKey(input.orgId, input.projectId, input.usageDate);
    const existing = this.daily.get(key);
    const next: BillingDailyRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      orgId: input.orgId,
      projectId: input.projectId,
      usageDate: input.usageDate,
      docReads: finiteNumber(input.docReads, "docReads"),
      docWrites: finiteNumber(input.docWrites, "docWrites"),
      docDeletes: finiteNumber(input.docDeletes, "docDeletes"),
      egressBytes: finiteNumber(input.egressBytes, "egressBytes"),
      updatedAt: new Date().toISOString(),
    };
    this.daily.set(key, next);
    InMemoryBillingRepository.addToSetMap(this.dailyByOrg, input.orgId, key);
    return cloneDaily(next);
  }

  public listDaily(orgId: string, from?: string, to?: string): BillingDailyRecord[] {
    const keys = this.dailyByOrg.get(orgId);
    if (!keys) return [];
    const rows: BillingDailyRecord[] = [];
    for (const key of keys) {
      const record = this.daily.get(key);
      if (!record) continue;
      if (from !== undefined && record.usageDate < from) continue;
      if (to !== undefined && record.usageDate > to) continue;
      rows.push(cloneDaily(record));
    }
    rows.sort(
      (a, b) =>
        a.usageDate.localeCompare(b.usageDate) ||
        a.projectId.localeCompare(b.projectId)
    );
    return rows;
  }

  public getLastLedgerHash(): string | null {
    const last = this.ledger[this.ledger.length - 1];
    return last ? last.entryHash : null;
  }

  public appendLedgerEntry(input: LedgerEntryInput): LedgerEntryRecord {
    const duplicate = this.ledgerByKey.get(input.idempotencyKey);
    if (duplicate) return cloneLedger(duplicate);
    const record: LedgerEntryRecord = {
      seq: this.ledger.length + 1,
      id: crypto.randomUUID(),
      orgId: input.orgId,
      billingMonth: input.billingMonth,
      entryType: input.entryType,
      amountCents: finiteNumber(input.amountCents, "amountCents"),
      metricSnapshot: asObject(input.metricSnapshot),
      idempotencyKey: input.idempotencyKey,
      description: input.description,
      prevHash: input.prevHash,
      entryHash: input.entryHash,
      createdAt: new Date().toISOString(),
    };
    this.ledger.push(record);
    this.ledgerByKey.set(record.idempotencyKey, record);
    let orgLedger = this.ledgerByOrg.get(record.orgId);
    if (!orgLedger) {
      orgLedger = [];
      this.ledgerByOrg.set(record.orgId, orgLedger);
    }
    orgLedger.push(record);
    return cloneLedger(record);
  }

  public listLedger(orgId?: string, billingMonth?: string): LedgerEntryRecord[] {
    const source = orgId !== undefined ? (this.ledgerByOrg.get(orgId) ?? []) : this.ledger;
    const rows: LedgerEntryRecord[] = [];
    for (const record of source) {
      if (billingMonth !== undefined && record.billingMonth !== billingMonth) continue;
      rows.push(cloneLedger(record));
    }
    // `source` is already ordered by ascending `seq`.
    return rows;
  }

  public upsertInvoice(input: InvoiceInput): InvoiceRecord {
    const key = InMemoryBillingRepository.orgMonthKey(input.orgId, input.billingMonth);
    const existing = this.invoicesByOrgMonth.get(key) ?? this.invoicesByNumber.get(input.invoiceNumber);
    const next: InvoiceRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      invoiceNumber: input.invoiceNumber,
      orgId: input.orgId,
      billingMonth: input.billingMonth,
      planId: input.planId,
      baseAmountCents: finiteNumber(input.baseAmountCents, "baseAmountCents"),
      overageAmountCents: finiteNumber(input.overageAmountCents, "overageAmountCents"),
      creditsAppliedCents: finiteNumber(input.creditsAppliedCents, "creditsAppliedCents"),
      totalAmountCents: finiteNumber(input.totalAmountCents, "totalAmountCents"),
      lineItems: asUnknownArray(input.lineItems),
      status: input.status ?? "draft",
      issuedAt: input.issuedAt === undefined ? null : input.issuedAt,
      paidAt: input.paidAt === undefined ? null : input.paidAt,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    if (existing) {
      this.invoicesById.delete(existing.id);
      this.invoicesByNumber.delete(existing.invoiceNumber);
      this.invoicesByOrgMonth.delete(
        InMemoryBillingRepository.orgMonthKey(existing.orgId, existing.billingMonth)
      );
      InMemoryBillingRepository.removeFromSetMap(this.invoicesByOrg, existing.orgId, existing.id);
    }
    this.invoicesById.set(next.id, next);
    this.invoicesByNumber.set(next.invoiceNumber, next);
    this.invoicesByOrgMonth.set(key, next);
    InMemoryBillingRepository.addToSetMap(this.invoicesByOrg, next.orgId, next.id);
    return cloneInvoice(next);
  }

  public getInvoice(orgId: string, billingMonth: string): InvoiceRecord | null {
    const found = this.invoicesByOrgMonth.get(
      InMemoryBillingRepository.orgMonthKey(orgId, billingMonth)
    );
    return found ? cloneInvoice(found) : null;
  }

  public listInvoices(orgId?: string): InvoiceRecord[] {
    const rows: InvoiceRecord[] = [];
    if (orgId !== undefined) {
      const ids = this.invoicesByOrg.get(orgId);
      if (ids) {
        for (const id of ids) {
          const record = this.invoicesById.get(id);
          if (record) rows.push(cloneInvoice(record));
        }
      }
    } else {
      for (const record of this.invoicesById.values()) {
        rows.push(cloneInvoice(record));
      }
    }
    rows.sort(
      (a, b) =>
        b.billingMonth.localeCompare(a.billingMonth) ||
        b.createdAt.localeCompare(a.createdAt) ||
        a.id.localeCompare(b.id)
    );
    return rows;
  }

  public recordWebhookEvent(eventId: string, _provider: string, _eventType: string): boolean {
    if (this.webhookEvents.has(eventId)) return false;
    if (this.webhookEvents.size >= MAX_WEBHOOK_EVENTS) {
      const oldest = this.webhookEvents.values().next();
      if (!oldest.done) this.webhookEvents.delete(oldest.value);
    }
    this.webhookEvents.add(eventId);
    return true;
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL implementation
// ---------------------------------------------------------------------------

class PgBillingRepository implements BillingRepository {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /**
   * One transaction for the whole delta. Without it a failure after the monthly row was written
   * made the engine requeue the full delta, counting it twice.
   */
  public async applyUsageDelta(input: UsageDeltaInput): Promise<UsageDeltaResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.applyUsageDeltaOn(client, input);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // the original error is the one that matters
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Serializes ledger appends across API instances with a session advisory lock. The hash chain
   * reads the previous hash, signs, then inserts; two instances doing that at once fork the chain.
   */
  public async withLedgerLock<T>(fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1::bigint)", [LEDGER_LOCK_KEY]);
      try {
        return await fn();
      } finally {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [LEDGER_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }

  private async applyUsageDeltaOn(q: pg.Pool | pg.PoolClient, input: UsageDeltaInput): Promise<UsageDeltaResult> {
    const reads = finiteNumber(input.docReads, "docReads");
    const writes = finiteNumber(input.docWrites, "docWrites");
    const deletes = finiteNumber(input.docDeletes, "docDeletes");
    const storage = finiteNumber(input.storageBytes, "storageBytes");
    const egress = finiteNumber(input.egressBytes, "egressBytes");
    const peak = finiteNumber(input.peakConcurrentWs, "peakConcurrentWs");
    const monthly = await q.query(
      `INSERT INTO usage_monthly_rollups (
         id, org_id, project_id, billing_month,
         doc_reads, doc_writes, doc_deletes, storage_bytes, egress_bytes,
         auth_mau, peak_concurrent_ws, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4,
         $5, $6, $7, GREATEST(0, $8::bigint), $9, 0, $10, now()
       )
       ON CONFLICT (org_id, project_id, billing_month) DO UPDATE SET
         doc_reads = usage_monthly_rollups.doc_reads + $5,
         doc_writes = usage_monthly_rollups.doc_writes + $6,
         doc_deletes = usage_monthly_rollups.doc_deletes + $7,
         storage_bytes = GREATEST(0, usage_monthly_rollups.storage_bytes + $8::bigint),
         egress_bytes = usage_monthly_rollups.egress_bytes + $9,
         peak_concurrent_ws = GREATEST(usage_monthly_rollups.peak_concurrent_ws, $10),
         updated_at = now()
       RETURNING ${MONTHLY_COLUMNS}`,
      [crypto.randomUUID(), input.orgId, input.projectId, input.billingMonth, reads, writes, deletes, storage, egress, peak]
    );
    // The monthly upsert above holds this (org, project, month) row lock until COMMIT, so
    // transactions for the same row run one after another. Counting users only now means each
    // count sees every earlier committed insert. Counting before the lock let a stale, smaller
    // count overwrite a larger one under concurrent flushes.
    let monthlyRow = monthly.rows[0] as Record<string, unknown> | undefined;
    if (input.authUserIds.length > 0) {
      await q.query(
        `INSERT INTO usage_active_users (org_id, project_id, billing_month, user_id)
         SELECT $1::uuid, $2::uuid, $3, u FROM unnest($4::text[]) AS u
         ON CONFLICT DO NOTHING`,
        [input.orgId, input.projectId, input.billingMonth, [...input.authUserIds]]
      );
      const withMau = await q.query(
        `UPDATE usage_monthly_rollups SET auth_mau = (
           SELECT count(*)::bigint FROM usage_active_users
            WHERE org_id = $1::uuid AND project_id = $2::uuid AND billing_month = $3
         )
         WHERE org_id = $1::uuid AND project_id = $2::uuid AND billing_month = $3
         RETURNING ${MONTHLY_COLUMNS}`,
        [input.orgId, input.projectId, input.billingMonth]
      );
      monthlyRow = withMau.rows[0] as Record<string, unknown> | undefined;
    }
    const daily = await q.query(
      `INSERT INTO usage_daily_rollups (
         id, org_id, project_id, usage_date,
         doc_reads, doc_writes, doc_deletes, egress_bytes, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, now())
       ON CONFLICT (org_id, project_id, usage_date) DO UPDATE SET
         doc_reads = usage_daily_rollups.doc_reads + $5,
         doc_writes = usage_daily_rollups.doc_writes + $6,
         doc_deletes = usage_daily_rollups.doc_deletes + $7,
         egress_bytes = usage_daily_rollups.egress_bytes + $8,
         updated_at = now()
       RETURNING ${DAILY_COLUMNS}`,
      [crypto.randomUUID(), input.orgId, input.projectId, input.usageDate, reads, writes, deletes, egress]
    );
    const mRow = monthlyRow;
    const dRow = daily.rows[0] as Record<string, unknown> | undefined;
    if (!mRow || !dRow) throw new Error("applyUsageDelta returned no row");
    return { monthly: mapMonthlyRow(mRow), daily: mapDailyRow(dRow) };
  }

  public async getQuotaState(orgId: string, billingMonth: string): Promise<QuotaState | null> {
    const sub = await this.pool.query(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM org_subscriptions WHERE org_id = $1::uuid LIMIT 1`,
      [orgId]
    );
    const subRow = sub.rows[0] as Record<string, unknown> | undefined;
    if (!subRow) return null;
    const subscription = mapSubscriptionRow(subRow);
    const [plan, usage] = await Promise.all([
      this.getPlan(subscription.planId),
      this.pool.query(
        `SELECT COALESCE(SUM(doc_reads), 0)::float8 AS "docReads",
                COALESCE(SUM(doc_writes), 0)::float8 AS "docWrites",
                COALESCE(SUM(doc_deletes), 0)::float8 AS "docDeletes",
                COALESCE(SUM(storage_bytes), 0)::float8 AS "storageBytes",
                COALESCE(SUM(egress_bytes), 0)::float8 AS "egressBytes",
                COALESCE(SUM(auth_mau), 0)::float8 AS "authMau",
                COALESCE(MAX(peak_concurrent_ws), 0)::float8 AS "peakConcurrentWs"
           FROM usage_monthly_rollups WHERE org_id = $1::uuid AND billing_month = $2`,
        [orgId, billingMonth]
      ),
    ]);
    const u = (usage.rows[0] ?? {}) as Record<string, number>;
    return {
      subscription,
      plan,
      usage: {
        docReads: u["docReads"] ?? 0,
        docWrites: u["docWrites"] ?? 0,
        docDeletes: u["docDeletes"] ?? 0,
        storageBytes: u["storageBytes"] ?? 0,
        egressBytes: u["egressBytes"] ?? 0,
        authMau: u["authMau"] ?? 0,
        peakConcurrentWs: u["peakConcurrentWs"] ?? 0,
      },
    };
  }

  public async getPlan(id: string): Promise<BillingPlanRecord | null> {
    try {
      const { rows } = await this.pool.query(
        `SELECT ${PLAN_COLUMNS} FROM billing_plans WHERE id = $1 LIMIT 1`,
        [id]
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      if (row) return mapPlanRow(row);
    } catch {
      // Migration 0008 may not have run yet in a test database.
    }
    const seeded = SEEDED_PLANS.find((plan) => plan.id === id);
    return seeded ? clonePlan(seeded) : null;
  }

  public async listPlans(): Promise<BillingPlanRecord[]> {
    return this.loadPlans();
  }

  /** Reads the seeded table; falls back to the locked seeds if it is empty/missing. */
  private async loadPlans(): Promise<BillingPlanRecord[]> {
    try {
      const { rows } = await this.pool.query(
        `SELECT ${PLAN_COLUMNS} FROM billing_plans
          ORDER BY CASE id
            WHEN 'free' THEN 0 WHEN 'pro' THEN 1 WHEN 'enterprise' THEN 2 ELSE 3
          END ASC, id ASC`
      );
      if (rows.length > 0) {
        return (rows as Record<string, unknown>[]).map(mapPlanRow);
      }
    } catch {
      // Migration 0008 may not have run yet in a test database.
    }
    return seededPlans();
  }

  public async getSubscription(orgId: string): Promise<OrgSubscriptionRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM org_subscriptions WHERE org_id = $1::uuid LIMIT 1`,
      [orgId]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapSubscriptionRow(row) : null;
  }

  public async ensureSubscription(orgId: string): Promise<OrgSubscriptionRecord> {
    const existing = await this.getSubscription(orgId);
    if (existing) return existing;
    const period = currentBillingPeriod();
    // Seed billing_email from the owning organization so alerts and invoices
    // reach the org's billing contact without a separate settings step.
    const orgResult = await this.pool.query(
      `SELECT billing_email FROM organizations WHERE id = $1::uuid LIMIT 1`,
      [orgId]
    );
    const orgRow = orgResult.rows[0] as Record<string, unknown> | undefined;
    const billingEmail = typeof orgRow?.["billing_email"] === "string" ? orgRow["billing_email"] : null;
    const { rows } = await this.pool.query(
      `INSERT INTO org_subscriptions (
         org_id, plan_id, status, monthly_spend_cap_cents, billing_email,
         external_customer_id, external_subscription_id,
         current_period_start, current_period_end, quota_override,
         alert_80_sent_at, alert_95_sent_at, created_at, updated_at
       ) VALUES (
         $1::uuid, 'free', 'active', NULL, $4, NULL, NULL,
         $2::timestamptz, $3::timestamptz, '{}'::jsonb, NULL, NULL, now(), now()
       )
       ON CONFLICT (org_id) DO NOTHING
       RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [orgId, period.start, period.end, billingEmail]
    );
    const inserted = rows[0] as Record<string, unknown> | undefined;
    if (inserted) return mapSubscriptionRow(inserted);
    // A concurrent writer won the INSERT; read the committed row.
    const winner = await this.getSubscription(orgId);
    if (winner) return winner;
    throw new Error(`ensureSubscription failed to create a subscription for org '${orgId}'`);
  }

  public async updateSubscription(
    orgId: string,
    patch: SubscriptionPatch
  ): Promise<OrgSubscriptionRecord | null> {
    if (patch.status !== undefined && !VALID_SUBSCRIPTION_STATUSES.has(patch.status)) {
      throw new RangeError(`Invalid subscription status: ${String(patch.status)}`);
    }
    if (
      patch.monthlySpendCapCents !== undefined &&
      patch.monthlySpendCapCents !== null &&
      (!Number.isFinite(patch.monthlySpendCapCents) || patch.monthlySpendCapCents < 0)
    ) {
      throw new RangeError("monthlySpendCapCents must be null or a non-negative finite number");
    }

    const assignments: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown, cast = ""): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}${cast}`);
    };
    if (patch.planId !== undefined) add("plan_id", patch.planId);
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.monthlySpendCapCents !== undefined) {
      add("monthly_spend_cap_cents", patch.monthlySpendCapCents);
    }
    if (patch.billingEmail !== undefined) add("billing_email", patch.billingEmail);
    if (patch.externalCustomerId !== undefined) {
      add("external_customer_id", patch.externalCustomerId);
    }
    if (patch.externalSubscriptionId !== undefined) {
      add("external_subscription_id", patch.externalSubscriptionId);
    }
    if (patch.quotaOverride !== undefined) {
      add("quota_override", JSON.stringify(asObject(patch.quotaOverride)), "::jsonb");
    }
    if (patch.alert80SentAt !== undefined) {
      add("alert_80_sent_at", isoOrNull(patch.alert80SentAt), "::timestamptz");
    }
    if (patch.alert95SentAt !== undefined) {
      add("alert_95_sent_at", isoOrNull(patch.alert95SentAt), "::timestamptz");
    }
    if (assignments.length === 0) return this.getSubscription(orgId);

    values.push(orgId);
    const { rows } = await this.pool.query(
      `UPDATE org_subscriptions
          SET ${assignments.join(", ")}, updated_at = now()
        WHERE org_id = $${values.length}::uuid
        RETURNING ${SUBSCRIPTION_COLUMNS}`,
      values
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapSubscriptionRow(row) : null;
  }

  public async upsertMonthly(input: UsageMonthlyInput): Promise<UsageMonthlyRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO usage_monthly_rollups (
         id, org_id, project_id, billing_month,
         doc_reads, doc_writes, doc_deletes, storage_bytes, egress_bytes,
         auth_mau, peak_concurrent_ws, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4,
         $5, $6, $7, $8, $9, $10, $11, now()
       )
       ON CONFLICT (org_id, project_id, billing_month) DO UPDATE SET
         doc_reads = EXCLUDED.doc_reads,
         doc_writes = EXCLUDED.doc_writes,
         doc_deletes = EXCLUDED.doc_deletes,
         storage_bytes = EXCLUDED.storage_bytes,
         egress_bytes = EXCLUDED.egress_bytes,
         auth_mau = EXCLUDED.auth_mau,
         peak_concurrent_ws = EXCLUDED.peak_concurrent_ws,
         updated_at = now()
       RETURNING ${MONTHLY_COLUMNS}`,
      [
        crypto.randomUUID(),
        input.orgId,
        input.projectId,
        input.billingMonth,
        finiteNumber(input.docReads, "docReads"),
        finiteNumber(input.docWrites, "docWrites"),
        finiteNumber(input.docDeletes, "docDeletes"),
        finiteNumber(input.storageBytes, "storageBytes"),
        finiteNumber(input.egressBytes, "egressBytes"),
        finiteNumber(input.authMau, "authMau"),
        finiteNumber(input.peakConcurrentWs, "peakConcurrentWs"),
      ]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("upsertMonthly returned no row");
    return mapMonthlyRow(row);
  }

  public async listMonthly(orgId: string, billingMonth?: string): Promise<UsageMonthlyRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT ${MONTHLY_COLUMNS} FROM usage_monthly_rollups
        WHERE org_id = $1::uuid AND ($2::text IS NULL OR billing_month = $2)
        ORDER BY billing_month ASC, project_id ASC`,
      [orgId, billingMonth ?? null]
    );
    return (rows as Record<string, unknown>[]).map(mapMonthlyRow);
  }

  public async upsertDaily(input: BillingDailyInput): Promise<BillingDailyRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO usage_daily_rollups (
         id, org_id, project_id, usage_date,
         doc_reads, doc_writes, doc_deletes, egress_bytes, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4,
         $5, $6, $7, $8, now()
       )
       ON CONFLICT (org_id, project_id, usage_date) DO UPDATE SET
         doc_reads = EXCLUDED.doc_reads,
         doc_writes = EXCLUDED.doc_writes,
         doc_deletes = EXCLUDED.doc_deletes,
         egress_bytes = EXCLUDED.egress_bytes,
         updated_at = now()
       RETURNING ${DAILY_COLUMNS}`,
      [
        crypto.randomUUID(),
        input.orgId,
        input.projectId,
        input.usageDate,
        finiteNumber(input.docReads, "docReads"),
        finiteNumber(input.docWrites, "docWrites"),
        finiteNumber(input.docDeletes, "docDeletes"),
        finiteNumber(input.egressBytes, "egressBytes"),
      ]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("upsertDaily returned no row");
    return mapDailyRow(row);
  }

  public async listDaily(orgId: string, from?: string, to?: string): Promise<BillingDailyRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT ${DAILY_COLUMNS} FROM usage_daily_rollups
        WHERE org_id = $1::uuid
          AND ($2::text IS NULL OR usage_date >= $2)
          AND ($3::text IS NULL OR usage_date <= $3)
        ORDER BY usage_date ASC, project_id ASC`,
      [orgId, from ?? null, to ?? null]
    );
    return (rows as Record<string, unknown>[]).map(mapDailyRow);
  }

  public async getLastLedgerHash(): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT entry_hash AS "entryHash" FROM billing_ledger_entries
        ORDER BY seq DESC LIMIT 1`
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row && typeof row["entryHash"] === "string" ? row["entryHash"] : null;
  }

  public async appendLedgerEntry(input: LedgerEntryInput): Promise<LedgerEntryRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO billing_ledger_entries (
         org_id, billing_month, entry_type, amount_cents, metric_snapshot,
         idempotency_key, description, prev_hash, entry_hash
       ) VALUES (
         $1::uuid, $2, $3, $4, $5::jsonb, $6, $7, $8, $9
       )
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${LEDGER_COLUMNS}`,
      [
        input.orgId,
        input.billingMonth,
        input.entryType,
        finiteNumber(input.amountCents, "amountCents"),
        JSON.stringify(asObject(input.metricSnapshot)),
        input.idempotencyKey,
        input.description,
        input.prevHash,
        input.entryHash,
      ]
    );
    const inserted = rows[0] as Record<string, unknown> | undefined;
    if (inserted) return mapLedgerRow(inserted);
    const existing = await this.pool.query(
      `SELECT ${LEDGER_COLUMNS} FROM billing_ledger_entries
        WHERE idempotency_key = $1 LIMIT 1`,
      [input.idempotencyKey]
    );
    const row = existing.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("appendLedgerEntry returned no row after idempotent insert");
    return mapLedgerRow(row);
  }

  public async listLedger(orgId?: string, billingMonth?: string): Promise<LedgerEntryRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT ${LEDGER_COLUMNS} FROM billing_ledger_entries
        WHERE ($1::uuid IS NULL OR org_id = $1::uuid)
          AND ($2::text IS NULL OR billing_month = $2)
        ORDER BY seq ASC`,
      [orgId ?? null, billingMonth ?? null]
    );
    return (rows as Record<string, unknown>[]).map(mapLedgerRow);
  }

  public async upsertInvoice(input: InvoiceInput): Promise<InvoiceRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO billing_invoices (
         invoice_number, org_id, billing_month, plan_id,
         base_amount_cents, overage_amount_cents, credits_applied_cents,
         total_amount_cents, line_items, status, issued_at, paid_at
       ) VALUES (
         $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::timestamptz, $12::timestamptz
       )
       ON CONFLICT (org_id, billing_month) DO UPDATE SET
         invoice_number = EXCLUDED.invoice_number,
         plan_id = EXCLUDED.plan_id,
         base_amount_cents = EXCLUDED.base_amount_cents,
         overage_amount_cents = EXCLUDED.overage_amount_cents,
         credits_applied_cents = EXCLUDED.credits_applied_cents,
         total_amount_cents = EXCLUDED.total_amount_cents,
         line_items = EXCLUDED.line_items,
         status = EXCLUDED.status,
         issued_at = EXCLUDED.issued_at,
         paid_at = EXCLUDED.paid_at
       RETURNING ${INVOICE_COLUMNS}`,
      [
        input.invoiceNumber,
        input.orgId,
        input.billingMonth,
        input.planId,
        finiteNumber(input.baseAmountCents, "baseAmountCents"),
        finiteNumber(input.overageAmountCents, "overageAmountCents"),
        finiteNumber(input.creditsAppliedCents, "creditsAppliedCents"),
        finiteNumber(input.totalAmountCents, "totalAmountCents"),
        JSON.stringify(asUnknownArray(input.lineItems)),
        input.status ?? "draft",
        isoOrNull(input.issuedAt),
        isoOrNull(input.paidAt),
      ]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("upsertInvoice returned no row");
    return mapInvoiceRow(row);
  }

  public async getInvoice(orgId: string, billingMonth: string): Promise<InvoiceRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT ${INVOICE_COLUMNS} FROM billing_invoices
        WHERE org_id = $1::uuid AND billing_month = $2 LIMIT 1`,
      [orgId, billingMonth]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapInvoiceRow(row) : null;
  }

  public async listInvoices(orgId?: string): Promise<InvoiceRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT ${INVOICE_COLUMNS} FROM billing_invoices
        WHERE ($1::uuid IS NULL OR org_id = $1::uuid)
        ORDER BY billing_month DESC, created_at DESC, id ASC`,
      [orgId ?? null]
    );
    return (rows as Record<string, unknown>[]).map(mapInvoiceRow);
  }

  public async recordWebhookEvent(
    eventId: string,
    provider: string,
    eventType: string
  ): Promise<boolean> {
    const { rows } = await this.pool.query(
      `INSERT INTO billing_webhook_events (event_id, provider, event_type)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eventId, provider, eventType]
    );
    return rows.length > 0;
  }
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function createInMemoryBillingRepository(
  resolveOrgBillingEmail?: (orgId: string) => string | null
): BillingRepository {
  return new InMemoryBillingRepository(resolveOrgBillingEmail);
}

export function createPgBillingRepository(pool: pg.Pool): BillingRepository {
  return new PgBillingRepository(pool);
}
