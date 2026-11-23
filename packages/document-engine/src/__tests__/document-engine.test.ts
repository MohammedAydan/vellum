import { describe, it, expect, beforeEach } from "vitest";
import { DocumentEngine } from "../engine.js";
import { applyFieldTransforms } from "../transforms.js";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { VellumError } from "@vellum/core";

const TENANT = {
  projectId: "11111111-1111-1111-1111-111111111111",
  // Trusted test caller: permits the engine's fail-closed synthetic key path.
  internal: true as const,
};

class MockControlStore {
  public usageEvents: Array<{ projectId: string; usage: unknown }> = [];

  getActiveRuleset() {
    return null; // Public server key mode
  }

  incrementUsage(projectId: string, usage: unknown) {
    this.usageEvents.push({ projectId, usage });
  }
}

describe("@vellum/document-engine - Field Transforms", () => {
  const nowIso = "2026-11-15T12:00:00.000Z";

  it("applies serverTimestamp transform", () => {
    const res = applyFieldTransforms({}, { updated: { $op: "serverTimestamp" } }, nowIso);
    expect(res["updated"]).toEqual({ $t: "ts", $v: nowIso, $ms: Date.parse(nowIso) });
  });

  it("applies inc transform on number and int64", () => {
    const res1 = applyFieldTransforms({ views: 10 }, { views: { $op: "inc", by: 5 } }, nowIso);
    expect(res1["views"]).toBe(15);

    const res2 = applyFieldTransforms(
      { counter: { $t: "int", $v: "100" } },
      { counter: { $op: "inc", by: 25 } },
      nowIso
    );
    expect(res2["counter"]).toEqual({ $t: "int", $v: "125" });
  });

  it("throws FAILED_PRECONDITION when inc is applied to non-numeric field", () => {
    expect(() =>
      applyFieldTransforms({ title: "hello" }, { title: { $op: "inc", by: 1 } }, nowIso)
    ).toThrowError(VellumError);
  });

  it("applies arrayUnion and arrayRemove transforms", () => {
    const res1 = applyFieldTransforms(
      { tags: ["alpha", "beta"] },
      { tags: { $op: "arrayUnion", elements: ["beta", "gamma"] } },
      nowIso
    );
    expect(res1["tags"]).toEqual(["alpha", "beta", "gamma"]);

    const res2 = applyFieldTransforms(
      { tags: ["alpha", "beta", "gamma"] },
      { tags: { $op: "arrayRemove", elements: ["beta"] } },
      nowIso
    );
    expect(res2["tags"]).toEqual(["alpha", "gamma"]);
  });

  it("applies deleteField transform", () => {
    const res = applyFieldTransforms({ removeMe: "bye", keepMe: "hi" }, { removeMe: { $op: "deleteField" } }, nowIso);
    expect(res["removeMe"]).toBeUndefined();
    expect(res["keepMe"]).toBe("hi");
  });
});

describe("@vellum/document-engine - CRUD & Batch Writes", () => {
  let engine: DocumentEngine;
  let dataStore: DataPlaneStore;

  beforeEach(() => {
    dataStore = new DataPlaneStore();
    engine = new DocumentEngine({
      controlStore: new MockControlStore(),
      dataStore,
    });
  });

  it("creates, reads, updates, and deletes documents", async () => {
    // 1. Create
    const created = await engine.createDocument({
      ...TENANT,
      path: "users/u1",
      data: { name: "Alice", score: 100 },
    });
    expect(created.path).toBe("users/u1");
    expect(created.version).toBe(1);
    expect(created.data["name"]).toBe("Alice");

    // 2. Read
    const fetched = await engine.getDocument({
      ...TENANT,
      path: "users/u1",
    });
    expect(fetched.data["score"]).toBe(100);

    // 3. Update with $op
    const updated = await engine.updateDocument({
      ...TENANT,
      path: "users/u1",
      data: { score: { $op: "inc", by: 50 } },
    });
    expect(updated.version).toBe(2);
    expect(updated.data["score"]).toBe(150);

    // 4. Delete
    const deleted = await engine.deleteDocument({
      ...TENANT,
      path: "users/u1",
    });
    expect(deleted.status).toBe("deleted");

    // 5. Subsequent read throws NOT_FOUND
    await expect(engine.getDocument({ ...TENANT, path: "users/u1" })).rejects.toThrowError(VellumError);
  });

  it("enforces batch write limit of 100 operations", async () => {
    const writes = Array.from({ length: 101 }, (_, i) => ({
      type: "create" as const,
      path: `items/item_${i}`,
      data: { index: i },
    }));

    await expect(engine.batchWrite({ ...TENANT, writes })).rejects.toThrow("exceeds maximum limit");
  });


  it("supports preconditions in batchWrite (ifVersion and exists)", async () => {
    await engine.createDocument({ ...TENANT, path: "configs/app", data: { theme: "light" } });

    // ifVersion precondition matches
    await engine.setDocument({
      ...TENANT,
      path: "configs/app",
      data: { theme: "dark" },
      ifVersion: 1,
    });

    // ifVersion mismatch fails
    await expect(
      engine.setDocument({
        ...TENANT,
        path: "configs/app",
        data: { theme: "blue" },
        ifVersion: 1, // now version is 2
      })
    ).rejects.toThrowError(VellumError);
  });
});

