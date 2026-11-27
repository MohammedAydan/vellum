/**
 * @vellum/api - Security Fortress + Metering/Billing middleware wiring.
 *
 * Implements the locked registration order from
 * `docs/SECURITY-BILLING-CONTRACT.md` §5. All hot-path work here is synchronous
 * and in-memory: no middleware performs database I/O or writes transaction
 * state. Startup cache priming is fire-and-forget so an empty control plane can
 * never prevent the API from booting.
 */

import type { Context, Hono } from "hono";
import type { ErrorCode } from "@vellum/core";
import { VellumError, SYSTEM_LIMITS } from "@vellum/core";
import { QuotaGuard, UsageMeteringEngine } from "@vellum/billing";
import type { MeteringLogger, QuotaDecision, QuotaOperation } from "@vellum/billing";
import { ThreatDetector } from "@vellum/security";
import type { GuardOutcome, ThreatCategory } from "@vellum/security";
import {
  assertQueryCost,
  assertSafeJsonPayload,
  deriveChainKey,
  PAYLOAD_LIMITS,
  securityHeaders,
  verifyCsrfOrigin,
} from "@vellum/security";
import {
  assertSafeJsonStructure,
  constantTimeEqual,
  DEFAULT_MAX_JSON_KEYS,
  extractClientIp,
} from "./security.js";
import type { JsonSafetyOutcome } from "./security.js";

import type { ControlPlaneRepository } from "@vellum/database-control";

const METERING_INTERVAL_MS = 5_000;

export interface FortressServices {
  threatDetector: ThreatDetector;
  metering: UsageMeteringEngine;
  quota: QuotaGuard;
  chainKeys: { security: Buffer; billing: Buffer };
}

export interface FortressServiceOptions {
  controlStore: ControlPlaneRepository;
  logger: {
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
  masterKey?: string;
  corsOrigins?: readonly string[];
}

export interface FortressMiddlewareOptions {
  corsOrigins: readonly string[];
  isProd: boolean;
  controlStore: ControlPlaneRepository;
  getOrgIdForProject?: (projectId: string) => Promise<string | null>;
}

/** Best-effort bridge from the platform logger into the metering flush logger. */
function makeMeteringLogger(
  logger: FortressServiceOptions["logger"]
): MeteringLogger {
  return {
    error: (message: string, error?: unknown): void => {
      logger.error(message, error === undefined ? {} : { error });
    },
    warn: (message: string, error?: unknown): void => {
      logger.warn(message, error === undefined ? {} : { error });
    },
  };
}

/**
 * Build the three fortress services and prime their in-process caches. The
 * function is intentionally synchronous: store refreshes are scheduled as a
 * detached task whose failures are swallowed.
 */
const BATCH_PATH = /\/(?:documents:batchWrite|batchWrite|transactions:commit)$/;

// Ruleset publishing (security rules, relation rules, compile/decompile/simulate) carries a
// single large rules AST in the body, not user documents, so the 500-key per-document cap
// with its batch wording was both too small and misleading there. These routes get their own
// budget and error.
const RULESET_PATH = /\/(?:rulesets|relation-rules|rules\/(?:compile|decompile|simulate))$/;

// Collection import carries many documents in one request (a bare array, or
// `{ documents, mode }`); each document gets its own key budget.
const IMPORT_PATH = /\/collections\/[^/]+\/import$/;
// Auth users:import carries up to 100 user records in one request.
const USERS_IMPORT_PATH = /\/users:import$/;
// Single-document reads/writes (`/v1/.../documents/<path>` and the console equivalents).
const DOCUMENT_PATH = /\/documents\//;

const DOCUMENT_KEY_LIMITS = {
  ...PAYLOAD_LIMITS,
  maxObjectKeys: SYSTEM_LIMITS.DOCUMENT_MAX_OBJECT_KEYS,
};

/** Accurate message when one document (or one write in a batch) exceeds the key budget. */
function documentKeyFailure(): GuardOutcome {
  return {
    ok: false,
    code: "INVALID_ARGUMENT",
    message: `A single document exceeds ${SYSTEM_LIMITS.DOCUMENT_MAX_OBJECT_KEYS} object keys. Split large documents into smaller documents or subcollections.`,
  };
}

function checkDocumentKeys(data: unknown): GuardOutcome {
  const outcome = assertSafeJsonPayload(data, DOCUMENT_KEY_LIMITS);
  if (!outcome.ok && outcome.message.startsWith("Total object keys")) {
    return documentKeyFailure();
  }
  return outcome;
}

/** Envelope + per-item check for routes that carry a list of documents/writes. */
function checkItemsPayload(body: unknown, fields: readonly string[]): GuardOutcome | null {
  if (Array.isArray(body)) {
    for (const item of body) {
      const outcome = checkDocumentKeys(item);
      if (!outcome.ok) return outcome;
    }
    return { ok: true };
  }
  if (body !== null && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const field of fields) {
      const items = record[field];
      if (Array.isArray(items)) {
        const envelope = assertSafeJsonPayload({ ...record, [field]: [] });
        if (!envelope.ok) return envelope;
        for (const item of items) {
          const outcome = checkDocumentKeys(item);
          if (!outcome.ok) return outcome;
        }
        return { ok: true };
      }
    }
  }
  return null;
}

