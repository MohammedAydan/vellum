import type { MiddlewareHandler } from "hono";
import { normalizeStrictOrigin } from "./security.js";

/**
 * Per-project CORS for browser apps.
 *
 * The deployment-wide allowlist (`CORS_ALLOWED_ORIGINS`) is for first-party origins such as the
 * console and may use cookies. A developer's own website is not in that list, so the browser SDK
 * would be blocked on every call. This middleware lets an origin through for one project when an
 * active API key of that same project lists the origin in its `allowedOrigins`.
 *
 * Safety rules:
 * - exact origins only, never `*` or `null`;
 * - a key with no origin restriction opens nothing;
 * - revoked and expired keys are ignored;
 * - never `Access-Control-Allow-Credentials`, so cookies are not sent from these origins;
 * - only data-plane and end-user auth routes; admin and console routes are excluded.
 */

export interface ProjectCorsStore {
  /** Origins on the project's active keys, read from the database on every call. */
  listActiveApiKeyOrigins(projectId: string): Promise<string[]>;
  /** True when the project has an active dev-flagged key (localhost bypass). */
  hasActiveDevKey(projectId: string): Promise<boolean>;
}

/** http(s) origins on localhost / 127.0.0.1 / [::1], any port. */
const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** One diagnostic per (project, origin) per process, not per request. */
const devBypassLogged = new Set<string>();
const rejectedLogged = new Set<string>();

/** Development escape hatch: a dev-flagged publishable key opens localhost origins. */
async function isDevLocalhostAllowed(store: ProjectCorsStore, projectId: string, normalizedOrigin: string): Promise<boolean> {
  if (!LOCALHOST_ORIGIN.test(normalizedOrigin)) return false;
  if (!(await store.hasActiveDevKey(projectId))) return false;
  const key = `${projectId}|${normalizedOrigin}`;
  if (!devBypassLogged.has(key)) {
    devBypassLogged.add(key);
    console.info(
      `[project-cors] allowing localhost origin ${normalizedOrigin} for project ${projectId}: a dev-flagged API key is active. Remove the dev flag before production use.`
    );
  }
  return true;
}

const PROJECT_PATH = /^\/v1\/projects\/([^/]+)\/(.*)$/;
const EXCLUDED = [/^auth\/admin(\/|$)/, /^admin(\/|$)/, /^console(\/|$)/];
const ALLOW_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Project-Key",
  "X-Vellum-Api-Key",
  "X-Vellum-User-Token",
  "X-Request-Id",
  "X-Transaction-Token",
  "X-Setup-Token",
  "If-Match",
].join(",");
const ALLOW_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const EXPOSE_HEADERS = "X-Request-Id,X-Refreshed-Session-Token,X-Vellum-Index-Suggestion,X-Vellum-Index-Url";

/**
 * Checks one origin against the active API keys of one project, reading the database on every call.
 * Shared by the REST middleware, the SSE stream route and the WebSocket auth step so all three apply
 * the same rule.
 */
export function createProjectOriginChecker(store: ProjectCorsStore): (projectId: string, origin: string) => Promise<boolean> {
  return async (projectId, origin) => {
    const normalized = normalizeStrictOrigin(origin);
    if (!normalized || !projectId) return false;
    const origins = await store.listActiveApiKeyOrigins(projectId);
    if (origins.some((raw) => normalizeStrictOrigin(raw) === normalized)) return true;
    return isDevLocalhostAllowed(store, projectId, normalized);
  };
}

export const REALTIME_STREAM_PATH = "/v1/realtime/stream";
export const PROJECT_CORS_EXPOSE_HEADERS = EXPOSE_HEADERS;

export function createProjectCors(
  store: ProjectCorsStore,
  isGloballyAllowed: (origin: string) => boolean
): MiddlewareHandler {
  // No cache. Allowed origins are read from the database for each cross-origin request, so a key
  // edit or revoke applies to the next request on every instance. The query is indexed by project.
  async function isAllowed(projectId: string, normalizedOrigin: string): Promise<boolean> {
    const origins = await store.listActiveApiKeyOrigins(projectId);
    for (const raw of origins) {
      if (normalizeStrictOrigin(raw) === normalizedOrigin) return true;
    }
    return isDevLocalhostAllowed(store, projectId, normalizedOrigin);
  }

  return async (c, next) => {
    const origin = c.req.header("origin");
    if (!origin) return next();
    // The SSE stream carries its project id in the POST body, which a preflight cannot see. Answer the
    // preflight for any well-formed origin (no credentials, nothing is readable from it); the actual
    // response only gets Access-Control-Allow-Origin in routes/realtime-sse.ts, after the project's keys
    // list the origin, so the browser still blocks every other origin from reading the stream.
    if (c.req.path === REALTIME_STREAM_PATH && c.req.method === "OPTIONS") {
      const strict = normalizeStrictOrigin(origin);
      if (strict && !isGloballyAllowed(origin)) {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": origin,
            vary: "Origin",
            "access-control-allow-methods": "POST,OPTIONS",
            "access-control-allow-headers": ALLOW_HEADERS,
            "access-control-max-age": "600",
          },
        });
      }
      return next();
    }
    if (c.req.path === REALTIME_STREAM_PATH && !isGloballyAllowed(origin) && normalizeStrictOrigin(origin)) {
      await next();
      // The deployment-wide CORS layer adds Allow-Credentials for every origin; third-party sites never get it.
      c.res.headers.delete("access-control-allow-credentials");
      return undefined;
    }
    const match = PROJECT_PATH.exec(c.req.path);
    if (!match) return next();
    const [, projectId, rest] = match;
    if (EXCLUDED.some((re) => re.test(rest ?? ""))) return next();
    const normalized = normalizeStrictOrigin(origin);
    if (!normalized || isGloballyAllowed(origin)) return next();
    if (!(await isAllowed(projectId ?? "", normalized))) {
      const key = `${projectId}|${normalized}`;
      if (!rejectedLogged.has(key)) {
        rejectedLogged.add(key);
        console.warn(
          `[project-cors] origin ${normalized} is not allowed for project ${projectId}: add it to an active API key's allowedOrigins (a browser blocks the response without this).`
        );
      }
      return next();
    }

    const headers = {
      "access-control-allow-origin": origin,
      vary: "Origin",
    };
    if (c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          "access-control-allow-methods": ALLOW_METHODS,
          "access-control-allow-headers": ALLOW_HEADERS,
          "access-control-max-age": "600",
        },
      });
    }
    await next();
    // The deployment-wide CORS layer adds Allow-Credentials for every origin; third-party sites never get it.
    c.res.headers.delete("access-control-allow-credentials");
    for (const [k, v] of Object.entries(headers)) {
      if (k === "vary") c.res.headers.append("vary", v);
      else c.res.headers.set(k, v);
    }
    c.res.headers.set("access-control-expose-headers", EXPOSE_HEADERS);
    return undefined;
  };
}
