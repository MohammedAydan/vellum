/**
 * ENGINE-HARDENING §7–§11 — deleteWhere parity, import hygiene, sink resilience,
 * deterministic export / bulk read / restore / idempotency.
 */
import { describe, it, expect, vi } from "vitest";
import { type TenantContext, type TxHandle } from "@vellum/storage";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { createCircuitBreaker } from "../circuit-breaker.js";
import {
  createFixture,
  publicKey,
  TENANT,
  type RecordingAudit,
  type RecordingMetering,
  type RecordingRealtime,
} from "./_harness.js";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

/**
 * Test-double adapter that exposes the SQL adapter's uncapped cursor page
 * capability. The in-memory adapter deliberately caps pages at 500 rows; the
 * real pg/neon adapters do not. This wrapper lets the stream test exercise the
 * contractual 1,000-row page shape over 2,500+ documents.
 */
class WidePageStore extends DataPlaneStore {
  public override async withTransaction<T>(
    ctx: TenantContext,
    callback: (tx: TxHandle) => Promise<T>
  ): Promise<T> {
    return super.withTransaction(ctx, (tx) => {
      const wideTx: TxHandle = {
        ...tx,
        listDocumentsInCollectionPage: (async (
          collectionName: string,
          opts: { afterDocumentId?: string | null; limit: number }
        ) => {
          const after = opts.afterDocumentId ?? null;
          const rows = Array.from(this.documents.values())
            .filter(
              (row) =>
                row.projectId === ctx.projectId &&
                row.collectionPath === collectionName &&
                row.deletedAt === null &&
                (after === null || row.documentId > after)
            )
            .sort((a, b) => (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0))
            .slice(0, opts.limit);
          return rows.map((row) => structuredClone(row));
        }) as NonNullable<TxHandle["listDocumentsInCollectionPage"]>,
      };
      return callback(wideTx);
    });
  }
}

describe("hardening/capabilities — deleteWhere parity with batchWrite", () => {
  it("applies referential-integrity rules identically (cascade tombstone)", async () => {
    const { engine, store } = createFixture();
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
    expect(store.outbox.some((e) => e.path === "posts/p1" && e.opType === "deleted")).toBe(true);
  });

  it("emits outbox events and notifies realtime for each tombstone", async () => {
    const { engine, realtime } = createFixture();
    for (const id of ["a", "b", "c"]) {
      await engine.createDocument({ ...TENANT, path: `orders/${id}`, data: { stale: true } });
    }
    const notificationsBefore = (realtime as RecordingRealtime).calls.length;
    const result = await engine.deleteWhere({
      ...TENANT,
      collectionPath: "orders",
      where: [{ field: "stale", op: "==", value: true }],
    });
    expect(result.deletedCount).toBe(3);
    const notifications = (realtime as RecordingRealtime).calls;
    expect(notifications).toHaveLength(notificationsBefore + 1);
    expect(notifications[notifications.length - 1]?.events).toHaveLength(3);
  });

  it("reports storageBytesDelta to metering and count-only metadata to audit", async () => {
    const { engine, metering, audit } = createFixture();
    const meter = metering as RecordingMetering;
    const auditor = audit as RecordingAudit;
    await engine.createDocument({ ...TENANT, path: "orders/a", data: { stale: true, payload: "x".repeat(200) } });
    const meteringBefore = meter.calls.length;
    await engine.deleteWhere({ ...TENANT, collectionPath: "orders" });

    expect(meter.calls).toHaveLength(meteringBefore + 1);
    const deleteCall = meter.calls[meter.calls.length - 1];
    expect(deleteCall?.count).toBe(1);
    expect(deleteCall?.storageDeltaBytes).toBeLessThan(0);
    const action = auditor.calls.find((c) => c.action === "document.delete.where");
    expect(action).toBeDefined();
    expect(action?.metadata?.["deletedCount"]).toBe(1);
    expect(JSON.stringify(action)).not.toContain("xxxx");
  });
});

