import { describe, expect, it } from "vitest";
import { IndexedDbDocStore } from "../index.js";

/** Minimal in-memory IndexedDB stand-in covering only what IndexedDbDocStore uses. */
function fakeIndexedDb(rows: Map<string, Record<string, unknown>>, opts: { failOpen?: boolean } = {}) {
  const req = <T>(compute: () => T) => {
    const r: { result?: T; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null } = {
      error: null, onsuccess: null, onerror: null,
    };
    setTimeout(() => {
      try { r.result = compute(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); }
    }, 0);
    return r;
  };
  const store = {
    get: (k: string) => req(() => rows.get(k)),
    put: (row: Record<string, unknown>) => { rows.set(row["key"] as string, row); return req(() => undefined); },
    delete: (k: string) => { rows.delete(k); return req(() => undefined); },
    clear: () => { rows.clear(); return req(() => undefined); },
    getAll: () => req(() => [...rows.values()]),
  };
  const db = {
    createObjectStore: () => store,
    transaction: () => {
      const tx: Record<string, unknown> = { objectStore: () => store, oncomplete: null, onerror: null, onabort: null, error: null };
      setTimeout(() => (tx["oncomplete"] as (() => void) | null)?.(), 5);
      return tx;
    },
  };
  return {
    open: () => {
      const r = req(() => { if (opts.failOpen) throw new Error("denied"); return db; }) as unknown as {
        result?: unknown; onupgradeneeded: (() => void) | null; onsuccess: (() => void) | null;
      };
      r.onupgradeneeded = null;
      return r;
    },
  };
}

describe("IndexedDbDocStore", () => {
  it("persists entries, rehydrates the LRU index and evicts past the budget", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const store = new IndexedDbDocStore("t", 3_000, fakeIndexedDb(rows));
    for (let i = 0; i < 10; i++) {
      await store.set(`k${i}`, { path: `c/${i}`, value: { s: "x".repeat(400) }, storedAt: 1 });
    }
    expect(rows.size).toBeLessThan(10);
    expect(rows.has("k9")).toBe(true);
    expect((await store.get("k9"))?.value).toEqual({ s: "x".repeat(400) });
    expect(await store.get("k0")).toBeUndefined();

    const reopened = new IndexedDbDocStore("t", 3_000, fakeIndexedDb(rows));
    expect((await reopened.get("k9"))?.path).toBe("c/9");
    await reopened.deletePath("c/9");
    expect(await reopened.get("k9")).toBeUndefined();
    await reopened.clear();
    expect(rows.size).toBe(0);
  });

  it("falls back to memory when IndexedDB is unusable", async () => {
    const store = new IndexedDbDocStore("t", 10_000, fakeIndexedDb(new Map(), { failOpen: true }));
    await store.set("a", { path: "c/a", value: { n: 1 }, storedAt: 1 });
    expect((await store.get("a"))?.value).toEqual({ n: 1 });
  });
});
