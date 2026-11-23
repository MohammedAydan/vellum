/**
 * @vellum/storage - In-process TTL/LRU caches + PostgreSQL NOTIFY invalidation 
 *
 * Zero external stateful services: no Redis. Caches are process-local, bounded,
 * and expire on a lazy-on-get + periodically-swept schedule. Cross-instance
 * invalidation uses `NOTIFY vellum_cache_invalidate` on a dedicated PostgreSQL
 * client that is never returned to a request pool.
 *
 * The authoritative verified-API-key cache remains in `@vellum/authorization`
 * (30-second TTL, keyed by the 16-char `keyPrefix`, with revocation/expiry
 * checks on the fast path). This module mirrors those semantics so storage
 * adapters can cheaply memoize the same records; it never weakens the existing
 * verifier and never caches a secret in plaintext.
 */

import crypto from "node:crypto";
import pg from "pg";

/** Minimal surface of a pg client needed by the invalidation bus. */
export interface CacheNotifyClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows?: unknown[] }>;
  on(event: "error" | "notification", listener: (...args: unknown[]) => void): unknown;
  end(): Promise<void>;
}

export interface TtlCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  size: number;
}

export interface TtlCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V, ttlMs?: number): void;
  delete(key: string): void;
  clear(): void;
  size(): number;
  /** Live (non-expired) keys. Used for prefix invalidation and diagnostics. */
  keys(): string[];
  /** Diagnostic counters for benchmarks/tests. Never contains cached values. */
  stats(): TtlCacheStats;
  /** Stop the periodic sweep timer (tests / graceful shutdown). */
  dispose(): void;
  /**
   * Stampede-safe single-flight loader with generation tracking: concurrent
   * callers for the same key share one in-flight promise, and if the key is
   * invalidated while loading, the stale result is NOT written back to cache.
   */
  getOrLoad?(key: string, loader: () => Promise<V>, ttlMs?: number): Promise<V>;
  /** Delete all entries matching a prefix (e.g. tenant-scoped keys). */
  deleteByPrefix?(prefix: string): number;
}

interface TtlEntry<V> {
  value: V;
  expiresAt: number;
}

