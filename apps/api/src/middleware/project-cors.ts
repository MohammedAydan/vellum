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
  readonly apiKeysById: Map<string, { projectId: string; allowedOrigins?: string[] | undefined; revokedAt: string | null; expiresAt: string | null }>;
}

const PROJECT_PATH = /^\/v1\/projects\/([^/]+)\/(.*)$/;
const EXCLUDED = [/^auth\/admin(\/|$)/, /^admin(\/|$)/, /^console(\/|$)/];
const CACHE_TTL_MS = 5_000;
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

export function createProjectCors(
  store: ProjectCorsStore,
  isGloballyAllowed: (origin: string) => boolean,
  now: () => number = Date.now
): MiddlewareHandler {
  const cache = new Map<string, { at: number; origins: Set<string> }>();

  function originsFor(projectId: string): Set<string> {
    const hit = cache.get(projectId);
    const t = now();
    if (hit && t - hit.at < CACHE_TTL_MS) return hit.origins;
    const origins = new Set<string>();
    for (const key of store.apiKeysById.values()) {
      if (key.projectId !== projectId || key.revokedAt) continue;
      if (key.expiresAt && Date.parse(key.expiresAt) <= t) continue;
      for (const raw of key.allowedOrigins ?? []) {
        const normalized = normalizeStrictOrigin(raw);
        if (normalized) origins.add(normalized);
      }
    }
    if (cache.size > 1000) cache.clear();
    cache.set(projectId, { at: t, origins });
    return origins;
  }

  return async (c, next) => {
    const origin = c.req.header("origin");
    if (!origin) return next();
    const match = PROJECT_PATH.exec(c.req.path);
    if (!match) return next();
    const [, projectId, rest] = match;
    if (EXCLUDED.some((re) => re.test(rest ?? ""))) return next();
    const normalized = normalizeStrictOrigin(origin);
    if (!normalized || isGloballyAllowed(origin)) return next();
    if (!originsFor(projectId ?? "").has(normalized)) return next();

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
    for (const [k, v] of Object.entries(headers)) {
      if (k === "vary") c.res.headers.append("vary", v);
      else c.res.headers.set(k, v);
    }
    c.res.headers.set("access-control-expose-headers", EXPOSE_HEADERS);
    return undefined;
  };
}
