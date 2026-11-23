/**
 * @vellum/api - In-process authentication throttle middleware.
 *
 * ZERO-REDIS DOCTRINE: this is *ephemeral* throttle state, not durable state.
 * PostgreSQL remains the only stateful runtime dependency; this in-process
 * sliding window intentionally lives only for the lifetime of the process and
 * is never persisted or shared across instances.
 *
 * Notes on Hono error flow (verified against hono@4.13's `compose`): a thrown
 * error from a downstream handler is caught by Hono at that handler's dispatch
 * level and converted into a response *before* `next()` resolves. Therefore
 * `await next()` does not reject here, and `c.res.status` reflects the real
 * handler outcome (e.g. 401 for a bad password). This is what lets us count
 * only failed attempts after the handler has run.
 */

import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { VellumError, type BoundedCachePolicy } from "@vellum/core";
import { extractClientIp } from "./security.js";

export interface AuthRateLimitOptions {
  /** Maximum number of recorded events allowed inside the window. */
  max: number;
  /** Sliding-window length in milliseconds. */
  windowMs: number;
  /** Bucket namespace, e.g. "admin-login" — keeps different routes isolated. */
  scope: string;
  /**
   * Return the throttle bucket key. May be async so callers can read fields
   * such as `mfaTicket` / `userId` from the body. When omitted the key defaults
   * to `${ip}|${email}`.
   */
  keyFrom?: (c: Context) => string | Promise<string>;
  /**
   * When true every request is counted, not just responses with status >= 400.
   * Used by the non-enumerating password-reset / email-verify request endpoints.
   */
  countAll?: boolean;
}

interface RateBucket {
  /** Epoch-ms timestamps of the events currently inside the sliding window. */
  events: number[];
  /** Last timestamp this bucket was touched (for bounded-memory eviction). */
  lastSeen: number;
}

export const AUTH_RATE_LIMIT_CACHE_POLICY: BoundedCachePolicy = Object.freeze({
  name: "api.auth-rate-limit",
  scope: "process",
  maxEntries: 50_000,
  ttlMs: 15 * 60 * 1000,
});

/**
 * Only ever keyed by opaque identifiers derived from `(ip,email)` or an MFA
 * ticket/user id. Emails and IPs are never logged, serialized or returned.
 */
const buckets = new Map<string, RateBucket>();

/** Test helper: drop all in-process throttle state between cases. */
export function clearAuthRateLimitState(): void {
  buckets.clear();
}

/** Spoof-resistant client IP. No value is logged anywhere. */
function requestIp(c: Context): string {
  return extractClientIp(c);
}

/** Evict expired or oldest buckets to keep memory strictly bounded under DDoS. */
function pruneBucketsIfNeeded(now: number, maxWindowMs: number): void {
  const { maxEntries, ttlMs } = AUTH_RATE_LIMIT_CACHE_POLICY;
  if (buckets.size < maxEntries) return;
  const effectiveWindowMs = Math.min(maxWindowMs, ttlMs);
  const cutoff = now - effectiveWindowMs;
  for (const [key, entry] of buckets) {
    if (entry.lastSeen <= cutoff || entry.events.length === 0) {
      buckets.delete(key);
    }
  }
  // If still above cap, evict oldest entries (Map preserves insertion order).
  while (buckets.size >= maxEntries) {
    const oldestKey = buckets.keys().next().value;
    if (oldestKey === undefined) break;
    buckets.delete(oldestKey);
  }
}

/**
 * Opaque, unforgeable identity for authenticated requests that carry no email
 * in their body (e.g. `POST /auth/email/verify/request` called with `{}` and a
 * bearer token). Hashing the *signed* credential keeps distinct end-user
 * sessions in distinct buckets while preventing a caller from rotating an
 * unverified `sub`/`email` claim to dodge the throttle. The raw token is never
 * stored, logged or returned.
 */
function authenticatedIdentity(c: Context): string {
  const raw = c.req.header("x-vellum-user-token") ?? c.req.header("authorization") ?? "";
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  if (!token) return "";
  return `token:${createHash("sha256").update(token).digest("hex")}`;
}

/**
 * Default identity `${ip}|${email}` — or `${ip}|token:<hash>` when the body
 * has no email but the request is authenticated. The request body is cloned
 * before parsing so the downstream handler can still read it.
 */
async function defaultKey(c: Context): Promise<string> {
  let email = "";
  try {
    const body = (await c.req.raw.clone().json()) as { email?: unknown } | null;
    if (body && typeof body["email"] === "string") {
      email = body["email"].trim().toLowerCase();
    }
  } catch {
    // Empty or non-JSON body — fall through to the authenticated identity.
  }
  return `${requestIp(c)}|${email || authenticatedIdentity(c)}`;
}

/**
 * Sliding-window limiter for authentication endpoints.
 *
 * Runs the handler first, then (a) counts failed responses — or every request
 * when `countAll` is set — and (b) throws `TOO_MANY_REQUESTS` once the number
 * of events inside the window exceeds `max`. `Retry-After` is written before
 * throwing so it survives Hono's `onError` replacement of `c.res`.
 */
export function authRateLimit(options: AuthRateLimitOptions): MiddlewareHandler {
  const { max, windowMs, scope, countAll = false } = options;
  const retryAfterSeconds = Math.ceil(windowMs / 1000);

  return async (c, next) => {
    const identity = options.keyFrom ? await options.keyFrom(c) : await defaultKey(c);
    // The composed key is an opaque Map key only — never logged or returned.
    const bucketKey = `${scope}:${identity}`;
    const now = Date.now();
    const cutoff = now - windowMs;

    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      pruneBucketsIfNeeded(now, windowMs);
      bucket = { events: [], lastSeen: now };
      buckets.set(bucketKey, bucket);
    } else {
      bucket.lastSeen = now;
    }
    // Prune events that have fallen out of the window (true sliding window).
    bucket.events = bucket.events.filter((ts) => ts > cutoff);

    await next();

    const shouldCount = countAll || c.res.status >= 400;
    if (!shouldCount) return;

    bucket.events.push(now);
    bucket.lastSeen = now;
    if (bucket.events.length > max) {
      c.header("Retry-After", String(retryAfterSeconds));
      throw new VellumError("TOO_MANY_REQUESTS", "Too many attempts. Please try again later.", {
        retryAfterSeconds,
      });
    }
  };
}
