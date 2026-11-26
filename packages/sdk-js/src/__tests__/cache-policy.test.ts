import { describe, expect, it } from "vitest";
import { createClient, MemoryDocStore, createDefaultDocStore } from "../index.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(opts: { policy?: "networkFirst" | "cacheFirst" | "networkOnly" | "cacheOnly" } = {}) {
  const server = new Map<string, unknown>([["posts/a", { title: "v1" }]]);
  let online = true;
  let gets = 0;
  const db = createClient({
    projectId: "p",
    apiKey: "pk_test",
    maxRetries: 0,
    ...(opts.policy ? { cachePolicy: opts.policy } : {}),
    customFetch: (async (input, init) => {
      if (!online) throw new TypeError("fetch failed");
      const url = String(input);
      const path = decodeURIComponent(url.split("/documents/")[1]?.split("?")[0] ?? "");
      const method = init?.method ?? "GET";
      if (method === "PUT" || method === "PATCH") {
        const body = JSON.parse(String(init?.body)).data;
        server.set(path, { ...(server.get(path) as object), ...body });
        return json({ path, documentId: path.split("/").pop(), version: 2, data: server.get(path) });
      }
      if (method === "DELETE") {
        server.delete(path);
        return json({});
      }
      gets += 1;
      if (!server.has(path)) return json({ error: { code: "NOT_FOUND", message: "nf" } }, 404);
      return json({ path, documentId: path.split("/").pop(), version: 1, data: server.get(path) });
    }) as typeof fetch,
  });
  return { db, server, setOnline: (v: boolean) => (online = v), gets: () => gets };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

describe("CachePolicy", () => {
  it("networkFirst (default) serves the stored copy with fromCache=true when offline", async () => {
    const { db, setOnline } = setup();
    const live = await db.collection("posts").doc("a").get();
    expect(live.metadata?.fromCache).toBe(false);
    await flush();
    setOnline(false);
    const offline = await db.collection("posts").doc("a").get();
    expect(offline.exists).toBe(true);
    expect(offline.data()).toEqual({ title: "v1" });
    expect(offline.metadata?.fromCache).toBe(true);
  });

  it("networkFirst still throws offline when nothing is stored", async () => {
    const { db, setOnline } = setup();
    setOnline(false);
    await expect(db.collection("posts").doc("a").get()).rejects.toBeDefined();
  });

  it("does not mask a deleted document with stored data (returns exists=false)", async () => {
    const { db, server } = setup();
    await db.collection("posts").doc("a").get();
    await flush();
    server.delete("posts/a");
    const snap = await db.collection("posts").doc("a").get();
    expect(snap.exists).toBe(false);
    expect(snap.metadata?.fromCache).toBe(false);
  });

  it("cacheFirst skips the network when fresh; networkOnly always hits it", async () => {
    const { db, gets } = setup();
    const ref = db.collection("posts").doc("a");
    await ref.get({ cachePolicy: "cacheFirst" });
    await flush();
    await ref.get({ cachePolicy: "cacheFirst" });
    expect(gets()).toBe(1);
    await ref.get({ cachePolicy: "networkOnly" });
    expect(gets()).toBe(2);
  });

  it("cacheOnly returns stored data or a non-existent snapshot, never the network", async () => {
    const { db, gets } = setup();
    const ref = db.collection("posts").doc("a");
    const miss = await ref.get({ cachePolicy: "cacheOnly" });
    expect(miss.exists).toBe(false);
    expect(miss.metadata?.fromCache).toBe(true);
    expect(gets()).toBe(0);
    await ref.get();
    await flush();
    expect((await ref.get({ cachePolicy: "cacheOnly" })).data()).toEqual({ title: "v1" });
  });

  it("writes invalidate the stored copy", async () => {
    const { db, setOnline } = setup();
    const ref = db.collection("posts").doc("a");
    await ref.get();
    await flush();
    await ref.set({ title: "v2" });
    await flush();
    setOnline(false);
    expect((await ref.get({ cachePolicy: "cacheOnly" })).exists).toBe(false);
  });

  it("cache.store=false disables offline fallback", async () => {
    const db = createClient({
      projectId: "p", apiKey: "pk_test", maxRetries: 0, cache: { store: false },
      customFetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch,
    });
    await expect(db.collection("posts").doc("a").get()).rejects.toBeDefined();
  });
});

describe("MemoryDocStore", () => {
  it("evicts least-recently-used entries past the byte budget", async () => {
    const store = new MemoryDocStore(4_000);
    const big = { blob: "x".repeat(500) };
    for (let i = 0; i < 20; i++) await store.set(`k${i}`, { path: `c/${i}`, value: big, storedAt: 1 });
    expect(store.sizeBytes).toBeLessThanOrEqual(4_000);
    expect(await store.get("k0")).toBeUndefined();
    expect(await store.get("k19")).toBeDefined();
  });

  it("handles 50,000 documents within the size budget", async () => {
    const store = new MemoryDocStore(100 * 1024 * 1024);
    const t = Date.now();
    for (let i = 0; i < 50_000; i++) await store.set(`k${i}`, { path: `c/${i}`, value: { n: i, s: "doc" + i }, storedAt: 1 });
    expect(store.size).toBe(50_000);
    expect(store.sizeBytes).toBeLessThan(100 * 1024 * 1024);
    await store.deletePrefix("c/1");
    expect(store.size).toBeLessThan(50_000);
    expect(Date.now() - t).toBeLessThan(20_000);
  });

  it("default store falls back to memory without IndexedDB", () => {
    expect(createDefaultDocStore("x")).toBeInstanceOf(MemoryDocStore);
  });
});
