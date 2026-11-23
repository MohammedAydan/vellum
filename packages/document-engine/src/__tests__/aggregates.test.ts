import { describe, it, expect, beforeEach } from "vitest";
import { DocumentEngine, projectDocumentFields, setPath } from "../engine.js";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { VellumError } from "@vellum/core";

const TENANT = {
  projectId: "11111111-1111-1111-1111-111111111111",
  // Trusted test caller: permits the engine's fail-closed synthetic key path.
  internal: true as const,
};

class MockControlStore {
  public usageEvents: Array<{ usage: Record<string, unknown> }> = [];
  public ruleset: unknown = null;

  getActiveRuleset() {
    return this.ruleset;
  }

  incrementUsage(_projectId: string, usage: Record<string, unknown>) {
    this.usageEvents.push({ usage });
  }
}

const PUBLIC_KEY = {
  id: "pk_test",
  projectId: TENANT.projectId,
  name: "public",
  keyType: "public",
  keyPrefix: "pk_test",
  secretHash: "hash",
  scopes: ["documents:read", "documents:write"],
  rateLimitRps: 100,
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdBy: null,
  createdAt: new Date().toISOString(),
};

describe("@vellum/document-engine - Dot-path projection", () => {
  it("setPath builds nested objects", () => {
    const out: Record<string, unknown> = {};
    setPath(out, "stats.views", 12);
    setPath(out, "title", "Hi");
    expect(out).toEqual({ stats: { views: 12 }, title: "Hi" });
  });

  it("projectDocumentFields rebuilds nested JSON from a flat dot-path map", () => {
    const flat = { title: "Post", "author.name": "Ada", "stats.views": 42 };
    expect(projectDocumentFields(flat, ["title", "author.name", "stats.views"])).toEqual({
      title: "Post",
      author: { name: "Ada" },
      stats: { views: 42 },
    });
  });

  it("projectDocumentFields also reads raw nested data via getFieldByPath", () => {
    const raw = { title: "Post", author: { name: "Ada", email: "a@b.c" }, stats: { views: 42 } };
    expect(projectDocumentFields(raw, ["title", "author.name"])).toEqual({
      title: "Post",
      author: { name: "Ada" },
    });
  });
});

