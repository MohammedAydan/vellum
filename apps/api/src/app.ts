/**
 * @vellum/api - Main Hono Application
 * Connects Middlewares, Better Auth, Control Plane Routes, and Document Engine Routes.
 */

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { createProjectCors } from "./middleware/project-cors.js";
import { compress } from "hono/compress";
import { VellumError, SYSTEM_LIMITS, normalizeIndexFieldSpec, parseCollectionPath } from "@vellum/core";
import type { IndexRecommendationRecorder } from "@vellum/database-control";
import {
  CreateCollectionSchema,
  UpdateCollectionSchema,
  ImportCollectionRequestSchema,
  ListCollectionsQuerySchema,
  normalizeImportRequest,
  type CreateCollectionRequest,
  type UpdateCollectionRequest,
} from "@vellum/api-contract";
import { verifyApiKeyAsync, authorizeOperation } from "@vellum/authorization";
import type { SessionService } from "@vellum/authorization";
import { requestId } from "./middleware/request-id.js";
import { errorHandler } from "./middleware/error-handler.js";
import {
  bodyLimit,
  createCorsOriginValidator,
  parseAllowedOrigins,
  extractClientIp,
  redactHeaders,
  safeJsonParse,
  securityHeaders,
} from "./middleware/security.js";
import { authRateLimit } from "./middleware/auth-rate-limit.js";
import { createRootHealthRoutes, healthRoutes } from "./routes/health.js";
import { createControlPlaneRoutes } from "./routes/control-plane.js";
import { createAdminRoutes } from "./routes/admin.js";
import { createCustomerAuthRoutes, sha256Hex } from "./routes/auth-endpoints.js";
import { createConsoleRoutes } from "./routes/console.js";
import { createMfaRoutes } from "./routes/mfa.js";
import { createUsageRoutes } from "./routes/usage.js";
import { createAuthEndUserRoutes } from "./routes/auth-enduser.js";
import { createAuthCustomerAdminRoutes } from "./routes/auth-customer-admin.js";
import { createAuthSuperAdminRoutes } from "./routes/auth-super-admin.js";
import {
  buildAdvisorQuery,
  createIndexAdvisor,
  createPlatformIndexRecommendationRecorder,
  createV2Routes,
} from "./routes/v2.js";
import { getApiKeyHeader, resolveEndUserAuth } from "./middleware/tenant-auth.js";
import { extractBearerToken } from "./middleware/session.js";
import {
  requireCustomerConsoleSession,
  requireSuperAdminSession,
} from "./middleware/realm-session.js";
import { createBetterAuth } from "./auth/config.js";
import type { ControlPlaneRepository } from "@vellum/database-control";
import type { StorageAdapter, CollectionSchemaValidation } from "@vellum/storage";
import type { RealtimeGatewayHub } from "@vellum/realtime";
import type { DocumentEngine, BatchMutation, IncludeSpec } from "@vellum/document-engine";
import type { StructuredLogger, SlidingWindowRateLimiter } from "@vellum/observability";
import type { ThreatDetector } from "@vellum/security";
import type { UsageMeteringEngine, QuotaGuard } from "@vellum/billing";
import { listIndexesReconciled, refreshIndexRecord } from "./index-build.js";
import { createRealtimeSseRoutes } from "./routes/realtime-sse.js";
import { loadProject } from "./project-lookup.js";
import { attachFortressMiddleware } from "./middleware/fortress.js";
import { createFortressRoutes } from "./routes/fortress.js";

export interface VellumPlatformContext {
  controlStore: ControlPlaneRepository;
  dataStore: StorageAdapter;
  realtimeHub: RealtimeGatewayHub;
  documentEngine: DocumentEngine;
  logger: StructuredLogger;
  rateLimiter: SlidingWindowRateLimiter;
  jwtSecret: string;
  /** Console-realm session service; `sessionService` aliases it for compatibility. */
  sessionService: SessionService;
  /** Realm-bound Customer Console session service (HS256). */
  consoleSessionService: SessionService;
  /** Realm-bound Platform Super Admin session service (HS256). */
  superAdminSessionService: SessionService;
  /** HMAC pepper for API key digests. */
  apiKeyPepper: string;
  /** Explicit CORS allowlist. Defaults to local dashboard origins; never `*`. */
  corsOrigins?: string[];
  /**
   * Shared index-recommendation recorder. Built once by `createVellumPlatform`
   * and reused by the app; a memory adapter is used when absent (tests).
   */
  indexRecommendationRecorder?: IndexRecommendationRecorder | undefined;
  /** Security Fortress: in-process threat detector, O(1) metering and quota guard. */
  threatDetector: ThreatDetector;
  metering: UsageMeteringEngine;
  quota: QuotaGuard;
  /** HKDF-derived signing keys for the audit and billing hash chains. */
  chainKeys: { security: Buffer; billing: Buffer };
}