describe("@vellum/document-engine - OCC Transactions", () => {
  let engine: DocumentEngine;

  beforeEach(() => {
    engine = new DocumentEngine({
      controlStore: new MockControlStore(),
      dataStore: new DataPlaneStore(),
    });
  });

  it("begins and commits an OCC transaction without conflicts", async () => {
    await engine.createDocument({ ...TENANT, path: "accounts/acc1", data: { balance: 500 } });

    const tx = await engine.beginTransaction(TENANT);
    expect(tx.transactionToken).toBeDefined();

    // Read within transaction records version in read-set
    const doc = await engine.getDocument({
      ...TENANT,
      path: "accounts/acc1",
      transactionToken: tx.transactionToken,
    });
    expect(doc.version).toBe(1);

    // Commit write with transaction token
    const commitRes = await engine.commitTransaction({
      ...TENANT,
      transactionToken: tx.transactionToken,
      writes: [
        {
          type: "set",
          path: "accounts/acc1",
          data: { balance: 600 },
        },
      ],
    });
    expect(commitRes.results).toHaveLength(1);
    expect((commitRes.results[0] as { version: number }).version).toBe(2);
  });

  it("aborts OCC transaction with ABORTED_CONFLICT when document is concurrently modified", async () => {
    await engine.createDocument({ ...TENANT, path: "accounts/acc2", data: { balance: 1000 } });

    const tx = await engine.beginTransaction(TENANT);

    // Read doc in transaction (records version 1)
    await engine.getDocument({
      ...TENANT,
      path: "accounts/acc2",
      transactionToken: tx.transactionToken,
    });

    // Concurrent modification outside transaction bumps version to 2
    await engine.updateDocument({
      ...TENANT,
      path: "accounts/acc2",
      data: { balance: 900 },
    });

    // Attempting to commit OCC tx fails with ABORTED_CONFLICT
    await expect(
      engine.commitTransaction({
        ...TENANT,
        transactionToken: tx.transactionToken,
        writes: [
          {
            type: "set",
            path: "accounts/acc2",
            data: { balance: 800 },
          },
        ],
      })
    ).rejects.toThrow("concurrent modification");

  });
});

describe("@vellum/document-engine - Query Execution", () => {
  let engine: DocumentEngine;

  beforeEach(async () => {
    engine = new DocumentEngine({
      controlStore: new MockControlStore(),
      dataStore: new DataPlaneStore(),
    });

    for (let i = 1; i <= 5; i++) {
      await engine.createDocument({
        ...TENANT,
        path: `products/p${i}`,
        data: { name: `Product ${i}`, price: i * 10, category: "books" },
      });
    }
  });

  it("executes basic query with where filter and orderBy", async () => {
    const res = await engine.executeQuery({
      ...TENANT,
      querySpec: {
        collection: "products",
        where: [{ field: "category", op: "==", value: "books" }],
        orderBy: [{ field: "documentId", dir: "asc" }],
        limit: 3,
      },
    });

    expect(res.documents).toHaveLength(3);
    expect(res.documents[0]?.documentId).toBe("p1");
    expect(res.documents[2]?.documentId).toBe("p3");
    expect(res.nextCursor).not.toBeNull();
  });
});
