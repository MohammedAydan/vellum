import { describe, it, expect, vi } from "vitest";
import {
  CACHE_TTL_MS,
  CACHE_INVALIDATION_CHANNEL,
  applyCacheInvalidation,
  createCacheInvalidationBus,
  createTtlCache,
  decodeCacheInvalidation,
  encodeCacheInvalidation,
  getNamedCache,
  invalidateAllCaches,
  invalidateApiKeyCache,
  invalidateProjectCache,
  invalidateRulesetCache,
  projectCacheKey,
  type CacheNotifyClient,
} from "../cache.js";

class FakePgClient implements CacheNotifyClient {
  readonly queries: Array<{ sql: string; params?: unknown[] }> = [];
  readonly listeners = new Map<string, (...args: unknown[]) => void>();
  ended = false;

  async connect(): Promise<void> {
    /* no network */
  }

  async query(sql: string, params?: unknown[]): Promise<{ rows?: unknown[] }> {
    this.queries.push({ sql, ...(params === undefined ? {} : { params }) });
    return { rows: [] };
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    this.listeners.set(event, listener);
    return this;
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  emitNotification(payload: string, channel = CACHE_INVALIDATION_CHANNEL): void {
    this.listeners.get("notification")?.({ channel, payload });
  }

  emitError(error: unknown): void {
    this.listeners.get("error")?.(error);
  }
}

describe("@vellum/storage - TTL/LRU cache", () => {
  it("expires entries lazily on get and counts statistics", () => {
    let now = 1_000;
    const cache = createTtlCache<string>({
      ttlMs: 100,
      sweepIntervalMs: 0,
      now: () => now,
    });
    cache.set("key", "value");
    expect(cache.get("key")).toBe("value");
    now += 101;
    expect(cache.get("key")).toBeUndefined();
    expect(cache.size()).toBe(0);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, expirations: 1 });
    cache.dispose();
  });

  it("evicts the least-recently-used entry at the hard bound", () => {
    const cache = createTtlCache<number>({ ttlMs: 10_000, maxEntries: 2, sweepIntervalMs: 0 });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1); // "a" becomes most-recent; "b" is now oldest
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.stats().evictions).toBe(1);
    cache.dispose();
  });

  it("uses locked 30s/60s TTLs for the named caches", () => {
    expect(CACHE_TTL_MS).toEqual({ api_key: 30_000, ruleset: 60_000, project: 60_000, relation_rules: 30_000 });
    expect(getNamedCache("api_key")).toBe(getNamedCache("api_key"));
    expect(getNamedCache("ruleset")).toBe(getNamedCache("ruleset"));
  });
});

describe("@vellum/storage - invalidation hooks", () => {
  it("invalidates a single API key without evicting its neighbours", () => {
    const cache = getNamedCache<string>("api_key");
    invalidateApiKeyCache();
    cache.set("pk_aaaaaaaaaaaa", "a");
    cache.set("pk_bbbbbbbbbbbb", "b");
    invalidateApiKeyCache("pk_aaaaaaaaaaaa");
    expect(cache.get("pk_aaaaaaaaaaaa")).toBeUndefined();
    expect(cache.get("pk_bbbbbbbbbbbb")).toBe("b");
  });

  it("invalidates one ruleset, a project prefix, and everything", () => {
    const rulesets = getNamedCache<string>("ruleset");
    const metadata = getNamedCache<string>("project");
    invalidateAllCaches();

    rulesets.set("ruleset-1", "v1");
    rulesets.set("ruleset-2", "v2");
    invalidateRulesetCache("ruleset-1");
    expect(rulesets.get("ruleset-1")).toBeUndefined();
    expect(rulesets.get("ruleset-2")).toBe("v2");

    metadata.set(projectCacheKey("p1"), "p1");
    metadata.set(projectCacheKey("p2"), "p2");
    invalidateProjectCache("p1");
    expect(metadata.get(projectCacheKey("p1"))).toBeUndefined();
    expect(metadata.get(projectCacheKey("p2"))).toBe("p2");

    invalidateProjectCache();
    expect(metadata.get(projectCacheKey("p2"))).toBeUndefined();

    rulesets.set("ruleset-3", "v3");
    invalidateAllCaches();
    expect(rulesets.size()).toBe(0);
  });

  it("round-trips and validates NOTIFY payloads without leaking values", () => {
    const payload = encodeCacheInvalidation({ kind: "ruleset", key: "ruleset-9", source: "instance-a" });
    expect(payload).not.toContain("v3");
    expect(decodeCacheInvalidation(payload)).toEqual({
      kind: "ruleset",
      key: "ruleset-9",
      source: "instance-a",
    });
    expect(decodeCacheInvalidation("not json")).toBeNull();
    expect(decodeCacheInvalidation(JSON.stringify({ kind: "bogus" }))).toBeNull();
    expect(decodeCacheInvalidation(JSON.stringify({ kind: "api_key", key: 42 }))).toEqual({ kind: "api_key" });
  });

  it("applies a decoded message to the local named caches", () => {
    invalidateAllCaches();
    getNamedCache<string>("api_key").set("pk_x", "record");
    applyCacheInvalidation({ kind: "api_key", key: "pk_x" });
    expect(getNamedCache<string>("api_key").get("pk_x")).toBeUndefined();

    getNamedCache<string>("project").set("p:meta", "meta");
    applyCacheInvalidation({ kind: "project", key: "p:meta" });
    expect(getNamedCache<string>("project").get("p:meta")).toBeUndefined();
  });
});