export function createVellumApp(platform: VellumPlatformContext): Hono {
  const app = new Hono();

  // Index telemetry is built ONCE per app so the hot paths and the management
  // endpoints share dedupe state. PG mode uses the control-store pool; memory
  // mode uses a bounded in-process adapter.
  const recorder =
    platform.indexRecommendationRecorder ??
    createPlatformIndexRecommendationRecorder(platform.controlStore, platform.logger);
  const adviseIndex = createIndexAdvisor(platform, recorder);

  /** Never let advisor or recorder failures reach a document request path. */
  async function adviseQuery(
    c: Context,
    rawQuery: Record<string, unknown>,
    tenant: {
      projectId: string;
      orgId: string;
    },
    sampleQuery: unknown,
    durationMs: number
  ): Promise<void> {
    try {
      await adviseIndex(c, buildAdvisorQuery(rawQuery), tenant, { durationMs, sampleQuery });
    } catch (err) {
      platform.logger.warn("Index advisor invocation failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 1. Global Middleware
  app.use("*", requestId());

  // Security Fortress ingress pipeline (contract §5). Registered immediately
  // after requestId so every subsequent middleware and handler is protected.
  attachFortressMiddleware(app, {
    threatDetector: platform.threatDetector,
    metering: platform.metering,
    quota: platform.quota,
    chainKeys: platform.chainKeys,
  }, {
    corsOrigins: platform.corsOrigins ?? [],
    isProd: process.env["NODE_ENV"] === "production",
    controlStore: platform.controlStore,
    getOrgIdForProject: async (projectId) => {
      const project = await platform.controlStore.findProjectById(projectId);
      return project?.organizationId ?? null;
    },
  });

  app.use("*", bodyLimit());
  // POST routes whose body is optional. SDKs send `Content-Type: application/json`
  // on every POST, so an empty body must reach these handlers unchanged
  // (they fall back to `{}` via optionalJsonBody or never read the body).
  const BODY_OPTIONAL_POST_PATHS = [
    /^\/v1\/projects\/[^/]+\/collections\/[^/]+\/clear$/,
    /^\/v1\/console\/projects\/[^/]+\/collections\/[^/]+\/clear$/,
    /^\/v1\/auth\/sign-out$/,
    /^\/v1\/projects\/[^/]+\/auth\/(?:sign-in\/anonymous|sign-out|email\/verify\/request|mfa\/enroll)$/,
  ];
  // Validate transport JSON once, before any route-specific parser/catch.
  // Only parse errors are client errors; unrelated SyntaxErrors stay 500.
  app.use("*", async (c, next) => {
    const contentType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!["GET", "HEAD"].includes(c.req.method) && (contentType === "application/json" || contentType?.endsWith("+json"))) {
      const raw = await c.req.text();
      // DELETE commonly carries a JSON header without a body. Leave its
      // authorization/route contract intact; nonempty malformed JSON still fails.
      const emptyAllowed =
        raw.trim().length === 0 &&
        (c.req.method === "DELETE" ||
          (c.req.method === "POST" && BODY_OPTIONAL_POST_PATHS.some((re) => re.test(c.req.path))));
      try { if (!emptyAllowed) safeJsonParse(raw); }
      catch (error) {
        if (error instanceof SyntaxError) {
          throw new VellumError("INVALID_ARGUMENT", "Malformed JSON request body: invalid JSON syntax");
        }
        throw error;
      }
    }
    await next();
  });
  // Response compression for JSON bodies above 1 KiB, negotiated via
  // Accept-Encoding. Hono's built-in middleware is a no-op for clients that do
  // not advertise a supported encoding (including the in-process test runner).
  app.use(
    "*",
    compress({ threshold: 1024, contentTypeFilter: /^application\/json/ })
  );
  const globalCorsValidator = createCorsOriginValidator(parseAllowedOrigins(platform.corsOrigins?.join(",")));
  // A developer's own site: allowed per project through the origins on its API keys (no cookies).
  app.use(
    "*",
    createProjectCors(platform.controlStore, (origin) => globalCorsValidator(origin) !== undefined)
  );
  app.use(
    "*",
    cors({
      origin: globalCorsValidator,
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Project-Key",
        "X-Vellum-Api-Key",
        "X-Vellum-User-Token",
        "X-Request-Id",
        "X-Transaction-Token",
        "X-Setup-Token",
        "If-Match",
      ],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: [
        "X-Request-Id",
        "X-Refreshed-Session-Token",
        "X-Vellum-Index-Suggestion",
        "X-Vellum-Index-Url",
      ],
      credentials: true,
    })
  );
  app.onError((err, c) => {
    const reqId = c.get("requestId") || c.req.header("x-request-id") || "req_unknown";
    const safeHeaders = redactHeaders(c.req.raw.headers);
    // The canonical alias is redacted here as well so a header-list change in
    // the transport middleware can never leak a raw key into structured logs.
    if (safeHeaders["x-vellum-api-key"]) safeHeaders["x-vellum-api-key"] = "[REDACTED]";
    if (safeHeaders["x-vellum-user-token"]) safeHeaders["x-vellum-user-token"] = "[REDACTED]";
    platform.logger.error("HTTP Request failed", {
      requestId: reqId,
      method: c.req.method,
      pathname: c.req.path,
      code: err instanceof VellumError ? err.code : "INTERNAL",
      // Only redacted values are ever logged — never raw JWTs, API keys or cookies.
      apiKey:
        safeHeaders["x-project-key"] || safeHeaders["x-vellum-api-key"] ? "[REDACTED]" : undefined,
      authorization: safeHeaders["authorization"] ? "[REDACTED]" : undefined,
      headers: safeHeaders,
    });
    return errorHandler(err, c);
  });

  // 1.0 Hardening headers for credential-bearing surfaces. Registered here,
  // before any route mount, so they apply to every auth/admin/console response
  // (and document-plane auth responses) without touching static dashboards.
  app.use("/v1/auth/*", securityHeaders());
  app.use("/v1/admin/*", securityHeaders());
  app.use("/v1/console/*", securityHeaders());
  app.use("/v1/projects/:projectId/auth/*", securityHeaders());

  // 1.0a Authentication throttles (contract §10). These MUST be registered
  // before the route mounts below, otherwise Hono will not run them.
  const LOGIN_LIMIT = { max: 10, windowMs: 15 * 60 * 1000 } as const;
  const REQUEST_LIMIT = { max: 5, windowMs: 15 * 60 * 1000, countAll: true } as const;
  const MFA_LIMIT = { max: 5, windowMs: 5 * 60 * 1000 } as const;

  // 10 failures / 15 min per (ip,email). `/v1/console/auth/login` does not
  // exist in this build (console uses the Better Auth wildcard), so it is
  // intentionally skipped.
  app.use("/v1/auth/sign-in/email", authRateLimit({ ...LOGIN_LIMIT, scope: "sign-in-email" }, platform.controlStore.throttle));
  app.use("/v1/auth/sign-up/email", authRateLimit({ ...LOGIN_LIMIT, scope: "sign-up-email" }, platform.controlStore.throttle));
  app.use("/v1/admin/login", authRateLimit({ ...LOGIN_LIMIT, scope: "admin-login" }, platform.controlStore.throttle));
  // Per-account failure ceiling that does NOT depend on the client IP. The
  // per-(ip,email) limits above are bypassed by anyone who can vary the apparent
  // source address (rotating proxies, a botnet, or a spoofable forwarding
  // header on a directly exposed deployment), so a password could be guessed
  // without limit. 50 failures / 15 min per account bounds that.
  const ACCOUNT_LIMIT = { max: 50, windowMs: 15 * 60 * 1000 } as const;
  const emailOnlyKey = (prefix: string) => async (c: Context): Promise<string> => {
    let email = "";
    try {
      const body = (await c.req.raw.clone().json()) as { email?: unknown } | null;
      if (typeof body?.email === "string") email = body.email.trim().toLowerCase();
    } catch {
      // No JSON body.
    }
    return sha256Hex(`${prefix}|${email}`);
  };
  app.use("/v1/auth/sign-in/email", authRateLimit({ ...ACCOUNT_LIMIT, scope: "sign-in-email-account", keyFrom: emailOnlyKey("console") }, platform.controlStore.throttle));
  app.use("/v1/admin/login", authRateLimit({ ...ACCOUNT_LIMIT, scope: "admin-login-account", keyFrom: emailOnlyKey("admin") }, platform.controlStore.throttle));
  app.use(
    "/v1/projects/:projectId/auth/sign-in/email",
    authRateLimit({
      ...ACCOUNT_LIMIT,
      scope: "enduser-sign-in-account",
      keyFrom: async (c) => `${c.req.param("projectId") ?? ""}|${await emailOnlyKey("enduser")(c)}`,
    }, platform.controlStore.throttle)
  );

  // Project END-USER credentials (`/v1/projects/:projectId/auth/*`). These were
  // previously unthrottled (the limits above cover only console routes). The key
  // includes projectId so tenants never share a bucket for the same ip/email.
  const endUserKey = async (c: Context): Promise<string> => {
    let email = "";
    try {
      const body = (await c.req.raw.clone().json()) as { email?: unknown } | null;
      if (typeof body?.email === "string") email = body.email.trim().toLowerCase();
    } catch {
      // No JSON body.
    }
    return sha256Hex(`${c.req.param("projectId") ?? ""}|${extractClientIp(c)}|${email}`);
  };
  const endUserIpKey = (c: Context): Promise<string> =>
    Promise.resolve(sha256Hex(`${c.req.param("projectId") ?? ""}|${extractClientIp(c)}`));
  // 10 failures / 15 min per (project, ip, email); lockout is enforced before the handler runs.
  app.use(
    "/v1/projects/:projectId/auth/sign-in/email",
    authRateLimit({ ...LOGIN_LIMIT, scope: "enduser-sign-in", keyFrom: endUserKey }, platform.controlStore.throttle)
  );
  // 30 sign-up attempts / 15 min per (project, ip); every attempt counts.
  app.use(
    "/v1/projects/:projectId/auth/sign-up/email",
    authRateLimit({ max: 30, windowMs: 15 * 60 * 1000, countAll: true, scope: "enduser-sign-up", keyFrom: endUserIpKey }, platform.controlStore.throttle)
  );
  app.use(
    "/v1/projects/:projectId/auth/sign-in/anonymous",
    authRateLimit({ max: 30, windowMs: 15 * 60 * 1000, countAll: true, scope: "enduser-anonymous", keyFrom: endUserIpKey }, platform.controlStore.throttle)
  );

  // OAuth: start and exchange count every request; 60 / 15 min per (project, ip).
  for (const path of ["oauth/:provider/start", "oauth/exchange", "oauth/google/id-token"]) {
    app.use(
      `/v1/projects/:projectId/auth/${path}`,
      authRateLimit({ max: 60, windowMs: 15 * 60 * 1000, countAll: true, scope: `enduser-${path}`, keyFrom: endUserIpKey }, platform.controlStore.throttle)
    );
  }

  // Redirect-less sign-in polls every ~2 s for up to 5 min, so it gets its own, larger budget.
  app.use(
    "/v1/projects/:projectId/auth/oauth/poll",
    authRateLimit({ max: 600, windowMs: 15 * 60 * 1000, countAll: true, scope: "enduser-oauth-poll", keyFrom: endUserIpKey }, platform.controlStore.throttle)
  );

  // Endpoints that check the current password for a signed-in user: 10 attempts / 15 min per (project, ip). Email changes through PATCH /user have their own per-user lockout.
  for (const [method, path, scope] of [
    ["POST", "password/change", "enduser-password-change"],
    ["DELETE", "user", "enduser-delete-user"],
    ["DELETE", "identities/:provider", "enduser-unlink"],
  ] as const) {
    const limit = authRateLimit({ max: 10, windowMs: 15 * 60 * 1000, countAll: true, scope, keyFrom: endUserIpKey }, platform.controlStore.throttle);
    app.use(`/v1/projects/:projectId/auth/${path}`, async (c, next) => (c.req.method === method ? limit(c, next) : next()));
  }

  // 5 requests / 15 min — every request counts (no account enumeration).
  app.use(
    "/v1/projects/:projectId/auth/password/reset",
    authRateLimit({ ...REQUEST_LIMIT, scope: "password-reset" }, platform.controlStore.throttle)
  );
  app.use(
    "/v1/projects/:projectId/auth/email/verify/request",
    authRateLimit({ ...REQUEST_LIMIT, scope: "email-verify-request" }, platform.controlStore.throttle)
  );

  // 5 failures / 5 min keyed by mfaTicket (challenge) or the caller identity.
  // Raw tickets/tokens are hashed so no plaintext secret is retained as a key.
  const mfaKey = async (c: Context): Promise<string> => {
    let ticket = "";
    let userId = "";
    try {
      const body = (await c.req.raw.clone().json()) as
        | { mfaTicket?: unknown; userId?: unknown }
        | null;
      if (typeof body?.mfaTicket === "string") ticket = body.mfaTicket;
      if (typeof body?.userId === "string") userId = body.userId;
    } catch {
      // No JSON body.
    }
    const bearer = c.req.header("x-vellum-user-token") ?? c.req.header("authorization") ?? "";
    return sha256Hex(`${ticket}|${userId}|${bearer}`);
  };
  app.use(
    "/v1/projects/:projectId/auth/mfa/challenge",
    authRateLimit({ ...MFA_LIMIT, scope: "mfa-challenge", keyFrom: mfaKey }, platform.controlStore.throttle)
  );
  app.use(
    "/v1/projects/:projectId/auth/mfa/verify",
    authRateLimit({ ...MFA_LIMIT, scope: "mfa-verify", keyFrom: mfaKey }, platform.controlStore.throttle)
  );
  app.use(
    "/v1/projects/:projectId/auth/mfa/disable",
    authRateLimit({ ...MFA_LIMIT, scope: "mfa-disable", keyFrom: mfaKey }, platform.controlStore.throttle)
  );

  // 1.1 TOTP MFA — must be mounted BEFORE the `/v1/auth/**` Better Auth wildcard.
  app.route(
    "/v1",
    createMfaRoutes({
      controlStore: platform.controlStore,
      sessionService: platform.sessionService,
      apiKeyPepper: platform.apiKeyPepper,
      logger: platform.logger,
    })
  );

  // 2. Customer Authentication Routes & Better Auth Endpoints
  app.route(
    "/v1",
    createCustomerAuthRoutes(platform.controlStore, {
      apiKeyPepper: platform.apiKeyPepper,
      jwtSecret: platform.jwtSecret,
      sessionService: platform.sessionService,
    })
  );
  const auth = createBetterAuth();
  app.on(["POST", "GET"], "/v1/auth/**", (c) => auth.handler(c.req.raw));

  // 3. Health & OpenAPI Specification (root /health & /ready + /v1/health/*)
  app.route("/", createRootHealthRoutes());
  app.route("/v1", healthRoutes);

  // 4. Control Plane Routes
  app.route(
    "/v1",
    createControlPlaneRoutes(
      platform.controlStore,
      platform.sessionService,
      platform.superAdminSessionService,
      platform.apiKeyPepper
    )
  );

  // 4.1 Admin Operator & Cluster Routes (session-authenticated)
  app.route(
    "/v1",
    createAdminRoutes(
      platform.controlStore,
      platform.dataStore,
      platform.sessionService,
      platform.superAdminSessionService
    )
  );

  // 4.2 Session-authenticated Console API (replaces master API keys for the dashboard)
  app.route("/v1", createConsoleRoutes(platform));

  // 4.3 Usage & metering (session-authenticated, live PostgreSQL reads)
  app.route("/v1", createUsageRoutes(platform.controlStore, platform.sessionService, platform.dataStore));

  // 4.4 End-User Auth REST tiers (project-scoped, customer admin, super admin)
  app.route(
    "/v1/projects/:projectId/auth/admin",
    createAuthCustomerAdminRoutes(platform)
  );
  app.route("/v1", createRealtimeSseRoutes(platform));
  app.route("/v1/projects/:projectId/auth", createAuthEndUserRoutes(platform));
  app.route("/v1/admin/auth", createAuthSuperAdminRoutes(platform));

  // 5. Document Plane Helper
  async function authenticateRequest(c: Context, projectId: string) {
    const project = await loadProject(platform.controlStore, projectId);
    if (project.status.toLowerCase() === "suspended") {
      throw new VellumError("PERMISSION_DENIED", `Project '${projectId}' has been suspended by platform administration`);
    }
    if (project.status.toLowerCase() === "throttled") {
      throw new VellumError("RATE_LIMITED", `Project '${projectId}' is currently throttled by platform administration`);
    }

    // API key is mandatory on the public document plane. No fallback
    // "console server key" may be synthesized when the header is missing.
    const rawApiKey = getApiKeyHeader(c);
    if (!rawApiKey) {
      throw new VellumError("UNAUTHENTICATED", "Missing X-Vellum-Api-Key (or legacy X-Project-Key) header");
    }
    const apiKeyRecord = await verifyApiKeyAsync(rawApiKey, platform.controlStore, platform.apiKeyPepper);
    if (apiKeyRecord.projectId !== project.id) {
      throw new VellumError(
        "PERMISSION_DENIED",
        "Provided API key does not belong to the requested project",
        { projectId }
      );
    }

    platform.rateLimiter.checkAndConsume(apiKeyRecord.keyPrefix, apiKeyRecord.rateLimitRps);

    // A present end-user token must be an EdDSA `vellum+enduser+jwt` token that
    // verifies against the project's Ed25519 auth config. There is no HS256
    // fallback. Invalid tokens propagate a 401 rather than silently degrading
    // to an anonymous context.
    const authContext = await resolveEndUserAuth(c, platform);

    return { project, apiKeyRecord, authContext };
  }

  interface SafeParseLike<T> {
    safeParse(value: unknown):
      | { success: true; data: T }
      | { success: false; error: { issues: Array<{ message?: string }> } };
  }

  function parseCollectionRequest<T>(schema: SafeParseLike<T>, value: unknown, label: string): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      // Explicit shape assertion: Vercel's function compiler uses its own TS
      // options and does not always narrow this discriminated union, although
      // the package tsconfig does. The runtime shape is guaranteed by the
      // SafeParseLike contract, so this is type-only and has no runtime cost.
      const failed = parsed as { error: { issues: Array<{ message?: string }> } };
      throw new VellumError("INVALID_ARGUMENT", `Invalid ${label}`, {
        issues: failed.error.issues.slice(0, 10),
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

  /** Collection lifecycle mutations are server-key-only on the public plane. */
  function requireServerKey(apiKeyRecord: { keyType: string }): void {
    if (apiKeyRecord.keyType !== "server") {
      throw new VellumError(
        "PERMISSION_DENIED",
        "Collection mutations require a server API key (sk_)"
      );
    }
  }

  /** Metering and audit must never turn a successful mutation into an error. */
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

  async function recordCollectionAudit(input: {
    action: string;
    organizationId: string;
    projectId: string;
    name: string;
    keyId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await platform.controlStore.recordAuditLog({
        action: input.action,
        organizationId: input.organizationId,
        projectId: input.projectId,
        targetId: input.name,
        actorType: "api_key",
        actorUserId: input.keyId,
        metadata: input.metadata ?? {},
      });
    } catch (err) {
      platform.logger.warn("Collection audit log failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Safely decode a URL path segment, converting malformed encodings to 400. */
  function safeDecodePath(raw: string): string {
    try {
      return decodeURIComponent(raw);
    } catch {
      throw new VellumError("INVALID_ARGUMENT", "Malformed URL encoding in document path");
    }
  }

  /** Clamp collection listing limits to the canonical [1, MAX_QUERY_LIMIT] range. */
  function clampListLimit(raw: string | null): number {
    if (!raw) return 50;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 1) return 50;
    return Math.min(Math.floor(parsed), SYSTEM_LIMITS.MAX_QUERY_LIMIT);
  }

  /** Parse a JSON-encoded query parameter safely (prototype-pollution & depth guarded). */
  function parseJsonQueryParam<T>(value: string | null | undefined): T | undefined {
    if (typeof value !== "string" || value.length === 0) return undefined;
    try {
      return safeJsonParse<T>(value);
    } catch {
      return undefined;
    }
  }

  /**
   * Extract V2 write options from a document request body into EngineContext.
   * ALLOWLIST ONLY: every EngineContext passed to the engine in this file is
   * built from named, authenticated fields (projectId, apiKeyRecord,
   * authContext) plus the three keys below. Request bodies are
   * NEVER spread into ctx, so privileged fields (`bypassRules`, `internal`,
   * `debug`, `idempotencyKey`, `rateLimitKey`) cannot be forwarded by a caller.
   */
  /**
   * Document data must be a JSON object. The `body.data ?? body` shorthand
   * would otherwise accept a bare string/array/number body and persist it as
   * a character- or index-keyed object, silently corrupting the document.
   */
  function requireDocumentData(body: unknown): Record<string, unknown> {
    const data = (body as Record<string, unknown> | null)?.["data"] ?? body;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new VellumError("INVALID_ARGUMENT", "Document data must be a JSON object");
    }
    return data as Record<string, unknown>;
  }

  function v2WriteOptions(body: Record<string, unknown>): Record<string, unknown> {
    const opts: Record<string, unknown> = {};
    if (typeof body["ttlSeconds"] === "number") opts["ttlSeconds"] = body["ttlSeconds"];
    if (typeof body["expiresAt"] === "string" || body["expiresAt"] === null) {
      opts["expiresAt"] = body["expiresAt"];
    }
    if (typeof body["upsert"] === "boolean") opts["upsert"] = body["upsert"];
    return opts;
  }

  // Header-only opt-in. Scope replay to the authenticated credentials and exact
  // request so another caller or operation cannot retrieve a cached response.
  function mutationIdempotency(c: Context, body: unknown, apiKeyId: string, uid: string | null): { idempotencyKey?: string } {
    const key = c.req.header("Idempotency-Key");
    if (key === undefined) return {};
    if (key.length === 0 || key.length > 256 || key.includes("\u0000")) {
      throw new VellumError("INVALID_ARGUMENT", "Invalid Idempotency-Key header");
    }
    return { idempotencyKey: sha256Hex(JSON.stringify([
      key, c.req.method, new URL(c.req.url).pathname, body,
      apiKeyId, uid,
    ])) };
  }

  // 5.1 V2 endpoints (aggregate, bulk-delete, rules DSL, recommendations).
  // Mounted before the `/documents/*` wildcard so `documents:aggregate` and
  // `documents:bulk-delete` resolve to their exact routes.
  app.route(
    "/v1",
    createV2Routes(platform, {
      authenticateRequest,
      recorder,
    })
  );

  // 6. Document Plane Routes (`/v1/projects/:projectId/...`)
  // 6.1 Structured Query
  app.post("/v1/projects/:projectId/query", async (c) => {
    const projectId = c.req.param("projectId");
    const { project, apiKeyRecord, authContext } = await authenticateRequest(c, projectId);

    const body = await c.req.json();
    const result = await platform.documentEngine.executeQuery({
      projectId,
      querySpec: body,
      apiKeyRecord,
      authContext,
    });
    await adviseQuery(
      c,
      body as Record<string, unknown>,
      {
        projectId,
        orgId: project.organizationId,
      },
      body,
      result.meta?.executionTimeMs ?? 0
    );
    return c.json(result);
  });

  // 6.2 Batch Write
  app.post("/v1/projects/:projectId/batchWrite", async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await authenticateRequest(c, projectId);

    const body = await c.req.json();
    const writes = (body.writes ?? body.operations) as BatchMutation[];
    const result = await platform.documentEngine.batchWrite({
      projectId,
      writes,
      ...mutationIdempotency(c, body, apiKeyRecord.id, authContext.uid),
      apiKeyRecord,
      authContext,
    });
    return c.json(result);
  });

  app.post("/v1/projects/:projectId/documents:batchWrite", async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await authenticateRequest(c, projectId);

    const body = await c.req.json();
    const writes = (body.writes ?? body.operations) as BatchMutation[];
    const result = await platform.documentEngine.batchWrite({
      projectId,
      writes,
      ...mutationIdempotency(c, body, apiKeyRecord.id, authContext.uid),
      apiKeyRecord,
      authContext,
    });
    return c.json(result);
  });

  // 6.3 OCC Transactions
  app.post("/v1/projects/:projectId/transactions:begin", async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await authenticateRequest(c, projectId);

    const result = await platform.documentEngine.beginTransaction({
      projectId,
      apiKeyRecord,
      authContext,
    });
    return c.json(result);
  });

  app.post("/v1/projects/:projectId/transactions:commit", async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await authenticateRequest(c, projectId);

    const body = await c.req.json();
    type RawWrite = {
      ifVersion?: unknown;
      exists?: unknown;
      preconditions?: Record<string, unknown> | null;
      precondition?: Record<string, unknown> | null;
    };
    const rawWrites = (body.writes ?? body.mutations ?? []) as RawWrite[];
    const writes = rawWrites.map((m) => ({
      ...m,
      ifVersion: m.ifVersion ?? m.preconditions?.["ifVersion"] ?? m.precondition?.["version"],
      exists: m.exists ?? m.preconditions?.["exists"] ?? m.precondition?.["exists"],
    })) as BatchMutation[];
    const result = await platform.documentEngine.commitTransaction({
      projectId,
      transactionToken: body.transactionToken as string,
      writes,
      apiKeyRecord,
      authContext,
    });
    return c.json(result);
  });

  // 6.4 Composite Indexes
  app.get("/v1/projects/:projectId/indexes", async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await authenticateRequest(c, projectId);

    authorizeOperation({
      apiKeyRecord,
      rulesetRecord: null,
      operation: "indexes:manage",
      path: "indexes",
      authContext,
    });

    const indexes = await listIndexesReconciled(platform, projectId);
    return c.json({ indexes });
  });

  app.post("/v1/projects/:projectId/indexes", async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await authenticateRequest(c, projectId);

    authorizeOperation({
      apiKeyRecord,
      rulesetRecord: null,
      operation: "indexes:manage",
      path: "indexes",
      authContext,
    });

    const body = await c.req.json();
    parseCollectionPath(body.collectionPath as string);
    if (!Array.isArray(body.fields) || body.fields.length === 0) {
      throw new VellumError("INVALID_ARGUMENT", "Composite index requires a non-empty 'fields' array");
    }

    // Normalize the accepted legacy field shape ({ path, direction }) to the
    // canonical ({ path, dir }) so the query planner can match the index, same
    // as the console route does.
    const created = await platform.dataStore.createCompositeIndex(
      { projectId },
      body.collectionPath as string,
      (body.fields as Array<Parameters<typeof normalizeIndexFieldSpec>[0]>).map(normalizeIndexFieldSpec)
    );
    const built = await refreshIndexRecord(platform, projectId, created);
    // The dashboard deep-link carries the advisor fingerprint. Mark it applied
    // so the same suggestion is not recorded again after the index is created.
    if (typeof body.fingerprint === "string" && body.fingerprint.length > 0) {
      try {
        await recorder.markAppliedByFingerprint(projectId, body.fingerprint);
      } catch (err) {
        platform.logger.warn("Failed to mark index recommendation applied", {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return c.json(built, 201);
  });

  app.delete("/v1/projects/:projectId/indexes/:indexId", async (c) => {
    const projectId = c.req.param("projectId");
    const indexId = c.req.param("indexId");
    const { apiKeyRecord, authContext } = await authenticateRequest(c, projectId);

    authorizeOperation({
      apiKeyRecord,
      rulesetRecord: null,
      operation: "indexes:manage",
      path: "indexes",
      authContext,
    });

    await platform.dataStore.deleteCompositeIndex(
      { projectId },
      indexId
    );
    return c.json({ deleted: true, indexId });
  });

  // 6.45 Collections lifecycle (API-key auth). Registered before the
  // `/documents/*` wildcard so literal `:name/clear|import|export` segments
  // always resolve here. Reads accept pk_/sk_ keys; mutations require sk_.
  app.get("/v1/projects/:projectId/collections", async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await authenticateRequest(c, projectId);
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

    // Both key types see the same registry view. There is no collection-level
    // rules concept available here, so no key-type-specific filtering is added.
    return c.json(
      await platform.documentEngine.listCollections(
        { projectId, apiKeyRecord, authContext },
        {
          ...(query.search === undefined ? {} : { search: query.search }),
          limit: query.limit,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        }
      )
    );
  });

  app.post("/v1/projects/:projectId/collections", async (c) => {
    const projectId = c.req.param("projectId");
    const { project, apiKeyRecord, authContext } = await authenticateRequest(c, projectId);
    requireServerKey(apiKeyRecord);
    const body: CreateCollectionRequest = parseCollectionRequest(
      CreateCollectionSchema,
      await c.req.json(),
      "collection"
    );
    const created = await platform.documentEngine.createCollection(
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
    if (platform.documentEngine.audit === undefined) {
      await recordCollectionAudit({
        action: "collection.create",
        organizationId: project.organizationId,
        projectId,
        name: body.name,
        keyId: apiKeyRecord.id,
      });
    }
    return c.json(created, 201);
  });

  app.get("/v1/projects/:projectId/collections/:name", async (c) => {
    const projectId = c.req.param("projectId");
    const name = c.req.param("name");
    const { apiKeyRecord, authContext } = await authenticateRequest(c, projectId);
    const collection = await platform.documentEngine.getCollection(
      { projectId, apiKeyRecord, authContext },
      name
    );
    return c.json(collection);
  });

  app.patch("/v1/projects/:projectId/collections/:name", async (c) => {
    const projectId = c.req.param("projectId");
    const name = c.req.param("name");
    const { project, apiKeyRecord, authContext } = await authenticateRequest(c, projectId);
    requireServerKey(apiKeyRecord);
    const patch: UpdateCollectionRequest = parseCollectionRequest(
      UpdateCollectionSchema,
      await c.req.json(),
      "collection update"
    );
    const updated = await platform.documentEngine.updateCollection(
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
    if (platform.documentEngine.audit === undefined) {
      await recordCollectionAudit({
        action: "collection.update",
        organizationId: project.organizationId,
        projectId,
        name,
        keyId: apiKeyRecord.id,
        metadata: { operation: "settings" },
      });
    }
    return c.json(updated);
  });

  app.post("/v1/projects/:projectId/collections/:name/clear", async (c) => {
    const projectId = c.req.param("projectId");
    const name = c.req.param("name");
    const { project, apiKeyRecord, authContext } = await authenticateRequest(c, projectId);
    requireServerKey(apiKeyRecord);
    const result = await platform.documentEngine.clearCollection(
      {
        projectId,
        orgId: project.organizationId,
        apiKeyRecord,
        authContext,
      },
      name
    );
    // Phase 2A engine hooks meter/audit when wired; the guards keep a single
    // authoritative count when a platform is built without those hooks.
    if (platform.documentEngine.metering === undefined) {
      recordCollectionDeletes(
        project.organizationId,
        projectId,
        result.deletedCount,
        result.freedBytes
      );
    }
    if (platform.documentEngine.audit === undefined) {
      await recordCollectionAudit({
        action: "collection.clear",
        organizationId: project.organizationId,
        projectId,
        name,
        keyId: apiKeyRecord.id,
        metadata: { deletedCount: result.deletedCount, freedBytes: result.freedBytes },
      });
    }
    return c.json(result);
  });

  app.delete("/v1/projects/:projectId/collections/:name", async (c) => {
    const projectId = c.req.param("projectId");
    const name = c.req.param("name");
    const { project, apiKeyRecord, authContext } = await authenticateRequest(c, projectId);
    requireServerKey(apiKeyRecord);
    const result = await platform.documentEngine.deleteCollection(
      {
        projectId,
        orgId: project.organizationId,
        apiKeyRecord,
        authContext,
      },
      name
    );
    if (platform.documentEngine.metering === undefined) {
      recordCollectionDeletes(
        project.organizationId,
        projectId,
        result.deletedDocuments,
        result.freedBytes
      );
    }
    if (platform.documentEngine.audit === undefined) {
      await recordCollectionAudit({
        action: "collection.delete",
        organizationId: project.organizationId,
        projectId,
        name,
        keyId: apiKeyRecord.id,
        metadata: {
          deletedCollection: result.deletedCollection,
          deletedDocuments: result.deletedDocuments,
          freedBytes: result.freedBytes,
        },
      });
    }
    return c.json(result);
  });

  app.post("/v1/projects/:projectId/collections/:name/import", async (c) => {
    const projectId = c.req.param("projectId");
    const name = c.req.param("name");
    const { project, apiKeyRecord, authContext } = await authenticateRequest(c, projectId);
    requireServerKey(apiKeyRecord);
    // Accept both the bare-array REST shape and the `{documents, mode}` shape
    // used by the JS/Flutter SDKs and the Dashboard (TASK collections Phase 5).
    const importRequest = parseCollectionRequest(
      ImportCollectionRequestSchema,
      await c.req.json(),
      "collection import"
    );
    const { documents, mode } = normalizeImportRequest(importRequest);
    // The wire shape nests `data`; the engine consumes the document payload
    // itself and derives the id from `data.id`, so flatten it here.
    const docs: Record<string, unknown>[] = documents.map((entry) =>
      entry.id === undefined ? { ...entry.data } : { ...entry.data, id: entry.id }
    );
    const result = await platform.documentEngine.importCollectionDocuments(
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
    if (platform.documentEngine.audit === undefined) {
      await recordCollectionAudit({
        action: "collection.update",
        organizationId: project.organizationId,
        projectId,
        name,
        keyId: apiKeyRecord.id,
        metadata: { operation: "import", documentCount: docs.length },
      });
    }
    return c.json(result);
  });

  app.get("/v1/projects/:projectId/collections/:name/export", async (c) => {
    const projectId = c.req.param("projectId");
    const name = c.req.param("name");
    const { apiKeyRecord, authContext } = await authenticateRequest(c, projectId);
    return c.json(
      await platform.documentEngine.exportCollectionDocuments(
        { projectId, apiKeyRecord, authContext },
        name,
        {
          ...(c.req.query("limit") === undefined ? {} : { limit: Number(c.req.query("limit")) }),
          ...(c.req.query("cursor") === undefined ? {} : { cursor: c.req.query("cursor") }),
        }
      )
    );
  });

  // 6.5 Document CRUD and Collection Listing
  app.get("/v1/projects/:projectId/documents/*", async (c) => {
    const projectId = c.req.param("projectId");
    const { project, apiKeyRecord, authContext } = await authenticateRequest(c, projectId);

    const url = new URL(c.req.url);
    const prefix = `/v1/projects/${projectId}/documents/`;
    const docOrColPath = safeDecodePath(url.pathname.slice(prefix.length));
    const segments = docOrColPath.split("/").filter(Boolean);

    // Collection listing (odd segments)
    if (segments.length % 2 === 1) {
      const limit = clampListLimit(url.searchParams.get("limit"));
      const startAfter = url.searchParams.get("startAfter") ?? undefined;
      const querySpec = { collectionPath: docOrColPath, limit, startAfter } as Record<string, unknown>;
      const select = parseJsonQueryParam<string[]>(url.searchParams.get("select"));
      const include = parseJsonQueryParam<unknown[]>(url.searchParams.get("include"));
      if (select !== undefined) querySpec["select"] = select;
      if (include !== undefined) querySpec["include"] = include;
      const queryResult = await platform.documentEngine.executeQuery({
        projectId,
          querySpec,
        apiKeyRecord,
        authContext,
      });
      await adviseQuery(
        c,
        querySpec,
        {
          projectId,
          orgId: project.organizationId,
        },
        querySpec,
        queryResult.meta?.executionTimeMs ?? 0
      );
      return c.json(queryResult);
    }

    // Document get (even segments)
    const txToken =
      url.searchParams.get("transactionToken") ??
      url.searchParams.get("txToken") ??
      c.req.header("x-transaction-token") ??
      null;
    const docInclude = parseJsonQueryParam<IncludeSpec[]>(url.searchParams.get("include"));
    const docSelect = parseJsonQueryParam<string[]>(url.searchParams.get("select"));
    const doc = await platform.documentEngine.getDocument({
      projectId,
      path: docOrColPath,
      apiKeyRecord,
      authContext,
      transactionToken: txToken,
      ...(docInclude === undefined ? {} : { include: docInclude }),
      ...(docSelect === undefined ? {} : { select: docSelect }),
    });
    return c.json(doc);
  });

  app.post("/v1/projects/:projectId/documents/*", async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await authenticateRequest(c, projectId);

    const url = new URL(c.req.url);
    const prefix = `/v1/projects/${projectId}/documents/`;
    const docPath = safeDecodePath(url.pathname.slice(prefix.length));

    const body = await c.req.json();
    const created = await platform.documentEngine.createDocument({
      projectId,
      path: docPath,
      data: requireDocumentData(body),
      ...v2WriteOptions(body as Record<string, unknown>),
      ...mutationIdempotency(c, body, apiKeyRecord.id, authContext.uid),
      apiKeyRecord,
      authContext,
    });
    return c.json(created, 201);
  });

  app.put("/v1/projects/:projectId/documents/*", async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await authenticateRequest(c, projectId);

    const url = new URL(c.req.url);
    const prefix = `/v1/projects/${projectId}/documents/`;
    const docPath = safeDecodePath(url.pathname.slice(prefix.length));

    const body = await c.req.json();
    const merge = Boolean(body.merge ?? url.searchParams.get("merge") === "true");
    const ifVersion = typeof body.ifVersion === "number" ? body.ifVersion : null;

    const saved = await platform.documentEngine.setDocument({
      projectId,
      path: docPath,
      data: requireDocumentData(body),
      merge,
      ifVersion,
      ...v2WriteOptions(body as Record<string, unknown>),
      ...mutationIdempotency(c, body, apiKeyRecord.id, authContext.uid),
      apiKeyRecord,
      authContext,
    });
    return c.json(saved);
  });

  app.patch("/v1/projects/:projectId/documents/*", async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await authenticateRequest(c, projectId);

    const url = new URL(c.req.url);
    const prefix = `/v1/projects/${projectId}/documents/`;
    const docPath = safeDecodePath(url.pathname.slice(prefix.length));

    const body = await c.req.json();
    const ifVersion = typeof body.ifVersion === "number" ? body.ifVersion : null;

    const updated = await platform.documentEngine.updateDocument({
      projectId,
      path: docPath,
      data: requireDocumentData(body),
      ifVersion,
      ...v2WriteOptions(body as Record<string, unknown>),
      ...mutationIdempotency(c, body, apiKeyRecord.id, authContext.uid),
      apiKeyRecord,
      authContext,
    });
    return c.json(updated);
  });

  app.delete("/v1/projects/:projectId/documents/*", async (c) => {
    const projectId = c.req.param("projectId");
    const { apiKeyRecord, authContext } = await authenticateRequest(c, projectId);

    const url = new URL(c.req.url);
    const prefix = `/v1/projects/${projectId}/documents/`;
    const docPath = safeDecodePath(url.pathname.slice(prefix.length));
    const ifVersionParam = url.searchParams.get("ifVersion");

    const deleted = await platform.documentEngine.deleteDocument({
      projectId,
      path: docPath,
      ifVersion: ifVersionParam !== null ? Number(ifVersionParam) : null,
      ...mutationIdempotency(c, null, apiKeyRecord.id, authContext.uid),
      apiKeyRecord,
      authContext,
    });
    return c.json(deleted);
  });

  // 7. Realm-bound guards for the two control-plane surfaces. Public bootstrap
  // and refresh endpoints are exempted here so they remain reachable.
  // The new fortress admin surfaces distinguish a valid customer session
  // (403 PERMISSION_DENIED) from a missing/invalid one (401). The generic
  // realm guard below still applies to all other admin routes unchanged.
  const rejectCustomerOnFortressAdmin = async (c: Context, next: () => Promise<void>) => {
    const token = extractBearerToken(c.req.header("authorization"));
    if (token !== null) {
      try {
        const claims = (await platform.consoleSessionService.verifyAccessChecked(token)) as {
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
  };
  app.use("/v1/admin/security/*", rejectCustomerOnFortressAdmin);
  app.use("/v1/admin/billing/*", rejectCustomerOnFortressAdmin);

  app.use(
    "/v1/console/*",
    requireCustomerConsoleSession(platform, undefined, ["/v1/console/auth/refresh"])
  );
  app.use(
    "/v1/admin/*",
    requireSuperAdminSession(platform, undefined, [
      "/v1/admin/login",
      "/v1/admin/setup-status",
      "/v1/admin/setup-owner",
      "/v1/admin/auth/session/refresh",
    ])
  );

  // Security Fortress control surfaces (customer billing + super-admin
  // security/revenue). Must precede the catch-all; realm guards are internal.
  app.route("/v1", createFortressRoutes(platform));

  // Catch-all 404
  app.all("*", (c) => {
    throw new VellumError("NOT_FOUND", `Route '${c.req.method} ${c.req.path}' not found`);
  });

  return app;
}