/** Payload guard with per-route key budgets. */
function checkJsonPayloadForRoute(path: string, body: unknown): GuardOutcome {
  if (RULESET_PATH.test(path)) {
    const outcome = assertSafeJsonPayload(body, {
      ...PAYLOAD_LIMITS,
      maxObjectKeys: SYSTEM_LIMITS.RULESET_MAX_OBJECT_KEYS,
    });
    if (!outcome.ok && outcome.message.startsWith("Total object keys")) {
      return {
        ok: false,
        code: "RULESET_TOO_LARGE",
        message: `The ruleset is too large: it has more than ${SYSTEM_LIMITS.RULESET_MAX_OBJECT_KEYS} object keys. Simplify the rules or split them across more collections.`,
      };
    }
    return outcome;
  }
  if (BATCH_PATH.test(path)) {
    const checked = checkItemsPayload(body, ["writes", "operations", "mutations"]);
    if (checked !== null) return checked;
  }
  if (IMPORT_PATH.test(path)) {
    const checked = checkItemsPayload(body, ["documents"]);
    if (checked !== null) return checked;
  }
  if (USERS_IMPORT_PATH.test(path)) {
    const checked = checkItemsPayload(body, ["users"]);
    if (checked !== null) return checked;
  }
  if (DOCUMENT_PATH.test(path)) {
    return checkDocumentKeys(body);
  }
  return assertSafeJsonPayload(body);
}

export function createFortressServices(options: FortressServiceOptions): FortressServices {
  const masterKey =
    options.masterKey ?? process.env["MASTER_ENCRYPTION_KEY"] ?? "vellum-fortress-master-v1";
  const chainKeys = {
    security: deriveChainKey(masterKey, "security-audit-v1"),
    billing: deriveChainKey(masterKey, "billing-ledger-v1"),
  };

  const threatDetector = new ThreatDetector();
  const metering = new UsageMeteringEngine({
    billing: options.controlStore.billing,
    chainKey: chainKeys.billing,
    logger: makeMeteringLogger(options.logger),
  });
  const quota = new QuotaGuard({
    billing: options.controlStore.billing,
    chainKey: chainKeys.billing,
  });

  void (async () => {
    try {
      const entries = await options.controlStore.security.listBlocklist(true);
      threatDetector.refreshFromStore(entries);
    } catch {
      // Blocklist is an in-process accelerator; the durable store remains authoritative.
    }
  })();

  metering.start(METERING_INTERVAL_MS);
  return { threatDetector, metering, quota, chainKeys };
}

/** Spoof-resistant client IP extraction (rightmost untrusted hop). */
export function requestIp(c: Context): string {
  return extractClientIp(c);
}

function isDocumentPlanePath(path: string): boolean {
  return path.startsWith("/v1/projects/") || path.startsWith("/v1/console/projects/");
}

function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function projectIdFromContext(c: Context): string | null {
  const param = c.req.param("projectId");
  if (typeof param === "string" && param.length > 0) return param;
  const segments = pathSegments(c.req.path);
  const index = segments.indexOf("projects");
  return index >= 0 ? (segments[index + 1] ?? null) : null;
}

function normalizeOrigin(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\/+$/, "").toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Browsers send no Origin header on a same-origin GET or HEAD, so an app served from the API's own host
 * would be locked out of a key with allowedOrigins. For exactly that case the request's own origin stands in,
 * when the browser also says Sec-Fetch-Site: same-origin (a forbidden header that page scripts cannot set).
 * Every other request without an Origin header is still refused. Origin is a browser-side control; a
 * non-browser client can already send any Origin it likes, so this opens nothing new to them.
 */
