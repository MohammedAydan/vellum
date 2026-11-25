import { describe, expect, it } from "vitest";
import { createClient } from "../index.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe("transaction get of a missing document", () => {
  it("returns an exists:false snapshot instead of aborting the transaction", async () => {
    const calls: string[] = [];
    const db = createClient({
      projectId: "p",
      apiKey: "key",
      customFetch: async (url) => {
        const u = String(url);
        calls.push(u);
        if (u.endsWith("/transactions:begin")) return json({ transactionToken: "t1" });
        if (u.includes("/documents/items/new")) return json({ error: { code: "NOT_FOUND", message: "nope" } }, 404);
        if (u.endsWith("/transactions:commit")) return json({ committed: true });
        return json({});
      },
    });
    let existed: boolean | undefined;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get("items/new");
      existed = snap.exists;
      expect(snap.id).toBe("new");
      expect(snap.data()).toBeUndefined();
      tx.set("items/new", { a: 1 });
    });
    expect(existed).toBe(false);
    expect(calls.some((u) => u.endsWith("/transactions:commit"))).toBe(true);
    db.dispose();
  });
});
