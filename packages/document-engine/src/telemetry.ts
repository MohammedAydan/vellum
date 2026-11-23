/**
 * @vellum/document-engine - Zero-dependency telemetry hooks.
 *
 * The engine never imports an observability vendor. Callers supply a
 * `TelemetryLike` (see `types.ts`); when none is supplied every hook is a
 * no-op. Spans are awaited so timing/tags are meaningful, while counters and
 * histograms are fire-and-forget by contract.
 *
 * Hardening:
 * - Metric names, tag counts, tag keys/values, and unique metric+tag
 *   cardinality are bounded so high-cardinality callers cannot exhaust memory
 *   or downstream observability backends.
 * - Sync/async sink failures in `counter`/`histogram` (and sink wrapper
 *   failures in `span`) are swallowed so telemetry never fails a request.
 */

import type { TelemetryLike } from "./types.js";

const MAX_METRIC_NAME_LEN = 128;
const MAX_TAGS_PER_CALL = 16;
const MAX_TAG_KEY_LEN = 64;
const MAX_TAG_VALUE_LEN = 128;
const MAX_CARDINALITY_SERIES = 1024;
const OVERFLOW_TAGS: Record<string, string> = Object.freeze({ _cardinality: "overflow" });

function sanitizeMetricString(raw: string, maxLen: number): string {
  const cleaned = raw.includes("\u0000") ? raw.replace(/\u0000/g, "") : raw;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function sanitizeTags(
  tags: Record<string, string> | undefined
): { sanitized: Record<string, string> | undefined; sig: string } {
  if (!tags || typeof tags !== "object") {
    return { sanitized: undefined, sig: "" };
  }
  const keys = Object.keys(tags);
  if (keys.length === 0) {
    return { sanitized: undefined, sig: "" };
  }
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  const limit = Math.min(keys.length, MAX_TAGS_PER_CALL);
  const sigParts: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    const rawKey = keys[i]!;
    if (rawKey === "__proto__" || rawKey === "constructor" || rawKey === "prototype") {
      continue;
    }
    const rawVal = tags[rawKey];
    if (typeof rawVal !== "string") continue;
    const k = sanitizeMetricString(rawKey, MAX_TAG_KEY_LEN);
    const v = sanitizeMetricString(rawVal, MAX_TAG_VALUE_LEN);
    out[k] = v;
    sigParts.push(`${k}=${v}`);
  }
  if (sigParts.length === 0) {
    return { sanitized: undefined, sig: "" };
  }
  sigParts.sort();
  return { sanitized: out, sig: sigParts.join("&") };
}

function swallowPotentialPromise(result: unknown): void {
  if (result && typeof (result as PromiseLike<unknown>).then === "function") {
    void Promise.resolve(result).catch(() => undefined);
  }
}

/** Shared no-op implementation. Safe to reuse across engines. */
export const noopTelemetry: TelemetryLike = {
  async span<T>(_name: string, fn: () => Promise<T> | T): Promise<T> {
    return await fn();
  },
  counter(): void {
    /* intentionally empty */
  },
  histogram(): void {
    /* intentionally empty */
  },
};

/**
 * Returns the supplied telemetry wrapped in a failure-isolating,
 * cardinality-bounded guard, or the shared no-op implementation when absent.
 */
export function resolveTelemetry(telemetry: TelemetryLike | null | undefined): TelemetryLike {
  if (!telemetry || telemetry === noopTelemetry) {
    return noopTelemetry;
  }

  const seenSeries = new Set<string>();

  const boundTags = (
    name: string,
    tags: Record<string, string> | undefined
  ): Record<string, string> | undefined => {
    const { sanitized, sig } = sanitizeTags(tags);
    const seriesKey = sig.length > 0 ? `${name}|${sig}` : name;
    if (seenSeries.has(seriesKey)) {
      return sanitized;
    }
    if (seenSeries.size < MAX_CARDINALITY_SERIES) {
      seenSeries.add(seriesKey);
      return sanitized;
    }
    return sig.length > 0 ? { ...OVERFLOW_TAGS } : undefined;
  };

  return {
    async span<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
      const safeName = sanitizeMetricString(String(name), MAX_METRIC_NAME_LEN);
      let invoked = false;
      let fnSettled = false;
      let fnThrew = false;
      let fnError: unknown;
      let fnResult: T | undefined;

      const guardedFn = async (): Promise<T> => {
        invoked = true;
        try {
          fnResult = await fn();
          fnSettled = true;
          return fnResult;
        } catch (error) {
          fnThrew = true;
          fnError = error;
          fnSettled = true;
          throw error;
        }
      };

      try {
        return await telemetry.span(safeName, guardedFn);
      } catch (error) {
        if (fnThrew) {
          throw fnError;
        }
        if (fnSettled) {
          return fnResult as T;
        }
        if (!invoked) {
          return await fn();
        }
        throw error;
      }
    },

    counter(name: string, value?: number, tags?: Record<string, string>): void {
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
        return;
      }
      const safeName = sanitizeMetricString(String(name), MAX_METRIC_NAME_LEN);
      const safeTags = boundTags(safeName, tags);
      try {
        const res =
          safeTags !== undefined
            ? telemetry.counter(safeName, value, safeTags)
            : value !== undefined
              ? telemetry.counter(safeName, value)
              : telemetry.counter(safeName);
        swallowPotentialPromise(res);
      } catch {
        // Telemetry failures are swallowed and never block requests.
      }
    },

    histogram(name: string, value: number, tags?: Record<string, string>): void {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return;
      }
      const safeName = sanitizeMetricString(String(name), MAX_METRIC_NAME_LEN);
      const safeTags = boundTags(safeName, tags);
      try {
        const res =
          safeTags !== undefined
            ? telemetry.histogram(safeName, value, safeTags)
            : telemetry.histogram(safeName, value);
        swallowPotentialPromise(res);
      } catch {
        // Telemetry failures are swallowed and never block requests.
      }
    },
  };
}
