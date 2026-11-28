/**
 * `@vellum/observability/src/platform-usage-meter.ts`
 *
 * O(1) platform cost meter. It counts the work the platform itself performs
 * (requests by class, CPU time, bytes in and out) per project and per minute so
 * the admin console can price platform spend. It never reads or stores customer
 * documents: only counts and byte totals leave this module.
 *
 * Recording is synchronous, allocation-bounded and never throws. Persistence is
 * the caller's job: `flush()` swaps the pending buckets and hands them over in
 * one batch, exactly like the billing metering engine does for customer usage.
 */

export type PlatformUsageMetric =
  | "requests_read"
  | "requests_write"
  | "requests_other"
  | "cpu_ms"
  | "bytes_in"
  | "bytes_out"
  | "realtime_frames";

/** Every counter a bucket carries, in a stable order. */
export const PLATFORM_USAGE_METRICS: readonly PlatformUsageMetric[] = [
  "requests_read",
  "requests_write",
  "requests_other",
  "cpu_ms",
  "bytes_in",
  "bytes_out",
  "realtime_frames",
];

/**
 * Scope used for work that belongs to no single project (console, admin, auth
 * and anything the platform runs for itself). The zero UUID keeps the column a
 * plain `uuid NOT NULL` and keeps the primary key usable.
 */
export const PLATFORM_SCOPE = "00000000-0000-0000-0000-000000000000";

export type PlatformUsageCounts = Record<PlatformUsageMetric, number>;

export interface PlatformUsageBucket {
  /** Start of the minute bucket, epoch milliseconds. */
  bucketStartMs: number;
  /** Project UUID, or {@link PLATFORM_SCOPE}. */
  projectId: string;
  counts: PlatformUsageCounts;
}

export interface PlatformUsageMeterOptions {
  /** Injectable clock (epoch ms). Defaults to `Date.now`. */
  now?: (() => number) | undefined;
  /** Bucket width. Defaults to 60s, which is the documented cost granularity. */
  bucketMs?: number | undefined;
  /** Hard cap on live buckets; the oldest are dropped when it is reached. */
  maxBuckets?: number | undefined;
  /** Receives each flushed batch. A rejection keeps the batch for the next flush. */
  onFlush?: ((buckets: PlatformUsageBucket[]) => Promise<void> | void) | undefined;
}

const DEFAULT_BUCKET_MS = 60_000;
const DEFAULT_MAX_BUCKETS = 4_000;
const MAX_COUNTER_VALUE = Number.MAX_SAFE_INTEGER;
const MAX_PROJECT_ID_LENGTH = 64;
const VALID_METRICS: ReadonlySet<string> = new Set(PLATFORM_USAGE_METRICS);

function emptyCounts(): PlatformUsageCounts {
  return {
    requests_read: 0,
    requests_write: 0,
    requests_other: 0,
    cpu_ms: 0,
    bytes_in: 0,
    bytes_out: 0,
    realtime_frames: 0,
  };
}

/** Guard against NaN, Infinity, negatives and overflow without branching hot paths. */
function safeDelta(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.trunc(value), MAX_COUNTER_VALUE);
}

function safeAdd(current: number, delta: number): number {
  const next = current + delta;
  return next > MAX_COUNTER_VALUE ? MAX_COUNTER_VALUE : next;
}

export class PlatformUsageMeter {
  private readonly now: () => number;
  private readonly bucketMs: number;
  private readonly maxBuckets: number;
  private onFlush: ((buckets: PlatformUsageBucket[]) => Promise<void> | void) | undefined;
  private buckets = new Map<string, PlatformUsageBucket>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(options: PlatformUsageMeterOptions = {}) {
    this.now = options.now ?? Date.now;
    const bucketMs = options.bucketMs ?? DEFAULT_BUCKET_MS;
    this.bucketMs = Number.isFinite(bucketMs) && bucketMs >= 1_000 ? Math.trunc(bucketMs) : DEFAULT_BUCKET_MS;
    const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
    this.maxBuckets = Number.isFinite(maxBuckets) && maxBuckets > 0 ? Math.trunc(maxBuckets) : DEFAULT_MAX_BUCKETS;
    this.onFlush = options.onFlush;
  }

  /** Replace the flush sink, for composition roots that wire it after construction. */
  setFlushHandler(handler: ((buckets: PlatformUsageBucket[]) => Promise<void> | void) | undefined): void {
    this.onFlush = handler;
  }

  /** Number of live buckets; used by tests and the live admin view. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Add `value` to one counter for the current minute bucket. Synchronous, no
   * I/O, never throws: a bad metric name or value is dropped.
   */
  record(projectId: string, metric: PlatformUsageMetric, value = 1): void {
    if (!VALID_METRICS.has(metric)) return;
    const delta = safeDelta(value);
    if (delta === 0) return;

    const scope =
      typeof projectId === "string" && projectId.length > 0 && projectId.length <= MAX_PROJECT_ID_LENGTH
        ? projectId
        : PLATFORM_SCOPE;
    const bucketStartMs = Math.floor(this.now() / this.bucketMs) * this.bucketMs;
    const key = `${bucketStartMs}|${scope}`;
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxBuckets) this.evictOldest();
      bucket = { bucketStartMs, projectId: scope, counts: emptyCounts() };
      this.buckets.set(key, bucket);
    }
    bucket.counts[metric] = safeAdd(bucket.counts[metric], delta);
  }

  /** Non-destructive copy of the live buckets, oldest first. */
  snapshot(): PlatformUsageBucket[] {
    return Array.from(this.buckets.values())
      .map((bucket) => ({
        bucketStartMs: bucket.bucketStartMs,
        projectId: bucket.projectId,
        counts: { ...bucket.counts },
      }))
      .sort((a, b) => a.bucketStartMs - b.bucketStartMs);
  }

  /**
   * Swap the pending buckets and hand them to the flush handler in one batch.
   * Returns the number of buckets persisted; on failure the batch is merged back
   * so the next cycle retries it, and the error is swallowed.
   */
  async flush(): Promise<number> {
    if (this.flushing || this.onFlush === undefined || this.buckets.size === 0) return 0;
    const batch = Array.from(this.buckets.values());
    const pending = this.buckets;
    this.buckets = new Map();
    this.flushing = true;
    try {
      await this.onFlush(batch);
      return batch.length;
    } catch {
      this.mergeBack(pending);
      return 0;
    } finally {
      this.flushing = false;
    }
  }

  /** Start the periodic flush. Idempotent. */
  start(intervalMs = DEFAULT_BUCKET_MS): void {
    if (this.timer !== null) return;
    const period = Number.isFinite(intervalMs) && intervalMs >= 1_000 ? Math.trunc(intervalMs) : DEFAULT_BUCKET_MS;
    this.timer = setInterval(() => {
      void this.flush();
    }, period);
    this.timer.unref?.();
  }

  /** Stop the timer and flush whatever is pending. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private mergeBack(previous: Map<string, PlatformUsageBucket>): void {
    for (const [key, bucket] of previous) {
      const existing = this.buckets.get(key);
      if (existing === undefined) {
        this.buckets.set(key, bucket);
        continue;
      }
      for (const metric of PLATFORM_USAGE_METRICS) {
        existing.counts[metric] = safeAdd(existing.counts[metric], bucket.counts[metric]);
      }
    }
    while (this.buckets.size > this.maxBuckets) this.evictOldest();
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestStart = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.bucketStartMs < oldestStart) {
        oldestStart = bucket.bucketStartMs;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.buckets.delete(oldestKey);
  }
}
