import { describe, expect, it } from "vitest";
import { createClient } from "../index.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(opts: { cache?: boolean } = {}) {
  const docs = new Map<string, unknown>();
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("/projects/gone/")) return json({ error: { code: "NOT_FOUND", message: "Project 'gone' not found" } }, 404);
    const m = /\/documents\/(.+?)(\?|$)/.exec(u);
    const path = decodeURIComponent(m?.[1] ?? "");
    if (method === "DELETE") { docs.delete(path); return json({ ok: true }); }
    if (method === "GET") {
      return docs.has(path)
        ? json({ path, documentId: path.split("/").pop(), version: 1, data: docs.get(path) })
        : json({ error: { code: "NOT_FOUND", message: "Document not found" } }, 404);
    }
    return json({});
  }) as unknown as typeof fetch;
  return { docs, fetchImpl, ...opts };
}

describe("get() on a missing document and cache metadata", () => {
  it("returns exists=false after a delete instead of throwing NOT_FOUND", async () => {
    const { docs, fetchImpl } = setup();
    docs.set("items/a", { n: 1 });
    const db = createClient({ projectId: "p", apiKey: "pk_t", customFetch: fetchImpl });
    const ref = db.doc("items/a");
    expect((await ref.get({ bypassCache: true })).exists).toBe(true);
    await ref.delete();
    const snap = await ref.get({ bypassCache: true });
    expect(snap.exists).toBe(false);
    expect(snap.data()).toBeNull();
  });

  it("still throws when the project does not exist", async () => {
    const { fetchImpl } = setup();
    const db = createClient({ projectId: "gone", apiKey: "pk_t", customFetch: fetchImpl });
    await expect(db.doc("items/a").get({ bypassCache: true })).rejects.toBeTruthy();
  });

  it("marks snapshots served from the read cache with metadata.fromCache=true", async () => {
    const { docs, fetchImpl } = setup();
    docs.set("items/a", { n: 1 });
    const db = createClient({ projectId: "p", apiKey: "pk_t", customFetch: fetchImpl, cache: { enabled: true } });
    const first = await db.doc("items/a").get();
    expect(first.metadata?.fromCache).toBe(false);
    const second = await db.doc("items/a").get();
    expect(second.exists).toBe(true);
    expect(second.metadata?.fromCache).toBe(true);
  });
});
