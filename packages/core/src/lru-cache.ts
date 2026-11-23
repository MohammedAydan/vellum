/**
 * @vellum/core - Bounded LRU + TTL cache (V2, Zero-Redis doctrine)
 *
 * A tiny, zero-dependency, generic cache used by the control plane for the
 * synchronous "active ruleset" and "auth config" read paths. The cache keeps a
 * hard bound on live entries so a tenant-id-keyed workload can never grow
 * without limit, and every entry carries a monotonic deadline supplied by an
 * injectable clock.
 *
 * Semantics:
 *  - LRU recency is the `Map` insertion order. A `get` hit is delete+reinserted
 *    at the tail; an eviction removes the head (least recently used).
 *  - Expiry is lazy on `get` (and on `size`/`stats`) plus an unref'd periodic
 *    sweep timer so entries that are never read are still reclaimed.
 *  - `invalidatePrefix` coerces each key with `String(key)` before matching,
 *    which is what makes string-prefix cache namespaces safe for generic keys.
 */

export interface BoundedLruCacheOptions {
  /** Hard upper bound on live entries. Always at least 1. */
  maxEntries: number;
  /** Per-entry time-to-live in milliseconds. Always at least 1. */
  ttlMs: number;
  /** Injectable monotonic clock. Defaults to `Date.now`. */
  now?: (() => number) | undefined;
}

export interface LruCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  size: number;
}

interface LruEntry<V> {
  value: V;
  expiresAt: number;
}

export class BoundedLruCache<K, V> {
  private readonly entries = new Map<K, LruEntry<V>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly sweepTimer: ReturnType<typeof setInterval> | undefined;
  private readonly counters = { hits: 0, misses: 0, evictions: 0, expirations: 0 };

  constructor(options: BoundedLruCacheOptions) {
    const rawMax = Number.isFinite(options.maxEntries) ? Math.floor(options.maxEntries) : 1;
    const rawTtl = Number.isFinite(options.ttlMs) ? options.ttlMs : 1;
    this.maxEntries = Math.max(1, rawMax);
    this.ttlMs = Math.max(1, rawTtl);
    this.now = options.now ?? Date.now;
    // Sweep often enough to bound memory from never-read entries, but never
    // more often than the TTL itself. A short cadence is intentional: with a
    // 10s TTL the sweep reclaims expired rows within ~1s of their deadline.
    const sweepEveryMs = Math.max(1, Math.min(this.ttlMs, 1_000));
    this.sweepTimer = setInterval(() => this.sweep(), sweepEveryMs);
    // A cache timer must never keep a test runner or a shutting-down process alive.
    this.sweepTimer?.unref?.();
  }

  public get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.counters.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.counters.expirations += 1;
      this.counters.misses += 1;
      return undefined;
    }
    // Move-to-tail: delete + reinsert preserves LRU recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.counters.hits += 1;
    return entry.value;
  }

  public set(key: K, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
      this.counters.evictions += 1;
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  public delete(key: K): void {
    this.entries.delete(key);
  }

  /** Delete every key whose `String(key)` starts with `prefix`. */
  public invalidatePrefix(prefix: string): void {
    for (const key of Array.from(this.entries.keys())) {
      if (String(key).startsWith(prefix)) this.entries.delete(key);
    }
  }

  public clear(): void {
    this.entries.clear();
  }

  public size(): number {
    this.sweep();
    return this.entries.size;
  }

  public stats(): LruCacheStats {
    this.sweep();
    return { ...this.counters, size: this.entries.size };
  }

  /** Stop the periodic sweep. Idempotent; safe for graceful shutdown/tests. */
  public dispose(): void {
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
  }

  private sweep(): void {
    const at = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= at) {
        this.entries.delete(key);
        this.counters.expirations += 1;
      }
    }
  }
}
