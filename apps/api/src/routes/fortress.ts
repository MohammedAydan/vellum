/**
 * @vellum/api - Security Fortress & Billing delivery adapter
 * (`docs/SECURITY-BILLING-CONTRACT.md` §6.1 / §6.2).
 *
 * Mounted at `/v1` by the orchestrator. Realm isolation is enforced by the two
 * existing session guards; every customer route additionally asserts org
 * membership so a valid console token can never reach another tenant's data.
 * No document payload is ever read or returned from these endpoints.
 */

import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { VellumError } from "@vellum/core";
import {
  BlocklistCreateSchema,
  BillingWebhookSchema,
  InvoiceGenerateSchema,
  KeyRestrictionsSchema,
  OrgOverrideSchema,
  SubscriptionPatchSchema,
  ThreatStatusPatchSchema,
} from "@vellum/api-contract";
import {
  calculateMonthlyBill,
  consumeWebhookEvent,
  generateMonthlyInvoice,
  verifyStripeWebhook,
  type QuotaDecision,
  type UsageTotals,
  type WebhookVerificationResult,
} from "@vellum/billing";
import {
  computeChainHash,
  verifyHashChain,
  type ChainRow,
} from "@vellum/security";
import type { Role, SessionClaims } from "@vellum/authorization";
import type {
  BillingPlanRecord,
  BlocklistInput,
  InvoiceRecord,
  OrgSubscriptionRecord,
  SecurityAuditFilter,
  SecurityAuditRecord,
  SubscriptionPatch as SubscriptionPatchRecord,
  ThreatFilter,
  UsageMonthlyRecord,
} from "@vellum/database-control";
import {
  requireCustomerConsoleSession,
  requireSuperAdminSession,
} from "../middleware/realm-session.js";
import {
  assertOrgAccess,
  extractBearerToken,
  getSession,
  getUserOrgMemberships,
} from "../middleware/session.js";
import { extractClientIp, mapWithConcurrency } from "../middleware/security.js";
import type { VellumPlatformContext } from "../app.js";

type PlatformContext = VellumPlatformContext;

const GENESIS_HASH = "0".repeat(64);
// `billing_viewer` is a console role allowed by contract §6.1 but is not yet in
// the shared `Role` union; the guard performs a plain inclusion check at runtime.
// Console sessions issued by `/v1/auth/sign-in/email` carry the `customer`
// role; billing and audit reads are available to every authenticated member.
// Subscription mutations are additionally gated on an owner membership row.
const CONSOLE_ROLES = ["owner", "admin", "billing_viewer", "customer", "support_readonly"] as readonly Role[];
const QUOTA_OPERATIONS = ["read", "write", "delete", "ws_connect", "auth_signup"] as const;

/* -------------------------------------------------------------------------- */
/* Small boundary helpers                                                     */
/* -------------------------------------------------------------------------- */

interface SafeParseLike<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ message?: string }> } };
}

function parseOrThrow<T>(schema: SafeParseLike<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new VellumError("INVALID_ARGUMENT", `Invalid ${label}`, {
      issues: (parsed as Extract<typeof parsed, { success: false }>).error.issues.slice(0, 10),
    });
  }
  return parsed.data;
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return (await c.req.json()) as unknown;
  } catch {
    throw new VellumError("INVALID_ARGUMENT", "Request body must be valid JSON");
  }
}

function requireClaims(c: Context): SessionClaims {
  const claims = getSession(c);
  if (!claims) throw new VellumError("UNAUTHENTICATED", "Missing session context");
  return claims;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new VellumError("INVALID_ARGUMENT", "Invalid 'limit' query parameter");
  }
  return Math.min(1_000, value);
}

function requestMeta(c: Context): { ipAddress?: string; userAgent?: string } {
  const resolvedIp = extractClientIp(c);
  const ipAddress = resolvedIp !== "unknown" ? resolvedIp : undefined;
  const userAgent = c.req.header("user-agent") || undefined;
  return {
    ...(ipAddress !== undefined ? { ipAddress } : {}),
    ...(userAgent !== undefined ? { userAgent } : {}),
  };
}

/** Membership check on every org-scoped route; platform operators may span orgs. */
async function assertOrgMember(
  platform: PlatformContext,
  claims: SessionClaims,
  orgId: string
): Promise<void> {
  await assertOrgAccess(platform.controlStore, claims, orgId);
}

