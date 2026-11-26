/**
 * @vellum/api - HTTP transport hardening middleware & shared security primitives
 */

import crypto from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { VellumError, SYSTEM_LIMITS } from "@vellum/core";

const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "x-project-key",
  "x-api-key",
  "x-vellum-user-token",
  "x-vellum-api-key",
  "cookie",
  "set-cookie",
  "x-transaction-token",
  "stripe-signature",
]);

const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173", "http://localhost:5174"] as const;

const FORBIDDEN_JSON_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export const DEFAULT_MAX_JSON_DEPTH = 32;
export const DEFAULT_MAX_JSON_KEYS = 10_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Constant-time string comparison using `crypto.timingSafeEqual`.
 * Always hashes both inputs to fixed 32-byte SHA-256 digests so comparison
 * time does not leak input length or prefix matches.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const digestA = crypto.createHash("sha256").update(a, "utf8").digest();
  const digestB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(digestA, digestB) && a.length === b.length;
}

/** Validate and normalize an IPv4/IPv6 candidate string. */
function normalizeIpCandidate(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (value.length === 0 || value.length > 64) return null;
  // Strip IPv4-mapped IPv6 prefix (::ffff:127.0.0.1 -> 127.0.0.1)
  if (value.toLowerCase().startsWith("::ffff:")) {
    value = value.slice(7);
  }
  // Reject control chars, whitespace, quotes, or brackets with ports that could forge logs/keys
  if (!/^[0-9a-fA-F:.]+$/.test(value)) return null;
  return value;
}

/**
 * Resolve configured number of trusted reverse-proxy hops from `TRUST_PROXY_HOPS`.
 * Default is `1` (single reverse proxy / LB). Set to `0` when exposed directly
 * to the internet without a trusted proxy.
 */
export function getTrustedProxyHops(): number {
  const raw = process.env["TRUST_PROXY_HOPS"];
  if (raw === undefined || raw === "") return 1;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) return 1;
  return parsed;
}

/**
 * Spoof-resistant client IP extraction.
 *
 * When `trustedProxyHops > 0`, takes the rightmost untrusted hop from
 * `X-Forwarded-For` (`hops[hops.length - trustedProxyHops]`) rather than the
 * client-controlled leftmost entry, preventing `X-Forwarded-For` spoofing
 * against rate limiters, IP blocklists, and API key IP allowlists.
 * When `trustedProxyHops === 0`, ignores forwarded headers and uses the
 * socket-level `x-vellum-remote-addr` injected by `node-server.ts`.
 */
export function extractClientIp(
  c: Context,
  trustedProxyHops: number = getTrustedProxyHops()
): string {
  const directAddr = normalizeIpCandidate(c.req.header("x-vellum-remote-addr"));

  if (trustedProxyHops > 0) {
    // Any client can send cf-connecting-ip. It is only trustworthy when every request really passes
    // through Cloudflare, so it is ignored unless TRUST_CLOUDFLARE_IP=true, and never on Vercel.
    if (process.env["TRUST_CLOUDFLARE_IP"] === "true" && !process.env["VERCEL"]) {
      const cfIp = normalizeIpCandidate(c.req.header("cf-connecting-ip"));
      if (cfIp) return cfIp;
    }

    // On Vercel the platform sets this header itself and overwrites any client-supplied value, so it is
    // the real client address even when `x-forwarded-for` carries extra hops (for example a rewrite from
    // another deployment). Without it, every user behind such a hop would share one rate-limit bucket.
    if (process.env["VERCEL"] !== undefined && process.env["VERCEL"] !== "") {
      const vercelIp = normalizeIpCandidate(c.req.header("x-vercel-forwarded-for")?.split(",")[0]);
      if (vercelIp) return vercelIp;
    }

    const forwarded = c.req.header("x-forwarded-for");
    if (typeof forwarded === "string" && forwarded.length > 0) {
      const hops = forwarded
        .split(",")
        .map((part) => normalizeIpCandidate(part))
        .filter((part): part is string => part !== null);
      if (hops.length > 0) {
        const idx = Math.max(0, hops.length - trustedProxyHops);
        const chosen = hops[idx];
        if (chosen) return chosen;
      }
    }

    const realIp = normalizeIpCandidate(c.req.header("x-real-ip"));
    if (realIp) return realIp;
  }

  return directAddr ?? "unknown";
}

