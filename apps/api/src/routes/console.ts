/**
 * @vellum/api - Session-authenticated Console API (`/v1/console/...`) 
 *
 * The customer dashboard uses these routes instead of master API keys.
 * Every request requires a valid session JWT (single shared `SessionService`),
 * an organization-membership check, and an immutable audit-log entry for
 * mutations. All business logic delegates to `DocumentEngine` / control store;
 * no rules evaluation, SQL, or wire serialization is implemented here.
 */

import { listIndexesReconciled, refreshIndexRecord } from "../index-build.js";
import { Hono, type Context } from "hono";
import { VellumError, SYSTEM_LIMITS, normalizeIndexFieldSpec, parseCollectionPath } from "@vellum/core";
import {
  CreateCollectionSchema,
  UpdateCollectionSchema,
  ImportCollectionRequestSchema,
  ListCollectionsQuerySchema,
  normalizeImportRequest,
  type CreateCollectionRequest,
  type UpdateCollectionRequest,
} from "@vellum/api-contract";
import {
  generateProjectApiKey,
  validateSecurityRulesetAst,
  type ApiKeyRecord,
  type Role,
} from "@vellum/authorization";
import type { BatchMutation } from "@vellum/document-engine";
import type { CollectionSchemaValidation } from "@vellum/storage";
import type { VellumPlatformContext } from "../app.js";
import {
  assertProjectAccess,
  getUserOrgIds,
  getUserOrgMemberships,
} from "../middleware/session.js";
import { requireCustomerConsoleSession } from "../middleware/realm-session.js";
import { extractClientIp } from "../middleware/security.js";
import { invalidateProjectIndexCache } from "./v2.js";
import {
  CONSOLE_REFRESH_COOKIE,
  readControlRefreshToken,
  refreshControlSession,
  setRefreshCookie,
  toControlRole,
} from "./auth-endpoints.js";

const CONSOLE_ROLES: readonly Role[] = ["customer", "owner", "admin", "support_readonly"];

