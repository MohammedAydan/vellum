/**
 * @vellum/api - V2 delivery adapter (contract §2.7, §2.8, §6.4, §6.5)
 *
 * Hosts the Phase 2 endpoints and the two cross-cutting helpers shared with
 * the document hot paths in `app.ts`:
 *   - `createPlatformIndexRecommendationRecorder` — PG-backed when the control
 *     store exposes a pool, otherwise a bounded in-process memory adapter.
 *   - `createIndexAdvisor` — non-throwing index-coverage analysis that attaches
 *     `x-vellum-index-*` headers and fire-and-forget records recommendations.
 *
 * The rules DSL is imported through the `@vellum/authorization` namespace and
 * accessed structurally: agent 2B adds these exports in parallel, so this
 * module compiles before (and after) that package lands without a hard
 * compile-time dependency on named exports that may not exist yet.
 */

import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import {
  VellumError,
  analyzeQueryIndexCoverage,
  buildIndexSuggestionHeaders,
  normalizeIndexFieldSpec,
  type IndexAdvisorIndex,
  type IndexAdvisorQuery,
} from "@vellum/core";
import {
  authorizeOperation,
} from "@vellum/authorization";
import * as authorizationModule from "@vellum/authorization";
import {
  createIndexRecommendationRecorder,
  type IndexRecommendationRecorder,
  type IndexRecommendationRecord,
  type IndexRecommendationQueryPool,
  type RecordIndexRecommendationInput,
} from "@vellum/database-control";
import { validateAndNormalizeQuery } from "@vellum/query-engine";
import {
  ReferencedByRequestSchema,
  AggregateRequestSchema,
  BulkDeleteRequestSchema,
  CompileRulesDslSchema,
  DecompileRulesSchema,
  SimulateRulesSchema,
} from "@vellum/api-contract";
import type { AuthContext, SessionClaims } from "@vellum/authorization";
import type { ApiKeyRecord, ControlPlaneRepository } from "@vellum/database-control";
import type { StructuredLogger } from "@vellum/observability";
import type { VellumPlatformContext } from "../app.js";
import { assertProjectAccess, extractBearerToken } from "../middleware/session.js";
import { loadProject } from "../project-lookup.js";

/* -------------------------------------------------------------------------- */
/* Structural types (kept local so parallel agents' types are not required)   */
/* -------------------------------------------------------------------------- */

type WhereClauseLike = { field: string; op: string; value: unknown };

interface AggregateRequestLike {
  collectionPath: string;
  where?: WhereClauseLike[];
  or?: WhereClauseLike[][];
  groupBy?: string[];
  metrics: Record<string, { op: "count" | "sum" | "avg" | "min" | "max"; field?: string | undefined }>;
}

interface AggregateEngineLike {
  aggregateDocuments(ctx: {
    projectId: string;
    apiKeyRecord?: unknown;
    authContext?: unknown;
    request: AggregateRequestLike;
  }): Promise<{ rows: Array<Record<string, unknown>>; executionTimeMs: number }>;
  deleteWhere(ctx: {
    projectId: string;
    apiKeyRecord?: unknown;
    authContext?: unknown;
    collectionPath: string;
    where?: WhereClauseLike[];
    or?: WhereClauseLike[][];
    limit?: number;
  }): Promise<{ deletedCount: number }>;
}

interface RulesDslDiagnosticLike {
  message: string;
  line: number;
  column: number;
  snippet?: string;
}

interface RulesDslSyntaxErrorLike extends Error {
  name: string;
  line: number;
  column: number;
  snippet: string;
}

interface RulesDslApi {
  compileRulesDsl(source: string): { ast: unknown; diagnostics: RulesDslDiagnosticLike[] };
  decompileRulesAstToDsl(ast: unknown): string;
  simulateRuleEvaluation(params: {
    ruleset: unknown;
    operation: "get" | "list" | "create" | "update" | "delete";
    path: string;
    auth: unknown;
    resourceData?: unknown;
    incomingData?: unknown;
  }): { allowed: boolean; matchedRule: string | null; evaluationTrace: string[] };
}