export interface TtlCacheOptions {
  /** Default TTL applied by `set` when no per-entry TTL is supplied. */
  ttlMs?: number;
  /** Hard upper bound on live entries; least-recently-used is evicted first. */
  maxEntries?: number;
  /** Sweep cadence for expired entries. `0` disables the timer entirely. */
  sweepIntervalMs?: number;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 1_024;
const DEFAULT_SWEEP_MS = 5_000;
const MAX_NOTIFICATION_KEY_LEN = 512;
const MAX_NOTIFICATION_SOURCE_LEN = 128;
const PG_CHANNEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

/**
 * Bounded O(1) LRU cache with lazy expiry on `get`, unref'd periodic sweep,
 * single-flight stampede protection, and generation-guarded invalidation so
 * in-flight loads can never re-populate a key invalidated mid-flight.
 */
export function createTtlCache<V>(options: TtlCacheOptions = {}): TtlCache<V> {
  const ttlMs = Number.isFinite(options.ttlMs) && (options.ttlMs as number) > 0
    ? (options.ttlMs as number)
    : DEFAULT_TTL_MS;
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
  const now = options.now ?? Date.now;

  const entries = new Map<string, TtlEntry<V>>();
  const inflight = new Map<string, { promise: Promise<V>; gen: number }>();
  const keyVersions = new Map<string, number>();
  let globalGen = 0;
  const counters = { hits: 0, misses: 0, evictions: 0, expirations: 0 };

  function isExpired(entry: TtlEntry<V>, at: number): boolean {
    return entry.expiresAt <= at;
  }

  function dropExpired(key: string, entry: TtlEntry<V>, at: number): boolean {
    if (isExpired(entry, at)) {
      entries.delete(key);
      counters.expirations += 1;
      return true;
    }
    return false;
  }

  function bumpKeyVersion(key: string): void {
    const next = (keyVersions.get(key) ?? 0) + 1;
    keyVersions.set(key, next);
    // Keep keyVersions bounded so long-lived caches with dynamic keys never leak.
    if (keyVersions.size > maxEntries * 2) {
      const oldest = keyVersions.keys().next();
      if (oldest.done !== true) keyVersions.delete(oldest.value);
    }
  }

  function sweep(): void {
    const at = now();
    for (const [key, entry] of entries) dropExpired(key, entry, at);
  }

  const timer = sweepIntervalMs > 0 ? setInterval(sweep, sweepIntervalMs) : undefined;
  // A cache timer must never keep a test runner or a shutting-down process alive.
  timer?.unref?.();

  const cache: TtlCache<V> = {
    get(key: string): V | undefined {
      const entry = entries.get(key);
      if (entry === undefined) {
        counters.misses += 1;
        return undefined;
      }
      const at = now();
      if (dropExpired(key, entry, at)) {
        counters.misses += 1;
        return undefined;
      }
      // O(1) move-to-tail: delete + re-insert preserves LRU recency.
      entries.delete(key);
      entries.set(key, entry);
      counters.hits += 1;
      return entry.value;
    },

    set(key: string, value: V, perEntryTtlMs?: number): void {
      const effectiveTtl = perEntryTtlMs === undefined ? ttlMs : perEntryTtlMs;
      if (!Number.isFinite(effectiveTtl) || effectiveTtl <= 0) {
        entries.delete(key);
        bumpKeyVersion(key);
        return;
      }
      const at = now();
      const existing = entries.get(key);
      if (existing !== undefined) entries.delete(key);
      while (entries.size >= maxEntries) {
        const oldest = entries.entries().next();
        if (oldest.done === true) break;
        const [oldestKey, oldestEntry] = oldest.value;
        entries.delete(oldestKey);
        if (isExpired(oldestEntry, at)) {
          counters.expirations += 1;
        } else {
          counters.evictions += 1;
        }
      }
      entries.set(key, { value, expiresAt: at + effectiveTtl });
      bumpKeyVersion(key);
    },

    delete(key: string): void {
      entries.delete(key);
      inflight.delete(key);
      bumpKeyVersion(key);
    },

    deleteByPrefix(prefix: string): number {
      let deleted = 0;
      for (const key of Array.from(entries.keys())) {
        if (key.startsWith(prefix)) {
          entries.delete(key);
          bumpKeyVersion(key);
          deleted += 1;
        }
      }
      for (const key of Array.from(inflight.keys())) {
        if (key.startsWith(prefix)) {
          inflight.delete(key);
          bumpKeyVersion(key);
        }
      }
      return deleted;
    },

    clear(): void {
      entries.clear();
      inflight.clear();
      keyVersions.clear();
      globalGen += 1;
    },

    size(): number {
      const at = now();
      for (const [key, entry] of entries) dropExpired(key, entry, at);
      return entries.size;
    },

    keys(): string[] {
      const at = now();
      const result: string[] = [];
      for (const [key, entry] of entries) {
        if (!dropExpired(key, entry, at)) result.push(key);
      }
      return result;
    },

    stats(): TtlCacheStats {
      return { ...counters, size: entries.size };
    },

    dispose(): void {
      if (timer !== undefined) clearInterval(timer);
      inflight.clear();
    },

    async getOrLoad(key: string, loader: () => Promise<V>, perEntryTtlMs?: number): Promise<V> {
      const cached = cache.get(key);
      if (cached !== undefined) return cached;

      const existingFlight = inflight.get(key);
      if (existingFlight !== undefined && existingFlight.gen === globalGen) {
        return existingFlight.promise;
      }

      const startGlobalGen = globalGen;
      const startKeyVer = keyVersions.get(key) ?? 0;
      const promise = Promise.resolve()
        .then(() => loader())
        .then((value) => {
          // Only populate cache if no invalidation/clear/write occurred mid-flight.
          if (globalGen === startGlobalGen && (keyVersions.get(key) ?? 0) === startKeyVer) {
            cache.set(key, value, perEntryTtlMs);
          }
          return value;
        })
        .finally(() => {
          const current = inflight.get(key);
          if (current?.promise === promise) inflight.delete(key);
        });

      inflight.set(key, { promise, gen: startGlobalGen });
      return promise;
    },
  };

  return cache;
}

/* -------------------------------------------------------------------------- */
/* Named caches (locked TTLs)                                                 */
/* -------------------------------------------------------------------------- */

export type CacheKind = "api_key" | "ruleset" | "project" | "relation_rules";

/** Locked v1 cache lifetimes. API keys match the 30s verifier cache exactly. */
export const CACHE_TTL_MS: Readonly<Record<CacheKind, number>> = {
  api_key: 30_000,
  ruleset: 60_000,
  project: 60_000,
  relation_rules: 30_000,
};

const namedCaches = new Map<CacheKind, TtlCache<unknown>>();

/** Returns the process-wide cache for a kind (lazily created once). */
export function getNamedCache<V>(kind: CacheKind): TtlCache<V> {
  let cache = namedCaches.get(kind);
  if (cache === undefined) {
    cache = createTtlCache<unknown>({ ttlMs: CACHE_TTL_MS[kind], maxEntries: 4_096 });
    namedCaches.set(kind, cache);
  }
  return cache as TtlCache<V>;
}

/** Canonical key for project metadata entries (tenant == project). */
export function projectCacheKey(projectId: string): string {
  return projectId;
}

/**
 * Collision-proof tenant-scoped cache key using length-prefixed projectId so
 * `scopedCacheKey("a:b", "c")` can never collide with `scopedCacheKey("a", "b:c")`.
 */
export function scopedCacheKey(projectId: string, key: string): string {
  if (!projectId) {
    throw new Error("Tenant-scoped cache key requires a non-empty projectId");
  }
  return `${projectId.length}:${projectId}:${key}`;
}

/* -------------------------------------------------------------------------- */
/* Explicit invalidation hooks — call from admin writes                       */
/* -------------------------------------------------------------------------- */

/** Invalidate one verified API key (by `keyPrefix`) or every cached key. */
export function invalidateApiKeyCache(keyPrefix?: string): void {
  const cache = getNamedCache<unknown>("api_key");
  if (keyPrefix === undefined) cache.clear();
  else cache.delete(keyPrefix);
}

/** Invalidate one active ruleset (by id) or every cached ruleset. */
export function invalidateRulesetCache(rulesetId?: string): void {
  const cache = getNamedCache<unknown>("ruleset");
  if (rulesetId === undefined) cache.clear();
  else cache.delete(rulesetId);
}

/** Invalidate one project's relation rules (by projectId) or all of them. */
export function invalidateRelationRulesCache(projectId?: string): void {
  const cache = getNamedCache<unknown>("relation_rules");
  if (projectId === undefined) cache.clear();
  else cache.delete(projectId);
}

/**
 * Invalidate one project metadata entry (and any `projectId:*` or
 * length-prefixed scoped sub-keys for that project), or all cached project entries.
 */
export function invalidateProjectCache(projectId?: string): void {
  const cache = getNamedCache<unknown>("project");
  if (projectId === undefined) {
    cache.clear();
    return;
  }
  cache.delete(projectId);
  cache.deleteByPrefix?.(`${projectId}:`);
  cache.deleteByPrefix?.(`${projectId.length}:${projectId}:`);
}

/** Invalidate all tenant-scoped entries in a named cache for a specific projectId. */
export function invalidateTenantCachePrefix(kind: CacheKind, projectId: string): void {
  const cache = getNamedCache<unknown>(kind);
  cache.delete(projectId);
  cache.deleteByPrefix?.(`${projectId}:`);
  cache.deleteByPrefix?.(`${projectId.length}:${projectId}:`);
}

/** Invalidate every named cache (e.g. a full admin metadata reload). */
export function invalidateAllCaches(): void {
  for (const cache of namedCaches.values()) cache.clear();
}

/* -------------------------------------------------------------------------- */
/* Cross-instance invalidation via PostgreSQL LISTEN / NOTIFY                 */
/* -------------------------------------------------------------------------- */

export const CACHE_INVALIDATION_CHANNEL = "vellum_cache_invalidate";

export type InvalidationKind = CacheKind | "all";

export interface CacheInvalidationMessage {
  kind: InvalidationKind;
  /** Optional cache key. Absent means "invalidate the whole kind". */
  key?: string;
  /** Opaque instance id so a publisher can ignore its own notification. */
  source?: string;
}

const VALID_KINDS: ReadonlySet<string> = new Set<InvalidationKind>([
  "api_key",
  "ruleset",
  "project",
  "relation_rules",
  "all",
]);

/** Serialize a notification payload. Never includes cached values or secrets. */
export function encodeCacheInvalidation(message: CacheInvalidationMessage): string {
  return JSON.stringify({
    kind: message.kind,
    ...(message.key === undefined ? {} : { key: message.key }),
    ...(message.source === undefined ? {} : { source: message.source }),
  });
}

/** Parse + validate a notification payload. Returns `null` for malformed frames. */
export function decodeCacheInvalidation(payload: string): CacheInvalidationMessage | null {
  if (typeof payload !== "string" || payload.length === 0 || payload.length > 4_096) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, "kind")) return null;
    const kind = obj["kind"];
    if (typeof kind !== "string" || !VALID_KINDS.has(kind)) return null;
    const key = Object.prototype.hasOwnProperty.call(obj, "key") ? obj["key"] : undefined;
    const source = Object.prototype.hasOwnProperty.call(obj, "source") ? obj["source"] : undefined;
    const validKey =
      typeof key === "string" && key.length <= MAX_NOTIFICATION_KEY_LEN && !key.includes("\0")
        ? key
        : undefined;
    const validSource =
      typeof source === "string" && source.length <= MAX_NOTIFICATION_SOURCE_LEN && !source.includes("\0")
        ? source
        : undefined;
    return {
      kind: kind as InvalidationKind,
      ...(validKey !== undefined ? { key: validKey } : {}),
      ...(validSource !== undefined ? { source: validSource } : {}),
    };
  } catch {
    return null;
  }
}

