/**
 * ENGINE-HARDENING §4–§5 — OCC contention and non-OCC TOCTOU races.
 *
 * HARNESS NOTE
 * ------------
 * PostgreSQL serialises conflicting `SELECT ... FOR UPDATE` row locks. The
 * in-memory adapter has no row locks, so OCC tests use `SerializedDataPlaneStore`
 * (a promise-mutex wrapper around `withTransaction`) to emulate that DB-level
 * serialisation deterministically. The non-OCC CAS tests intentionally use the
 * plain adapter so both writers can pass the read phase before either writes —
 * the exact window `conditionalPutDocument` is designed to close.
 */
import { describe, it, expect } from "vitest";
import {
  createFixture,
  SerializedDataPlaneStore,
  TENANT,
  type Fixture,
} from "./_harness.js";

function serializedFixture(): Fixture {
  return createFixture({ dataStore: new SerializedDataPlaneStore() });
}

async function settleAll(promises: Promise<unknown>[]): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled(promises);
}

function reasons(results: PromiseSettledResult<unknown>[]): string[] {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => (r.reason as { code?: string }).code ?? String(r.reason));
}

describe("hardening/concurrency — OCC overlapping read sets", () => {
  it("exactly one of two parallel commits with overlapping read sets wins", async () => {
    const { engine } = serializedFixture();
    await engine.createDocument({ ...TENANT, path: "accounts/shared", data: { balance: 100 } });

    const txA = await engine.beginTransaction(TENANT);
    const txB = await engine.beginTransaction(TENANT);
    await engine.getDocument({
      ...TENANT,
      path: "accounts/shared",
      transactionToken: txA.transactionToken,
    });
    await engine.getDocument({
      ...TENANT,
      path: "accounts/shared",
      transactionToken: txB.transactionToken,
    });

    const results = await settleAll([
      engine.commitTransaction({
        ...TENANT,
        transactionToken: txA.transactionToken,
        writes: [{ type: "set", path: "accounts/shared", data: { writer: "A" } }],
      }),
      engine.commitTransaction({
        ...TENANT,
        transactionToken: txB.transactionToken,
        writes: [{ type: "set", path: "accounts/shared", data: { writer: "B" } }],
      }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(reasons(results)).toEqual(["ABORTED_CONFLICT"]);

    const final = await engine.getDocument({ ...TENANT, path: "accounts/shared" });
    expect(["A", "B"]).toContain(final.data["writer"]);
    expect(final.version).toBe(2);
  });

  it("disjoint read sets both commit", async () => {
    const { engine } = serializedFixture();
    await engine.createDocument({ ...TENANT, path: "accounts/a", data: { n: 1 } });
    await engine.createDocument({ ...TENANT, path: "accounts/b", data: { n: 1 } });

    const txA = await engine.beginTransaction(TENANT);
    const txB = await engine.beginTransaction(TENANT);
    await engine.getDocument({ ...TENANT, path: "accounts/a", transactionToken: txA.transactionToken });
    await engine.getDocument({ ...TENANT, path: "accounts/b", transactionToken: txB.transactionToken });

    const results = await settleAll([
      engine.commitTransaction({
        ...TENANT,
        transactionToken: txA.transactionToken,
        writes: [{ type: "set", path: "accounts/a", data: { n: 2 } }],
      }),
      engine.commitTransaction({
        ...TENANT,
        transactionToken: txB.transactionToken,
        writes: [{ type: "set", path: "accounts/b", data: { n: 2 } }],
      }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("a NOT_FOUND read inside an OCC tx records version 0 and conflicts on later create", async () => {
    const { engine } = serializedFixture();
    const tx = await engine.beginTransaction(TENANT);
    await expect(
      engine.getDocument({ ...TENANT, path: "accounts/late", transactionToken: tx.transactionToken })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await engine.createDocument({ ...TENANT, path: "accounts/late", data: { n: 1 } });
    await expect(
      engine.commitTransaction({
        ...TENANT,
        transactionToken: tx.transactionToken,
        writes: [{ type: "set", path: "accounts/late", data: { n: 2 } }],
      })
    ).rejects.toMatchObject({ code: "ABORTED_CONFLICT" });
  });
});

describe("hardening/concurrency — non-OCC TOCTOU", () => {
  it("two parallel creates on the same path: exactly one succeeds", async () => {
    // Serialized store gives the CAS-equivalent outcome deterministically.
    const { engine } = serializedFixture();
    const results = await settleAll([
      engine.createDocument({ ...TENANT, path: "users/duplicate", data: { writer: "A" } }),
      engine.createDocument({ ...TENANT, path: "users/duplicate", data: { writer: "B" } }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(reasons(results)).toEqual(["ALREADY_EXISTS"]);
  });

  it("two parallel creates on disjoint paths both succeed", async () => {
    const { engine } = createFixture();
    const results = await settleAll([
      engine.createDocument({ ...TENANT, path: "users/a", data: {} }),
      engine.createDocument({ ...TENANT, path: "users/b", data: {} }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("two parallel ifVersion:5 updates: exactly one wins, other ABORTED_CONFLICT", async () => {
    // Plain adapter: both writers observe version 5 before either commits, so
    // the loser can only be rejected by the compare-and-swap at write time.
    const { engine } = createFixture();
    const doc = await engine.createDocument({ ...TENANT, path: "counters/cas", data: { n: 1 } });
    // Bump to version 5 (four further writes).
    let version = doc.version;
    while (version < 5) {
      const updated = await engine.updateDocument({
        ...TENANT,
        path: "counters/cas",
        data: { n: ++version },
      });
      version = updated.version;
    }
    expect(version).toBe(5);

    const results = await settleAll([
      engine.updateDocument({
        ...TENANT,
        path: "counters/cas",
        data: { writer: "A" },
        ifVersion: 5,
      }),
      engine.updateDocument({
        ...TENANT,
        path: "counters/cas",
        data: { writer: "B" },
        ifVersion: 5,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(reasons(results)).toEqual(["ABORTED_CONFLICT"]);
  });

  it("a sequential ifVersion mismatch still reports FAILED_PRECONDITION", async () => {
    const { engine } = serializedFixture();
    await engine.createDocument({ ...TENANT, path: "counters/seq", data: { n: 1 } });
    await expect(
      engine.updateDocument({ ...TENANT, path: "counters/seq", data: { n: 9 }, ifVersion: 99 })
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
  });
});
