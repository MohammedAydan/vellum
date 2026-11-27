/**
 * @vellum/api - Authentication throttle middleware.
 *
 * All throttle state is durable: every API instance reserves and releases
 * sliding-window slots in PostgreSQL through the control store's throttle
 * repository, so limits hold across serverless instances, cold starts and
 * redeploys. Reservation is atomic (a per-bucket advisory lock serializes
 * concurrent reservers inside `auth_throttle_acquire`), so parallel attempts
 * cannot all pass one free slot.
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
import { VellumError } from "@vellum/core";
import type { ThrottleRepository } from "@vellum/database-control";
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
   * Resolve the maximum per request, e.g. from the project's auth config.
   * Overrides `max`; the rate-limit scale still applies on top.
   */
  maxFrom?: (c: Context) => number | Promise<number>;
  /**
   * When true every request is counted, not just responses with status >= 400.
   * Used by the non-enumerating password-reset / email-verify request endpoints.
   */
  countAll?: boolean;
  /**
   * When true and the bucket is exhausted, the handler still runs: a successful
   * response (< 400) is allowed through, while a failed one (4xx) gets the 429.
   * Use ONLY on the per-account sign-in ceilings, never on the per-(ip,email)
   * limits. An attacker who knows a victim's email can fill the account bucket
   * with failed attempts from rotating addresses; without this, the real owner
   * is then locked out of their own account for the whole window (a lockout
   * DoS). Wrong guesses stay capped by the per-(ip,email) limit that runs
   * first, so this opens no new brute-force path — it only stops a lockout
   * from ever beating the correct password. 5xx responses pass through
   * untouched so infrastructure errors are never masked as throttling.
   */
  bypassOnSuccess?: boolean;
}

/** Spoof-resistant client IP. No value is logged anywhere. */
function requestIp(c: Context): string {
  return extractClientIp(c);
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
    const body = (await c.req.json()) as { email?: unknown } | null;
    if (body && typeof body["email"] === "string") {
      email = body["email"].trim().toLowerCase();
    }
  } catch {
    // Empty or non-JSON body — fall through to the authenticated identity.
  }
  return `${requestIp(c)}|${email || authenticatedIdentity(c)}`;
}

/**
 * Optional multiplier for every auth limit, for load and end-to-end tests only. Unset (the default) or
 * anything that is not a number greater than 1 leaves the limits unchanged. Capped at 1000.
 */
export function authRateLimitScale(raw: string | undefined = process.env["AUTH_RATE_LIMIT_SCALE"]): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 1 ? Math.min(n, 1000) : 1;
}

/**
 * Sliding-window limiter for authentication endpoints.
 *
 * Rejects with `TOO_MANY_REQUESTS` once `max` events are inside the window,
 * before the handler runs. Each attempt reserves a slot up front; only failed
 * responses keep it — or every request when `countAll` is set. `Retry-After` is written before
 * throwing so it survives Hono's `onError` replacement of `c.res`.
 *
 * The throttle fails closed: when the durable store is unreachable the error
 * propagates instead of silently disabling brute-force protection.
 */
export function authRateLimit(
  options: AuthRateLimitOptions,
  throttle: ThrottleRepository
): MiddlewareHandler {
  const { windowMs, scope, countAll = false, bypassOnSuccess = false } = options;
  const retryAfterSeconds = Math.ceil(windowMs / 1000);

  return async (c, next) => {
    const baseMax = options.maxFrom ? await options.maxFrom(c) : options.max;
    const max = Math.max(1, Math.ceil(baseMax * authRateLimitScale()));
    const identity = options.keyFrom ? await options.keyFrom(c) : await defaultKey(c);
    // The composed key is an opaque bucket subject only — never logged or returned.
    const slot = await throttle.acquireThrottleSlot(scope, identity, windowMs, max);
    if (!slot.acquired) {
      if (bypassOnSuccess) {
        // The composed handler converts downstream throws into responses before
        // `next()` resolves (see the header comment), so c.res is the verdict.
        await next();
        const status = c.res.status;
        if (status < 400 || status >= 500) return;
        c.header("Retry-After", String(retryAfterSeconds));
        throw new VellumError("TOO_MANY_REQUESTS", "Too many attempts. Please try again later.", {
          retryAfterSeconds,
        });
      }
      c.header("Retry-After", String(retryAfterSeconds));
      throw new VellumError("TOO_MANY_REQUESTS", "Too many attempts. Please try again later.", {
        retryAfterSeconds,
      });
    }

    // Attempts that turn out not to count (successes in failure-only mode, or
    // infrastructure-level throws, which Hono never converted into a response)
    // release their slot afterwards. A failed release simply keeps the slot —
    // the throttle errs on the strict side, never the permissive one.
    const release = (): void => {
      if (slot.eventId !== null) {
        void throttle.releaseThrottleSlot(slot.eventId).catch(() => undefined);
      }
    };
    try {
      await next();
    } catch (error) {
      if (!countAll) release();
      throw error;
    }
    if (!countAll && c.res.status < 400) release();
  };
}