describe("hardening/capabilities — import boundary hygiene", () => {
  it("strips transactionToken before any chunk reaches batchWrite", async () => {
    const { engine } = createFixture();
    const spy = vi.spyOn(engine, "batchWrite");
    const ctx = { ...TENANT, transactionToken: "opaque-occ-token" };
    await engine.importCollectionDocuments(
      ctx,
      "imported",
      [{ id: "a", n: 1 }, { id: "b", n: 2 }],
      { limit: 10 }
    );
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      expect(call[0]).not.toHaveProperty("transactionToken");
    }
    spy.mockRestore();
  });

  it("rejects NaN, fractional and negative import limits", async () => {
    const { engine } = createFixture();
    for (const limit of [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY]) {
      await expect(
        engine.importCollectionDocuments(TENANT, "imported", [{ id: "a" }], { limit })
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });
});

describe("hardening/capabilities — best-effort sink failure isolation", () => {
  it("a throwing realtime hub never fails an already-committed write", async () => {
    const { engine, store } = createFixture({
      realtimeHub: {
        notifyCommittedEvents: () => {
          throw new Error("hub offline");
        },
      },
    });
    const doc = await engine.createDocument({ ...TENANT, path: "users/u1", data: { n: 1 } });
    expect(doc.version).toBe(1);
    expect((await store.getDocument(TENANT, "users/u1"))?.data["n"]).toBe(1);
  });

  it("a rejecting metering sink produces zero unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", handler);
    try {
      const { engine } = createFixture({
        metering: { recordDeletes: () => Promise.reject(new Error("meter down")) },
      });
      await engine.createDocument({ ...TENANT, path: "orders/a", data: {} });
      await engine.clearCollection(TENANT, "orders");
      await flush();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  it("circuit breaker opens after 5 consecutive failures and drops later calls", async () => {
    const sink = vi.fn(() => Promise.reject(new Error("sink down")));
    const breaker = createCircuitBreaker(sink, { failureThreshold: 5, cooldownMs: 60_000 });
    for (let i = 0; i < 5; i += 1) breaker.call();
    await flush();
    expect(breaker.isOpen).toBe(true);
    expect(sink).toHaveBeenCalledTimes(5);

    breaker.call();
    breaker.call();
    expect(sink).toHaveBeenCalledTimes(5); // dropped while open
  });
});

describe("hardening/capabilities — deterministic export & bulk read", () => {
  it("exportCollectionDocuments pages 2,500+ docs with no gaps or duplicates", async () => {
    const { engine } = createFixture();
    const total = 2_534;
    const docs = Array.from({ length: total }, (_, i) => ({
      id: `doc_${String(i).padStart(5, "0")}`,
      n: i,
    }));
    const imported = await engine.importCollectionDocuments(TENANT, "bulk", docs);
    expect(imported.importedCount).toBe(total);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await engine.exportCollectionDocuments(TENANT, "bulk", {
        limit: 500,
        ...(cursor !== null ? { cursor } : {}),
      });
      seen.push(...page.documents.map((d) => d.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen[0]).toBe("doc_00000");
    expect(seen[seen.length - 1]).toBe("doc_02533");
  });

  it("exportCollectionDocumentsStream emits 2,500+ docs in deterministic order", async () => {
    const { engine } = createFixture({ dataStore: new WidePageStore() });
    const total = 2_517;
    const docs = Array.from({ length: total }, (_, i) => ({
      id: `s_${String(i).padStart(5, "0")}`,
      n: i,
    }));
    expect((await engine.importCollectionDocuments(TENANT, "stream_bulk", docs)).importedCount).toBe(total);

    const seen: string[] = [];
    for await (const doc of engine.exportCollectionDocumentsStream(TENANT, "stream_bulk")) {
      seen.push(doc.id);
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen).toEqual([...seen].sort());
  });

  it("getDocuments filters each document by Security Rules", async () => {
    const ruleset = {
      rulesAst: {
        version: 1,
        rules: [
          { match: "inbox/{id}", allow: { list: true } },
          {
            match: "inbox/{id}",
            allow: { get: { op: "==", left: { var: "resource.data.owner" }, right: { val: "u1" } } },
          },
        ],
      },
    };
    const { engine } = createFixture({ ruleset });
    await engine.createDocument({ ...TENANT, path: "inbox/a", data: { owner: "u1" } });
    await engine.createDocument({ ...TENANT, path: "inbox/b", data: { owner: "u2" } });
    await engine.createDocument({ ...TENANT, path: "inbox/c", data: { owner: "u1" } });

    const docs = await engine.getDocuments({
      ...TENANT,
      apiKeyRecord: publicKey(),
      authContext: { uid: "u1", claims: {} },
      paths: ["inbox/a", "inbox/b", "inbox/c"],
    });
    expect(docs.map((d) => d.path)).toEqual(["inbox/a", "inbox/c"]);
  });

  it("restoreDocument requires an ifVersion equal to the tombstone version", async () => {
    const { engine } = createFixture();
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { name: "Ada" } });
    const deleted = await engine.deleteDocument({ ...TENANT, path: "users/u1" });
    expect(deleted.version).toBe(2);

    await expect(
      engine.restoreDocument({ ...TENANT, path: "users/u1", ifVersion: 1 })
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
    const restored = await engine.restoreDocument({ ...TENANT, path: "users/u1", ifVersion: 2 });
    expect(restored.version).toBe(3);
    expect(restored.data["name"]).toBe("Ada");
    await expect(
      engine.restoreDocument({ ...TENANT, path: "users/u1", ifVersion: 2 })
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
  });

  it("idempotencyKey replays the first response without re-applying writes", async () => {
    const { engine, store } = createFixture();
    const first = await engine.batchWrite({
      ...TENANT,
      idempotencyKey: "retry-key",
      writes: [{ type: "create", path: "orders/first", data: { n: 1 } }],
    });
    const replay = await engine.batchWrite({
      ...TENANT,
      idempotencyKey: "retry-key",
      writes: [{ type: "create", path: "orders/second", data: { n: 2 } }],
    });
    expect(replay).toEqual(first);
    expect(await store.getDocument(TENANT, "orders/first")).not.toBeNull();
    expect(await store.getDocument(TENANT, "orders/second")).toBeNull();
  });
});
