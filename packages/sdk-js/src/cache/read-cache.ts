/**
 * @vellum/sdk-js - Bounded LRU + TTL Document Read Cache
 *
 * Zero external dependencies. Uses insertion-ordered `Map` for O(1) LRU
 * recency promotion and eviction, paired with a secondary per-path index for
 * O(1) targeted invalidation on local writes and incoming realtime mutations.
 *
 * All stored and retrieved values are defensively cloned via `sanitizeAndClone`
 * so callers cannot mutate cached entries in place.
 */

import { sanitizeAndClone } from "../core/safe-json.js";

export interface BoundedReadCacheOptions {
  /** Time-to-live for cached entries in milliseconds. Defaults to `30_000`. */
  ttlMs?: number;
  /** Maximum number of cached entries before LRU eviction. Defaults to `1_000`. */
  maxEntries?: number;
  /** Test seam: injectable clock returning epoch ms (defaults to `Date.now`). */
  now?: () => number;
}

interface CacheEntry<V> {
  path: string;
  value: V;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_CACHE_MAX_ENTRIES = 1_000;

export class BoundedReadCache<V> {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry<V>>();
  private readonly keysByPath = new Map<string, Set<string>>();

  public constructor(options: BoundedReadCacheOptions = {}) {
    this.ttlMs =
      typeof options.ttlMs === "number" && Number.isFinite(options.ttlMs) && options.ttlMs > 0
        ? options.ttlMs
        : DEFAULT_CACHE_TTL_MS;
    this.maxEntries =
      typeof options.maxEntries === "number" && Number.isFinite(options.maxEntries) && options.maxEntries >= 1
        ? Math.floor(options.maxEntries)
        : DEFAULT_CACHE_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    Object.freeze(this);
  }

  public get size(): number {
    return this.entries.size;
  }

  /** Safe JSON representation that never dumps cached document payloads. */
  public toJSON(): { size: number; maxEntries: number; ttlMs: number } {
    return {
      size: this.entries.size,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
    };
  }

  /** Safe string representation. */
  public toString(): string {
    return `BoundedReadCache(size=${this.entries.size}, maxEntries=${this.maxEntries}, ttlMs=${this.ttlMs})`;
  }

  /** Read an entry, enforcing TTL expiration and promoting it as most-recently-used. */
  public get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.deleteKey(key, entry.path);
      return undefined;
    }
    // Promote to most-recently-used (tail of Map iteration order).
    this.entries.delete(key);
    this.entries.set(key, entry);
    return sanitizeAndClone(entry.value);
  }

  /** Insert or update an entry under `key` associated with document `path`. */
  public set(key: string, path: string, value: V): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.deleteKey(key, existing.path);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldestEntry = this.entries.get(oldestKey);
      if (oldestEntry) {
        this.deleteKey(oldestKey, oldestEntry.path);
      } else {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, {
      path,
      value: sanitizeAndClone(value),
      expiresAt: this.now() + this.ttlMs,
    });
    let pathKeys = this.keysByPath.get(path);
    if (!pathKeys) {
      pathKeys = new Set<string>();
      this.keysByPath.set(path, pathKeys);
    }
    pathKeys.add(key);
  }

  /** Invalidate every cached variant (e.g. different select/include) for a document path. */
  public invalidatePath(path: string): void {
    const pathKeys = this.keysByPath.get(path);
    if (!pathKeys) return;
    for (const key of pathKeys) {
      this.entries.delete(key);
    }
    this.keysByPath.delete(path);
  }

  /** Invalidate every cached document belonging to a collection path prefix. */
  public invalidateCollection(collectionPath: string): void {
    const prefix = collectionPath.endsWith("/") ? collectionPath : `${collectionPath}/`;
    const matchedPaths: string[] = [];
    for (const path of this.keysByPath.keys()) {
      if (path.startsWith(prefix)) {
        matchedPaths.push(path);
      }
    }
    for (const path of matchedPaths) {
      this.invalidatePath(path);
    }
  }

  /** Clear all cached entries. */
  public clear(): void {
    this.entries.clear();
    this.keysByPath.clear();
  }

  private deleteKey(key: string, path: string): void {
    this.entries.delete(key);
    const pathKeys = this.keysByPath.get(path);
    if (pathKeys) {
      pathKeys.delete(key);
      if (pathKeys.size === 0) {
        this.keysByPath.delete(path);
      }
    }
  }
}