function isRulesDslApi(mod: object): mod is RulesDslApi {
  return (
    "compileRulesDsl" in mod &&
    typeof mod.compileRulesDsl === "function" &&
    "decompileRulesAstToDsl" in mod &&
    typeof mod.decompileRulesAstToDsl === "function" &&
    "simulateRuleEvaluation" in mod &&
    typeof mod.simulateRuleEvaluation === "function"
  );
}

function isAggregateEngine(engine: object): engine is AggregateEngineLike {
  return (
    "aggregateDocuments" in engine &&
    typeof engine.aggregateDocuments === "function" &&
    "deleteWhere" in engine &&
    typeof engine.deleteWhere === "function"
  );
}

function getIndexRecommendationPool(store: object): IndexRecommendationQueryPool | null {
  if (!("pool" in store)) return null;
  const candidate = store.pool;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "query" in candidate &&
    typeof candidate.query === "function"
  ) {
    return candidate as IndexRecommendationQueryPool;
  }
  return null;
}

function requireRulesDsl(): RulesDslApi {
  if (!isRulesDslApi(authorizationModule)) {
    throw new VellumError("INTERNAL_ERROR", "Rules DSL compiler is not available in this build");
  }
  return authorizationModule;
}

function isRulesDslSyntaxError(err: unknown): err is RulesDslSyntaxErrorLike {
  if (!(err instanceof Error)) return false;
  const candidate = err as Partial<RulesDslSyntaxErrorLike>;
  return (
    candidate.name === "RulesDslSyntaxError" ||
    (typeof candidate.line === "number" && typeof candidate.column === "number" && typeof candidate.snippet === "string")
  );
}

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

interface AuthenticatedTenant {
  project: { id: string; organizationId: string };
  /** null only for the dashboard-session path on rules endpoints. */
  apiKeyRecord: ApiKeyRecord | null;
  authContext: AuthContext | null;
}

export type V2AuthenticateRequest = (
  c: Context,
  projectId: string
) => Promise<AuthenticatedTenant>;

/* -------------------------------------------------------------------------- */
/* In-process recommendation recorder (legitimate memory adapter)             */
/* -------------------------------------------------------------------------- */

/**
 * Bounded, deduplicating memory implementation of `IndexRecommendationRecorder`.
 * Used only when the control store has no SQL pool (tests / offline mode).
 */
const MAX_IN_MEMORY_RECOMMENDATIONS = 5_000;

