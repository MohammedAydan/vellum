import { VellumError } from "@vellum/core";

/**
 * Per-project cap on queries that no index serves (they read the collection). Without it a handful of
 * concurrent scans can saturate the data plane for every other tenant request. The cap is per API
 * process; excess callers get a retryable 429 instead of queueing behind the scans.
 * `VELLUM_UNINDEXED_QUERY_MAX_CONCURRENT`: default 4, `0` disables.
 */
const DEFAULT_MAX_CONCURRENT = 4;
const inFlight = new Map<string, number>();

export function resolveUnindexedQueryMaxConcurrent(): number {
  const raw = process.env["VELLUM_UNINDEXED_QUERY_MAX_CONCURRENT"];
  if (raw === undefined || raw === "") return DEFAULT_MAX_CONCURRENT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_CONCURRENT;
}

export async function withUnindexedQuerySlot<T>(projectId: string, run: () => Promise<T>): Promise<T> {
  const max = resolveUnindexedQueryMaxConcurrent();
  if (max === 0) return run();
  const current = inFlight.get(projectId) ?? 0;
  if (current >= max) {
    throw new VellumError(
      "RESOURCE_EXHAUSTED",
      `Too many concurrent unindexed queries for this project (limit ${max}). Create the suggested index, or retry shortly.`,
      { reason: "UNINDEXED_QUERY_CONCURRENCY", maxConcurrentUnindexedQueries: max, retryAfterMs: 1000 }
    );
  }
  inFlight.set(projectId, current + 1);
  try {
    return await run();
  } finally {
    const left = (inFlight.get(projectId) ?? 1) - 1;
    if (left <= 0) inFlight.delete(projectId);
    else inFlight.set(projectId, left);
  }
}
