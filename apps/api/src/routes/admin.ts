/**
 * @vellum/api - Platform Owner & Operator Admin REST Routes (`apps/api/src/routes/admin.ts`)
 * Provides:
 *   - First-time Master Owner Setup (`/v1/admin/setup-status` & `/v1/admin/setup-owner`)
 *   - Operator Authentication (`/v1/admin/login`)
 *   - Real Cluster Telemetry & Node Health (`/v1/admin/overview`)
 *   - Multi-Tenant Directory & Lifecycle (`/v1/admin/tenants`)
 *   - Tenant Suspension & Reactivation (`/v1/admin/tenants/:orgId/suspend`)
 *   - Immutable Audit Logs Explorer (`/v1/admin/audit-logs`)
 *   - Dynamic Feature Flags Management (`/v1/admin/features`)
 *
 * every read/mutation route now requires a verified session JWT.
 * Tokens issued by login/setup are real HS256 session tokens from the shared
 * `createSessionService` implementation — never random `adm_jwt_*` strings.
 */

import { adminRuntimeTelemetry } from "../admin-runtime-telemetry.js";
import { readTenantSecurity } from "./admin-metadata.js";
import { Hono, type Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import { VellumError } from "@vellum/core";
import { getConfig } from "../config.js";
import type { Role, SessionService } from "@vellum/authorization";
import type { ControlPlaneRepository } from "@vellum/database-control";
import type { StorageAdapter } from "@vellum/storage";
import {
  ADMIN_REFRESH_COOKIE,
  hashPassword,
  issueControlTokens,
  setRefreshCookie,
  verifyPassword,
} from "./auth-endpoints.js";
import { getUserOrgIds, requireSession } from "../middleware/session.js";
import { extractClientIp } from "../middleware/security.js";
import {
  aggregateTenantUsage,
  deleteFeatureFlagRecord,
  getQueryPool,
  queryAuditLogs,
  readClusterTelemetry,
  readOrganizationUsage,
  type AuditLogQuery,
} from "./usage.js";

function hasFeatureFlagsMap(store: object): store is { featureFlags: Map<string, unknown> } {
  return "featureFlags" in store && store.featureFlags instanceof Map;
}

const OPERATOR_ROLES: readonly Role[] = ["owner", "admin", "support_readonly"];
const OPERATOR_WRITE_ROLES: readonly Role[] = ["owner", "admin"];

/** Hermetic-mode password store (mirrors `users.password_hash` in postgres mode). */
const operatorPasswords = new Map<string, string>();

/**
 * Keys that must never leave an admin response, at any nesting depth. Covers
 * password/token hashes, encrypted signing keys, encrypted OAuth/SMTP secrets
 * and API-key digests. (The document-privacy guard is kept below.)
 */
const FORBIDDEN_SECRET_KEYS: ReadonlySet<string> = new Set([
  "passwordHash",
  "jwtPrivateKeyEncrypted",
  "secretEncrypted",
  "refreshTokenHash",
  "previousRefreshTokenHash",
  "clientSecretEncrypted",
  "appleRefreshTokenEncrypted",
  "platformSmtpPassEncrypted",
  "apiKeySecretHash",
  "secretHash",
]);

/**
 * Privacy invariant: platform operators may see tenant metadata,
 * quotas, indexes and audit logs, but NEVER a customer `documents.data` payload.
 * Every admin response passes through this recursive guard before serialization.
 */
export function sanitizeAdminPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAdminPayload);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();

  const source = value as Record<string, unknown>;
  const looksLikeDocument =
    typeof source["path"] === "string" ||
    typeof source["collectionPath"] === "string" ||
    typeof source["documentId"] === "string" ||
    typeof source["version"] === "number";
  const result: Record<string, unknown> = {};
  const flags: Record<string, boolean> = {};
  for (const [key, child] of Object.entries(source)) {
    if (looksLikeDocument && (key === "data" || key === "beforeData" || key === "afterData")) {
      continue;
    }
    if (key === "beforeData" || key === "afterData") continue;
    if (FORBIDDEN_SECRET_KEYS.has(key)) {
      // Replace a stripped secret with a safe presence flag where useful.
      // Arrays never receive flags — they are sanitized element-wise above.
      if (!Array.isArray(child) && child !== null && child !== undefined) {
        if (key === "clientSecretEncrypted") flags["hasClientSecret"] = true;
        if (key === "jwtPrivateKeyEncrypted") flags["hasPrivateKey"] = true;
      }
      continue;
    }
    result[key] = sanitizeAdminPayload(child);
  }
  return { ...result, ...flags };
}