export function effectiveRequestOrigin(
  method: string,
  header: (name: string) => string | undefined
): string | null {
  const origin = header("origin");
  if (typeof origin === "string" && origin.trim().length > 0) return normalizeOrigin(origin);
  const verb = method.toUpperCase();
  if (verb !== "GET" && verb !== "HEAD") return null;
  if (header("sec-fetch-site")?.trim().toLowerCase() !== "same-origin") return null;
  const host = (header("x-forwarded-host") ?? header("host"))?.split(",")[0]?.trim();
  if (!host || /[\s/@]/.test(host)) return null;
  const proto = header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto !== "https" && proto !== "http") return null;
  return normalizeOrigin(`${proto}://${host}`);
}

function quotaOperationFor(method: string, path: string): QuotaOperation {
  if (path.includes("/realtime")) return "ws_connect";
  switch (method.toUpperCase()) {
    case "DELETE":
      return "delete";
    case "POST":
    case "PUT":
    case "PATCH":
      return path.endsWith("/query") || path.includes("/documents:aggregate") ? "read" : "write";
    case "GET":
    case "HEAD":
    case "OPTIONS":
    default:
      return "read";
  }
}

function safeRecord(
  detector: ThreatDetector,
  category: ThreatCategory,
  sourceIp: string,
  summary: string,
  evidence: Record<string, unknown>
): void {
  try {
    detector.record({ severity: "high", category, sourceIp, summary, evidence });
  } catch {
    // Threat recording must never break a request.
  }
}

/**
 * Translate a quota decision into a canonical error. The §9 codes are not yet
 * members of the `@vellum/core` ErrorCode union, so the literal status is also
 * attached to `details` for consumers that honour it.
 */
function quotaErrorFromDecision(decision: QuotaDecision): VellumError {
  const rawCode = decision.code;
  const code = (rawCode ?? "RATE_LIMITED") as ErrorCode;
  const details: Record<string, unknown> = {
    ...(decision.statusCode === undefined ? {} : { statusCode: decision.statusCode }),
    ...(rawCode === undefined ? {} : { decisionCode: rawCode }),
    ...(decision.metric === undefined ? {} : { metric: decision.metric }),
    ...(decision.used === undefined ? {} : { used: decision.used }),
    ...(decision.limit === undefined ? {} : { limit: decision.limit }),
    ...(decision.currentCents === undefined ? {} : { currentCents: decision.currentCents }),
    ...(decision.capCents === undefined ? {} : { capCents: decision.capCents }),
  };
  return new VellumError(code, rawCode ?? "Quota exceeded", details);
}

/**
 * Register all eight fortress middlewares in the contract-mandated order.
 */
