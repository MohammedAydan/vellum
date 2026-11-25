import { describe, expect, it } from "vitest";
import { createClient } from "../index.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe("runTransaction rollback", () => {
  it("rolls the server transaction back when the callback throws, and rethrows the original error", async () => {
    const calls: string[] = [];
    const db = createClient({
      projectId: "p",
      apiKey: "key",
      customFetch: async (url) => {
        const u = String(url);
        calls.push(u.split("/").pop() ?? u);
        if (u.endsWith("/transactions:begin")) return json({ transactionToken: "t1" });
        return json({ status: "rolled_back" });
      },
    });
    await expect(
      db.runTransaction(async () => {
        throw new Error("user bug");
      })
    ).rejects.toThrow("user bug");
    expect(calls).toEqual(["transactions:begin", "transactions:rollback"]);
    db.dispose();
  });

  it("still surfaces the original error when the rollback call itself fails", async () => {
    const db = createClient({
      projectId: "p",
      apiKey: "key",
      maxRetries: 0,
      customFetch: async (url) => {
        if (String(url).endsWith("/transactions:begin")) return json({ transactionToken: "t1" });
        return json({ error: { code: "INTERNAL" } }, 500);
      },
    });
    await expect(
      db.runTransaction(async () => {
        throw new Error("user bug");
      })
    ).rejects.toThrow("user bug");
    db.dispose();
  });

  it("rolls back a conflicted attempt before it retries", async () => {
    let commits = 0;
    const calls: string[] = [];
    const db = createClient({
      projectId: "p",
      apiKey: "key",
      customFetch: async (url) => {
        const u = String(url);
        calls.push(u.split("/").pop() ?? u);
        if (u.endsWith("/transactions:begin")) return json({ transactionToken: `t${calls.length}` });
        if (u.endsWith("/transactions:commit")) {
          commits += 1;
          return commits === 1 ? json({ error: { code: "ABORTED_CONFLICT", message: "x" } }, 409) : json({ ok: true });
        }
        return json({ status: "rolled_back" });
      },
    });
    await db.runTransaction(async (tx) => {
      tx.set("a/1", { n: 1 });
    });
    expect(calls).toEqual([
      "transactions:begin",
      "transactions:commit",
      "transactions:rollback",
      "transactions:begin",
      "transactions:commit",
    ]);
    db.dispose();
  });
});
