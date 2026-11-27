/**
 * @vellum/api - Control Plane REST Routes
 * Manages Organizations, Projects, API Keys, Security Rulesets,
 * and records immutable audit logs for all mutations.
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { VellumError } from "@vellum/core";
import {
  CreateOrganizationRequestSchema,
  CreateProjectRequestSchema,
  CreateApiKeyRequestSchema,
  UpdateRulesetRequestSchema,
  UpdateRelationRulesRequestSchema,
} from "@vellum/api-contract";
import { generateProjectApiKey } from "@vellum/authorization";
import { validateSecurityRulesetAst } from "@vellum/authorization";
import type { SessionService } from "@vellum/authorization";
import type { ControlPlaneRepository } from "@vellum/database-control";
import { loadProject } from "../project-lookup.js";
import {
  getCacheInvalidationBus,
  invalidateApiKeyCache,
  invalidateRelationRulesCache,
  invalidateRulesetCache,
} from "@vellum/storage";

async function publishInvalidation(kind: "api_key" | "ruleset" | "relation_rules", key: string): Promise<void> {
  if (kind === "api_key") invalidateApiKeyCache(key);
  else if (kind === "ruleset") invalidateRulesetCache(key);
  else invalidateRelationRulesCache(key);
  const bus = getCacheInvalidationBus();
  if (bus) await bus.publish({ kind, key }).catch(() => undefined);
}
import {
  assertOrgAccess,
  assertProjectAccess,
  getSession,
  getUserOrgMemberships,
  optionalRealmSession,
  optionalSession,
  requireRealmSession,
} from "../middleware/session.js";
import { extractClientIp } from "../middleware/security.js";

export function createControlPlaneRoutes(
  controlStore: ControlPlaneRepository,
  sessionService: SessionService,
  superAdminSessionService?: SessionService,
  apiKeyPepper?: string
) {
  const routes = new Hono();

  // Legacy routes remain callable without a session for backward compatibility,
  // but any token that IS presented must be valid (fail closed). Applied per
  // route — a sub-app `use("*")` would leak onto /v1/health, /v1/auth and the
  // document plane after mounting at /v1.
  // Super-admin operators read the same project metadata from
  // /admin, so accept either realm token on these shared read-only routes.
  // Anonymous callers are only tolerated outside production (local dev, tests,
  // examples). In production a valid session is mandatory: an unauthenticated
  // caller could otherwise list tenants and mint secret API keys for any
  // project. Evaluated per request so the NODE_ENV guard cannot be bypassed by
  // module load order.
  const lenientGuard = superAdminSessionService
    ? optionalRealmSession(sessionService, superAdminSessionService)
    : optionalSession(sessionService);
  const strictGuard = requireRealmSession(sessionService, superAdminSessionService);
  // Fail closed: anonymous access is allowed only when the process says it is a test or development
  // one (or the operator opts in). An unset or unexpected NODE_ENV must not open the control plane.
  const sessionGuard: MiddlewareHandler = (c, next) => {
    const env = process.env["NODE_ENV"];
    const anonymousAllowed =
      env === "test" || env === "development" || process.env["VELLUM_ALLOW_ANONYMOUS_CONTROL_PLANE"] === "1";
    return (anonymousAllowed ? lenientGuard : strictGuard)(c, next);
  };

  // Helper to extract actor metadata for audit logs
  function getActorMetadata(c: Context) {
    return {
      ipAddress: extractClientIp(c),
      userAgent: c.req.header("user-agent") || null,
    };
  }

  // 1. Organizations
  routes.post("/organizations", sessionGuard, async (c) => {
    const body = await c.req.json();
    const parsed = CreateOrganizationRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new VellumError("INVALID_ARGUMENT", (parsed as Extract<typeof parsed, { success: false }>).error.issues[0]?.message ?? "Invalid organization data", {
        issues: (parsed as Extract<typeof parsed, { success: false }>).error.issues,
      });
    }

    const { name, slug, planTier } = parsed.data;
    const session = getSession(c);
    // Paid plans are not self-serve until online billing is enabled: only a platform admin can
    // create an organization on one. Otherwise any customer could grant themselves "enterprise".
    if (planTier !== "free" && session !== undefined && session.realm !== "super_admin") {
      throw new VellumError("PERMISSION_DENIED", "Paid plans are assigned by a platform admin. Create the organization on the free plan.");
    }
    const org = await controlStore.createOrganization({
      slug,
      name,
      billingEmail: body.billingEmail ?? `${slug}@example.com`,
      planId: planTier,
      // Without this the creator cannot see the new organization: the GET list
      // filters customer sessions by organization membership.
      ownerUserId: session?.uid ?? null,
    });

    const meta = getActorMetadata(c);
    await controlStore.recordAuditLog({
      action: "organization.created",
      targetId: org.id,
      organizationId: org.id,
      actorType: session ? "customer" : "system",
      actorUserId: session?.uid ?? null,
      metadata: { slug, name, planTier },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return c.json(org, 201);
  });

  routes.get("/organizations", sessionGuard, async (c) => {
    let orgs = Array.from(controlStore.organizations.values());
    const session = getSession(c);
    if (session && session.role !== "owner" && session.role !== "admin") {
      // never leak the full tenant directory to a customer session.
      const memberOrgIds = new Set((await getUserOrgMemberships(controlStore, session.uid)).map((m) => m.organizationId));
      orgs = orgs.filter((org) => memberOrgIds.has(org.id));
    }
    return c.json(orgs);
  });

  // 2. Projects
  routes.post("/organizations/:orgId/projects", sessionGuard, async (c) => {
    const orgId = c.req.param("orgId");
    const body = await c.req.json();
    const parsed = CreateProjectRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new VellumError("INVALID_ARGUMENT", (parsed as Extract<typeof parsed, { success: false }>).error.issues[0]?.message ?? "Invalid project data", {
        issues: (parsed as Extract<typeof parsed, { success: false }>).error.issues,
      });
    }

    const session = getSession(c);
    if (session) {
      await assertOrgAccess(controlStore, session, orgId, { write: true });
    }

    const { name, slug } = parsed.data;
    const { project } = await controlStore.createProject({
      organizationId: orgId,
      slug,
      name,
    });

    const meta = getActorMetadata(c);
    await controlStore.recordAuditLog({
      action: "project.created",
      targetId: project.id,
      organizationId: orgId,
      projectId: project.id,
      metadata: { slug, name },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return c.json({ project }, 201);
  });

  routes.get("/organizations/:orgId/projects", sessionGuard, async (c) => {
    const orgId = c.req.param("orgId");
    const session = getSession(c);
    if (session) {
      await assertOrgAccess(controlStore, session, orgId);
    }
    const projects = Array.from(controlStore.projects.values()).filter((p) => p.organizationId === orgId);
    return c.json(projects);
  });

  // 3. API Keys
  routes.post("/projects/:projectId/api-keys", sessionGuard, async (c) => {
    const projectId = c.req.param("projectId");
    const body = await c.req.json();
    const parsed = CreateApiKeyRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new VellumError("INVALID_ARGUMENT", (parsed as Extract<typeof parsed, { success: false }>).error.issues[0]?.message ?? "Invalid API key data", {
        issues: (parsed as Extract<typeof parsed, { success: false }>).error.issues,
      });
    }

    const { name, keyType, expiresAt, isDev } = parsed.data;
    if (isDev && keyType !== "publishable") {
      throw new VellumError("INVALID_ARGUMENT", "Only publishable keys can be flagged as development keys");
    }

    const keySession = getSession(c);
    if (keySession) {
      await assertProjectAccess(controlStore, keySession, projectId, { write: true });
    }

    const generated = generateProjectApiKey({
      keyType: keyType === "secret" ? "server" : "public",
      pepper: apiKeyPepper,
    });

    const apiKeyRecord = await controlStore.registerApiKey({
      projectId,
      name,
      keyType: keyType === "secret" ? "server" : "public",
      keyPrefix: generated.keyPrefix,
      secretHash: generated.secretHash,
      scopes: keyType === "secret" ? ["documents:read", "documents:write", "indexes:manage"] : ["documents:read", "documents:write"],
      expiresAt: expiresAt ?? null,
      isDev: keyType === "publishable" ? (isDev ?? false) : false,
    });
    await publishInvalidation("api_key", generated.keyPrefix);

    const meta = getActorMetadata(c);
    await controlStore.recordAuditLog({
      action: "api_key.created",
      targetId: apiKeyRecord.id,
      projectId,
      metadata: { keyPrefix: generated.keyPrefix, keyType, name },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    const { secretHash: _createdSecretHash, ...safeApiKey } = apiKeyRecord;
    return c.json(
      {
        apiKey: safeApiKey,
        rawKey: generated.fullKey,
      },
      201
    );
  });

  routes.get("/projects/:projectId/api-keys", sessionGuard, async (c) => {
    const projectId = c.req.param("projectId");
    const listSession = getSession(c);
    if (listSession) {
      await assertProjectAccess(controlStore, listSession, projectId);
    }

    const keys = await controlStore.listProjectApiKeys(projectId);
    return c.json(keys.map(({ secretHash: _secretHash, ...key }) => key));
  });

  routes.delete("/projects/:projectId/api-keys/:keyId", sessionGuard, async (c) => {
    const projectId = c.req.param("projectId");
    const keyId = c.req.param("keyId");

    // validate that the key actually belongs to the addressed
    // project before revoking it. Previously any key in the store could be
    // revoked by ID, enabling cross-tenant revocation.
    const project = await loadProject(controlStore, projectId);
    const existing = await controlStore.findApiKeyById(keyId);
    if (!existing) {
      throw new VellumError("NOT_FOUND", `API key '${keyId}' not found`);
    }
    if (existing.projectId !== projectId) {
      throw new VellumError(
        "PERMISSION_DENIED",
        "API key does not belong to the requested project",
        { keyId, projectId }
      );
    }

    const session = getSession(c);
    if (session) {
      await assertOrgAccess(controlStore, session, project.organizationId, { write: true });
    }

    const revoked = await controlStore.revokeApiKey(keyId, session?.uid ?? null);
    await publishInvalidation("api_key", revoked.keyPrefix);

    const meta = getActorMetadata(c);
    await controlStore.recordAuditLog({
      action: "api_key.revoked",
      targetId: keyId,
      organizationId: project.organizationId,
      projectId,
      actorType: session ? "customer" : "system",
      actorUserId: session?.uid ?? null,
      metadata: { keyPrefix: revoked.keyPrefix },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    const { secretHash: _revokedSecretHash, ...safeRevoked } = revoked;
    return c.json({ success: true, revoked: safeRevoked });
  });

  // 4. Security Rulesets
  routes.post("/projects/:projectId/rulesets", sessionGuard, async (c) => {
    const projectId = c.req.param("projectId");

    const body = await c.req.json();
    const parsed = UpdateRulesetRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new VellumError("INVALID_ARGUMENT", (parsed as Extract<typeof parsed, { success: false }>).error.issues[0]?.message ?? "Invalid ruleset data", {
        issues: (parsed as Extract<typeof parsed, { success: false }>).error.issues,
      });
    }

    const rulesSession = getSession(c);
    if (rulesSession) {
      await assertProjectAccess(controlStore, rulesSession, projectId, { write: true });
    }

    const { rulesAst } = parsed.data;
    validateSecurityRulesetAst(rulesAst);

    const published = await controlStore.publishSecurityRuleset({
      projectId,
      rulesAst,
    });
    await publishInvalidation("ruleset", published.id);

    const meta = getActorMetadata(c);
    await controlStore.recordAuditLog({
      action: "ruleset.published",
      targetId: published.id,
      projectId,
      metadata: { version: published.version },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return c.json(published, 201);
  });

  routes.get("/projects/:projectId/rulesets", sessionGuard, async (c) => {
    const projectId = c.req.param("projectId");
    const getRulesSession = getSession(c);
    if (getRulesSession) {
      await assertProjectAccess(controlStore, getRulesSession, projectId);
    }

    const active = await controlStore.getActiveRulesetAsync(projectId);
    if (!active) {
      return c.json({
        id: `default_${projectId}`,
        projectId,
        version: 1,
        rulesAst: {
          schemaVersion: "1.0",
          rules: [
            {
              pattern: ".*",
              allow: { op: "==", left: { var: "auth.uid" }, right: { var: "resource.ownerId" } },
            },
          ],
        },
        publishedAt: new Date().toISOString(),
      });
    }
    return c.json(active);
  });

  // 5. Relation Rules (referential integrity: cascade / set_null / restrict).
  // These routes mutate or expose project integrity configuration, so unlike
  // the legacy read-only metadata routes they REQUIRE a valid session from
  // either realm — an absent token is rejected, not passed through.
  const relationRulesGuard = requireRealmSession(sessionService, superAdminSessionService);
  routes.get("/projects/:projectId/relation-rules", relationRulesGuard, async (c) => {
    const projectId = c.req.param("projectId");
    const project = await loadProject(controlStore, projectId);
    const session = getSession(c);
    if (session) {
      await assertOrgAccess(controlStore, session, project.organizationId);
    }
    const rules = await controlStore.getRelationRulesAsync(projectId);
    const version = await controlStore.getRelationRulesVersionAsync(projectId);
    return c.json({ projectId, version, rules });
  });

  routes.put("/projects/:projectId/relation-rules", relationRulesGuard, async (c) => {
    const projectId = c.req.param("projectId");
    const project = await loadProject(controlStore, projectId);

    const body = await c.req.json();
    const parsed = UpdateRelationRulesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new VellumError("INVALID_ARGUMENT", (parsed as Extract<typeof parsed, { success: false }>).error.issues[0]?.message ?? "Invalid relation rules data", {
        issues: (parsed as Extract<typeof parsed, { success: false }>).error.issues,
      });
    }

    const session = getSession(c);
    if (session) {
      await assertOrgAccess(controlStore, session, project.organizationId, { write: true });
    }

    // Optimistic concurrency: body expectedVersion wins; an If-Match header
    // (ETag-style integer) is accepted as the transport-level equivalent.
    const ifMatch = c.req.header("if-match");
    const headerVersion = ifMatch !== undefined && /^\d+$/.test(ifMatch.trim())
      ? Number(ifMatch.trim())
      : null;
    const expectedVersion = parsed.data.expectedVersion ?? headerVersion;

    const snapshot = await controlStore.replaceRelationRules({
      projectId,
      rules: parsed.data.rules,
      expectedVersion,
      createdBy: session?.uid ?? null,
    });
    await publishInvalidation("relation_rules", projectId);

    const meta = getActorMetadata(c);
    await controlStore.recordAuditLog({
      action: "relation_rules.replaced",
      targetId: projectId,
      organizationId: project.organizationId,
      projectId,
      actorType: session ? "customer" : "system",
      actorUserId: session?.uid ?? null,
      metadata: { version: snapshot.version, ruleCount: snapshot.rules.length },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return c.json(snapshot);
  });

  return routes;
}
