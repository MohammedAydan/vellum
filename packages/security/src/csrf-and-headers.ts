/**
 * @vellum/security - CSRF origin verification and baseline security headers.
 *
 * CSRF checks apply only to cookie-authenticated state-changing requests to
 * the console/admin API surface. A missing Origin/Referer is a hard failure
 * for those requests (fail closed), while token-authenticated API traffic is
 * not subject to cookie CSRF checks.
 */

import type { GuardOutcome } from "./payload-guard.js";

export interface CsrfRequest {
  method: string;
  path: string;
  origin?: string | null | undefined;
  referer?: string | null | undefined;
  cookieAuthenticated: boolean;
}

const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const PROTECTED_PATH_PREFIXES: readonly string[] = ["/v1/console/", "/v1/admin/"];
const MAX_ORIGIN_LENGTH = 2_048;
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;

function firstNonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Normalize an Origin/Referer value to a comparable scheme+host origin. */
function parseOrigin(value: string): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ORIGIN_LENGTH) {
    return null;
  }
  if (CONTROL_CHAR_REGEX.test(value)) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return null;
    }
    // Reject opaque "null" origins or empty hosts.
    if (parsed.origin === "null" || parsed.hostname === "") {
      return null;
    }
    // WHATWG URL lowercases scheme and host and drops default ports, giving
    // the required case-insensitive comparison.
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Normalize leading duplicate slashes so `//v1/admin/` cannot bypass prefix matching. */
function normalizePathForPrefixCheck(path: string): string {
  if (typeof path !== "string") {
    return "";
  }
  return path.replace(/^\/+/, "/");
}

export function verifyCsrfOrigin(req: CsrfRequest, expectedOrigins: readonly string[]): GuardOutcome {
  const method = typeof req.method === "string" ? req.method.toUpperCase() : "";
  const normalizedPath = normalizePathForPrefixCheck(req.path);
  const isCookieStateChange =
    req.cookieAuthenticated &&
    STATE_CHANGING_METHODS.has(method) &&
    PROTECTED_PATH_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix));

  if (!isCookieStateChange) {
    return { ok: true };
  }

  const candidate = firstNonEmpty(req.origin) ?? firstNonEmpty(req.referer);
  if (candidate === null) {
    return {
      ok: false,
      code: "CSRF_ORIGIN_MISSING",
      message: "Missing Origin or Referer header for cookie-authenticated state change",
    };
  }

  const actualOrigin = parseOrigin(candidate);
  if (actualOrigin === null) {
    return {
      ok: false,
      code: "CSRF_ORIGIN_INVALID",
      message: "Malformed Origin or Referer header",
    };
  }

  const allowedOrigins = new Set<string>();
  for (const expected of expectedOrigins) {
    const normalized = parseOrigin(expected);
    if (normalized !== null) {
      allowedOrigins.add(normalized);
    }
  }

  if (!allowedOrigins.has(actualOrigin)) {
    return {
      ok: false,
      code: "CSRF_ORIGIN_MISMATCH",
      message: "Request origin is not in the allow-list",
    };
  }

  return { ok: true };
}

export function securityHeaders(opts: { isProd: boolean; isHtml: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };

  if (opts.isProd) {
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains";
  }

  if (opts.isHtml) {
    headers["Content-Security-Policy"] =
      "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  }

  return headers;
}
