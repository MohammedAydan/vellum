import { describe, expect, it } from "vitest";
import { createClient } from "../index.js";

type Call = { headers?: Record<string, string>; method: string; url: string; body: { data?: Record<string, unknown>; writes?: Array<{ type: string; path: string; data: Record<string, unknown> }> } | null };
function setup() {
  const calls: Call[] = [];
  const db = createClient({
    projectId: "p",
    apiKey: "pk_test",
    customFetch: (async (input, init) => {
      calls.push({ headers: (init?.headers ?? {}) as Record<string, string>, method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ ok: true, path: "x/y", documentId: "y", version: 1, data: {} }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  return { db, calls };
}

describe("document references in write data", () => {
  it("serializes db.doc() values nested in add/set/update", async () => {
    const { db, calls } = setup();
    await db.collection("orders").doc("o1").set({ total: 250, customer: db.doc("users/u_123"), tags: [db.doc("tags/t1")] });
    expect(calls[0]!.body!.data).toEqual({
      total: 250,
      customer: { $t: "ref", $v: "users/u_123" },
      tags: [{ $t: "ref", $v: "tags/t1" }],
    });
    await db.collection("orders").doc("o1").update({ customer: db.doc("users/u_9") });
    expect(calls[1]!.body!.data).toEqual({ customer: { $t: "ref", $v: "users/u_9" } });
    await db.collection("orders").add({ customer: db.doc("users/u_1") });
    expect(calls[2]!.body!.data!['customer']).toEqual({ $t: "ref", $v: "users/u_1" });
  });
});

describe("addWithRelated", () => {
  it("creates parent and children in one batchWrite with links both ways", async () => {
    const { db, calls } = setup();
    const ref = await db.collection("orders").addWithRelated(
      { total: 250, customer: db.doc("users/u_123") },
      { items: { collection: "order_items", parentField: "order", docs: [{ qty: 2 }, { qty: 1 }] } },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.endsWith("/batchWrite")).toBe(true);
    const writes = calls[0]!.body!.writes!;
    expect(writes).toHaveLength(3);
    const parent = writes[0]!;
    expect(parent.path).toBe(ref.path);
    expect(parent.data['customer']).toEqual({ $t: "ref", $v: "users/u_123" });
    expect(parent.data['items']).toEqual(writes.slice(1).map((w) => ({ $t: "ref", $v: w.path })));
    for (const child of writes.slice(1)) {
      expect(child.path.startsWith("order_items/")).toBe(true);
      expect(child.data['order']).toEqual({ $t: "ref", $v: ref.path });
    }
  });

  it("rejects more than 500 documents", async () => {
    const { db } = setup();
    await expect(
      db.collection("orders").addWithRelated({}, { items: { collection: "i", docs: Array.from({ length: 500 }, () => ({})) } }),
    ).rejects.toThrow(/500/);
  });
});

describe("addWithRelated parity", () => {
  it("sends the Idempotency-Key header and applies the collection converter to the parent", async () => {
    const { db, calls } = setup();
    const conv = { toDoc: (v: { n: number }) => ({ n: v.n, via: "conv" }), fromDoc: (s: { data(): Record<string, unknown> | undefined }) => ({ n: Number(s.data()?.["n"]) }) };
    await db
      .collection("orders")
      .withConverter(conv)
      .addWithRelated({ n: 1 }, { items: { collection: "items", docs: [{ a: 1 }] } }, { idempotencyKey: "k-1" });
    const h = new Headers(calls[0]!.headers as Record<string, string>);
    expect(h.get("idempotency-key")).toBe("k-1");
    expect(calls[0]!.body!.writes![0]!.data["via"]).toBe("conv");
    expect(calls[0]!.body!.writes![0]!.data["n"]).toBe(1);
  });
});