export function createConsoleRoutes(platform: VellumPlatformContext) {
  const routes = new Hono();
  const { controlStore, dataStore, documentEngine, consoleSessionService } = platform;

  // Scoped to /console/* — a bare `*` here would also guard unrelated /v1
  // routes (health, admin, document plane) after sub-app mounting. The refresh
  // endpoint is public and validates the opaque refresh token itself.
  routes.use(
    "/console/*",
    requireCustomerConsoleSession(platform, CONSOLE_ROLES, [
      "/v1/console/auth/refresh",
      "/console/auth/refresh",
    ])
  );

  // ---- Public refresh (exempt from the console guard) ----

  routes.post("/console/auth/refresh", async (c) => {
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const rawRefreshToken = readControlRefreshToken(c, body, CONSOLE_REFRESH_COOKIE);

    const refreshed = await refreshControlSession({
      controlStore,
      realm: "customer_console",
      cookieDescriptor: CONSOLE_REFRESH_COOKIE,
      rawRefreshToken,
      signAccess: async (user) => {
        const orgIds = await getUserOrgIds(controlStore, user.id);
        return consoleSessionService.signAccess({
          sub: user.id,
          uid: user.id,
          role: toControlRole(user.platformRole),
          orgIds,
        });
      },
    });
    setRefreshCookie(c, refreshed.refreshToken, CONSOLE_REFRESH_COOKIE);
    return c.json({
      token: refreshed.accessToken,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.accessExpiresAt,
      user: {
        id: refreshed.user.id,
        name: refreshed.user.name,
        email: refreshed.user.email,
        platformRole: refreshed.user.platformRole,
      },
    });
  });


  function documentPath(c: Context, projectId: string): string {
    const url = new URL(c.req.url);
    const prefix = `/v1/console/projects/${projectId}/documents/`;
    try {
      return decodeURIComponent(url.pathname.slice(prefix.length));
    } catch {
      throw new VellumError("INVALID_ARGUMENT", "Malformed URL encoding in document path");
    }
  }

  async function audit(
    c: Context,
    action: string,
    input: {
      organizationId?: string | null;
      projectId?: string | null;
      targetId?: string | null;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    const claims = c.get("session");
    await controlStore.recordAuditLog({
      action,
      targetId: input.targetId ?? null,
      organizationId: input.organizationId ?? null,
      projectId: input.projectId ?? null,
      actorType: claims.role === "customer" ? "customer" : "operator",
      actorUserId: claims.uid,
      metadata: input.metadata ?? {},
      ipAddress: extractClientIp(c),
      userAgent: c.req.header("user-agent") ?? null,
    });
  }

  async function engineContext(c: Context, projectId: string, write = false) {
    const claims = c.get("session");
    const project = await assertProjectAccess(controlStore, claims, projectId, { write });

    // Console requests are authenticated by session, not by a long-lived key.
    // A scoped synthetic server-key record lets the engine apply its normal
    // rules/scopes pipeline without reimplementing it in the route layer.
    const apiKeyRecord: ApiKeyRecord = {
      id: `console_${claims.jti}`,
      projectId,
      name: "Console Session",
      keyType: "server",
      keyPrefix: "console",
      secretHash: "internal",
      scopes: ["documents:read", "documents:write", "indexes:manage"],
      rateLimitRps: 1000,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdBy: claims.uid,
      createdAt: new Date().toISOString(),
    };

    // Defensive ALLOWLIST: engine contexts are assembled from these named,
    // session-authenticated values only. Request bodies are never spread into a
    // ctx, so `bypassRules`, `internal`, `debug`, `idempotencyKey` and
    // `rateLimitKey` can never be attacker-controlled on the console surface.
    return {
      claims,
      project,
      apiKeyRecord,
      authContext: { uid: claims.uid, claims: { ...claims } },
    };
  }

  interface SafeParseLike<T> {
    safeParse(value: unknown):
      | { success: true; data: T }
      | { success: false; error: { issues: Array<{ message?: string }> } };
  }

  function parseCollectionRequest<T>(schema: SafeParseLike<T>, value: unknown, label: string): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new VellumError("INVALID_ARGUMENT", `Invalid ${label}`, {
        issues: (parsed as Extract<typeof parsed, { success: false }>).error.issues.slice(0, 10),
      });
    }
    return parsed.data;
  }

  /** Zod optional fields may be `undefined`; `exactOptionalPropertyTypes` wants them omitted. */
  function cleanSchemaValidation(
    value: { requiredFields?: string[] | undefined; strict?: boolean | undefined }
  ): CollectionSchemaValidation {
    const result: Record<string, unknown> = {};
    if (value.requiredFields !== undefined) result["requiredFields"] = value.requiredFields;
    if (value.strict !== undefined) result["strict"] = value.strict;
    return result as CollectionSchemaValidation;
  }

  function cleanNullableSchemaValidation(
    value: { requiredFields?: string[] | undefined; strict?: boolean | undefined } | null
  ): CollectionSchemaValidation | null {
    return value === null ? null : cleanSchemaValidation(value);
  }

  /** Delete metering is best-effort: a billing hiccup must not fail the request. */
  function recordCollectionDeletes(
    organizationId: string,
    projectId: string,
    deletedCount: number,
    freedBytes: number
  ): void {
    try {
      platform.metering.recordDeletes(organizationId, projectId, deletedCount, -freedBytes);
    } catch (err) {
      platform.logger.warn("Collection delete metering failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---- Organizations / projects visible to the session ----

  routes.get("/console/organizations", async (c) => {
    const claims = c.get("session");
    const memberships = await getUserOrgMemberships(controlStore, claims.uid);
    const ids = new Set(memberships.map((m) => m.organizationId));
    const orgs = Array.from(controlStore.organizations.values()).filter((o) =>
      claims.role === "owner" || claims.role === "admin" || ids.has(o.id));
    return c.json(orgs.map((o) => ({ ...o, projectsCount: Array.from(controlStore.projects.values())
      .filter((project) => project.organizationId === o.id).length })));
  });

  routes.get("/console/organizations/:orgId/projects", async (c) => {
    const claims = c.get("session");
    const orgId = c.req.param("orgId");
    // assertOrgAccess is exercised through assertProjectAccess below for
    // project routes; here we resolve memberships directly for the org list.
    const memberships = await getUserOrgMemberships(controlStore, claims.uid);
    const isOperator = claims.role === "owner" || claims.role === "admin";
    if (!isOperator && !memberships.some((m) => m.organizationId === orgId)) {
      throw new VellumError("PERMISSION_DENIED", "You are not a member of the requested organization", {
        organizationId: orgId,
      });
    }
    return c.json(
      Array.from(controlStore.projects.values()).filter((p) => p.organizationId === orgId)
    );
  });

  // ---- Query / batch / transactions ----

  routes.post("/console/projects/:projectId/query", async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await engineContext(c, projectId);
    const body = await c.req.json();
    const result = await documentEngine.executeQuery({
      projectId,
      querySpec: body,
      apiKeyRecord,
      authContext,
    });
    return c.json(result);
  });

  async function consoleBatchWrite(c: Context): Promise<Response> {
    const projectId = c.req.param("projectId") ?? "";
    const { project, apiKeyRecord, authContext } = await engineContext(c, projectId, true);
    const body = await c.req.json();
    const writes = (body.writes ?? body.operations) as BatchMutation[];
    const result = await documentEngine.batchWrite({
      projectId,
      writes,
      apiKeyRecord,
      authContext,
    });
    await audit(c, "console.documents.batch_write", {
      organizationId: project.organizationId,
      projectId,
      metadata: { operationCount: Array.isArray(writes) ? writes.length : 0 },
    });
    return c.json(result);
  }

  routes.post("/console/projects/:projectId/batchWrite", consoleBatchWrite);

  routes.post("/console/projects/:projectId/transactions:begin", async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await engineContext(c, projectId);
    const result = await documentEngine.beginTransaction({
      projectId,
      apiKeyRecord,
      authContext,
    });
    return c.json(result);
  });

  routes.post("/console/projects/:projectId/transactions:commit", async (c) => {
    const projectId = c.req.param("projectId");
    const { project, apiKeyRecord, authContext } = await engineContext(c, projectId, true);
    const body = await c.req.json();
    const rawWrites = (body.writes ?? body.mutations ?? []) as Array<Record<string, unknown>>;
    const writes = rawWrites.map((m) => ({
      ...m,
      ifVersion: m["ifVersion"] ?? m["preconditions"] ?? m["precondition"],
    })) as BatchMutation[];
    const result = await documentEngine.commitTransaction({
      projectId,
      transactionToken: body["transactionToken"] as string,
      writes,
      apiKeyRecord,
      authContext,
    });
    await audit(c, "console.transactions.commit", {
      organizationId: project.organizationId,
      projectId,
    });
    return c.json(result);
  });

  // ---- Collections lifecycle (session auth; mirrors the public surface).
  // Registered before the `/documents/*` wildcard so the literal `:name/clear`,
  // `:name/import` and `:name/export` suffixes always resolve here.

  routes.get("/console/projects/:projectId/collections", async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await engineContext(c, projectId);
    const url = new URL(c.req.url);
    const query = parseCollectionRequest(
      ListCollectionsQuerySchema,
      {
        ...(url.searchParams.has("search") ? { search: url.searchParams.get("search") ?? "" } : {}),
        ...(url.searchParams.has("limit") ? { limit: url.searchParams.get("limit") ?? "" } : {}),
        ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") ?? "" } : {}),
      },
      "collection list query"
    );
    return c.json(
      await documentEngine.listCollections(
        { projectId, apiKeyRecord, authContext },
        {
          ...(query.search === undefined ? {} : { search: query.search }),
          limit: query.limit,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        }
      )
    );
  });

  routes.post("/console/projects/:projectId/collections", async (c) => {
    const projectId = c.req.param("projectId");
    const { project, apiKeyRecord, authContext } = await engineContext(c, projectId, true);
    const body: CreateCollectionRequest = parseCollectionRequest(
      CreateCollectionSchema,
      await c.req.json(),
      "collection"
    );
    const created = await documentEngine.createCollection(
      {
        projectId,
        orgId: project.organizationId,
        apiKeyRecord,
        authContext,
      },
      {
        name: body.name,
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.defaultTtlSeconds === undefined ? {} : { defaultTtlSeconds: body.defaultTtlSeconds }),
        ...(body.schemaValidation === undefined
          ? {}
          : { schemaValidation: cleanSchemaValidation(body.schemaValidation) }),
        ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
        ...(body.ifNotExists === undefined ? {} : { ifNotExists: body.ifNotExists }),
      }
    );
    await audit(c, "collection.create", {
      organizationId: project.organizationId,
      projectId,
      targetId: body.name,
      metadata: { ifNotExists: body.ifNotExists ?? false },
    });
    return c.json(created, 201);
  });

  routes.get("/console/projects/:projectId/collections/:name", async (c) => {
    const projectId = c.req.param("projectId");
    const name = c.req.param("name");
    const { apiKeyRecord, authContext } = await engineContext(c, projectId);
    return c.json(
      await documentEngine.getCollection(
        { projectId, apiKeyRecord, authContext },
        name
      )
    );
  });

  routes.patch("/console/projects/:projectId/collections/:name", async (c) => {
    const projectId = c.req.param("projectId");
    const name = c.req.param("name");
    const { project, apiKeyRecord, authContext } = await engineContext(c, projectId, true);
    const patch: UpdateCollectionRequest = parseCollectionRequest(
      UpdateCollectionSchema,
      await c.req.json(),
      "collection update"
    );
    const updated = await documentEngine.updateCollection(
      {
        projectId,
        orgId: project.organizationId,
        apiKeyRecord,
        authContext,
      },
      name,
      {
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.defaultTtlSeconds === undefined ? {} : { defaultTtlSeconds: patch.defaultTtlSeconds }),
        ...(patch.schemaValidation === undefined
          ? {}
          : { schemaValidation: cleanNullableSchemaValidation(patch.schemaValidation) }),
        ...(patch.metadata === undefined ? {} : { metadata: patch.metadata }),
      }
    );
    await audit(c, "collection.update", {
      organizationId: project.organizationId,
      projectId,
      targetId: name,
      metadata: { operation: "settings" },
    });
    return c.json(updated);
  });

  routes.post("/console/projects/:projectId/collections/:name/clear", async (c) => {
    const projectId = c.req.param("projectId");
    const name = c.req.param("name");
    const { project, apiKeyRecord, authContext } = await engineContext(c, projectId, true);
    const result = await documentEngine.clearCollection(
      {
        projectId,
        orgId: project.organizationId,
        apiKeyRecord,
        authContext,
      },
      name
    );
    if (documentEngine.metering === undefined) {
      recordCollectionDeletes(
        project.organizationId,
        projectId,
        result.deletedCount,
        result.freedBytes
      );
    }
    await audit(c, "collection.clear", {
      organizationId: project.organizationId,
      projectId,
      targetId: name,
      metadata: { deletedCount: result.deletedCount, freedBytes: result.freedBytes },
    });
    return c.json(result);
  });

  routes.delete("/console/projects/:projectId/collections/:name", async (c) => {
    const projectId = c.req.param("projectId");
    const name = c.req.param("name");
    const { project, apiKeyRecord, authContext } = await engineContext(c, projectId, true);
    const result = await documentEngine.deleteCollection(
      {
        projectId,
        orgId: project.organizationId,
        apiKeyRecord,
        authContext,
      },
      name
    );
    if (documentEngine.metering === undefined) {
      recordCollectionDeletes(
        project.organizationId,
        projectId,
        result.deletedDocuments,
        result.freedBytes
      );
    }
    await audit(c, "collection.delete", {
      organizationId: project.organizationId,
      projectId,
      targetId: name,
      metadata: {
        deletedCollection: result.deletedCollection,
        deletedDocuments: result.deletedDocuments,
        freedBytes: result.freedBytes,
      },
    });
    return c.json(result);
  });

  routes.post("/console/projects/:projectId/collections/:name/import", async (c) => {
    const projectId = c.req.param("projectId");
    const name = c.req.param("name");
    const { project, apiKeyRecord, authContext } = await engineContext(c, projectId, true);
    // Accept the SDK/Dashboard `{documents, mode}` envelope as well as a bare
    // array — otherwise every SDK import fails with 400 despite a valid body.
    const importRequest = parseCollectionRequest(
      ImportCollectionRequestSchema,
      await c.req.json(),
      "collection import"
    );
    const { documents, mode } = normalizeImportRequest(importRequest);
    // Flatten the wire `{ id?, data }` shape into the document payload the
    // engine imports (it derives the path from `data.id`).
    const docs: Record<string, unknown>[] = documents.map((entry) =>
      entry.id === undefined ? { ...entry.data } : { ...entry.data, id: entry.id }
    );
    const result = await documentEngine.importCollectionDocuments(
      {
        projectId,
        orgId: project.organizationId,
        apiKeyRecord,
        authContext,
      },
      name,
      docs,
      { mode }
    );
    await audit(c, "collection.update", {
      organizationId: project.organizationId,
      projectId,
      targetId: name,
      metadata: { operation: "import", documentCount: docs.length },
    });
    return c.json(result);
  });

  routes.get("/console/projects/:projectId/collections/:name/export", async (c) => {
    const projectId = c.req.param("projectId");
    const name = c.req.param("name");
    const { apiKeyRecord, authContext } = await engineContext(c, projectId);
    return c.json(
      await documentEngine.exportCollectionDocuments(
        { projectId, apiKeyRecord, authContext },
        name
      )
    );
  });

  // ---- Document CRUD / collection listing ----

  routes.get("/console/projects/:projectId/documents/*", async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await engineContext(c, projectId);
    const path = documentPath(c, projectId);
    const segments = path.split("/").filter(Boolean);

    if (segments.length % 2 === 1) {
      const url = new URL(c.req.url);
      const rawLimit = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.floor(rawLimit), SYSTEM_LIMITS.MAX_QUERY_LIMIT) : 50;
      const startAfter = url.searchParams.get("startAfter") ?? undefined;
      return c.json(
        await documentEngine.executeQuery({
          projectId,
          querySpec: { collectionPath: path, limit, startAfter, search: url.searchParams.get("search") ?? undefined },
          apiKeyRecord,
          authContext,
        })
      );
    }

    const url = new URL(c.req.url);
    const txToken =
      url.searchParams.get("transactionToken") ??
      url.searchParams.get("txToken") ??
      c.req.header("x-transaction-token") ??
      null;
    return c.json(
      await documentEngine.getDocument({
        projectId,
        path,
        apiKeyRecord,
        authContext,
        transactionToken: txToken,
      })
    );
  });

