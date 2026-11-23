/**
 * @vellum/observability - Bounded Sliding Window Rate Limiter
 *
 * Uses O(1) insertion-order LRU eviction and bounded cardinality caps so IP
 * or tenant flooding can never exhaust process memory.
 */

import { VellumError } from "@vellum/core";

const DEFAULT_MAX_KEYS = 50_000;
const MAX_KEY_LENGTH = 256;
const WINDOW_MS = 1_000;
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/g;

export interface RateLimiter {
  checkAndConsume: (keyPrefix: string, limitRps?: number, nowMs?: number) => { remaining: number };
}

function sanitizeKey(raw: string): string {
  if (typeof raw !== "string") return "unknown";
  const cleaned = raw.replace(CONTROL_CHAR_REGEX, "").trim();
  if (cleaned.length === 0) return "unknown";
  return cleaned.length > MAX_KEY_LENGTH ? cleaned.slice(0, MAX_KEY_LENGTH) : cleaned;
}

export class SlidingWindowRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly maxKeys: number;

  constructor(maxKeys = DEFAULT_MAX_KEYS) {
    this.maxKeys =
      Number.isFinite(maxKeys) && maxKeys >= 1 ? Math.trunc(maxKeys) : DEFAULT_MAX_KEYS;
  }

  checkAndConsume(keyPrefix: string, limitRps = 100, nowMs: number = Date.now()): { remaining: number } {
    const safeKey = sanitizeKey(keyPrefix);
    const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
    const safeLimit = Number.isFinite(limitRps) ? Math.trunc(limitRps) : 100;

    if (safeLimit <= 0) {
      throw new VellumError("RATE_LIMITED", `Rate limit of ${safeLimit} requests/sec exceeded for key '${safeKey}'`, {
        keyPrefix: safeKey,
        limitRps: safeLimit,
        retryAfterMs: WINDOW_MS,
      });
    }

    const windowStart = safeNow - WINDOW_MS;
    const existing = this.windows.get(safeKey);
    let timestamps: number[];
    if (existing === undefined) {
      timestamps = [];
    } else {
      // Drop expired timestamps in O(k) without scanning when none expired.
      let keepFrom = 0;
      while (keepFrom < existing.length && (existing[keepFrom] ?? 0) <= windowStart) {
        keepFrom++;
      }
      timestamps = keepFrom === 0 ? existing : existing.slice(keepFrom);
      // Promote to MRU in O(1).
      this.windows.delete(safeKey);
    }

    if (timestamps.length >= safeLimit) {
      this.evictOldestIfFull();
      this.windows.set(safeKey, timestamps);
      const oldestTs = timestamps[0] ?? safeNow;
      const retryAfterMs = Math.max(1, Math.min(WINDOW_MS, oldestTs + WINDOW_MS - safeNow));
      throw new VellumError("RATE_LIMITED", `Rate limit of ${safeLimit} requests/sec exceeded for key '${safeKey}'`, {
        keyPrefix: safeKey,
        limitRps: safeLimit,
        retryAfterMs,
      });
    }

    timestamps.push(safeNow);
    this.evictOldestIfFull();
    this.windows.set(safeKey, timestamps);
    return { remaining: safeLimit - timestamps.length };
  }

  private evictOldestIfFull(): void {
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) break;
      this.windows.delete(oldest.value);
    }
  }
}