export interface JsonSafetyOptions {
  maxDepth?: number;
  maxKeys?: number;
}

export type JsonSafetyOutcome =
  | { ok: true }
  | { ok: false; code: "PROTOTYPE_POLLUTION" | "JSON_DEPTH_EXCEEDED" | "JSON_KEY_LIMIT_EXCEEDED"; message: string };

/**
 * Inspect a parsed JSON value for prototype-polluting keys (`__proto__`,
 * `constructor`, `prototype`), excessive nesting depth, or excessive key count.
 */
export function assertSafeJsonStructure(
  value: unknown,
  options: JsonSafetyOptions = {}
): JsonSafetyOutcome {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_JSON_DEPTH;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_JSON_KEYS;
  let totalKeys = 0;

  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const { node, depth } = current;
    if (node === null || typeof node !== "object") continue;

    if (depth > maxDepth) {
      return {
        ok: false,
        code: "JSON_DEPTH_EXCEEDED",
        message: `JSON payload exceeds maximum nesting depth of ${maxDepth}`,
      };
    }

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const item = node[i];
        if (item !== null && typeof item === "object") {
          stack.push({ node: item, depth: depth + 1 });
        }
      }
      continue;
    }

    const keys = Object.keys(node as Record<string, unknown>);
    totalKeys += keys.length;
    if (totalKeys > maxKeys) {
      return {
        ok: false,
        code: "JSON_KEY_LIMIT_EXCEEDED",
        message: `JSON payload exceeds maximum key count of ${maxKeys}`,
      };
    }

    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i]!;
      if (FORBIDDEN_JSON_KEYS.has(key)) {
        return {
          ok: false,
          code: "PROTOTYPE_POLLUTION",
          message: `Forbidden key '${key}' in JSON payload`,
        };
      }
      const child = (node as Record<string, unknown>)[key];
      if (child !== null && typeof child === "object") {
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }

  return { ok: true };
}

/**
 * Parse a JSON string safely: rejects prototype-polluting keys during parsing
 * (catching `__proto__` even before `JSON.parse` can attach it) and enforces
 * nesting depth and key count limits.
 */
export function safeJsonParse<T = unknown>(
  raw: string,
  options: JsonSafetyOptions = {}
): T {
  let forbiddenKey: string | null = null;
  const parsed = JSON.parse(raw, (key, val: unknown) => {
    if (key.length > 0 && FORBIDDEN_JSON_KEYS.has(key)) {
      forbiddenKey = key;
      return undefined;
    }
    return val;
  }) as unknown;

  if (forbiddenKey !== null) {
    throw new VellumError("INVALID_ARGUMENT", `Forbidden key '${forbiddenKey}' in JSON payload`, {
      guardCode: "PROTOTYPE_POLLUTION",
    });
  }

  const outcome = assertSafeJsonStructure(parsed, options);
  if (!outcome.ok) {
    // Type-only assertion: Vercel's function compiler uses a separate TS
    // configuration that does not narrow this discriminated union, while the
    // package tsconfig does. No runtime behaviour changes.
    const failed = outcome as Extract<JsonSafetyOutcome, { ok: false }>;
    throw new VellumError("INVALID_ARGUMENT", failed.message, { guardCode: failed.code });
  }
  return parsed as T;
}

/**
 * Reject oversized request bodies using the canonical 5 MiB batch limit.
 * Checks `Content-Length` up front AND enforces actual byte size when
 * `Content-Length` is omitted (e.g. `Transfer-Encoding: chunked`).
 */
export function bodyLimit(maxBytes: number = SYSTEM_LIMITS.MAX_BATCH_PAYLOAD_BYTES): MiddlewareHandler {
  return async (c, next) => {
    const rawLength = c.req.header("content-length");
    if (rawLength !== undefined && rawLength !== "") {
      const length = Number(rawLength);
      if (!Number.isFinite(length) || length < 0) {
        throw new VellumError("INVALID_ARGUMENT", "Invalid Content-Length header");
      }
      if (length > maxBytes) {
        throw new VellumError("PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`, {
          maxBytes,
          contentLength: length,
        });
      }
    } else if (
      c.req.method !== "GET" &&
      c.req.method !== "HEAD" &&
      c.req.method !== "OPTIONS" &&
      c.req.raw.body !== null
    ) {
      // Chunked / missing Content-Length: inspect actual size via cloned stream.
      const reader = c.req.raw.clone().body?.getReader();
      if (reader) {
        let totalBytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
              void reader.cancel().catch(() => undefined);
              throw new VellumError("PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`, {
                maxBytes,
                contentLength: totalBytes,
              });
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
    }
    await next();
  };
}

