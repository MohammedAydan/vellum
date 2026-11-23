/**
 * ENGINE-HARDENING — end-to-end engine flows against the in-memory data plane.
 * Complements the focused unit suites under packages/document-engine/src/__tests__.
 */
import { describe, it, expect } from "vitest";
import {
  createFixture,
  SerializedDataPlaneStore,
  TENANT,
  type RecordingMetering,
  type RecordingRealtime,
} from "../../packages/document-engine/src/__tests__/_harness.js";

describe("engine-hardening / integration — OCC lifecycle", () => {
  it("begins, reads, commits and refuses a second terminal transition", async () => {
    const { engine } = createFixture({ dataStore: new SerializedDataPlaneStore() });
    await engine.createDocument({ ...TENANT, path: "accounts/a", data: { balance: 100 } });

    const tx = await engine.beginTransaction(TENANT);
    const read = await engine.getDocument({
      ...TENANT,
      path: "accounts/a",
      transactionToken: tx.transactionToken,
    });
    expect(read.version).toBe(1);

    const committed = await engine.commitTransaction({
      ...TENANT,
      transactionToken: tx.transactionToken,
      writes: [{ type: "set", path: "accounts/a", data: { balance: 150 } }],
    });
    expect((committed.results[0] as { version: number }).version).toBe(2);
    await expect(
      engine.rollbackTransaction({ ...TENANT, transactionToken: tx.transactionToken })
    ).rejects.toMatchObject({ code: "ALREADY_COMMITTED" });
  });
});

describe("engine-hardening / integration — import / export / restore / idempotency", () => {
  it("round-trips a large collection and restores a tombstone with CAS", async () => {
    const { engine } = createFixture();
    const total = 620;
    const docs = Array.from({ length: total }, (_, i) => ({
      id: `e_${String(i).padStart(4, "0")}`,
      value: i,
    }));
    expect((await engine.importCollectionDocuments(TENANT, "archive", docs)).importedCount).toBe(total);

    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await engine.exportCollectionDocuments(TENANT, "archive", {
        limit: 250,
        ...(cursor !== null ? { cursor } : {}),
      });
      ids.push(...page.documents.map((d) => d.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);

    const deleted = await engine.deleteDocument({ ...TENANT, path: "archive/e_0000" });
    const restored = await engine.restoreDocument({
      ...TENANT,
      path: "archive/e_0000",
      ifVersion: deleted.version,
    });
    expect(restored.version).toBe(deleted.version + 1);
    expect(restored.data["value"]).toBe(0);
  });

  it("retries an idempotent mutation without duplicating writes", async () => {
    const { engine, store } = createFixture();
    const request = {
      ...TENANT,
      idempotencyKey: "integration-retry",
      writes: [{ type: "create" as const, path: "orders/one", data: { total: 5 } }],
    };
    const first = await engine.batchWrite(request);
    const second = await engine.batchWrite({
      ...request,
      writes: [{ type: "create", path: "orders/two", data: { total: 9 } }],
    });
    expect(second).toEqual(first);
    expect(await store.getDocument(TENANT, "orders/two")).toBeNull();
  });
});

describe("engine-hardening / integration — referential integrity & sinks", () => {
  it("cascade deletes from deleteWhere with outbox + metering + realtime", async () => {
    const { engine, store, metering, realtime } = createFixture();
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { stale: true } });
    await engine.createDocument({ ...TENANT, path: "posts/p1", data: { authorId: "users/u1" } });

    const result = await engine.deleteWhere({
      ...TENANT,
      collectionPath: "users",
      where: [{ field: "stale", op: "==", value: true }],
      relationRules: [{ collection: "posts", field: "authorId", onDelete: "cascade" }],
    });
    expect(result.deletedCount).toBe(1);
    const post = await store.getDocument(TENANT, "posts/p1", { includeSoftDeleted: true });
    expect(post?.deletedAt).toBeTruthy();
    expect((metering as RecordingMetering).calls.length).toBeGreaterThan(0);
    expect((realtime as RecordingRealtime).calls.length).toBeGreaterThan(0);
  });

  it("rate-limit denial surfaces as RATE_LIMITED without touching storage", async () => {
    const { engine, store } = createFixture({ rateLimiter: { check: () => false } });
    await expect(
      engine.createDocument({ ...TENANT, path: "users/u1", data: {} })
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await store.getDocument(TENANT, "users/u1")).toBeNull();
  });

  it("broken audit + realtime sinks never fail a committed write", async () => {
    const { engine, store } = createFixture({
      audit: { log: () => { throw new Error("audit offline"); } },
      realtimeHub: { notifyCommittedEvents: () => { throw new Error("hub offline"); } },
      metering: { recordDeletes: () => { throw new Error("meter offline"); } },
    });
    const created = await engine.createDocument({ ...TENANT, path: "users/u1", data: { n: 1 } });
    expect(created.version).toBe(1);
    await engine.deleteDocument({ ...TENANT, path: "users/u1" });
    expect((await store.getDocument(TENANT, "users/u1", { includeSoftDeleted: true }))?.deletedAt).toBeTruthy();
  });
});
