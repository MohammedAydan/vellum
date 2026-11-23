/**
 * @vellumdb/sdk-js - Backoff, Retry-After & AbortSignal Sleep Helpers
 * Specification Section 9.3:
 * t_sleep = random(0, min(t_max, t_0 * 2^attempt)), where t_0 = 500ms, t_max = 30,000ms.
 */

export function computeReconnectBackoffMs(
  attempt: number,
  t0 = 500,
  tMax = 30_000,
  randomFn = Math.random
): number {
  const safeAttempt = Math.max(0, Math.min(attempt, 30));
  const cap = Math.min(tMax, t0 * Math.pow(2, safeAttempt));
  const r = Math.max(0, Math.min(1, randomFn()));
  return Math.floor(r * cap);
}

/** Canonical alias for `computeReconnectBackoffMs`. */
export const computeBackoffMs = computeReconnectBackoffMs;

/**
 * Decorrelated jitter backoff (AWS Architecture Blog):
 * next = min(tMax, random(t0, max(t0, prevDelayMs * 3)))
 * Spreads reconnect storms more smoothly than simple capped exponential backoff.
 */
export function computeDecorrelatedJitterMs(
  prevDelayMs: number,
  t0 = 500,
  tMax = 30_000,
  randomFn = Math.random
): number {
  const base = Math.max(1, t0);
  const max = Math.max(base, tMax);
  const upper = Math.min(max, Math.max(base, prevDelayMs * 3));
  const r = Math.max(0, Math.min(1, randomFn()));
  return Math.floor(base + r * (upper - base));
}

/**
 * Parse an HTTP `Retry-After` header (either integer delta-seconds or HTTP-date)
 * into milliseconds, clamped to `[0, maxDelayMs]`. Returns `null` if invalid/absent.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, maxDelayMs = 60_000): number | null {
  if (typeof headerValue !== "string") return null;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return null;
    return Math.max(0, Math.min(seconds * 1000, maxDelayMs));
  }

  const parsedDateMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedDateMs)) return null;
  const deltaMs = parsedDateMs - Date.now();
  return Math.max(0, Math.min(deltaMs, maxDelayMs));
}

/** Build a normalized AbortError with `code = "REQUEST_ABORTED"`. */
export function createAbortError(signal?: AbortSignal): Error & { code: string } {
  const reason: unknown = signal?.reason;
  const typedReason = reason as (Error & { code?: unknown }) | undefined;
  // Only reuse errors we created ourselves. A native DOMException (Node 22's
  // default AbortController.reason) has a truthy numeric legacy `code` (20),
  // so checking `!err.code` would return it without our string error code.
  if (typedReason instanceof Error && typedReason.code === "REQUEST_ABORTED") {
    return typedReason as Error & { code: string };
  }
  const message =
    typedReason instanceof Error
      ? typedReason.message
      : typeof reason === "string" && reason.length > 0
        ? `@vellumdb/sdk-js: request aborted (${reason})`
        : "@vellumdb/sdk-js: request aborted";
  const err = new Error(message) as Error & { code: string };
  err.name = "AbortError";
  err.code = "REQUEST_ABORTED";
  return err;
}

/** Sleep for `ms` milliseconds, rejecting immediately if `signal` aborts. */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(createAbortError(signal));
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(createAbortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