/**
 * Enforce a bounded per-request timeout so hung downstream calls cannot hold
 * worker slots indefinitely.
 */
export function requestTimeout(timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): MiddlewareHandler {
  return async (_c, next) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      await next();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new VellumError("QUERY_DEADLINE_EXCEEDED", `Request exceeded ${timeoutMs}ms timeout`));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

export interface SecurityHeadersOptions {
  /** Set `Cache-Control: no-store` (default `true` for auth/sensitive routes). */
  noStore?: boolean;
}

/**
 * Hardening headers for API responses (`Strict-Transport-Security`,
 * `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
 * `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` on
 * credential-bearing / sensitive surfaces).
 */
export function securityHeaders(options: SecurityHeadersOptions = {}): MiddlewareHandler {
  const noStore = options.noStore ?? true;
  const headers: Record<string, string> = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    ...(noStore ? { "Cache-Control": "no-store", Pragma: "no-cache" } : {}),
  };
  return async (c, next) => {
    for (const [name, value] of Object.entries(headers)) c.header(name, value);
    await next();
    // Re-assert headers after handler execution in case c.res was replaced.
    for (const [name, value] of Object.entries(headers)) {
      if (!c.res.headers.has(name)) c.header(name, value);
    }
  };
}

/** Return a copy of request headers safe for structured logs. */
export function redactHeaders(
  headers: Headers | Iterable<[string, string]>
): Record<string, string> {
  const result: Record<string, string> = {};
  if (typeof (headers as { forEach?: unknown }).forEach === "function" && !(Symbol.iterator in Object(headers) && Array.isArray(headers))) {
    (headers as Headers).forEach((value, name) => {
      const lower = name.toLowerCase();
      result[lower] = SENSITIVE_HEADERS.has(lower) ? "[REDACTED]" : value;
    });
    return result;
  }
  for (const [name, value] of headers as Iterable<[string, string]>) {
    const lower = name.toLowerCase();
    result[lower] = SENSITIVE_HEADERS.has(lower) ? "[REDACTED]" : value;
  }
  return result;
}

/** Normalize a single origin string to canonical `scheme://host[:port]`, or null if invalid. */
export function normalizeStrictOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "*" || trimmed.toLowerCase() === "null" || trimmed.includes("*")) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.origin === "null") return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Parse `CORS_ALLOWED_ORIGINS` from configuration; never silently fall back to `*`. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const seen = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const normalized = normalizeStrictOrigin(entry);
    if (normalized) seen.add(normalized);
  }
  return seen.size > 0 ? Array.from(seen) : [...DEFAULT_ALLOWED_ORIGINS];
}

/**
 * Strict CORS origin validator for `hono/cors` with `credentials: true`.
 * Guarantees `*` is NEVER reflected alongside `Access-Control-Allow-Credentials: true`,
 * and only exact canonical allowlisted origins are echoed back.
 */
export function createCorsOriginValidator(
  allowedOrigins: readonly string[]
): (origin: string) => string | undefined {
  const allowedSet = new Set<string>();
  for (const candidate of allowedOrigins) {
    const normalized = normalizeStrictOrigin(candidate);
    if (normalized) allowedSet.add(normalized);
  }
  return (origin: string): string | undefined => {
    const normalized = normalizeStrictOrigin(origin);
    if (!normalized) return undefined;
    return allowedSet.has(normalized) ? origin : undefined;
  };
}

/**
 * Run an async mapper over `items` with a bounded concurrency ceiling so
 * fan-out admin/billing queries cannot exhaust the PostgreSQL connection pool.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const idx = nextIndex;
      nextIndex += 1;
      if (idx >= items.length) return;
      results[idx] = await mapper(items[idx]!, idx);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