/** Apply a decoded invalidation message to the local named caches. */
export function applyCacheInvalidation(message: CacheInvalidationMessage): void {
  switch (message.kind) {
    case "api_key":
      invalidateApiKeyCache(message.key);
      break;
    case "ruleset":
      invalidateRulesetCache(message.key);
      break;
    case "relation_rules":
      invalidateRelationRulesCache(message.key);
      break;
    case "project":
      if (message.key === undefined) invalidateProjectCache();
      else {
        const cache = getNamedCache<unknown>("project");
        cache.delete(message.key);
        cache.deleteByPrefix?.(`${message.key}:`);
        cache.deleteByPrefix?.(`${message.key.length}:${message.key}:`);
      }
      break;
    case "all":
      invalidateAllCaches();
      break;
  }
}

export interface CacheInvalidationBusOptions {
  connectionString: string;
  /** Defaults to `vellum_cache_invalidate`. */
  channel?: string;
  applicationName?: string;
  /** Called for each valid remote invalidation. */
  onInvalidate: (message: CacheInvalidationMessage) => void;
  /** Optional observer for background failures (must never throw). */
  onError?: (error: unknown) => void;
  /** Injectable client factory — enables hermetic unit tests. */
  clientFactory?: () => CacheNotifyClient;
  /** Initial reconnect delay after a LISTEN failure. Defaults to 500ms. */
  reconnectBackoffMs?: number;
  /** Reconnect delay ceiling. Defaults to 30_000ms. */
  maxReconnectBackoffMs?: number;
  instanceId?: string;
}

