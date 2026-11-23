import { describe, it, expect } from "vitest";
import { DataPlaneStore } from "../memory-adapter.js";
import { createStorageAdapter } from "../factory.js";
import { VellumError } from "@vellum/core";
import type { DocumentRecord } from "../types.js";

const TENANT_A = {
  projectId: "11111111-1111-1111-1111-111111111111",
};

const TENANT_B = {
  projectId: "33333333-3333-3333-3333-333333333333",
};

function createSampleDoc(ctx: { projectId: string }, id: string, age: number): DocumentRecord {
  return {
    projectId: ctx.projectId,
    path: `users/${id}`,
    collectionPath: "users",
    collectionGroup: "users",
    documentId: id,
    pathDepth: 2,
    data: { name: `User ${id}`, age },
    sizeBytes: 120,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  };
}

describe("@vellum/storage - In-Memory Storage Adapter", () => {
  it("enforces RLS tenant isolation across transactions", async () => {
    const store = new DataPlaneStore();

    // Tenant A writes a document
    await store.putDocument(TENANT_A, createSampleDoc(TENANT_A, "alice", 30));

    // Tenant A can read it
    const docA = await store.getDocument(TENANT_A, "users/alice");
    expect(docA).not.toBeNull();
    expect(docA?.documentId).toBe("alice");

    // Tenant B cannot read Tenant A's document
    const docB = await store.getDocument(TENANT_B, "users/alice");
    expect(docB).toBeNull();

    // Missing tenant context throws PERMISSION_DENIED
    expect(() =>
      store.runInTenantTransaction("", () => {
        /* noop */
      })
    ).toThrowError(VellumError);
  });

  it("rolls back document mutations and outbox events atomically on error", async () => {
    const store = new DataPlaneStore();

    await store.putDocument(TENANT_A, createSampleDoc(TENANT_A, "bob", 25));

    await expect(
      store.withTransaction(TENANT_A, async (tx) => {
        await tx.putDocumentRow(createSampleDoc(TENANT_A, "charlie", 40));
        await tx.appendOutboxEvent({
          collectionPath: "users",
          path: "users/charlie",
          documentId: "charlie",
          opType: "created",
          version: 1,
          beforeData: null,
          afterData: { name: "User charlie", age: 40 },
        });
        throw new Error("Simulated transaction failure");
      })
    ).rejects.toThrow("Simulated transaction failure");

    // Charlie was rolled back
    const charlie = await store.getDocument(TENANT_A, "users/charlie");
    expect(charlie).toBeNull();

    // Bob still exists
    const bob = await store.getDocument(TENANT_A, "users/bob");
    expect(bob).not.toBeNull();

    // Outbox has no events
    const outbox = await store.queryOutboxSince(TENANT_A);
    expect(outbox).toHaveLength(0);
  });

  it("maintains composite index entries synchronously and supports sorted index queries", async () => {
    const store = new DataPlaneStore();

    // Create index on users: age ASC, documentId ASC
    const index = await store.createCompositeIndex(TENANT_A, "users", [
      { path: "age", dir: "asc" },
      { path: "__name__", dir: "asc" },
    ]);
    expect(index.id).toBeDefined();

    // Insert docs out of age order
    await store.putDocument(TENANT_A, createSampleDoc(TENANT_A, "user_30", 30));
    await store.putDocument(TENANT_A, createSampleDoc(TENANT_A, "user_20", 20));
    await store.putDocument(TENANT_A, createSampleDoc(TENANT_A, "user_40", 40));

    // Query via index
    const sortedDocs = await store.listDocumentsViaIndex(TENANT_A, index.id);
    expect(sortedDocs.map((d) => d.documentId)).toEqual(["user_20", "user_30", "user_40"]);
  });

  it("appends to outbox and allows querying by high-water mark seqId", async () => {
    const store = new DataPlaneStore();

    const ev1 = await store.appendOutbox(TENANT_A, {
      collectionPath: "users",
      path: "users/1",
      documentId: "1",
      opType: "created",
      version: 1,
      beforeData: null,
      afterData: { name: "1" },
    });

    const ev2 = await store.appendOutbox(TENANT_A, {
      collectionPath: "users",
      path: "users/2",
      documentId: "2",
      opType: "created",
      version: 1,
      beforeData: null,
      afterData: { name: "2" },
    });

    const allEvents = await store.queryOutboxSince(TENANT_A, "0");
    expect(allEvents).toHaveLength(2);

    const since1 = await store.queryOutboxSince(TENANT_A, ev1.seqId);
    expect(since1).toHaveLength(1);
    expect(since1[0]?.seqId).toBe(ev2.seqId);
  });

  it("runs background workers for compaction and tombstones", async () => {
    const store = new DataPlaneStore();

    // Tombstone
    const doc = createSampleDoc(TENANT_A, "deleted_user", 50);
    doc.deletedAt = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    await store.putDocument(TENANT_A, doc);

    const tombstoneResult = await store.runTombstonePurgeWorker(Date.now());
    expect(tombstoneResult.purgedCount).toBe(1);

    // Compaction
    await store.appendOutbox(TENANT_A, {
      collectionPath: "users",
      path: "users/old",
      documentId: "old",
      opType: "deleted",
      version: 2,
      beforeData: null,
      afterData: null,
    });
    const compactionResult = await store.runOutboxCompactionWorker(Date.now() + 1000);
    expect(compactionResult.purgedCount).toBe(1);
  });

  it("createStorageAdapter creates an adapter based on options", () => {
    const adapter = createStorageAdapter({ driver: "memory" });
    expect(adapter).toBeInstanceOf(DataPlaneStore);
  });
});
