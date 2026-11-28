import { afterEach, describe, expect, it } from "vitest";
import { withUnindexedQuerySlot } from "../unindexed-gate.js";

describe("per-project cap on concurrent unindexed queries", () => {
  const prev = process.env["VELLUM_UNINDEXED_QUERY_MAX_CONCURRENT"];
  afterEach(() => {
    if (prev === undefined) delete process.env["VELLUM_UNINDEXED_QUERY_MAX_CONCURRENT"];
    else process.env["VELLUM_UNINDEXED_QUERY_MAX_CONCURRENT"] = prev;
  });

  it("rejects the call over the cap with a retryable RESOURCE_EXHAUSTED, per project, and frees slots", async () => {
    process.env["VELLUM_UNINDEXED_QUERY_MAX_CONCURRENT"] = "2";
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const a = withUnindexedQuerySlot("p1", () => hold);
    const b = withUnindexedQuerySlot("p1", () => hold);
    await expect(withUnindexedQuerySlot("p1", async () => 1)).rejects.toMatchObject({
      code: "RESOURCE_EXHAUSTED",
      details: { reason: "UNINDEXED_QUERY_CONCURRENCY" },
    });
    await expect(withUnindexedQuerySlot("p2", async () => 7)).resolves.toBe(7);
    release();
    await Promise.all([a, b]);
    await expect(withUnindexedQuerySlot("p1", async () => 2)).resolves.toBe(2);
  });

  it("releases the slot when the query throws, and 0 disables the cap", async () => {
    process.env["VELLUM_UNINDEXED_QUERY_MAX_CONCURRENT"] = "1";
    await expect(withUnindexedQuerySlot("p3", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(withUnindexedQuerySlot("p3", async () => 3)).resolves.toBe(3);
    process.env["VELLUM_UNINDEXED_QUERY_MAX_CONCURRENT"] = "0";
    const hold = new Promise<void>(() => undefined);
    void withUnindexedQuerySlot("p4", () => hold);
    await expect(withUnindexedQuerySlot("p4", async () => 4)).resolves.toBe(4);
  });
});
