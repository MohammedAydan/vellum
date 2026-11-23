import { describe, it, expect } from "vitest";
import { BoundedLruCache } from "../index.js";

describe("@vellum/core - BoundedLruCache", () => {
  it("stores, reads, overwrites and deletes values", () => {
    const cache = new BoundedLruCache<string, number>({ maxEntries: 10, ttlMs: 10_000 });
    try {
      expect(cache.get("missing")).toBeUndefined();
      cache.set("a", 1);
      cache.set("b", 2);
      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBe(2);
      cache.set("a", 99);
      expect(cache.get("a")).toBe(99);
      cache.delete("b");
      expect(cache.get("b")).toBeUndefined();
      expect(cache.size()).toBe(1);
    } finally {
      cache.dispose();
    }
  });

  it("evicts the least-recently-used entry at the hard bound", () => {
    const cache = new BoundedLruCache<string, number>({ maxEntries: 2, ttlMs: 10_000 });
    try {
      cache.set("a", 1);
      cache.set("b", 2);
      // "a" becomes most-recently-used.
      expect(cache.get("a")).toBe(1);
      // Inserting "c" must evict "b", not "a".
      cache.set("c", 3);
      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("c")).toBe(3);
      expect(cache.size()).toBe(2);
      expect(cache.stats().evictions).toBe(1);
    } finally {
      cache.dispose();
    }
  });

  it("never exceeds maxEntries under a long write burst", () => {
    const cache = new BoundedLruCache<number, number>({ maxEntries: 3, ttlMs: 10_000 });
    try {
      for (let i = 0; i < 100; i++) cache.set(i, i * 10);
      expect(cache.size()).toBe(3);
      expect(cache.stats().evictions).toBe(97);
      expect(cache.get(99)).toBe(990);
      expect(cache.get(0)).toBeUndefined();
    } finally {
      cache.dispose();
    }
  });

  it("expires entries lazily using the injected clock", () => {
    let now = 1_000;
    const cache = new BoundedLruCache<string, string>({
      maxEntries: 10,
      ttlMs: 100,
      now: () => now,
    });
    try {
      cache.set("k", "v");
      expect(cache.get("k")).toBe("v");
      now = 1_099; // still live (expiresAt === 1100)
      expect(cache.get("k")).toBe("v");
      now = 1_100; // boundary is exclusive: expired
      expect(cache.get("k")).toBeUndefined();
      expect(cache.size()).toBe(0);
      const stats = cache.stats();
      expect(stats.expirations).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(2);
    } finally {
      cache.dispose();
    }
  });

  it("sweeps expired entries even when they are never read", () => {
    let now = 0;
    const cache = new BoundedLruCache<string, number>({
      maxEntries: 10,
      ttlMs: 50,
      now: () => now,
    });
    try {
      cache.set("x", 1);
      now = 51;
      expect(cache.size()).toBe(0);
      expect(cache.stats().expirations).toBe(1);
    } finally {
      cache.dispose();
    }
  });

  it("invalidates by string prefix using String(key) coercion", () => {
    const cache = new BoundedLruCache<string | number, string>({
      maxEntries: 20,
      ttlMs: 10_000,
    });
    try {
      cache.set("ruleset:proj-1:1", "r1");
      cache.set("ruleset:proj-1:2", "r2");
      cache.set("ruleset:proj-2:1", "r3");
      cache.set("auth:project:scope", "a1");
      cache.set(12345, "numeric");
      cache.invalidatePrefix("ruleset:proj-1:");
      expect(cache.get("ruleset:proj-1:1")).toBeUndefined();
      expect(cache.get("ruleset:proj-1:2")).toBeUndefined();
      expect(cache.get("ruleset:proj-2:1")).toBe("r3");
      expect(cache.get("auth:project:scope")).toBe("a1");
      expect(cache.size()).toBe(3);
      // Numeric keys are coerced to string before matching.
      cache.invalidatePrefix("123");
      expect(cache.get(12345)).toBeUndefined();
    } finally {
      cache.dispose();
    }
  });

  it("clear removes everything and stats remain internally consistent", () => {
    const cache = new BoundedLruCache<string, number>({ maxEntries: 5, ttlMs: 10_000 });
    try {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.get("a");
      cache.get("nope");
      expect(cache.stats()).toEqual({ hits: 1, misses: 1, evictions: 0, expirations: 0, size: 2 });
      cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.stats().size).toBe(0);
      // Returned stats object is a snapshot, not the internal counters.
      const snapshot = cache.stats();
      cache.get("a");
      expect(snapshot.hits).toBe(1);
    } finally {
      cache.dispose();
    }
  });
});