export function createInMemoryIndexRecommendationRecorder(): IndexRecommendationRecorder {
  const rows = new Map<string, IndexRecommendationRecord>();
  const byFingerprint = new Map<string, string>();

  const key = (projectId: string, fingerprint: string): string =>
    `${projectId}:${fingerprint}`;

  return {
    record(input: RecordIndexRecommendationInput): void {
      if (!input || typeof input.projectId !== "string") return;
      const fingerprintKey = key(input.projectId, input.fingerprint);
      const duration = Number.isFinite(input.durationMs) ? Math.max(0, input.durationMs) : 0;
      const now = new Date().toISOString();
      const fields = Array.isArray(input.recommendedFields)
        ? input.recommendedFields.map((field) => ({
            path: typeof field?.path === "string" ? field.path : "",
            dir: field?.dir === "desc" ? ("desc" as const) : ("asc" as const),
          }))
        : [];
      const existingId = byFingerprint.get(fingerprintKey);
      const existing = existingId !== undefined ? rows.get(existingId) : undefined;
      if (existing && existing.status !== "applied") {
        existing.hitCount += 1;
        existing.totalDurationMs += duration;
        existing.maxDurationMs = Math.max(existing.maxDurationMs, duration);
        existing.reason = input.reason;
        existing.sampleQuery = input.sampleQuery ?? null;
        existing.lastSeenAt = now;
        existing.recommendedFields = fields;
        return;
      }
      if (existing && existing.status === "applied") {
        // Applied fingerprints are not re-opened; keep the durable marker.
        return;
      }
      if (rows.size >= MAX_IN_MEMORY_RECOMMENDATIONS) {
        const oldest = rows.entries().next().value as [string, IndexRecommendationRecord] | undefined;
        if (oldest) {
          rows.delete(oldest[0]);
          byFingerprint.delete(key(oldest[1].projectId, oldest[1].fingerprint));
        }
      }
      const id = randomUUID();
      rows.set(id, {
        id,
        projectId: input.projectId,
        fingerprint: input.fingerprint,
        collectionPath: input.collectionPath,
        recommendedFields: fields,
        sampleQuery: input.sampleQuery ?? null,
        reason: input.reason,
        hitCount: 1,
        totalDurationMs: duration,
        maxDurationMs: duration,
        status: "pending",
        lastSeenAt: now,
        createdAt: now,
      });
      byFingerprint.set(fingerprintKey, id);
    },

    async list(projectId: string): Promise<IndexRecommendationRecord[]> {
      return Array.from(rows.values())
        .filter((row) => row.projectId === projectId)
        .sort((a, b) => b.hitCount - a.hitCount || b.lastSeenAt.localeCompare(a.lastSeenAt));
    },

    async setStatus(id: string, status: string): Promise<void> {
      const row = rows.get(id);
      if (!row) return;
      if (status === "applied" || status === "dismissed" || status === "pending") row.status = status;
      row.lastSeenAt = new Date().toISOString();
    },

    async markAppliedByFingerprint(projectId: string, fingerprint: string): Promise<void> {
      const id = byFingerprint.get(key(projectId, fingerprint));
      const row = id !== undefined ? rows.get(id) : undefined;
      if (row) row.status = "applied";
    },

    async flush(): Promise<void> {
      // Memory mode is already durable for the lifetime of the process.
    },

    async close(): Promise<void> {
      rows.clear();
      byFingerprint.clear();
    },
  };
}

/** Build the recorder once per platform: shared PG pool when available. */
export function createPlatformIndexRecommendationRecorder(
  controlStore: ControlPlaneRepository,
  logger: StructuredLogger
): IndexRecommendationRecorder {
  const pool = getIndexRecommendationPool(controlStore);
  if (pool) return createIndexRecommendationRecorder({ pool, logger });
  return createInMemoryIndexRecommendationRecorder();
}

/* -------------------------------------------------------------------------- */
/* Index advisor helper                                                       */
/* -------------------------------------------------------------------------- */

export interface IndexAdvisorTenant {
  projectId: string;
  orgId: string;
}

export interface IndexAdvisorAdviseOptions {
  durationMs: number;
  sampleQuery: unknown;
}

export type IndexAdviseFn = (
  c: Context,
  query: IndexAdvisorQuery,
  tenant: IndexAdvisorTenant,
  options: IndexAdvisorAdviseOptions
) => Promise<void>;

/**
 * Normalize a raw query spec into the advisor's structural shape. The query
 * engine validator is preferred (it also adds the documentId tie-breaker); a
 * permissive raw fallback keeps the advisor alive for newly added V2 operators
 * while agent 2A's operator set is still landing.
 */
export function buildAdvisorQuery(raw: Record<string, unknown>): IndexAdvisorQuery {
  try {
    const normalized = validateAndNormalizeQuery(raw);
    return {
      collectionPath: normalized.collectionPath,
      where: normalized.where as IndexAdvisorQuery["where"],
      orderBy: normalized.orderBy,
    };
  } catch {
    const rawWhere = Array.isArray(raw["where"]) ? (raw["where"] as WhereClauseLike[]) : [];
    const rawOrder = Array.isArray(raw["orderBy"])
      ? (raw["orderBy"] as Array<{ field: string; dir?: string; direction?: string }>)
      : [];
    return {
      collectionPath: typeof raw["collectionPath"] === "string" ? raw["collectionPath"] : "",
      where: rawWhere.filter((clause) => clause && typeof clause.field === "string"),
      orderBy: rawOrder
        .filter((clause) => clause && typeof clause.field === "string")
        .map((clause) => ({
          field: clause.field,
          dir: clause.dir === "desc" || clause.direction === "desc" ? ("desc" as const) : ("asc" as const),
        })),
    };
  }
}