/** Owner-only mutation: membership role must be `owner` for customer sessions. */
async function assertOrgOwner(
  platform: PlatformContext,
  claims: SessionClaims,
  orgId: string
): Promise<void> {
  await assertOrgMember(platform, claims, orgId);
  // Unlike the generic operator check in `assertOrgAccess`, a billing mutation
  // requires a real owner membership row. A console token that merely carries
  // an operator-shaped role must not be able to cross the tenant boundary.
  const memberships = await getUserOrgMemberships(platform.controlStore, claims.uid);
  const membership = memberships.find((m) => m.organizationId === orgId);
  if (membership?.role !== "owner") {
    throw new VellumError("PERMISSION_DENIED", "Organization owner role required", {
      organizationId: orgId,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Hash-chained audit helper                                                  */
/* -------------------------------------------------------------------------- */

interface AuditEvent {
  actorRealm: "customer_console" | "super_admin";
  actorId: string;
  orgId?: string;
  projectId?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  outcome: "success" | "denied" | "error";
  ipAddress?: string;
  userAgent?: string;
  details: Record<string, unknown>;
}

/**
 * Ledger writers hash an explicit timestamp and persist it inside the payload
 * (see `generateMonthlyInvoice`). Prefer that value when verifying so the proof
 * cannot be broken by clock differences between the app and the database;
 * fall back to the persisted `createdAt` for rows written by other producers.
 */
function chainTimestamp(payload: Record<string, unknown>, createdAt: string): string {
  const embedded = payload["timestampIso"];
  return typeof embedded === "string" ? embedded : createdAt;
}

/**
 * Appends a tamper-evident security audit row. `platform.chainKeys.security`
 * is the HKDF key derived at startup with domain `security-audit-v1`; the
 * verification endpoint maps `details` back to the hashed payload.
 */
async function appendSecurityAudit(
  platform: PlatformContext,
  event: AuditEvent
): Promise<SecurityAuditRecord> {
  const security = platform.controlStore.security;
  const [recent, lastHash] = await Promise.all([
    security.listAuditLogs({ limit: 1 }),
    security.getLastAuditHash(),
  ]);
  const prevHash = lastHash ?? GENESIS_HASH;
  const nextSeq = (recent[0]?.seq ?? 0) + 1;
  const timestampIso = new Date().toISOString();
  // The exact hashed timestamp travels inside `details`, which is also the
  // hashed payload, so the verification proof can reproduce the digest.
  const details: Record<string, unknown> = { ...event.details, timestampIso };
  const entryHash = computeChainHash(
    platform.chainKeys.security,
    nextSeq,
    prevHash,
    timestampIso,
    details
  );
  return security.appendAuditLog({
    actorRealm: event.actorRealm,
    actorId: event.actorId,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    outcome: event.outcome,
    details,
    prevHash,
    entryHash,
    ...(event.orgId !== undefined ? { orgId: event.orgId } : {}),
    ...(event.projectId !== undefined ? { projectId: event.projectId } : {}),
    ...(event.ipAddress !== undefined ? { ipAddress: event.ipAddress } : {}),
    ...(event.userAgent !== undefined ? { userAgent: event.userAgent } : {}),
  });
}

/* -------------------------------------------------------------------------- */
/* Billing read-model helpers                                                 */
/* -------------------------------------------------------------------------- */

function currentBillingMonth(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function monthBounds(billingMonth: string): { from: string; to: string } {
  const year = Number(billingMonth.slice(0, 4));
  const month = Number(billingMonth.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${billingMonth}-01`,
    to: `${billingMonth}-${String(lastDay).padStart(2, "0")}`,
  };
}

function aggregateMonthly(rows: readonly UsageMonthlyRecord[]): UsageTotals {
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
    totals.docReads += row.docReads;
    totals.docWrites += row.docWrites;
    totals.docDeletes += row.docDeletes;
    totals.storageBytes += row.storageBytes;
    totals.egressBytes += row.egressBytes;
    totals.authMau += row.authMau;
    totals.peakConcurrentWs = Math.max(totals.peakConcurrentWs, row.peakConcurrentWs);
  }
  return totals;
}

interface OrgSubscriptionRow {
  orgId: string;
  orgName: string;
  subscription: OrgSubscriptionRecord;
}

async function listSubscriptionRows(platform: PlatformContext): Promise<OrgSubscriptionRow[]> {
  const billing = platform.controlStore.billing;
  const orgs = Array.from(platform.controlStore.organizations.values());
  const rows = await mapWithConcurrency(orgs, 10, async (org) => {
    const subscription = await billing.getSubscription(org.id);
    return subscription === null
      ? null
      : { orgId: org.id, orgName: org.name, subscription };
  });
  return rows.filter((row): row is OrgSubscriptionRow => row !== null);
}

async function planFor(
  platform: PlatformContext,
  subscription: OrgSubscriptionRecord
): Promise<BillingPlanRecord | null> {
  return platform.controlStore.billing.getPlan(subscription.planId);
}

/* -------------------------------------------------------------------------- */
/* Router                                                                     */
/* -------------------------------------------------------------------------- */

export function createFortressRoutes(platform: VellumPlatformContext): Hono {
  const routes = new Hono();
  const { controlStore, quota } = platform;
  const billing = controlStore.billing;
  const security = controlStore.security;

  // Paths are relative to the router mounted at `/v1` (app.ts mounts every
  // domain router this way). Customers are confined to their own org; admin
  // routes are unreachable for them because the guard rejects the realm.
  routes.use(
    "/console/orgs/:orgId/*",
    requireCustomerConsoleSession(platform, CONSOLE_ROLES)
  );
  // A valid customer-console token must get 403 (not 401) on every admin
  // surface: this distinguishes "wrong realm" from "no/invalid token" while
  // leaving the shared realm guard's behaviour unchanged elsewhere.
  routes.use("/admin/*", async (c, next) => {
    const token = extractBearerToken(c.req.header("authorization"));
    if (token !== null) {
      try {
        const claims = platform.consoleSessionService.verifyAccess(token) as {
          realm?: string;
        };
        if (claims.realm === "customer_console") {
          throw new VellumError(
            "PERMISSION_DENIED",
            "Super admin privileges required for this endpoint"
          );
        }
      } catch (error) {
        if (error instanceof VellumError && error.code === "PERMISSION_DENIED") throw error;
      }
    }
    await next();
  });
  routes.use("/admin/*", requireSuperAdminSession(platform));

  /* ====================================================================== */
  /* Customer console — billing                                             */
  /* ====================================================================== */

  routes.get("/console/orgs/:orgId/billing/summary", async (c) => {
    const orgId = c.req.param("orgId");
    const claims = requireClaims(c);
    await assertOrgMember(platform, claims, orgId);

    const billingMonth = currentBillingMonth();
    const subscription =
      (await billing.getSubscription(orgId)) ?? (await billing.ensureSubscription(orgId));
    const plan = await planFor(platform, subscription);
    const [monthlyRows, dailyRows] = await Promise.all([
      billing.listMonthly(orgId, billingMonth),
      billing.listDaily(orgId, monthBounds(billingMonth).from, monthBounds(billingMonth).to),
    ]);
    const usage = aggregateMonthly(monthlyRows);
    const projected = plan === null ? null : calculateMonthlyBill(plan, usage);

    const quotaDecisions: Record<string, QuotaDecision> = {};
    for (const operation of QUOTA_OPERATIONS) {
      quotaDecisions[operation] = quota.checkQuota(orgId, operation);
    }

    return c.json({
      billingMonth,
      plan: plan === null ? null : {
        id: plan.id,
        name: plan.name,
        monthlyBasePriceCents: plan.monthlyBasePriceCents,
        hardLimitEnforced: plan.hardLimitEnforced,
        includedDocReads: plan.includedDocReads,
        includedDocWrites: plan.includedDocWrites,
        includedDocDeletes: plan.includedDocDeletes,
        includedStorageBytes: plan.includedStorageBytes,
        includedEgressBytes: plan.includedEgressBytes,
        includedAuthMau: plan.includedAuthMau,
        maxConcurrentWs: plan.maxConcurrentWs,
      },
      status: subscription.status,
      billingEmail: subscription.billingEmail,
      usage,
      quota: quotaDecisions,
      projectedCostCents: projected?.totalAmountCents ?? 0,
      overageCostCents: projected?.overageAmountCents ?? 0,
      spendCapCents: subscription.monthlySpendCapCents,
      dailySeries: dailyRows.map((row) => ({
        usageDate: row.usageDate,
        docReads: row.docReads,
        docWrites: row.docWrites,
        docDeletes: row.docDeletes,
        egressBytes: row.egressBytes,
      })),
    });
  });

  routes.get("/console/orgs/:orgId/billing/plans", async (c) => {
    const orgId = c.req.param("orgId");
    const claims = requireClaims(c);
    await assertOrgMember(platform, claims, orgId);
    const plans = await billing.listPlans();
    return c.json({ plans });
  });

  routes.patch("/console/orgs/:orgId/billing/subscription", async (c) => {
    const orgId = c.req.param("orgId");
    const claims = requireClaims(c);
    await assertOrgOwner(platform, claims, orgId);

    const parsed = parseOrThrow(SubscriptionPatchSchema, await jsonBody(c), "subscription patch");
    const current =
      (await billing.getSubscription(orgId)) ?? (await billing.ensureSubscription(orgId));
    const patch: SubscriptionPatchRecord = {};
    if (parsed.planId !== undefined) patch.planId = parsed.planId;
    if (parsed.monthlySpendCapCents !== undefined) {
      patch.monthlySpendCapCents = parsed.monthlySpendCapCents;
    }
    if (parsed.billingEmail !== undefined) patch.billingEmail = parsed.billingEmail;
    const updated = (await billing.updateSubscription(orgId, patch)) ?? current;
    quota.invalidate(orgId);

    const details: Record<string, unknown> = {
      kind: "admin_adjustment",
      action: "billing.subscription.update",
      orgId,
      actorId: claims.uid,
      previous: {
        planId: current.planId,
        status: current.status,
        monthlySpendCapCents: current.monthlySpendCapCents,
      },
      patch: {
        ...(parsed.planId !== undefined ? { planId: parsed.planId } : {}),
        ...(parsed.monthlySpendCapCents !== undefined
          ? { monthlySpendCapCents: parsed.monthlySpendCapCents }
          : {}),
        // Billing contact is PII of the tenant but not a document payload; keep
        // it out of the immutable audit trail regardless.
      },
    };
    await appendSecurityAudit(platform, {
      actorRealm: "customer_console",
      actorId: claims.uid,
      orgId,
      action: "billing.subscription.update",
      resourceType: "organization_subscription",
      resourceId: orgId,
      outcome: "success",
      details,
      ...requestMeta(c),
    });

    return c.json({ subscription: updated });
  });

  routes.get("/console/orgs/:orgId/billing/invoices", async (c) => {
    const orgId = c.req.param("orgId");
    const claims = requireClaims(c);
    await assertOrgMember(platform, claims, orgId);
    const invoices = await billing.listInvoices(orgId);
    return c.json({ invoices });
  });

  routes.get("/console/orgs/:orgId/billing/invoices/:invoiceId", async (c) => {
    const orgId = c.req.param("orgId");
    const invoiceId = c.req.param("invoiceId");
    const claims = requireClaims(c);
    await assertOrgMember(platform, claims, orgId);
    const invoices = await billing.listInvoices(orgId);
    const invoice = invoices.find((row) => row.id === invoiceId);
    if (!invoice) throw new VellumError("NOT_FOUND", `Invoice '${invoiceId}' not found`);
    return c.json({ invoice });
  });

  /* ====================================================================== */
  /* Customer console — security                                            */
  /* ====================================================================== */

  routes.get("/console/orgs/:orgId/security/audit-logs", async (c) => {
    const orgId = c.req.param("orgId");
    const claims = requireClaims(c);
    await assertOrgMember(platform, claims, orgId);
    const limit = parseLimit(c.req.query("limit"), 200);
    const auditLogs = await security.listAuditLogs({ orgId, limit });
    return c.json({ auditLogs });
  });

  routes.patch(
    "/console/orgs/:orgId/projects/:projectId/keys/:keyId/restrictions",
    async (c) => {
      const orgId = c.req.param("orgId");
      const projectId = c.req.param("projectId");
      const keyId = c.req.param("keyId");
      const claims = requireClaims(c);
      await assertOrgMember(platform, claims, orgId);

      const project = controlStore.projects.get(projectId);
      if (!project || project.organizationId !== orgId) {
        throw new VellumError("NOT_FOUND", `Project '${projectId}' not found`);
      }
      const key = await controlStore.findApiKeyById(keyId);
      if (!key || key.projectId !== projectId) {
        throw new VellumError("NOT_FOUND", "API key not found in this project");
      }
      const parsed = parseOrThrow(
        KeyRestrictionsSchema,
        await jsonBody(c),
        "API key restrictions"
      );
      const patch: {
        allowedOrigins?: string[];
        allowedIps?: string[];
        expiresAt?: string | null;
      } = {};
      if (parsed.allowedOrigins !== undefined) patch.allowedOrigins = parsed.allowedOrigins;
      if (parsed.allowedIps !== undefined) patch.allowedIps = parsed.allowedIps;
      if (parsed.expiresAt !== undefined) patch.expiresAt = parsed.expiresAt;
      await security.updateApiKeyRestrictions(keyId, patch);
      // Nothing is mirrored locally for keys: every request reads api_keys from the database.
      // (The in-memory test repository applies the patch itself.)

      await appendSecurityAudit(platform, {
        actorRealm: "customer_console",
        actorId: claims.uid,
        orgId,
        projectId,
        action: "api_key.restrictions.update",
        resourceType: "api_key",
        resourceId: keyId,
        outcome: "success",
        details: {
          kind: "api_key_restrictions",
          orgId,
          projectId,
          keyId,
          allowedOrigins: patch.allowedOrigins ?? [],
          allowedIps: patch.allowedIps ?? [],
          expiresAt: patch.expiresAt ?? null,
        },
        ...requestMeta(c),
      });
      return c.json({ updated: true, keyId });
    }
  );

  /* ====================================================================== */
  /* Verified billing webhook (no session guard)                            */
  /* ====================================================================== */

  routes.post("/webhooks/billing/stripe", async (c) => {
    const webhookSecret = process.env["STRIPE_WEBHOOK_SECRET"];
    if (process.env["NODE_ENV"] === "production" && !webhookSecret) {
      throw new VellumError("SERVICE_UNAVAILABLE", "Stripe webhook secret is not configured");
    }
    const rawBody = await c.req.text();
    const verification = verifyStripeWebhook(
      rawBody,
      c.req.header("stripe-signature") ?? null,
      webhookSecret ?? "whsec_vellum_local"
    );
    if (!verification.ok) {
      // Type-only assertion for Vercel's separate function TS config, which
      // does not narrow this discriminated union (the package tsconfig does).
      const failed = verification as Extract<WebhookVerificationResult, { ok: false }>;
      throw new VellumError("INVALID_ARGUMENT", "Stripe webhook verification failed", {
        reason: failed.code,
      });
    }

    let rawEvent: unknown;
    try {
      rawEvent = JSON.parse(rawBody) as unknown;
    } catch {
      throw new VellumError("INVALID_ARGUMENT", "Stripe webhook body is not valid JSON");
    }
    parseOrThrow(BillingWebhookSchema, rawEvent, "Stripe event payload");

    const duplicate = await consumeWebhookEvent(
      billing,
      verification.eventId,
      "stripe",
      verification.eventType
    );
    if (!duplicate) {
      throw new VellumError("INVALID_ARGUMENT", "Duplicate Stripe webhook event", {
        eventId: verification.eventId,
      });
    }
    return c.json({ received: true, duplicate: false });
  });

  /* ====================================================================== */
  /* Super admin — security                                                 */
  /* ====================================================================== */

  routes.get("/admin/security/overview", async (c) => {
    const [openThreats, activeBlocks, recentAudit, lastAuditHash, lastLedgerHash] =
      await Promise.all([
        security.listThreats({ status: "open" }),
        security.listBlocklist(true),
        security.listAuditLogs({ limit: 1 }),
        security.getLastAuditHash(),
        billing.getLastLedgerHash(),
      ]);

    const threatsBySeverity: Record<"low" | "medium" | "high" | "critical", number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };
    const ipCounts = new Map<string, number>();
    for (const threat of openThreats) {
      if (threat.severity in threatsBySeverity) threatsBySeverity[threat.severity] += 1;
      if (threat.category === "quota_abuse" && threat.sourceIp !== null) {
        ipCounts.set(threat.sourceIp, (ipCounts.get(threat.sourceIp) ?? 0) + 1);
      }
    }
    const topRateLimitedIps = Array.from(ipCounts.entries())
      .map(([ip, events]) => ({ ip, events }))
      .sort((a, b) => b.events - a.events || a.ip.localeCompare(b.ip))
      .slice(0, 10);

    return c.json({
      threatsBySeverity,
      openThreats: openThreats.length,
      activeBlocks: activeBlocks.length,
      chainHealth: {
        audit: {
          lastSeq: recentAudit[0]?.seq ?? null,
          lastHashPresent: lastAuditHash !== null,
        },
        ledger: { lastHashPresent: lastLedgerHash !== null },
        healthy: lastAuditHash !== null && lastLedgerHash !== null,
      },
      topRateLimitedIps,
    });
  });

  routes.get("/admin/security/threats", async (c) => {
    const filter: ThreatFilter = {};
    const status = c.req.query("status");
    if (status === "open" || status === "acknowledged" || status === "resolved") {
      filter.status = status;
    }
    const severity = c.req.query("severity");
    if (severity !== undefined && severity !== "") filter.severity = severity;
    filter.limit = parseLimit(c.req.query("limit"), 200);
    const threats = await security.listThreats(filter);
    return c.json({ threats });
  });

  routes.patch("/admin/security/threats/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = parseOrThrow(ThreatStatusPatchSchema, await jsonBody(c), "threat status patch");
    const updated = await security.updateThreatStatus(id, parsed.status);
    if (!updated) throw new VellumError("NOT_FOUND", `Threat '${id}' not found`);

    const claims = requireClaims(c);
    await appendSecurityAudit(platform, {
      actorRealm: "super_admin",
      actorId: claims.uid,
      action: "security.threat.status.update",
      resourceType: "security_threat",
      resourceId: id,
      outcome: "success",
      details: { kind: "threat_status", threatId: id, status: parsed.status },
      ...requestMeta(c),
    });
    return c.json({ threat: updated });
  });

  routes.get("/admin/security/blocklist", async (c) => {
    const activeOnly = c.req.query("activeOnly");
    const entries = await security.listBlocklist(activeOnly !== "false");
    return c.json({ blocklist: entries });
  });

  routes.post("/admin/security/blocklist", async (c) => {
    const claims = requireClaims(c);
    const parsed = parseOrThrow(BlocklistCreateSchema, await jsonBody(c), "blocklist entry");
    const input: BlocklistInput = {
      targetType: parsed.targetType,
      targetValue: parsed.targetValue,
      reason: parsed.reason,
      createdBy: claims.uid,
      ...(parsed.expiresAt !== undefined ? { expiresAt: parsed.expiresAt } : {}),
    };
    const entry = await security.upsertBlocklist(input);
    await appendSecurityAudit(platform, {
      actorRealm: "super_admin",
      actorId: claims.uid,
      action: "security.blocklist.upsert",
      resourceType: "security_blocklist",
      resourceId: entry.id,
      outcome: "success",
      details: {
        kind: "blocklist_entry",
        targetType: parsed.targetType,
        targetValue: parsed.targetValue,
        reason: parsed.reason,
        expiresAt: parsed.expiresAt ?? null,
      },
      ...requestMeta(c),
    });
    return c.json({ block: entry }, 201);
  });

  routes.delete("/admin/security/blocklist/:id", async (c) => {
    const id = c.req.param("id");
    const claims = requireClaims(c);
    const deleted = await security.deleteBlocklist(id);
    if (!deleted) throw new VellumError("NOT_FOUND", `Blocklist entry '${id}' not found`);
    await appendSecurityAudit(platform, {
      actorRealm: "super_admin",
      actorId: claims.uid,
      action: "security.blocklist.delete",
      resourceType: "security_blocklist",
      resourceId: id,
      outcome: "success",
      details: { kind: "blocklist_entry", blockId: id, deleted: true },
      ...requestMeta(c),
    });
    return c.json({ deleted: true, id });
  });

  routes.get("/admin/security/audit-logs", async (c) => {
    const filter: SecurityAuditFilter = { limit: parseLimit(c.req.query("limit"), 200) };
    const orgId = c.req.query("orgId");
    const action = c.req.query("action");
    const outcome = c.req.query("outcome");
    if (orgId !== undefined && orgId !== "") filter.orgId = orgId;
    if (action !== undefined && action !== "") filter.action = action;
    if (outcome !== undefined && outcome !== "") {
      if (outcome === "success" || outcome === "denied" || outcome === "error") {
        filter.outcome = outcome;
      } else {
        throw new VellumError("INVALID_ARGUMENT", "Invalid 'outcome' query parameter");
      }
    }
    const auditLogs = await security.listAuditLogs(filter);
    return c.json({ auditLogs });
  });

  routes.post("/admin/security/audit-logs/verify-chain", async (c) => {
    const rows = await security.listAuditLogs({ limit: 1_000 });
    const chainRows: ChainRow[] = rows.map((row) => ({
      seq: row.seq,
      prevHash: row.prevHash,
      entryHash: row.entryHash,
      timestampIso: chainTimestamp(row.details, row.createdAt),
      payload: row.details,
    }));
    return c.json(verifyHashChain(platform.chainKeys.security, chainRows));
  });

  /* ====================================================================== */
  /* Super admin — billing                                                  */
  /* ====================================================================== */

  routes.get("/admin/billing/overview", async (c) => {
    const billingMonth = currentBillingMonth();
    const subscriptions = await listSubscriptionRows(platform);
    const planMap = new Map<string, BillingPlanRecord>();
    const plans = await billing.listPlans();
    for (const plan of plans) planMap.set(plan.id, plan);

    let mrrCents = 0;
    const activeRows = subscriptions.filter((row) => row.subscription.status === "active");
    const activeSubscriptions = activeRows.length;
    for (const row of activeRows) {
      const plan = planMap.get(row.subscription.planId) ?? null;
      if (plan !== null && (plan.id === "pro" || plan.id === "enterprise")) {
        mrrCents += plan.monthlyBasePriceCents;
      }
    }
    const usageRows = await mapWithConcurrency(activeRows, 10, async (row) => {
      const plan = planMap.get(row.subscription.planId) ?? null;
      const monthly = await billing.listMonthly(row.orgId, billingMonth);
      return {
        orgId: row.orgId,
        orgName: row.orgName,
        usage: aggregateMonthly(monthly),
        plan,
        subscription: row.subscription,
      };
    });

    let projectedOverageCents = 0;
    const nearCapOrgs: Array<{
      orgId: string;
      projectedCostCents: number;
      spendCapCents: number;
    }> = [];
    for (const row of usageRows) {
      if (row.plan === null) continue;
      const bill = calculateMonthlyBill(row.plan, row.usage);
      projectedOverageCents += bill.overageAmountCents;
      const cap = row.subscription.monthlySpendCapCents;
      if (cap !== null && bill.totalAmountCents * 100 >= cap * 80) {
        nearCapOrgs.push({
          orgId: row.orgId,
          projectedCostCents: bill.totalAmountCents,
          spendCapCents: cap,
        });
      }
    }
    nearCapOrgs.sort((a, b) => b.projectedCostCents - a.projectedCostCents);

    const topBy = (metric: "docReads" | "docWrites" | "egressBytes") =>
      usageRows
        .map((row) => ({ orgId: row.orgId, orgName: row.orgName, value: row.usage[metric] }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 10);

    return c.json({
      billingMonth,
      mrrCents,
      projectedOverageCents,
      activeSubscriptions,
      topOrgs: {
        reads: topBy("docReads"),
        writes: topBy("docWrites"),
        egress: topBy("egressBytes"),
      },
      nearCapOrgs: nearCapOrgs.slice(0, 20),
    });
  });

  routes.get("/admin/billing/orgs", async (c) => {
    const billingMonth = currentBillingMonth();
    const rows = await listSubscriptionRows(platform);
    const plans = await billing.listPlans();
    const planMap = new Map<string, BillingPlanRecord>();
    for (const plan of plans) planMap.set(plan.id, plan);

    const orgs = await mapWithConcurrency(rows, 10, async (row) => {
      const plan = planMap.get(row.subscription.planId) ?? null;
      const monthly = await billing.listMonthly(row.orgId, billingMonth);
      const usage = aggregateMonthly(monthly);
      const bill = plan === null ? null : calculateMonthlyBill(plan, usage);
      return {
        orgId: row.orgId,
        orgName: row.orgName,
        planId: row.subscription.planId,
        planName: plan?.name ?? row.subscription.planId,
        status: row.subscription.status,
        monthlySpendCapCents: row.subscription.monthlySpendCapCents,
        quotaOverride: row.subscription.quotaOverride,
        usage,
        totalCents: bill?.totalAmountCents ?? 0,
        overageCents: bill?.overageAmountCents ?? 0,
      };
    });
    return c.json({ billingMonth, orgs });
  });

  routes.patch("/admin/billing/orgs/:orgId/override", async (c) => {
    const orgId = c.req.param("orgId");
    const claims = requireClaims(c);
    const parsed = parseOrThrow(OrgOverrideSchema, await jsonBody(c), "organization override");
    const current =
      (await billing.getSubscription(orgId)) ?? (await billing.ensureSubscription(orgId));

    const patch: SubscriptionPatchRecord = {};
    if (parsed.planId !== undefined) patch.planId = parsed.planId;
    if (parsed.status !== undefined) patch.status = parsed.status;
    if (parsed.monthlySpendCapCents !== undefined) {
      patch.monthlySpendCapCents = parsed.monthlySpendCapCents;
    }
    if (parsed.quotaOverride !== undefined) patch.quotaOverride = parsed.quotaOverride;
    const updated = (await billing.updateSubscription(orgId, patch)) ?? current;
    quota.invalidate(orgId);

    let adjustmentAppended = false;
    if (parsed.adjustmentAmountCents !== undefined) {
      const billingMonth = currentBillingMonth();
      const ledgerRows = await billing.listLedger();
      let maxSeq = 0;
      for (const row of ledgerRows) maxSeq = Math.max(maxSeq, row.seq);
      const prevHash = (await billing.getLastLedgerHash()) ?? GENESIS_HASH;
      const timestampIso = new Date().toISOString();
      const description = parsed.adjustmentDescription ?? "Platform administrator adjustment";
      const payload: Record<string, unknown> = {
        kind: "admin_adjustment",
        orgId,
        billingMonth,
        amountCents: parsed.adjustmentAmountCents,
        description,
        actorId: claims.uid,
        timestampIso,
      };
      const entryHash = computeChainHash(
        platform.chainKeys.billing,
        maxSeq + 1,
        prevHash,
        timestampIso,
        payload
      );
      await billing.appendLedgerEntry({
        orgId,
        billingMonth,
        entryType: "admin_adjustment",
        amountCents: parsed.adjustmentAmountCents,
        metricSnapshot: payload,
        idempotencyKey: `admin-adjustment:${randomUUID()}`,
        description,
        prevHash,
        entryHash,
      });
      adjustmentAppended = true;
    }

    await appendSecurityAudit(platform, {
      actorRealm: "super_admin",
      actorId: claims.uid,
      orgId,
      action: "billing.org.override",
      resourceType: "organization_subscription",
      resourceId: orgId,
      outcome: "success",
      details: {
        kind: "admin_adjustment",
        orgId,
        actorId: claims.uid,
        previousPlanId: current.planId,
        planId: updated.planId,
        status: updated.status,
        monthlySpendCapCents: updated.monthlySpendCapCents,
        quotaOverrideUpdated: parsed.quotaOverride !== undefined,
        adjustmentApplied: adjustmentAppended,
      },
      ...requestMeta(c),
    });

    return c.json({ subscription: updated, adjustmentAppended });
  });

  routes.post("/admin/billing/invoices/generate", async (c) => {
    const parsed = parseOrThrow(
      InvoiceGenerateSchema,
      await jsonBody(c),
      "invoice generation request"
    );
    const { billingMonth } = parsed;
    const subscriptions = await listSubscriptionRows(platform);
    const invoices: InvoiceRecord[] = [];
    const failed: Array<{ orgId: string; reason: string }> = [];

    for (const row of subscriptions) {
      try {
        const invoice = await generateMonthlyInvoice(row.orgId, billingMonth, {
          billing,
          chainKey: platform.chainKeys.billing,
        });
        invoices.push(invoice);
      } catch (err) {
        failed.push({
          orgId: row.orgId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const claims = requireClaims(c);
    await appendSecurityAudit(platform, {
      actorRealm: "super_admin",
      actorId: claims.uid,
      action: "billing.invoices.generate",
      resourceType: "billing_invoice",
      resourceId: billingMonth,
      outcome: failed.length === 0 ? "success" : "error",
      details: {
        kind: "invoice_generation",
        billingMonth,
        generated: invoices.length,
        failed: failed.length,
        actorId: claims.uid,
      },
      ...requestMeta(c),
    });

    return c.json({ billingMonth, invoices, failed });
  });

  routes.post("/admin/billing/ledger/verify-chain", async (c) => {
    const rows = await billing.listLedger();
    const chainRows: ChainRow[] = rows.map((row) => {
      // The flusher signs the snapshot WITHOUT the `timestampIso` convenience
      // field it stores alongside it. Reconstruct the exact signed payload or
      // every canonical chain reports a false entry_hash_mismatch.
      const snapshot: Record<string, unknown> = { ...row.metricSnapshot };
      const timestampIso = chainTimestamp(snapshot, row.createdAt);
      delete snapshot["timestampIso"];
      return {
        seq: row.seq,
        prevHash: row.prevHash,
        entryHash: row.entryHash,
        timestampIso,
        payload: snapshot,
      };
    });
    return c.json(verifyHashChain(platform.chainKeys.billing, chainRows));
  });

  return routes;
}