export function attachFortressMiddleware(
  app: Hono,
  services: FortressServices,
  options: FortressMiddlewareOptions
): void {
  // 1. Security response headers (merge; never remove X-Request-Id).
  app.use("*", async (c, next) => {
    try {
      const headers = securityHeaders({ isProd: options.isProd, isHtml: false });
      for (const [name, value] of Object.entries(headers)) {
        if (!c.res.headers.has(name)) c.header(name, value);
      }
      // Always ensure HSTS, nosniff, DENY framing, and Referrer-Policy on API responses.
      if (!c.res.headers.has("Strict-Transport-Security")) {
        c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      }
      if (!c.res.headers.has("X-Content-Type-Options")) {
        c.header("X-Content-Type-Options", "nosniff");
      }
      if (!c.res.headers.has("X-Frame-Options")) {
        c.header("X-Frame-Options", "DENY");
      }
      if (!c.res.headers.has("Referrer-Policy")) {
        c.header("Referrer-Policy", "no-referrer");
      }
    } catch {
      // Header augmentation is cosmetic; never break a request.
    }
    await next();
  });

  // 2. Circuit-breaker blocklist (instant 403).
  app.use("*", async (c, next) => {
    const ip = requestIp(c);
    let blocked = false;
    let reason: string | undefined;
    let expiresAt: string | undefined;
    try {
      const decision = services.threatDetector.isBlocked("ip", ip);
      blocked = decision.blocked;
      reason = decision.reason;
      expiresAt = decision.expiresAt;
    } catch {
      blocked = false;
    }
    if (blocked) {
      throw new VellumError("PERMISSION_DENIED", "IP_BLOCKED", {
        ip,
        ...(reason === undefined ? {} : { reason }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
    }
    await next();
  });

  // 3. Request body size cap: 5 MiB for batch writes / imports, 1 MiB otherwise.
  // Enforces both Content-Length and actual stream length (prevents chunked bypass).
  app.use("*", async (c, next) => {
    const isBatch =
      c.req.path.includes("batchWrite") ||
      c.req.path.includes(":batchWrite") ||
      c.req.path.endsWith("/import") ||
      c.req.path.endsWith("/users:import");
    const limit = isBatch
      ? SYSTEM_LIMITS.MAX_BATCH_PAYLOAD_BYTES
      : SYSTEM_LIMITS.MAX_DOCUMENT_BYTES;

    const rawLength = c.req.header("content-length");
    if (typeof rawLength === "string" && rawLength.length > 0) {
      const length = Number(rawLength);
      if (Number.isFinite(length) && length > limit) {
        // A single oversized document keeps its canonical public code;
        // batch/other oversized payloads use PAYLOAD_TOO_LARGE (both 413).
        throw new VellumError(
          isBatch ? "PAYLOAD_TOO_LARGE" : "DOCUMENT_TOO_LARGE",
          `Request body exceeds ${limit} bytes`,
          { limit, contentLength: length, path: c.req.path }
        );
      }
    } else if (
      c.req.method !== "GET" &&
      c.req.method !== "HEAD" &&
      c.req.method !== "OPTIONS" &&
      c.req.raw.body !== null
    ) {
      const reader = c.req.raw.clone().body?.getReader();
      if (reader) {
        let totalBytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > limit) {
              // Do not await: `cancel()` on a cloned (tee'd) branch only settles once the other
              // branch is cancelled too, so awaiting it hung every oversized chunked body.
              void reader.cancel().catch(() => undefined);
              throw new VellumError(
                isBatch ? "PAYLOAD_TOO_LARGE" : "DOCUMENT_TOO_LARGE",
                `Request body exceeds ${limit} bytes`,
                { limit, contentLength: totalBytes, path: c.req.path }
              );
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
    }
    await next();
  });

  // 4. JSON payload safety + query cost guard.
  app.use("*", async (c, next) => {
    const contentType = c.req.header("content-type") ?? "";
    const ip = requestIp(c);
    if (contentType.toLowerCase().includes("application/json")) {
      let body: unknown;
      let rawText: string;
      try {
        rawText = await c.req.raw.clone().text();
        if (rawText.trim().length === 0) {
          await next();
          return;
        }
        // Detect raw "__proto__" / "constructor" / "prototype" keys before JSON.parse drops __proto__.
        let forbiddenKey: string | null = null;
        body = JSON.parse(rawText, (key, val: unknown) => {
          if (key === "__proto__" || key === "constructor" || key === "prototype") {
            forbiddenKey = key;
          }
          return val;
        }) as unknown;
        if (forbiddenKey !== null) {
          safeRecord(
            services.threatDetector,
            "prototype_pollution",
            ip,
            `Forbidden key '${forbiddenKey}' in JSON payload`,
            { path: c.req.path, guardCode: "PROTOTYPE_POLLUTION" }
          );
          throw new VellumError("INVALID_ARGUMENT", `Forbidden key '${forbiddenKey}' in JSON payload`, {
            guardCode: "PROTOTYPE_POLLUTION",
          });
        }
      } catch (err) {
        if (err instanceof VellumError) throw err;
        // Malformed JSON is handled by the existing route handlers.
        await next();
        return;
      }

      // Structural key budget per route class, mirroring checkJsonPayloadForRoute:
      // ruleset routes carry one large rules AST; batch/import routes are bounded
      // by their 5 MiB byte cap (a key can never outnumber bytes); single-document
      // routes get the document budget so the payload guard's accurate message wins.
      const isRulesetPath = RULESET_PATH.test(c.req.path);
      const isBatchLikePath =
        BATCH_PATH.test(c.req.path) || IMPORT_PATH.test(c.req.path) || USERS_IMPORT_PATH.test(c.req.path);
      const isDocumentPath = DOCUMENT_PATH.test(c.req.path);
      const structureMaxKeys = isRulesetPath
        ? SYSTEM_LIMITS.RULESET_MAX_OBJECT_KEYS
        : isBatchLikePath
          ? SYSTEM_LIMITS.MAX_BATCH_PAYLOAD_BYTES
          : isDocumentPath
            ? SYSTEM_LIMITS.DOCUMENT_MAX_OBJECT_KEYS
            : DEFAULT_MAX_JSON_KEYS;
      const structureCheck = assertSafeJsonStructure(body, { maxKeys: structureMaxKeys });
      if (!structureCheck.ok) {
        // Type-only assertion for Vercel's separate function TS config, which
        // does not narrow this discriminated union (the package tsconfig does).
        const failed = structureCheck as Extract<JsonSafetyOutcome, { ok: false }>;
        const keyOverflow = failed.code === "JSON_KEY_LIMIT_EXCEEDED";
        const message =
          keyOverflow && isRulesetPath
            ? `The ruleset is too large: it has more than ${SYSTEM_LIMITS.RULESET_MAX_OBJECT_KEYS} object keys. Simplify the rules or split them across more collections.`
            : keyOverflow && isDocumentPath
              ? `A single document exceeds ${SYSTEM_LIMITS.DOCUMENT_MAX_OBJECT_KEYS} object keys. Split large documents into smaller documents or subcollections.`
              : failed.message;
        const guardCode = keyOverflow && isRulesetPath ? "RULESET_TOO_LARGE" : failed.code;
        safeRecord(
          services.threatDetector,
          "prototype_pollution",
          ip,
          message,
          { path: c.req.path, guardCode }
        );
        throw new VellumError("INVALID_ARGUMENT", message, {
          guardCode,
        });
      }

      // Batch and transaction-commit bodies carry up to MAX_BATCH_OPERATIONS documents. The 500-key cap
      // applies to each write and to the rest of the body (the envelope) separately, so a full batch of
      // ordinary documents passes while a single oversized document or envelope still fails. Only these
      // routes get this treatment; every other route is checked as one body.
      const outcome = checkJsonPayloadForRoute(c.req.path, body);

      if (!outcome.ok) {
        const failed = outcome as Extract<GuardOutcome, { ok: false }>;
        safeRecord(
          services.threatDetector,
          failed.threatCategory ?? "prototype_pollution",
          ip,
          failed.message,
          { path: c.req.path, guardCode: failed.code }
        );
        throw new VellumError("INVALID_ARGUMENT", failed.message, { guardCode: failed.code });
      }

      const isQueryPath =
        c.req.path.endsWith("/query") || c.req.path.includes("/documents:aggregate");
      if (isQueryPath) {
        const cost = assertQueryCost(body);
        if (!cost.ok) {
          const failed = cost as Extract<GuardOutcome, { ok: false }>;
          safeRecord(
            services.threatDetector,
            "query_exhaustion",
            ip,
            failed.message,
            { path: c.req.path }
          );
          throw new VellumError(failed.code as ErrorCode, failed.message, { guardCode: failed.code });
        }
      }
    }
    await next();
  });

  // 5. CSRF origin verification for cookie-authenticated console/admin writes.
  // Refresh endpoints are exempt: they are first-party token-renewal calls
  // using SameSite HttpOnly cookies (the realm guards exclude them too), and
  // requiring an Origin header there would break native clients and the
  // existing single-flight refresh flow.
  const CSRF_REFRESH_EXEMPT = new Set([
    "/v1/console/auth/refresh",
    "/v1/admin/auth/session/refresh",
    "/v1/admin/auth/refresh",
  ]);
  app.use("*", async (c, next) => {
    const path = c.req.path;
    const protectedSurface = path.startsWith("/v1/console/") || path.startsWith("/v1/admin/");
    const cookie = c.req.header("cookie") ?? "";
    const cookieAuthenticated =
      cookie.includes("vellum_console_rt") || cookie.includes("vellum_admin_rt");
    if (protectedSurface && cookieAuthenticated && !CSRF_REFRESH_EXEMPT.has(path)) {
      let outcome: ReturnType<typeof verifyCsrfOrigin>;
      try {
        outcome = verifyCsrfOrigin(
          {
            method: c.req.method,
            path,
            origin: c.req.header("origin") ?? null,
            referer: c.req.header("referer") ?? null,
            cookieAuthenticated: true,
          },
          options.corsOrigins
        );
      } catch {
        throw new VellumError("INVALID_ARGUMENT", "CSRF_VERIFICATION_FAILED");
      }
      if (!outcome.ok) {
        const failed = outcome as Extract<GuardOutcome, { ok: false }>;
        throw new VellumError("INVALID_ARGUMENT", failed.code, { message: failed.message });
      }
    }
    await next();
  });

  // 6. API key Origin / IP / expiry restrictions (no key verification here).
  app.use("*", async (c, next) => {
    const rawKey = c.req.header("x-vellum-api-key") ?? c.req.header("x-project-key");
    if (typeof rawKey === "string" && rawKey.length > 0 && c.req.path.startsWith("/v1/projects/")) {
      try {
        // verifyApiKey() uses the first 16 characters as the lookup prefix.
        const record = await options.controlStore.findApiKeyByPrefix(rawKey.slice(0, 16));
        if (record !== null) {
          const ip = requestIp(c);
          const allowedOrigins = record.allowedOrigins ?? [];
          if (allowedOrigins.length > 0) {
            const actual = effectiveRequestOrigin(c.req.method, (name) => c.req.header(name));
            const allowed =
              actual !== null &&
              allowedOrigins.some((candidate) => {
                const normalizedCandidate = normalizeOrigin(candidate);
                return normalizedCandidate !== null && constantTimeEqual(normalizedCandidate, actual);
              });
            if (!allowed) {
              safeRecord(
                services.threatDetector,
                "cross_tenant_probe",
                ip,
                "API key used from a disallowed origin",
                { path: c.req.path, keyPrefix: record.keyPrefix }
              );
              throw new VellumError("PERMISSION_DENIED", "ORIGIN_NOT_ALLOWED", {
                ip,
                origin: c.req.header("origin"),
              });
            }
          }

          const allowedIps = record.allowedIps ?? [];
          if (allowedIps.length > 0 && !allowedIps.some((candidate) => constantTimeEqual(candidate, ip))) {
            safeRecord(
              services.threatDetector,
              "cross_tenant_probe",
              ip,
              "API key used from a disallowed IP",
              { path: c.req.path, keyPrefix: record.keyPrefix }
            );
            throw new VellumError("PERMISSION_DENIED", "IP_NOT_ALLOWED", { ip });
          }

          if (record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.now()) {
            throw new VellumError("PERMISSION_DENIED", "API_KEY_EXPIRED", {
              expiresAt: record.expiresAt,
            });
          }
        }
      } catch (err) {
        if (err instanceof VellumError) throw err;
        // A failed lookup is for the authentication middleware to reject.
      }
    }
    await next();
  });

  // 7. O(1) quota guard on the document plane.
  app.use("*", async (c, next) => {
    const path = c.req.path;
    const resolver = options.getOrgIdForProject;
    if (isDocumentPlanePath(path) && resolver !== undefined) {
      const projectId = projectIdFromContext(c);
      if (projectId !== null) {
        try {
          const orgId = await resolver(projectId);
          if (orgId !== null) {
            const decision = await services.quota.checkQuota(orgId, quotaOperationFor(c.req.method, path));
            if (!decision.allowed) {
              throw quotaErrorFromDecision(decision);
            }
            if (decision.warningHeader !== undefined) {
              c.header("x-vellum-quota-warning", decision.warningHeader);
            }
          }
        } catch (err) {
          if (err instanceof VellumError) throw err;
          // Resolver failure fails open; the request still authenticates normally.
        }
      }
    }
    await next();
  });

  // 8. Post-handler metering. Never throws and never blocks the response.
  app.use("*", async (c, next) => {
    await next();
    try {
      const path = c.req.path;
      if (!isDocumentPlanePath(path) || c.res.status >= 400) return;
      const projectId = projectIdFromContext(c);
      const resolver = options.getOrgIdForProject;
      if (projectId === null || resolver === undefined) return;
      const orgId = await resolver(projectId);
      if (orgId === null) return;

      const method = c.req.method.toUpperCase();
      const isQueryRead = path.endsWith("/query") || path.includes("/documents:aggregate");
      if (isQueryRead || method === "GET" || method === "HEAD" || method === "OPTIONS") {
        services.metering.recordReads(orgId, projectId, 1);
      } else if (method === "DELETE") {
        services.metering.recordDeletes(orgId, projectId, 1, 0);
      } else if (method === "POST" || method === "PUT" || method === "PATCH") {
        services.metering.recordWrites(orgId, projectId, 1, 0);
      }

      const contentLength = c.res.headers.get("content-length");
      if (contentLength !== null) {
        const bytes = Number(contentLength);
        if (Number.isFinite(bytes) && bytes > 0) {
          services.metering.recordEgress(orgId, projectId, bytes);
        }
      }
      services.metering.flushIfDue(METERING_INTERVAL_MS);
    } catch {
      // Metering is best-effort: a failure must never alter the response.
    }
  });
}
