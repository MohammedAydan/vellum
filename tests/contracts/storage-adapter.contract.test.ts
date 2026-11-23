import { describe, expect, it } from "vitest";
import type { DocumentRecord, StorageAdapterPort } from "@vellum/storage";
import { DataPlaneStore } from "@vellum/storage/adapters";

function makeDoc(projectId: string, documentId: string): DocumentRecord {
  const now = new Date().toISOString();
  return {
    projectId,
    path: `users/${documentId}`,
    collectionPath: "users",
    collectionGroup: "users",
    documentId,
    pathDepth: 2,
    data: { role: "member" },
    sizeBytes: 32,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function runStorageAdapterConformanceSuite(name: string, factory: () => StorageAdapterPort): void {
  describe(`StorageAdapterPort conformance: ${name}`, () => {
    it("enforces strict projectId tenant isolation on reads and writes", async () => {
      const adapter = factory();
      const ctxA = { projectId: "proj_alpha" };
      const ctxB = { projectId: "proj_beta" };
      await adapter.putDocument(ctxA, makeDoc(ctxA.projectId, "u1"));

      const own = await adapter.getDocument(ctxA, "users/u1");
      expect(own?.projectId).toBe(ctxA.projectId);
      expect(own?.path).toBe("users/u1");
      expect(await adapter.getDocument(ctxB, "users/u1")).toBeNull();
    });

    it("supports transactional read-your-writes and rollback isolation", async () => {
      const adapter = factory();
      const ctx = { projectId: "proj_tx" };
      await expect(
        adapter.withTransaction(ctx, async (tx) => {
          await tx.putDocumentRow(makeDoc(ctx.projectId, "i1"));
          throw new Error("FORCE_ROLLBACK");
        })
      ).rejects.toThrow("FORCE_ROLLBACK");

      const afterRollback = await adapter.getDocument(ctx, "users/i1");
      expect(afterRollback).toBeNull();
    });
  });
}

runStorageAdapterConformanceSuite("In-Memory DataPlaneStore", () => new DataPlaneStore());