export interface CacheInvalidationBus {
  publish(message: CacheInvalidationMessage): Promise<void>;
  close(): Promise<void>;
  isListening(): boolean;
}

let activeInvalidationBus: CacheInvalidationBus | null = null;

/** Register the process-wide invalidation bus so route handlers can publish. */
export function setCacheInvalidationBus(bus: CacheInvalidationBus | null): void {
  activeInvalidationBus = bus;
}

/** Returns the registered bus, if the runtime started one. */
export function getCacheInvalidationBus(): CacheInvalidationBus | null {
  return activeInvalidationBus;
}

/**
 * Dedicated LISTEN client + dedicated publish client. Neither is ever taken
 * from a request pool. The listener auto-reconnects with capped backoff and
 * every timer is unref'd so it cannot keep the process alive.
 */
export function createCacheInvalidationBus(options: CacheInvalidationBusOptions): CacheInvalidationBus {
  const channel = options.channel ?? CACHE_INVALIDATION_CHANNEL;
  if (!PG_CHANNEL_RE.test(channel)) {
    throw new Error(`Invalid PostgreSQL LISTEN/NOTIFY channel identifier: '${channel}'`);
  }
  const instanceId = options.instanceId ?? `vellum-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const initialBackoff = Math.max(1, options.reconnectBackoffMs ?? 500);
  const maxBackoff = Math.max(initialBackoff, options.maxReconnectBackoffMs ?? 30_000);
  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // A broken observer must never crash the invalidation loop.
    }
  };

  const makeClient: () => CacheNotifyClient =
    options.clientFactory ??
    (() => {
      const client = new pg.Client({
        connectionString: options.connectionString,
        application_name: options.applicationName ?? "vellum-cache-invalidation",
      });
      return {
        connect: async () => {
          await client.connect();
        },
        query: (sql: string, params?: unknown[]) => client.query(sql, params),
        on: (event: "error" | "notification", listener: (...args: unknown[]) => void) =>
          event === "error" ? client.on("error", listener) : client.on("notification", listener),
        end: () => client.end(),
      };
    });

  let listener: CacheNotifyClient | null = null;
  let publisher: CacheNotifyClient | null = null;
  let publisherConnectPromise: Promise<CacheNotifyClient> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let backoff = initialBackoff;
  let closed = false;
  let listening = false;

  async function ensurePublisher(): Promise<CacheNotifyClient> {
    if (closed) {
      throw new Error("Cache invalidation bus is closed");
    }
    if (publisher !== null) return publisher;
    if (publisherConnectPromise !== null) return publisherConnectPromise;

    const client = makeClient();
    client.on("error", (error: unknown) => {
      reportError(error);
      if (publisher === client) publisher = null;
    });
    publisherConnectPromise = client
      .connect()
      .then(() => {
        if (closed) {
          void client.end().catch((error: unknown) => reportError(error));
          throw new Error("Cache invalidation bus is closed");
        }
        publisher = client;
        return client;
      })
      .catch((error: unknown) => {
        void client.end().catch(() => {
          /* ignore secondary close error */
        });
        throw error;
      })
      .finally(() => {
        publisherConnectPromise = null;
      });
    return publisherConnectPromise;
  }

  function startListener(): void {
    if (closed) return;
    const client = makeClient();
    listener = client;
    client.on("notification", (...args: unknown[]) => {
      const frame = args[0] as { channel?: string; payload?: string } | undefined;
      if (frame?.channel !== channel || typeof frame.payload !== "string") return;
      const message = decodeCacheInvalidation(frame.payload);
      if (message === null) return;
      // Ignore our own notifications: the publisher already invalidated locally.
      if (message.source === instanceId) return;
      try {
        options.onInvalidate(message);
      } catch (error: unknown) {
        reportError(error);
      }
    });
    client.on("error", (error: unknown) => {
      listening = false;
      reportError(error);
      scheduleReconnect();
    });

    void client
      .connect()
      .then(() => {
        if (closed) return;
        return client.query(`LISTEN ${quoteIdentifier(channel)}`);
      })
      .then(() => {
        if (closed) {
          void client.end().catch((error: unknown) => reportError(error));
          return;
        }
        backoff = initialBackoff;
        listening = true;
      })
      .catch((error: unknown) => {
        listening = false;
        reportError(error);
        scheduleReconnect();
      });
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer !== undefined) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      const previous = listener;
      listener = null;
      void previous?.end().catch((error: unknown) => reportError(error));
      startListener();
    }, backoff);
    reconnectTimer.unref?.();
    backoff = Math.min(maxBackoff, backoff * 2);
  }

  // Begin listening immediately on a client that is never returned to a pool.
  startListener();

  return {
    async publish(message: CacheInvalidationMessage): Promise<void> {
      // Apply locally first so a transient NOTIFY network error never leaves
      // stale data on the instance that performed the mutation.
      applyCacheInvalidation(message);
      if (closed) return;

      const pub = await ensurePublisher();
      const payload = encodeCacheInvalidation({
        ...message,
        source: message.source ?? instanceId,
      });
      try {
        await pub.query("SELECT pg_notify($1, $2)", [channel, payload]);
      } catch (error: unknown) {
        if (publisher === pub) publisher = null;
        void pub.end().catch(() => {
          /* ignore cleanup error on broken publisher */
        });
        throw error;
      }
    },

    async close(): Promise<void> {
      closed = true;
      listening = false;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const clients = [listener, publisher];
      listener = null;
      publisher = null;
      await Promise.all(
        clients.map(async (client) => {
          if (client === null) return;
          try {
            await client.end();
          } catch (error: unknown) {
            reportError(error);
          }
        })
      );
    },

    isListening(): boolean {
      return listening && !closed;
    },
  };
}

/** Quote a channel identifier for safe interpolation in `LISTEN`. */
function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