describe("@vellum/document-engine - Native aggregation & bulk delete", () => {
  let engine: DocumentEngine;
  let dataStore: DataPlaneStore;
  let control: MockControlStore;

  beforeEach(() => {
    dataStore = new DataPlaneStore();
    control = new MockControlStore();
    engine = new DocumentEngine({ controlStore: control, dataStore });
  });

  it("getDocument and executeQuery apply dot-path select as nested JSON", async () => {
    await engine.createDocument({
      ...TENANT,
      path: "posts/p1",
      data: { title: "Hello", author: { name: "Ada", email: "a@b.c" }, stats: { views: 7 } },
    });

    const got = await engine.getDocument({
      ...TENANT,
      path: "posts/p1",
      select: ["title", "author.name", "stats.views"],
    });
    expect(got.data).toEqual({ title: "Hello", author: { name: "Ada" }, stats: { views: 7 } });

    const queried = await engine.executeQuery({
      ...TENANT,
      querySpec: {
        collection: "posts",
        select: ["title", "author.name"],
      },
    });
    expect(queried.documents[0]?.data).toEqual({ title: "Hello", author: { name: "Ada" } });
  });

  it("aggregateDocuments groups, filters and computes metrics", async () => {
    await engine.createDocument({ ...TENANT, path: "orders/a", data: { status: "paid", amount: 10, region: "us" } });
    await engine.createDocument({ ...TENANT, path: "orders/b", data: { status: "paid", amount: 20, region: "eu" } });
    await engine.createDocument({ ...TENANT, path: "orders/c", data: { status: "pending", amount: 5, region: "us" } });

    const result = await engine.aggregateDocuments({
      ...TENANT,
      request: {
        collectionPath: "orders",
        where: [{ field: "amount", op: ">", value: 0 }],
        or: [
          [{ field: "region", op: "==", value: "us" }],
          [{ field: "status", op: "==", value: "paid" }],
        ],
        groupBy: ["status"],
        metrics: {
          count: { op: "count" },
          total: { op: "sum", field: "amount" },
          average: { op: "avg", field: "amount" },
        },
      },
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.find((r) => r["status"] === "paid")).toMatchObject({ count: 2, total: 30, average: 15 });
    expect(result.rows.find((r) => r["status"] === "pending")).toMatchObject({ count: 1, total: 5 });
    expect(typeof result.executionTimeMs).toBe("number");
  });

  it("aggregateDocuments enforces list Security Rules before execution", async () => {
    control.ruleset = {
      rulesAst: {
        version: 1,
        rules: [{ match: "orders/{orderId}", allow: { list: false } }],
      },
    };
    await expect(
      engine.aggregateDocuments({
        ...TENANT,
        apiKeyRecord: PUBLIC_KEY,
        request: { collectionPath: "orders", metrics: { count: { op: "count" } } },
      })
    ).rejects.toThrow(VellumError);
  });

  it("deleteWhere verifies list + per-document delete rules, stages tombstones and usage", async () => {
    await engine.createDocument({ ...TENANT, path: "orders/a", data: { owner: "u1", status: "stale" } });
    await engine.createDocument({ ...TENANT, path: "orders/b", data: { owner: "u1", status: "stale" } });
    control.ruleset = {
      rulesAst: {
        version: 1,
        rules: [
          {
            match: "orders/{orderId}",
            allow: {
              list: true,
              delete: { op: "==", left: { var: "resource.data.owner" }, right: { val: "u1" } },
            },
          },
        ],
      },
    };

    const result = await engine.deleteWhere({
      ...TENANT,
      apiKeyRecord: PUBLIC_KEY,
      authContext: { uid: "u1", claims: {} },
      collectionPath: "orders",
      where: [{ field: "status", op: "==", value: "stale" }],
    });
    expect(result.deletedCount).toBe(2);
    expect((await dataStore.getDocument(TENANT, "orders/a", { includeSoftDeleted: true }))?.deletedAt).toBeTruthy();
    expect((await dataStore.getDocument(TENANT, "orders/b", { includeSoftDeleted: true }))?.deletedAt).toBeTruthy();
    expect(dataStore.outbox.filter((e) => e.opType === "deleted")).toHaveLength(2);
    expect(control.usageEvents.some((e) => (e.usage as { documentDeletes?: number }).documentDeletes === 2)).toBe(true);
  });

  it("deleteWhere fails closed (rolls back) if any matched document fails delete rules", async () => {
    await engine.createDocument({ ...TENANT, path: "orders/a", data: { owner: "u1", status: "stale" } });
    await engine.createDocument({ ...TENANT, path: "orders/b", data: { owner: "u2", status: "stale" } });
    control.ruleset = {
      rulesAst: {
        version: 1,
        rules: [
          {
            match: "orders/{orderId}",
            allow: {
              list: true,
              delete: { op: "==", left: { var: "resource.data.owner" }, right: { val: "u1" } },
            },
          },
        ],
      },
    };
    await expect(
      engine.deleteWhere({
        ...TENANT,
        apiKeyRecord: PUBLIC_KEY,
        authContext: { uid: "u1", claims: {} },
        collectionPath: "orders",
        where: [{ field: "status", op: "==", value: "stale" }],
      })
    ).rejects.toThrow(VellumError);
    // Nothing was deleted: the authorization failure aborted the transaction.
    expect((await dataStore.getDocument(TENANT, "orders/a", { includeSoftDeleted: true }))?.deletedAt).toBeNull();
    expect(dataStore.outbox.filter((e) => e.opType === "deleted")).toHaveLength(0);
  });

  it("deleteWhere respects the limit and hard cap", async () => {
    for (const id of ["a", "b", "c"]) {
      await engine.createDocument({ ...TENANT, path: `orders/${id}`, data: { status: "stale" } });
    }
    const result = await engine.deleteWhere({
      ...TENANT,
      collectionPath: "orders",
      where: [{ field: "status", op: "==", value: "stale" }],
      limit: 2,
    });
    expect(result.deletedCount).toBe(2);
  });

  it("denies deleteWhere entirely when list rules fail", async () => {
    control.ruleset = {
      rulesAst: { version: 1, rules: [{ match: "orders/{orderId}", allow: { list: false } }] },
    };
    await expect(
      engine.deleteWhere({ ...TENANT, apiKeyRecord: PUBLIC_KEY, collectionPath: "orders" })
    ).rejects.toThrow(VellumError);
  });
});

describe("@vellum/document-engine - Upsert & TTL", () => {
  let engine: DocumentEngine;
  let dataStore: DataPlaneStore;

  beforeEach(() => {
    dataStore = new DataPlaneStore();
    engine = new DocumentEngine({ controlStore: new MockControlStore(), dataStore });
  });

  it("persists ttlSeconds as an absolute expiresAt", async () => {
    await engine.createDocument({
      ...TENANT,
      path: "sessions/s1",
      data: { user: "u1" },
      ttlSeconds: 60,
    });
    const row = await dataStore.getDocument(TENANT, "sessions/s1");
    expect(row?.expiresAt).toBeTruthy();
    const delta = Date.parse(row!.expiresAt!) - Date.now();
    expect(delta).toBeGreaterThan(50_000);
    expect(delta).toBeLessThanOrEqual(61_000);
  });

  it("persists an explicit expiresAt ISO string", async () => {
    const expiresAt = "2030-01-01T00:00:00.000Z";
    await engine.setDocument({ ...TENANT, path: "sessions/s2", data: {}, expiresAt });
    expect((await dataStore.getDocument(TENANT, "sessions/s2"))?.expiresAt).toBe(expiresAt);
  });

  it("rejects invalid ttlSeconds and expiresAt", async () => {
    await expect(
      engine.createDocument({ ...TENANT, path: "sessions/bad1", data: {}, ttlSeconds: -1 })
    ).rejects.toThrow(VellumError);
    await expect(
      engine.createDocument({ ...TENANT, path: "sessions/bad2", data: {}, ttlSeconds: 2 ** 31 + 1 })
    ).rejects.toThrow(VellumError);
    await expect(
      engine.createDocument({ ...TENANT, path: "sessions/bad3", data: {}, expiresAt: "not-a-date" })
    ).rejects.toThrow(VellumError);
  });

  it("upsert:true makes create on an existing path update instead of erroring", async () => {
    await engine.createDocument({ ...TENANT, path: "counters/c1", data: { n: 1 } });
    const updated = await engine.createDocument({
      ...TENANT,
      path: "counters/c1",
      data: { n: 2 },
      upsert: true,
    });
    expect(updated.version).toBe(2);
    expect(updated.data["n"]).toBe(2);
  });

  it("preserves an existing TTL when no new TTL is supplied", async () => {
    const expiresAt = "2030-01-01T00:00:00.000Z";
    await engine.createDocument({ ...TENANT, path: "sessions/s3", data: {}, expiresAt });
    await engine.updateDocument({ ...TENANT, path: "sessions/s3", data: { touched: true } });
    expect((await dataStore.getDocument(TENANT, "sessions/s3"))?.expiresAt).toBe(expiresAt);
  });
});
