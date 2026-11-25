import { describe, expect, it } from "vitest";
import { createClient, type BatchWriteOperation } from "../index.js";

describe("batchWrite preconditions", () => {
  it("sends ifVersion and exists untouched in one request", async () => {
    const bodies: unknown[] = [];
    const db = createClient({
      projectId: "p",
      apiKey: "key",
      customFetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ results: [], commitTimestamp: "t" }), { status: 200 });
      },
    });
    const writes: BatchWriteOperation[] = [
      { type: "update", path: "a/1", data: { n: 1 }, ifVersion: 3 },
      { type: "set", path: "a/2", data: { n: 1 }, exists: false },
    ];
    await db.batchWrite(writes);
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as { writes: unknown[] }).writes).toEqual(writes);
    db.dispose();
  });
});