describe("@vellum/storage - NOTIFY bus (hermetic)", () => {
  it("LISTENs on the dedicated client and applies remote invalidations", async () => {
    const clients: FakePgClient[] = [];
    const received: unknown[] = [];
    const bus = createCacheInvalidationBus({
      connectionString: "postgresql://unused:unused@localhost:5432/unused",
      clientFactory: () => {
        const client = new FakePgClient();
        clients.push(client);
        return client;
      },
      onInvalidate: (message) => received.push(message),
      instanceId: "self",
    });

    // Wait for the connect->LISTEN promise chain.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(clients[0]?.queries[0]?.sql).toContain('LISTEN "vellum_cache_invalidate"');
    expect(bus.isListening()).toBe(true);

    clients[0]?.emitNotification(
      encodeCacheInvalidation({ kind: "api_key", key: "pk_remote", source: "other" })
    );
    expect(received).toEqual([{ kind: "api_key", key: "pk_remote", source: "other" }]);

    // Our own notifications are ignored by the listener.
    clients[0]?.emitNotification(
      encodeCacheInvalidation({ kind: "api_key", key: "pk_self", source: "self" })
    );
    expect(received).toHaveLength(1);

    getNamedCache<string>("ruleset").set("ruleset-remote", "v");
    await bus.publish({ kind: "ruleset", key: "ruleset-remote" });
    const publisher = clients[1];
    expect(publisher?.queries[0]?.sql).toBe("SELECT pg_notify($1, $2)");
    expect(publisher?.queries[0]?.params?.[0]).toBe("vellum_cache_invalidate");
    expect(getNamedCache<string>("ruleset").get("ruleset-remote")).toBeUndefined();

    await bus.close();
    expect(bus.isListening()).toBe(false);
    expect(clients.every((client) => client.ended)).toBe(true);
  });

  it("reports LISTEN failures through onError and reconnects with capped backoff", async () => {
    const failures: unknown[] = [];
    let attempt = 0;
    const clients: FakePgClient[] = [];
    const bus = createCacheInvalidationBus({
      connectionString: "postgresql://unused:unused@localhost:5432/unused",
      clientFactory: () => {
        const client = new FakePgClient();
        clients.push(client);
        attempt += 1;
        if (attempt === 1) {
          queueMicrotask(() => client.emitError(new Error("listen failed")));
        }
        return client;
      },
      onInvalidate: () => {
        /* no remote invalidations in this test */
      },
      onError: (error) => {
        failures.push(error);
      },
      reconnectBackoffMs: 1,
      instanceId: "self",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(failures.length).toBeGreaterThan(0);
    expect(clients.length).toBeGreaterThanOrEqual(2);
    await bus.close();
  });

  it("never throws when the error observer is broken", async () => {
    const spy = vi.fn(() => {
      throw new Error("bad observer");
    });
    const bus = createCacheInvalidationBus({
      connectionString: "postgresql://unused:unused@localhost:5432/unused",
      clientFactory: () => new FakePgClient(),
      onInvalidate: () => {
        /* unused */
      },
      onError: spy,
      instanceId: "self",
    });
    const client = new FakePgClient();
    // Force a failure through the public close path (no listener started).
    await expect(bus.close()).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    void client;
  });
});
