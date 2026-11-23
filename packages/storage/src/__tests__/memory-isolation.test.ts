import { afterEach, describe, expect, it, vi } from "vitest";
import { DataPlaneStore } from "../memory-adapter.js";
import { createStorageAdapter } from "../factory.js";
import { PgStorageAdapter } from "../pg-adapter.js";
import type { DocumentRecord } from "../types.js";

const A = { projectId: "11111111-1111-1111-1111-111111111111" };
const B = { projectId: "22222222-2222-2222-2222-222222222222" };
function row(projectId: string): DocumentRecord {
  const at = new Date().toISOString();
  return { projectId, path: "items/a", collectionPath: "items", collectionGroup: "items", documentId: "a", pathDepth: 2, data: { ok: true }, sizeBytes: 10, version: 1, createdAt: at, updatedAt: at, deletedAt: null };
}

describe("memory transaction isolation", () => {
  it("a failed transaction cannot erase a concurrent committed tenant write", async () => {
    const store = new DataPlaneStore();
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const failed = store.withTransaction(A, async (tx) => {
      await tx.putDocumentRow(row(A.projectId));
      entered();
      await gate;
      throw new Error("intentional rollback");
    });
    const rejection = expect(failed).rejects.toThrow("intentional rollback");
    await started;
    const success = store.withTransaction(B, async (tx) => { await tx.putDocumentRow(row(B.projectId)); });
    resume();
    await Promise.all([rejection, success]);
    expect(await store.getDocument(A, "items/a")).toBeNull();
    expect((await store.getDocument(B, "items/a"))?.data).toEqual({ ok: true });
  });

  it("rolls back collection registration and its config cache", async () => {
    const store = new DataPlaneStore();
    await expect(store.withTransaction(A, async () => {
      await store.createCollection(A, { name: "transient", defaultTtlSeconds: 42 });
      throw new Error("rollback collection");
    })).rejects.toThrow("rollback collection");
    expect(await store.getCollection(A, "transient")).toBeNull();
    expect(await store.getCollectionConfig(A, "transient")).toBeNull();
  });
});


describe("storage adapter configuration", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("uses an explicit PostgreSQL URL rather than silently returning ephemeral memory", async () => {
    vi.stubEnv("DATA_DATABASE_URL", ""); vi.stubEnv("DATABASE_URL", ""); vi.stubEnv("DATA_DATABASE_DRIVER", undefined);
    const adapter = createStorageAdapter({ connectionString: "postgresql://localhost/unused" });
    expect(adapter).toBeInstanceOf(PgStorageAdapter);
    await adapter.close();
  });
  it("rejects unknown drivers and implicit production memory", () => {
    vi.stubEnv("DATA_DATABASE_DRIVER", "postgress");
    expect(() => createStorageAdapter()).toThrow("Unsupported storage driver");
    vi.stubEnv("DATA_DATABASE_DRIVER", undefined); vi.stubEnv("DATA_DATABASE_URL", ""); vi.stubEnv("DATABASE_URL", ""); vi.stubEnv("NODE_ENV", "production");
    expect(() => createStorageAdapter()).toThrow("In-memory storage is not allowed");
  });
});