export function createIndexAdvisor(
  platform: VellumPlatformContext,
  recorder: IndexRecommendationRecorder
): IndexAdviseFn {
  // In production a missing base URL means "no one-click link", never a link to the operator's localhost.
  const dashboardBaseUrl =
    process.env["VELLUM_DASHBOARD_BASE_URL"] ??
    (process.env["NODE_ENV"] === "production" ? "" : "http://localhost:3000");
  const analyze = analyzeQueryIndexCoverage;
  return async (c, query, tenant, options) => {
    try {
      // Read from the data DB on every call: no process-local copy of project indexes.
      const stored = await platform.dataStore.listCompositeIndexes({
        projectId: tenant.projectId,
      });
      const existingIndexes: IndexAdvisorIndex[] = stored.map((index) => ({
        collectionPath: index.collectionPath,
        fields: index.fields.map((field) => normalizeIndexFieldSpec(field)),
        status: index.status,
      }));
      const coverage = analyze(query, existingIndexes, {
        projectId: tenant.projectId,
        orgId: tenant.orgId,
        dashboardBaseUrl,
      });

      const headers = buildIndexSuggestionHeaders(coverage);
      for (const [name, value] of Object.entries(headers)) c.header(name, value);

      if (!coverage.covered && coverage.fingerprint && coverage.recommendedFields) {
        const input: RecordIndexRecommendationInput = {
          projectId: tenant.projectId,
          fingerprint: coverage.fingerprint,
          collectionPath: query.collectionPath,
          recommendedFields: coverage.recommendedFields,
          sampleQuery: options.sampleQuery,
          reason: coverage.reason,
          durationMs: options.durationMs,
          dashboardBaseUrl,
          ...(tenant.orgId ? { orgId: tenant.orgId } : {}),
        };
        // Fire-and-forget: record() is synchronous and never throws, but keep
        // the advisor entirely non-blocking for the request path.
        try {
          recorder.record(input);
        } catch (err) {
          platform.logger.warn("Index recommendation recorder failed", {
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      platform.logger.warn("Index advisor failed", {
        reason: err instanceof Error ? err.message : String(err),
        collectionPath: query.collectionPath,
      });
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Route factory                                                              */
/* -------------------------------------------------------------------------- */

export interface V2RouteHelpers {
  authenticateRequest: V2AuthenticateRequest;
  recorder: IndexRecommendationRecorder;
}

const BASE = "/projects/:projectId";

export function createV2Routes(platform: VellumPlatformContext, helpers: V2RouteHelpers): Hono {
  const routes = new Hono();

  /** Document endpoints: enforce the authenticated API key's document rules via the engine. */
  async function authenticateDocumentRequest(c: Context, projectId: string): Promise<AuthenticatedTenant> {
    return helpers.authenticateRequest(c, projectId);
  }

  /**
   * Rules endpoints accept either an API key (public path) or a Customer
   * Console session (dashboard). A session is realm-verified and checked for
   * project access before it can be used — tenant isolation is never relaxed.
   */
  async function authenticateRulesRequest(c: Context, projectId: string): Promise<AuthenticatedTenant> {
    const token = extractBearerToken(c.req.header("authorization"));
    if (token) {
      try {
        const claims = (await platform.consoleSessionService.verifyAccessChecked(token)) as SessionClaims & {
          realm?: string;
        };
        if (claims.realm === "customer_console") {
          await assertProjectAccess(platform.controlStore, claims, projectId);
          const project = await loadProject(platform.controlStore, projectId);
          return { project, apiKeyRecord: null, authContext: null };
        }
      } catch {
        // Not a usable console session — fall through to API-key authentication.
      }
    }
    return helpers.authenticateRequest(c, projectId);
  }

  /**
   * Index / recommendation endpoints require the `indexes:manage` privilege.
   * The customer dashboard authenticates with a realm-verified console session
   * (it has no API key), while SDKs/CLI use a server key with the scope. Both
   * paths enforce project access — never a bare session without that check.
   */
  async function authorizeIndexes(c: Context, projectId: string): Promise<AuthenticatedTenant> {
    const token = extractBearerToken(c.req.header("authorization"));
    if (token) {
      try {
        const claims = (await platform.consoleSessionService.verifyAccessChecked(token)) as SessionClaims & {
          realm?: string;
        };
        if (claims.realm === "customer_console") {
          await assertProjectAccess(platform.controlStore, claims, projectId);
          const project = await loadProject(platform.controlStore, projectId);
          return { project, apiKeyRecord: null, authContext: null };
        }
      } catch {
        // Not a usable console session — fall through to API-key authorization.
      }
    }
    const auth = await authenticateDocumentRequest(c, projectId);
    authorizeOperation({
      apiKeyRecord: auth.apiKeyRecord as ApiKeyRecord,
      rulesetRecord: null,
      operation: "indexes:manage",
      path: "indexes",
      ...(auth.authContext ? { authContext: auth.authContext } : {}),
    });
    return auth;
  }

  routes.post(`${BASE}/documents:referencedBy`, async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await authenticateDocumentRequest(c, projectId);
    const body = parseOrThrow(ReferencedByRequestSchema, await c.req.json(), "referencedBy request");
    return c.json(await platform.documentEngine.referencedBy({ projectId, apiKeyRecord, authContext,
      request: body,
      ...(body.select ? { select: body.select } : {}),
      ...(body.include ? { include: body.include } : {}),
    }));
  });

  // POST /v1/projects/:projectId/documents:aggregate
  routes.post(`${BASE}/documents:aggregate`, async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await authenticateDocumentRequest(c, projectId);
    const body = parseOrThrow(AggregateRequestSchema, await c.req.json(), "aggregate request");
    if (!isAggregateEngine(platform.documentEngine)) {
      throw new VellumError("INTERNAL_ERROR", "Aggregate engine unavailable");
    }
    const engine = platform.documentEngine;
    const request: AggregateRequestLike = {
      collectionPath: body.collectionPath,
      ...(body.where.length > 0 ? { where: body.where as WhereClauseLike[] } : {}),
      ...(body.or ? { or: body.or as WhereClauseLike[][] } : {}),
      ...(body.groupBy.length > 0 ? { groupBy: body.groupBy } : {}),
      metrics: body.metrics,
    };
    const result = await engine.aggregateDocuments({
      projectId,
      apiKeyRecord,
      authContext,
      request,
    } as never);
    return c.json(result);
  });

  // POST /v1/projects/:projectId/documents:bulk-delete
  routes.post(`${BASE}/documents:bulk-delete`, async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await authenticateDocumentRequest(c, projectId);
    const body = parseOrThrow(BulkDeleteRequestSchema, await c.req.json(), "bulk delete request");
    if (!isAggregateEngine(platform.documentEngine)) {
      throw new VellumError("INTERNAL_ERROR", "Bulk delete engine unavailable");
    }
    const engine = platform.documentEngine;
    const result = await engine.deleteWhere({
      projectId,
      apiKeyRecord,
      authContext,
      collectionPath: body.collectionPath,
      ...(body.where.length > 0 ? { where: body.where as WhereClauseLike[] } : {}),
      ...(body.or ? { or: body.or as WhereClauseLike[][] } : {}),
      limit: body.limit,
    } as never);
    return c.json(result);
  });

  // POST /v1/projects/:projectId/rules/compile
  routes.post(`${BASE}/rules/compile`, async (c) => {
    const projectId = c.req.param("projectId");
    await authenticateRulesRequest(c, projectId);
    const { source } = parseOrThrow(CompileRulesDslSchema, await c.req.json(), "rules compile request");
    const dsl = requireRulesDsl();
    try {
      const result = dsl.compileRulesDsl(source);
      return c.json({ ast: result.ast, diagnostics: result.diagnostics });
    } catch (err) {
      if (isRulesDslSyntaxError(err)) {
        const syntax = err as RulesDslSyntaxErrorLike;
        return c.json(
          {
            error: {
              code: "INVALID_ARGUMENT",
              message: syntax.message,
              line: syntax.line,
              column: syntax.column,
              snippet: syntax.snippet,
            },
          },
          400
        );
      }
      throw err;
    }
  });

  // POST /v1/projects/:projectId/rules/decompile
  routes.post(`${BASE}/rules/decompile`, async (c) => {
    const projectId = c.req.param("projectId");
    await authenticateRulesRequest(c, projectId);
    const parsed = parseOrThrow(DecompileRulesSchema, await c.req.json(), "rules decompile request");
    const ast = "rulesAst" in parsed ? parsed.rulesAst : parsed;
    return c.json({ dsl: requireRulesDsl().decompileRulesAstToDsl(ast) });
  });

  // POST /v1/projects/:projectId/rules/simulate
  routes.post(`${BASE}/rules/simulate`, async (c) => {
    const projectId = c.req.param("projectId");
    await authenticateRulesRequest(c, projectId);
    const parsed = parseOrThrow(SimulateRulesSchema, await c.req.json(), "rules simulate request");

    let ruleset: unknown = parsed.rulesAst;
    if (ruleset === undefined) {
      const active = await platform.controlStore.getActiveRulesetAsync(projectId);
      if (!active) {
        throw new VellumError("INVALID_ARGUMENT", "No active ruleset is published for this project");
      }
      ruleset = active.rulesAst;
    }
    const result = requireRulesDsl().simulateRuleEvaluation({
      ruleset,
      operation: parsed.operation,
      path: parsed.path,
      auth: parsed.auth === undefined ? null : parsed.auth,
      resourceData: parsed.resourceData ?? null,
      incomingData: parsed.incomingData ?? null,
    });
    return c.json(result);
  });

  // GET /v1/projects/:projectId/indexes/recommendations
  routes.get(`${BASE}/indexes/recommendations`, async (c) => {
    const projectId = c.req.param("projectId");
    await authorizeIndexes(c, projectId);
    const recommendations = await helpers.recorder.list(projectId);
    return c.json({ recommendations });
  });

  // POST /v1/projects/:projectId/indexes/recommendations/:id/apply
  routes.post(`${BASE}/indexes/recommendations/:id/apply`, async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await authorizeIndexes(c, projectId);
    const recommendations = await helpers.recorder.list(projectId);
    const recommendation = recommendations.find((row) => row.id === id);
    if (!recommendation) {
      throw new VellumError("NOT_FOUND", `Index recommendation '${id}' not found`);
    }
    const fields = recommendation.recommendedFields.map((field) => normalizeIndexFieldSpec(field));
    await platform.dataStore.createCompositeIndex(
      { projectId },
      recommendation.collectionPath,
      fields
    );
    await helpers.recorder.markAppliedByFingerprint(projectId, recommendation.fingerprint);
    await helpers.recorder.setStatus(id, "applied");
    return c.json({ applied: true, id, fingerprint: recommendation.fingerprint });
  });

  // POST /v1/projects/:projectId/indexes/recommendations/:id/dismiss
  routes.post(`${BASE}/indexes/recommendations/:id/dismiss`, async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    await authorizeIndexes(c, projectId);
    const recommendations = await helpers.recorder.list(projectId);
    if (!recommendations.some((row) => row.id === id)) {
      throw new VellumError("NOT_FOUND", `Index recommendation '${id}' not found`);
    }
    await helpers.recorder.setStatus(id, "dismissed");
    return c.json({ dismissed: true, id });
  });

  return routes;
}