/** Thin adapter: sanitize then serialize. */
function safeJson(c: Context, payload: unknown, status?: 200 | 201) {
  const clean = sanitizeAdminPayload(payload);
  return status === undefined ? c.json(clean) : c.json(clean, status);
}

export function createAdminRoutes(
  controlStore: ControlPlaneRepository,
  dataStore: StorageAdapter,
  sessionService: SessionService,
  superAdminSessionService: SessionService = sessionService,
  options: { setupToken?: string; requireSetupToken?: boolean } = {}
) {
  const routes = new Hono();
  const config = getConfig();
  const setupToken = options.setupToken ?? config.ADMIN_SETUP_TOKEN;
  // Production always requires the one-time secret: an anonymous visitor must
  // never be able to claim the Master Owner role, even on a brand-new database.
  const requireSetupToken =
    options.requireSetupToken ?? (config.NODE_ENV === "production" || Boolean(setupToken));

  // Platform operator endpoints are guarded by the Super Admin realm service.
  const requireOperator = requireSession(superAdminSessionService, OPERATOR_ROLES);
  const requireOperatorWrite = requireSession(superAdminSessionService, OPERATOR_WRITE_ROLES);

  function getActorMetadata(c: Context) {
    return {
      ipAddress: extractClientIp(c),
      userAgent: c.req.header("user-agent") || "AdminConsole/2.0",
    };
  }

  /** Constant-time comparison; never branches on token contents. */
  function isSetupTokenValid(presented: string | undefined): boolean {
    if (!requireSetupToken || !setupToken || !presented) return false;
    const expected = Buffer.from(setupToken, "utf8");
    const actual = Buffer.from(presented, "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /**
   * Issue a realm-bound access token plus an opaque refresh token. Only the
   * SHA-256 hashes are persisted in `control_plane_refresh_sessions`; the raw
   * refresh token travels back in an HttpOnly cookie and the JSON body.
   */
  async function issueAdminSession(
    c: Context,
    user: { id: string; platformRole: string },
    orgIds: string[]
  ) {
    const role = user.platformRole as Role;
    const token = superAdminSessionService.signAccess({
      sub: user.id,
      uid: user.id,
      role,
      orgIds,
    });
    const tokens = issueControlTokens(token, ADMIN_REFRESH_COOKIE);
    const meta = getActorMetadata(c);
    await controlStore.createControlRefreshSession({
      userId: user.id,
      realm: "super_admin",
      accessTokenHash: tokens.accessTokenHash,
      refreshTokenHash: tokens.refreshTokenHash,
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    setRefreshCookie(c, tokens.refreshToken, ADMIN_REFRESH_COOKIE);
    return {
      token,
      accessToken: token,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.accessExpiresAt,
    };
  }

  // Operator views list tenants and users. The lists are mirrored per process, so every handler
  // that reads them re-reads PostgreSQL first. Operator traffic is low, and concurrent calls
  // share one refresh.
  const syncFromDb = async (): Promise<void> => {
    await controlStore.refresh?.();
  };

  // 1. First-Time Setup Status & Master Owner Initialization
  routes.get("/admin/setup-status", async (c) => {
    await syncFromDb();
    const allUsers = Array.from(controlStore.users.values());
    const owners = allUsers.filter((u) => u.platformRole === "owner");
    const requiresSetup = owners.length === 0;
    return safeJson(c, {
      initialized: owners.length > 0,
      requiresSetup,
      // The UI needs to know a secret is required, never the secret itself.
      tokenRequired: requiresSetup && requireSetupToken,
    });
  });

  routes.post("/admin/setup-owner", async (c) => {
    await syncFromDb();
    const allUsers = Array.from(controlStore.users.values());
    const existingOwners = allUsers.filter((u) => u.platformRole === "owner");
    if (existingOwners.length > 0) {
      throw new VellumError("ALREADY_EXISTS", "Platform Master Owner account is already initialized");
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      throw new VellumError("INVALID_ARGUMENT", "A JSON body is required to initialize the master owner");
    }

    if (requireSetupToken) {
      const presented = c.req.header("x-setup-token") ??
        (typeof body["setupToken"] === "string" ? body["setupToken"] : undefined);
      if (!isSetupTokenValid(presented)) {
        throw new VellumError(
          "UNAUTHENTICATED",
          "A valid one-time setup token is required to initialize the Master Owner",
          { reason: "INVALID_SETUP_TOKEN" }
        );
      }
    }

    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    const email = typeof body["email"] === "string" ? body["email"].trim().toLowerCase() : "";
    const password = typeof body["password"] === "string" ? body["password"] : "";

    if (!name || !email) {
      throw new VellumError("INVALID_ARGUMENT", "Name and email are required to initialize master owner");
    }
    if (password.length < 8) {
      throw new VellumError("INVALID_ARGUMENT", "Master owner password must be at least 8 characters");
    }

    const user = await controlStore.createUser({
      name,
      email,
      platformRole: "owner",
      emailVerified: true,
    });
    // The master owner is the only account that may hold super-admin realm
    // privileges. Never derive this from a client-supplied signup payload.
    await controlStore.setPlatformSuperAdmin(user.id, true);

    const pwdHash = await hashPassword(password);
    operatorPasswords.set(user.id, pwdHash);
    const pgPool = getQueryPool(controlStore);
    if (pgPool) {
      await pgPool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [pwdHash, user.id]);
    }

    const meta = getActorMetadata(c);
    await controlStore.recordAuditLog({
      action: "platform.owner.initialized",
      targetId: user.id,
      actorType: "owner",
      actorUserId: user.id,
      metadata: { email, name, platformRole: "owner" },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    const session = await issueAdminSession(c, user, []);
    return safeJson(
      c,
      {
        success: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          platformRole: "owner",
        },
        ...session,
      },
      201
    );
  });

  // 2. Operator Authentication
  routes.post("/admin/login", async (c) => {
    await syncFromDb();
    const body = await c.req.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    const allUsers = Array.from(controlStore.users.values());
    const user = allUsers.find((u) => u.email.toLowerCase() === email);

    // If no user exists and no owners exist at all, direct to setup
    if (!user) {
      const owners = allUsers.filter((u) => u.platformRole === "owner");
      if (owners.length === 0) {
        throw new VellumError("NOT_FOUND", "Platform not initialized. Please complete First-Time Setup.", {
          requiresSetup: true,
        });
      }
      throw new VellumError("UNAUTHENTICATED", "Invalid email or password");
    }

    if (!OPERATOR_ROLES.includes(user.platformRole as Role)) {
      throw new VellumError("PERMISSION_DENIED", "Access Denied: Platform operator role required");
    }

    if (user.isSuspended) {
      throw new VellumError("PERMISSION_DENIED", "Operator account has been suspended");
    }

    // no password hash ⇒ authentication fails. The previous
    // "set the password on first login" backdoor has been removed.
    let storedHash = operatorPasswords.get(user.id);
    const pgPool = getQueryPool(controlStore);
    if (!storedHash && pgPool) {
      const pwdRes = await pgPool.query("SELECT password_hash FROM users WHERE id = $1", [user.id]);
      const value = pwdRes.rows[0]?.["password_hash"];
      storedHash = typeof value === "string" ? value : undefined;
    }
    if (!password || !storedHash || !(await verifyPassword(password, storedHash))) {
      throw new VellumError("UNAUTHENTICATED", "Invalid email or password");
    }

    const orgIds = await getUserOrgIds(controlStore, user.id);
    const session = await issueAdminSession(c, user, orgIds);
    return safeJson(c, {
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        platformRole: user.platformRole,
      },
      ...session,
    });
  });

  // 3. Cluster Telemetry & Overview — all numbers from live PostgreSQL reads
  routes.get("/admin/overview", requireOperator, async (c) => {
    await syncFromDb();
    const orgs = Array.from(controlStore.organizations.values());
    const projects = Array.from(controlStore.projects.values());
    const keys = Array.from(controlStore.apiKeysById.values());
    const users = Array.from(controlStore.users.values());
    const live = await readClusterTelemetry(controlStore, dataStore);

    return safeJson(c, {
      status: "healthy",
      version: "0.0.7",
      tenantsCount: orgs.length,
      projectsCount: projects.length,
      keysCount: keys.length,
      usersCount: users.length,
      planes: {
        controlDb: live.telemetry.controlDb.maxConnections > 0 ? "connected" : "unknown",
        dataDb: live.telemetry.dataDb.maxConnections > 0 ? "connected" : "unknown",
      },
      metrics: live.metrics,
      nodes: live.nodes,
      telemetry: { ...live.telemetry, runtime: { ...adminRuntimeTelemetry }, observedAt: new Date().toISOString() },
    });
  });

  // 4. Multi-Tenant Directory — usage from project_usage_daily, never invented
  routes.get("/admin/tenants", requireOperator, async (c) => {
    await syncFromDb();
    const orgs = Array.from(controlStore.organizations.values());
    const projects = Array.from(controlStore.projects.values());
    const today = new Date().toISOString().slice(0, 10);
    const usageByOrg = await aggregateTenantUsage(controlStore, today);

    const tenants = orgs.map((org) => {
      const orgProjects = projects.filter((p) => p.organizationId === org.id);
      const usage = usageByOrg.get(org.id) ?? {
        documentReads: 0,
        documentWrites: 0,
        documentDeletes: 0,
        realtimeMessagesSent: 0,
        egressBytes: 0,
        storageBytes: 0,
      };
      return {
        id: org.id,
        name: org.name,
        slug: org.slug,
        billingEmail: org.billingEmail,
        plan: (org.planId || "free").toLowerCase(),
        status: (org.status || "active").toLowerCase(),
        storageMb: Math.round(usage.storageBytes / 1_048_576),
        dailyReads: usage.documentReads,
        dailyWrites: usage.documentWrites,
        projectsCount: orgProjects.length,
        createdAt: org.createdAt,
      };
    });

    return safeJson(c, tenants);
  });

  // 5. Tenant Details
  routes.get("/admin/tenants/:orgId", requireOperator, async (c) => {
    await syncFromDb();
    const orgId = c.req.param("orgId");
    const org = controlStore.organizations.get(orgId);
    if (!org) {
      throw new VellumError("NOT_FOUND", `Tenant '${orgId}' not found`);
    }

    const orgProjects = Array.from(controlStore.projects.values()).filter((p) => p.organizationId === org.id);
    const usage = await readOrganizationUsage(controlStore, org.id);
    const tenant = {
      id: org.id,
      name: org.name,
      slug: org.slug,
      billingEmail: org.billingEmail,
      plan: (org.planId || "free").toLowerCase(),
      status: (org.status || "active").toLowerCase(),
      storageMb: Math.round(usage.storageBytes / 1_048_576),
      dailyReads: usage.documentReads,
      dailyWrites: usage.documentWrites,
      projectsCount: orgProjects.length,
      createdAt: org.createdAt,
      // Metadata only — safeJson strips any document `data` payload defensively.
      projects: orgProjects,
    };

    return safeJson(c, tenant);
  });

  routes.get("/admin/tenants/:orgId/security-metadata", requireOperator, async (c) => {
    await syncFromDb();
    const orgId = c.req.param("orgId");
    if (!controlStore.organizations.has(orgId)) throw new VellumError("NOT_FOUND", "Tenant not found");
    const ids = [...controlStore.projects.values()].filter(p => p.organizationId === orgId).map(p => p.id);
    return safeJson(c, await readTenantSecurity(controlStore, ids));
  });

  // 6. Tenant Suspend / Reactivate
  routes.post("/admin/tenants/:orgId/suspend", requireOperatorWrite, async (c) => {
    await syncFromDb();
    const orgId = c.req.param("orgId");
    const org = controlStore.organizations.get(orgId);
    if (!org) {
      throw new VellumError("NOT_FOUND", `Tenant '${orgId}' not found`);
    }

    org.status = "suspended";
    const meta = getActorMetadata(c);
    const session = c.get("session");
    await controlStore.recordAuditLog({
      action: "tenant.suspended",
      targetId: org.id,
      organizationId: org.id,
      actorType: "operator",
      actorUserId: session?.uid ?? null,
      metadata: { slug: org.slug, status: "suspended" },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return safeJson(c, { success: true, status: "suspended" });
  });

  routes.post("/admin/tenants/:orgId/reactivate", requireOperatorWrite, async (c) => {
    await syncFromDb();
    const orgId = c.req.param("orgId");
    const org = controlStore.organizations.get(orgId);
    if (!org) {
      throw new VellumError("NOT_FOUND", `Tenant '${orgId}' not found`);
    }

    org.status = "active";
    const meta = getActorMetadata(c);
    const session = c.get("session");
    await controlStore.recordAuditLog({
      action: "tenant.reactivated",
      targetId: org.id,
      organizationId: org.id,
      actorType: "operator",
      actorUserId: session?.uid ?? null,
      metadata: { slug: org.slug, status: "active" },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return safeJson(c, { success: true, status: "active" });
  });

  // 7. Immutable Audit Logs — server-side filtering + keyset pagination
  const toAuditView = (log: {
    id: string;
    createdAt: string;
    actorUserId: string | null;
    actorType: string;
    action: string;
    organizationId: string | null;
    projectId: string | null;
    targetId: string | null;
    metadata: Record<string, unknown>;
  }) => ({
    id: log.id,
    timestamp: log.createdAt,
    actorUserId: log.actorUserId || "usr_system",
    actorType: log.actorType,
    action: log.action,
    category: log.action.startsWith("tenant")
      ? "lifecycle"
      : log.action.startsWith("platform") || log.action.startsWith("api_key") || log.action.startsWith("feature_flag")
        ? "security"
        : "operator",
    organizationId: log.organizationId || "org_global",
    projectId: log.projectId || "proj_global",
    targetId: log.targetId || "target_global",
    metadata: log.metadata || {},
  });

  routes.get("/admin/audit-logs", requireOperator, async (c) => {
    const url = new URL(c.req.url);
    const param = (name: string): string | null => url.searchParams.get(name);
    const limitRaw = Number(param("limit"));
    const filters: AuditLogQuery = {
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50,
      cursor: param("cursor"),
      action: param("action"),
      actorUserId: param("actorUserId"),
      organizationId: param("organizationId"),
      projectId: param("projectId"),
      from: param("from"),
      to: param("to"),
    };
    const page = await queryAuditLogs(controlStore, filters);
    const items = page.logs.map(toAuditView);

    // Backward-compatible array response (the admin UI reads an array). Paging
    // metadata is always available as headers; `?envelope=true` opts into a
    // structured body for new clients.
    c.header("X-Total-Count", String(page.total));
    c.header("X-Has-More", String(page.hasMore));
    if (page.nextCursor) c.header("X-Next-Cursor", page.nextCursor);
    if (param("envelope") === "true") {
      return safeJson(c, {
        items,
        total: page.total,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    }
    return safeJson(c, items);
  });

  routes.get("/admin/audit-export", requireOperator, async (c) => {
    const from = c.req.query("from") || null;
    const to = c.req.query("to") || new Date().toISOString();
    if ((from && !Number.isFinite(Date.parse(from))) || !Number.isFinite(Date.parse(to))) {
      throw new VellumError("INVALID_ARGUMENT", "Invalid export date range");
    }
    let cursor: string | null = null;
    const rows: ReturnType<typeof toAuditView>[] = [];
    do {
      const page = await queryAuditLogs(controlStore, { from, to, cursor, limit: 500 });
      rows.push(...page.logs.map(toAuditView));
      cursor = page.hasMore ? page.nextCursor : null;
      if (cursor && rows.length >= 10000) throw new VellumError("INVALID_ARGUMENT", "Narrow the export date range (maximum 10000 events)");
    } while (cursor);
    const query = (c.req.query("q") || "").toLowerCase();
    const actor = c.req.query("actor") || "all";
    const category = c.req.query("category") || "all";
    const items = rows.filter(log => (actor === "all" || log.actorType === actor) &&
      (category === "all" || log.category === category) &&
      [log.action,log.organizationId,log.actorUserId,log.targetId].some(v=>v.toLowerCase().includes(query)));
    return safeJson(c, {
      exportedAt: new Date().toISOString(), scope: { source: "audit_logs", from, to, query, actor, category },
      integrity: { status: "not_available", reason: "audit_logs has no cryptographic hash chain. Security Center verifies the separate security_audit_logs chain; that proof does not verify these rows." },
      count: items.length, items,
    });
  });

  // 8. Feature Flags — PostgreSQL-backed CRUD with audit logging
  async function flagExists(key: string): Promise<boolean> {
    if (hasFeatureFlagsMap(controlStore)) return controlStore.featureFlags.has(key);
    return (await controlStore.listFeatureFlags()).some((flag) => flag.key === key);
  }

  async function upsertFlag(c: Context, keyOverride?: string) {
    const body = await c.req.json();
    const rawKey = keyOverride ?? (typeof body.key === "string" ? body.key : "");
    const key = rawKey.trim();
    if (!key) {
      throw new VellumError("INVALID_ARGUMENT", "Feature flag 'key' is required");
    }
    const created = !(await flagExists(key));
    const session = c.get("session");
    const flag = await controlStore.setFeatureFlag({
      key,
      description: typeof body.description === "string" ? body.description : "",
      enabled: Boolean(body.enabled),
      rolloutPercent: typeof body.rolloutPercent === "number" ? body.rolloutPercent : 100,
      updatedBy: session?.uid ?? null,
    });

    const meta = getActorMetadata(c);
    await controlStore.recordAuditLog({
      action: created ? "feature_flag.created" : "feature_flag.updated",
      targetId: key,
      actorType: "operator",
      actorUserId: session?.uid ?? null,
      metadata: { key, enabled: flag.enabled, rolloutPercent: flag.rolloutPercent },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return safeJson(c, flag, created ? 201 : 200);
  }

  routes.get("/admin/features", requireOperator, async (c) => {
    const flags = await controlStore.listFeatureFlags();
    return safeJson(c, flags);
  });

  routes.get("/admin/features/:key", requireOperator, async (c) => {
    const key = c.req.param("key");
    const flag = (await controlStore.listFeatureFlags()).find((item) => item.key === key);
    if (!flag) throw new VellumError("NOT_FOUND", `Feature flag '${key}' not found`);
    return safeJson(c, flag);
  });

  routes.post("/admin/features", requireOperatorWrite, (c) => upsertFlag(c));
  routes.put("/admin/features/:key", requireOperatorWrite, (c) => upsertFlag(c, c.req.param("key")));
  routes.patch("/admin/features/:key", requireOperatorWrite, async (c) => {
    const body = await c.req.json();
    const key = c.req.param("key");
    const existing = (await controlStore.listFeatureFlags()).find((item) => item.key === key);
    const flag = await controlStore.setFeatureFlag({
      key,
      description: typeof body.description === "string" ? body.description : (existing?.description ?? ""),
      enabled: typeof body.enabled === "boolean" ? body.enabled : (existing?.enabled ?? false),
      rolloutPercent:
        typeof body.rolloutPercent === "number" ? body.rolloutPercent : (existing?.rolloutPercent ?? 100),
      updatedBy: c.get("session")?.uid ?? null,
    });
    const meta = getActorMetadata(c);
    await controlStore.recordAuditLog({
      action: "feature_flag.updated",
      targetId: key,
      actorType: "operator",
      actorUserId: c.get("session")?.uid ?? null,
      metadata: { key, enabled: flag.enabled, rolloutPercent: flag.rolloutPercent },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return safeJson(c, flag);
  });

  routes.delete("/admin/features/:key", requireOperatorWrite, async (c) => {
    const key = c.req.param("key");
    const deleted = await deleteFeatureFlagRecord(controlStore, key, c.get("session")?.uid ?? null);
    if (!deleted) throw new VellumError("NOT_FOUND", `Feature flag '${key}' not found`);
    const meta = getActorMetadata(c);
    await controlStore.recordAuditLog({
      action: "feature_flag.deleted",
      targetId: key,
      actorType: "operator",
      actorUserId: c.get("session")?.uid ?? null,
      metadata: { key },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return safeJson(c, { deleted: true, key });
  });

  return routes;
}
