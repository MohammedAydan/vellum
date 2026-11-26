import { describe, expect, it } from "vitest";
import { expandUpdatePaths } from "../references/document-ref.js";
import { createClient } from "../index.js";

describe("update() dotted field paths", () => {
  it("expands dotted keys into nested objects and merges siblings", () => {
    expect(expandUpdatePaths({ "obj.a": 99, "obj.b.c": 1, n: 2 })).toEqual({ obj: { a: 99, b: { c: 1 } }, n: 2 });
    expect(expandUpdatePaths({ obj: { x: 1 }, "obj.y": 2 })).toEqual({ obj: { x: 1, y: 2 } });
  });

  it("leaves data without dotted keys untouched and refuses unsafe paths", () => {
    const data = { a: 1, b: { c: 2 } };
    expect(expandUpdatePaths(data)).toBe(data);
    expect(() => expandUpdatePaths({ "a..b": 1 })).toThrow(TypeError);
    expect(() => expandUpdatePaths({ "a.__proto__.b": 1 })).toThrow(TypeError);
  });

  it("sends a nested patch for doc.update, batchWrite and transaction updates", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const db = createClient({
      projectId: "p", apiKey: "pk_test",
      customFetch: (async (_u, init) => {
        if (init?.body) bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ok: true, path: "x/y", documentId: "y", version: 1, data: {} }), { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    await db.collection("c").doc("d").update({ "obj.a": 1 });
    expect(bodies[0]!["data"]).toEqual({ obj: { a: 1 } });
    await db.batchWrite([{ type: "update", path: "c/d", data: { "obj.a": 2 } }]);
    expect((bodies[1]!["writes"] as Array<{ data: unknown }>)[0]!.data).toEqual({ obj: { a: 2 } });
  });
});