/**
 * Document data must be a JSON object. The `body.data ?? body` shorthand
 * would otherwise accept a bare string/array/number body and persist it as a
 * character- or index-keyed object, silently corrupting the document.
 */
function requireDocumentData(body: unknown): Record<string, unknown> {
  const data = (body as Record<string, unknown> | null)?.["data"] ?? body;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new VellumError("INVALID_ARGUMENT", "Document data must be a JSON object");
  }
  return data as Record<string, unknown>;
}

  routes.post("/console/projects/:projectId/documents/*", async (c) => {
    const projectId = c.req.param("projectId");
    const { project, apiKeyRecord, authContext } = await engineContext(c, projectId, true);
    const path = documentPath(c, projectId);
    const body = await c.req.json();
    const created = await documentEngine.createDocument({
      projectId,
      path,
      data: requireDocumentData(body),
      apiKeyRecord,
      authContext,
    });
    await audit(c, "console.document.created", {
      organizationId: project.organizationId,
      projectId,
      targetId: path,
    });
    return c.json(created, 201);
  });

  routes.put("/console/projects/:projectId/documents/*", async (c) => {
    const projectId = c.req.param("projectId");
    const { project, apiKeyRecord, authContext } = await engineContext(c, projectId, true);
    const path = documentPath(c, projectId);
    const url = new URL(c.req.url);
    const body = await c.req.json();
    const saved = await documentEngine.setDocument({
      projectId,
      path,
      data: requireDocumentData(body),
      merge: Boolean(body.merge ?? url.searchParams.get("merge") === "true"),
      ifVersion: typeof body.ifVersion === "number" ? body.ifVersion : null,
      apiKeyRecord,
      authContext,
    });
    await audit(c, "console.document.updated", {
      organizationId: project.organizationId,
      projectId,
      targetId: path,
    });
    return c.json(saved);
  });

  routes.patch("/console/projects/:projectId/documents/*", async (c) => {
    const projectId = c.req.param("projectId");
    const { project, apiKeyRecord, authContext } = await engineContext(c, projectId, true);
    const path = documentPath(c, projectId);
    const body = await c.req.json();
    const updated = await documentEngine.updateDocument({
      projectId,
      path,
      data: requireDocumentData(body),
      ifVersion: typeof body.ifVersion === "number" ? body.ifVersion : null,
      apiKeyRecord,
      authContext,
    });
    await audit(c, "console.document.updated", {
      organizationId: project.organizationId,
      projectId,
      targetId: path,
    });
    return c.json(updated);
  });

  routes.delete("/console/projects/:projectId/documents/*", async (c) => {
    const projectId = c.req.param("projectId");
    const { project, apiKeyRecord, authContext } = await engineContext(c, projectId, true);
    const path = documentPath(c, projectId);
    const url = new URL(c.req.url);
    const ifVersionParam = url.searchParams.get("ifVersion");
    const deleted = await documentEngine.deleteDocument({
      projectId,
      path,
      ifVersion: ifVersionParam !== null ? Number(ifVersionParam) : null,
      apiKeyRecord,
      authContext,
    });
    await audit(c, "console.document.deleted", {
      organizationId: project.organizationId,
      projectId,
      targetId: path,
    });
    return c.json(deleted);
  });

  // ---- Composite indexes ----

  routes.get("/console/projects/:projectId/indexes", async (c) => {
    const projectId = c.req.param("projectId");
    await engineContext(c, projectId);
    return c.json({
      indexes: await listIndexesReconciled(platform, projectId),
    });
  });

  routes.post("/console/projects/:projectId/indexes", async (c) => {
    const projectId = c.req.param("projectId");
    const { project } = await engineContext(c, projectId, true);
    const body = await c.req.json();
    parseCollectionPath(body.collectionPath as string);
    if (!Array.isArray(body.fields) || body.fields.length === 0) {
      throw new VellumError("INVALID_ARGUMENT", "Composite index requires a non-empty 'fields' array");
    }
    const created = await dataStore.createCompositeIndex(
      { projectId },
      body.collectionPath as string,
      (body.fields as Array<Parameters<typeof normalizeIndexFieldSpec>[0]>).map(normalizeIndexFieldSpec)
    );
    invalidateProjectIndexCache(projectId);
    const built = await refreshIndexRecord(platform, projectId, created);
    // Deep-linked suggestions from `@vellumdb/sdk-js` / `vellum_flutter` carry the
    // advisor fingerprint in the create body. Mark the matching recommendations
    // applied so the dashboard queue never re-suggests an index we just created.
    if (typeof body.fingerprint === "string" && body.fingerprint.length > 0) {
      await platform.indexRecommendationRecorder?.markAppliedByFingerprint(
        projectId,
        body.fingerprint
      );
    }
    await audit(c, "console.index.created", {
      organizationId: project.organizationId,
      projectId,
      targetId: body.collectionPath as string,
    });
    return c.json(built, 201);
  });

  routes.delete("/console/projects/:projectId/indexes/:indexId", async (c) => {
    const projectId = c.req.param("projectId");
    const { project } = await engineContext(c, projectId, true);
    const indexId = c.req.param("indexId");
    await dataStore.deleteCompositeIndex({ projectId }, indexId);
    invalidateProjectIndexCache(projectId);
    await audit(c, "console.index.deleted", {
      organizationId: project.organizationId,
      projectId,
      targetId: indexId,
    });
    return c.json({ deleted: true, indexId });
  });

  // ---- Security rulesets ----

  routes.get("/console/projects/:projectId/rulesets", async (c) => {
    const projectId = c.req.param("projectId");
    await engineContext(c, projectId);
    const active = controlStore.getActiveRuleset(projectId);
    return c.json(active ?? { projectId, version: 0, rulesAst: null });
  });

  routes.post("/console/projects/:projectId/rulesets", async (c) => {
    const projectId = c.req.param("projectId");
    const { project, claims } = await engineContext(c, projectId, true);
    const body = await c.req.json();
    const rulesAst = body.rulesAst as Record<string, unknown>;
    if (!rulesAst || typeof rulesAst !== "object") {
      throw new VellumError("INVALID_ARGUMENT", "rulesAst is required");
    }
    validateSecurityRulesetAst(rulesAst);
    const published = await controlStore.publishSecurityRuleset({
      projectId,
      rulesAst,
      createdBy: claims.uid,
    });
    await audit(c, "console.ruleset.published", {
      organizationId: project.organizationId,
      projectId,
      targetId: published.id,
      metadata: { version: published.version },
    });
    return c.json(published, 201);
  });

  // ---- API keys ----

  routes.get("/console/projects/:projectId/api-keys", async (c) => {
    const projectId = c.req.param("projectId");
    await engineContext(c, projectId);
    return c.json(
      Array.from(controlStore.apiKeysById.values()).filter(
        (k) => k.projectId === projectId
      ).map(({ secretHash: _secretHash, ...key }) => key)
    );
  });

  routes.post("/console/projects/:projectId/api-keys", async (c) => {
    const projectId = c.req.param("projectId");
    const { project, claims } = await engineContext(c, projectId, true);
    const body = await c.req.json();
    const keyType = body.keyType === "publishable" || body.keyType === "public" ? "public" : "server";
    const generated = generateProjectApiKey({
      keyType,
      pepper: platform.apiKeyPepper,
    });
    const record = await controlStore.registerApiKey({
      projectId,
      name: typeof body.name === "string" ? body.name : "Console-created key",
      keyType,
      keyPrefix: generated.keyPrefix,
      secretHash: generated.secretHash,
      scopes: keyType === "server" ? ["documents:read", "documents:write", "indexes:manage"] : ["documents:read"],
      createdBy: claims.uid,
    });
    await audit(c, "console.api_key.created", {
      organizationId: project.organizationId,
      projectId,
      targetId: record.id,
      metadata: { keyPrefix: generated.keyPrefix, keyType },
    });
    const { secretHash: _secretHash, ...safeKey } = record;
    return c.json({ apiKey: safeKey, rawKey: generated.fullKey }, 201);
  });

  routes.delete("/console/projects/:projectId/api-keys/:keyId", async (c) => {
    const projectId = c.req.param("projectId");
    const { project, claims } = await engineContext(c, projectId, true);
    const keyId = c.req.param("keyId");
    const existing = controlStore.apiKeysById.get(keyId);
    if (!existing) throw new VellumError("NOT_FOUND", `API key '${keyId}' not found`);
    if (existing.projectId !== projectId) {
      throw new VellumError(
        "PERMISSION_DENIED",
        "API key does not belong to the requested project",
        { keyId, projectId }
      );
    }
    const revoked = await controlStore.revokeApiKey(keyId, claims.uid);
    await audit(c, "console.api_key.revoked", {
      organizationId: project.organizationId,
      projectId,
      targetId: keyId,
      metadata: { keyPrefix: revoked.keyPrefix },
    });
    return c.json({ success: true, revoked });
  });

  return routes;
}
