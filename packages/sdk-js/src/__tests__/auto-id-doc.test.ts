import { describe, expect, it } from "vitest";
import { createClient } from "../index.js";
import { generateAutoDocId } from "../core/auto-id.js";

type Call = { method: string; url: string };

function makeDb(store: Map<string, unknown>, calls: Call[]) {
  return createClient({
    projectId: "project",
    apiKey: "pk_test_auto_id_doc",
    customFetch: (async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      const path = decodeURIComponent(url.split("/documents/")[1]?.split("?")[0] ?? "");
      if (method === "PUT") {
        store.set(path, JSON.parse(String(init?.body)).data);
        return json({ path, documentId: path.split("/").pop(), version: 1, data: store.get(path) });
      }
      if (method === "GET") {
        if (!store.has(path)) {
          return json({ error: { code: "NOT_FOUND", message: "Document not found" } }, 404);
        }
        return json({ path, documentId: path.split("/").pop(), version: 1, data: store.get(path) });
      }
      return json({});
    }) as typeof fetch,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("generateAutoDocId", () => {
  it("is 20 url-safe characters and unique", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generateAutoDocId()));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(/^[0-9A-Za-z]{20}$/);
  });
  it("sorts by creation time", () => {
    expect(generateAutoDocId(1_000_000) < generateAutoDocId(1_000_001)).toBe(true);
    expect(generateAutoDocId(1_700_000_000_000) < generateAutoDocId(1_700_000_060_000)).toBe(true);
  });
});

describe("collection.doc() with optional id", () => {
  it("generates an id locally without any network request", () => {
    const calls: Call[] = [];
    const ref = makeDb(new Map(), calls).collection("posts").doc();
    expect(ref.id).toMatch(/^[0-9A-Za-z]{20}$/);
    expect(ref.path).toBe(`posts/${ref.id}`);
    expect(calls).toHaveLength(0);
  });

  it("doc() then set() creates the document under the generated id", async () => {
    const store = new Map<string, unknown>();
    const ref = makeDb(store, []).collection("posts").doc();
    await ref.set({ title: "hello" });
    expect(store.get(ref.path)).toEqual({ title: "hello" });
    const snap = await ref.get();
    expect(snap.exists).toBe(true);
    expect(snap.id).toBe(ref.id);
  });

  it("doc() then get() before saving returns exists=false and data()=null", async () => {
    const ref = makeDb(new Map(), []).collection("posts").doc();
    const snap = await ref.get();
    expect(snap.exists).toBe(false);
    expect(snap.data()).toBeNull();
    expect(snap.id).toBe(ref.id);
  });

  it("doc('id') still addresses the explicit document", async () => {
    const store = new Map<string, unknown>([["posts/custom-id", { a: 1 }]]);
    const ref = makeDb(store, []).collection("posts").doc("custom-id");
    expect(ref.id).toBe("custom-id");
    expect((await ref.get()).data()).toEqual({ a: 1 });
  });

  it("explicit ids resolve a missing document as exists=false", async () => {
    const ref = makeDb(new Map(), []).collection("posts").doc("missing");
    const snap = await ref.get();
    expect(snap.exists).toBe(false);
  });
});
