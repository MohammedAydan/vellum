import { describe, it, expect } from "vitest";
import { DataPlaneStore } from "../memory-adapter.js";
import {
  compileAggregateSql,
  validateAggregateRequest,
  aggregateRowsInMemory,
  normalizeAggregateRows,
  type AggregateRequest,
} from "../aggregates.js";
import { VellumError } from "@vellum/core";
import type { DocumentRecord } from "../types.js";

const TENANT = {
  projectId: "11111111-1111-1111-1111-111111111111",
};

function doc(
  id: string,
  data: Record<string, unknown>,
  overrides: Partial<DocumentRecord> = {}
): DocumentRecord {
  return {
    projectId: TENANT.projectId,
    path: `orders/${id}`,
    collectionPath: "orders",
    collectionGroup: "orders",
    documentId: id,
    pathDepth: 2,
    data,
    sizeBytes: 100,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("@vellum/storage - Aggregate SQL compilation", () => {
  it("compiles a fully parameterized grouped aggregate with TTL and tenant predicates", () => {
    const request: AggregateRequest = {
      collectionPath: "orders",
      where: [{ field: "status", op: "==", value: "paid" }],
      groupBy: ["customer.name"],
      metrics: {
        count: { op: "count" },
        total: { op: "sum", field: "amount" },
        average: { op: "avg", field: "amount" },
      },
    };
    const { sql, params } = compileAggregateSql(TENANT, request);
    expect(sql).toContain("d.project_id = $1::uuid");
    expect(sql).toContain("d.collection_path = $2");
    expect(sql).toContain("d.deleted_at IS NULL");
    expect(sql).toContain("(d.expires_at IS NULL OR d.expires_at > now())");
    expect(sql).toContain("COUNT(*) AS \"count\"");
    expect(sql).toContain("SUM(");
    expect(sql).toContain("AVG(");
    expect(sql).toContain("GROUP BY");
    expect(sql).toContain("d.data #>>");
    expect(params[0]).toBe(TENANT.projectId);
    expect(params[1]).toBe("orders");
    // No user value is interpolated into the SQL text.
    expect(sql).not.toContain("paid");
  });

  it("groups document fields on their JSON value so numbers and booleans keep their type", () => {
    const { sql } = compileAggregateSql(TENANT, {
      collectionPath: "orders",
      groupBy: ["level", "documentId"],
      metrics: { count: { op: "count" } },
    });
    expect(sql).toContain("NULLIF((d.data #> ");
    expect(sql).toContain("'null'::jsonb");
    expect(sql).toContain("d.document_id::text AS \"documentId\"");
  });

  it("compiles 'or' groups as parenthesized OR predicates", () => {
    const { sql } = compileAggregateSql(TENANT, {
      collectionPath: "orders",
      or: [
        [{ field: "status", op: "==", value: "paid" }],
        [{ field: "status", op: "==", value: "refunded" }],
      ],
      metrics: { count: { op: "count" } },
    });
    expect(sql).toContain(") OR (");
  });

  it("escapes metric aliases used as identifiers", () => {
    const { sql } = compileAggregateSql(TENANT, {
      collectionPath: "orders",
      metrics: { 'weird"alias': { op: "count" } },
    });
    expect(sql).toContain('AS "weird""alias"');
  });

  it("rejects invalid aggregate requests", () => {
    expect(() =>
      validateAggregateRequest({
        collectionPath: "orders",
        metrics: { total: { op: "sum" } },
      })
    ).toThrow(VellumError); // sum needs a field
    expect(() =>
      validateAggregateRequest({
        collectionPath: "orders",
        where: Array.from({ length: 11 }, (_, i) => ({ field: `f${i}`, op: "==" as const, value: i })),
        metrics: { count: { op: "count" } },
      })
    ).toThrow(VellumError);
    expect(() => validateAggregateRequest({ collectionPath: "orders", metrics: {} })).toThrow(VellumError);
  });

  it("normalizes numeric string results from PostgreSQL", () => {
    const rows = normalizeAggregateRows(
      [{ status: "paid", count: "3", total: "150.5", average: null }],
      {
        collectionPath: "orders",
        groupBy: ["status"],
        metrics: {
          count: { op: "count" },
          total: { op: "sum", field: "amount" },
          average: { op: "avg", field: "amount" },
        },
      }
    );
    expect(rows[0]).toEqual({ status: "paid", count: 3, total: 150.5, average: null });
  });
});

describe("@vellum/storage - In-memory aggregation semantics", () => {
  it("groups, coerces tagged ints, and ignores non-numeric values", () => {
    const docs = [
      doc("a", { status: "paid", amount: 10, customer: { name: "X" } }),
      doc("b", { status: "paid", amount: { $t: "int", $v: "20" }, customer: { name: "X" } }),
      doc("c", { status: "paid", amount: "not-a-number", customer: { name: "Y" } }),
      doc("d", { status: "free", amount: 5, customer: { name: "Y" } }),
    ];
    const rows = aggregateRowsInMemory(docs, {
      collectionPath: "orders",
      groupBy: ["status"],
      metrics: {
        count: { op: "count" },
        total: { op: "sum", field: "amount" },
        min: { op: "min", field: "amount" },
        max: { op: "max", field: "amount" },
      },
    });
    const paid = rows.find((r) => r["status"] === "paid");
    expect(paid).toMatchObject({ count: 3, total: 30, min: 10, max: 20 });
    const free = rows.find((r) => r["status"] === "free");
    expect(free).toMatchObject({ count: 1, total: 5 });
  });

  it("returns a single row with zero count for no docs and no groupBy", () => {
    const rows = aggregateRowsInMemory([], {
      collectionPath: "orders",
      metrics: { count: { op: "count" }, total: { op: "sum", field: "amount" } },
    });
    expect(rows).toEqual([{ count: 0, total: null }]);
  });

  it("supports dot-path group fields", () => {
    const rows = aggregateRowsInMemory(
      [doc("a", { customer: { tier: "gold" }, amount: 1 }), doc("b", { customer: { tier: "gold" }, amount: 2 })],
      {
        collectionPath: "orders",
        groupBy: ["customer.tier"],
        metrics: { total: { op: "sum", field: "amount" } },
      }
    );
    expect(rows).toEqual([{ "customer.tier": "gold", total: 3 }]);
  });
});

describe("@vellum/storage - Memory adapter aggregate / delete / TTL", () => {
  it("aggregates with where/or filtering via the adapter", async () => {
    const store = new DataPlaneStore();
    await store.putDocument(TENANT, doc("a", { status: "paid", amount: 10, region: "us" }));
    await store.putDocument(TENANT, doc("b", { status: "paid", amount: 20, region: "eu" }));
    await store.putDocument(TENANT, doc("c", { status: "pending", amount: 5, region: "ap" }));

    const rows = await store.aggregateDocuments(TENANT, {
      collectionPath: "orders",
      where: [{ field: "amount", op: ">", value: 0 }],
      or: [
        [{ field: "region", op: "==", value: "us" }],
        [{ field: "amount", op: "==", value: 20 }],
      ],
      groupBy: ["status"],
      metrics: { count: { op: "count" }, total: { op: "sum", field: "amount" } },
    });
    const paid = rows.find((r) => r["status"] === "paid");
    expect(paid?.["count"]).toBe(2);
    expect(paid?.["total"]).toBe(30);
    expect(rows.find((r) => r["status"] === "pending")).toBeUndefined();
  });

  it("deleteWhere tombstones matching rows, emits outbox events, and respects the limit", async () => {
    const store = new DataPlaneStore();
    for (const id of ["a", "b", "c"]) {
      await store.putDocument(TENANT, doc(id, { status: "stale", amount: 1 }));
    }
    await store.putDocument(TENANT, doc("keep", { status: "active", amount: 1 }));

    const deleted = await store.deleteWhere(TENANT, "orders", [{ field: "status", op: "==", value: "stale" }], {
      limit: 2,
    });
    expect(deleted).toBe(2);
    expect(await store.getDocument(TENANT, "orders/a")).toBeNull();
    expect(await store.getDocument(TENANT, "orders/b")).toBeNull();
    expect(await store.getDocument(TENANT, "orders/c")).not.toBeNull();
    expect(await store.getDocument(TENANT, "orders/keep")).not.toBeNull();
    expect(store.outbox.filter((e) => e.opType === "deleted").length).toBe(2);
    expect(store.outbox.every((e) => e.opType !== "deleted" || e.afterData === null)).toBe(true);
  });

  it("deleteWhere excludes expired rows via the TTL predicate", async () => {
    const store = new DataPlaneStore();
    await store.putDocument(TENANT, doc("expired", { status: "stale" }, { expiresAt: "2000-01-01T00:00:00.000Z" }));
    const deleted = await store.deleteWhere(TENANT, "orders", [{ field: "status", op: "==", value: "stale" }], {
      limit: 100,
    });
    expect(deleted).toBe(0);
  });

  it("runTtlSweeperWorker physically removes expired live rows in bounded batches", async () => {
    const store = new DataPlaneStore();
    for (const id of ["a", "b", "c"]) {
      await store.putDocument(TENANT, doc(id, { n: 1 }, { expiresAt: "2000-01-01T00:00:00.000Z" }));
    }
    await store.putDocument(TENANT, doc("future", { n: 1 }, { expiresAt: "2999-01-01T00:00:00.000Z" }));
    await store.putDocument(TENANT, doc("never", { n: 1 }));

    const first = await store.runTtlSweeperWorker(2);
    expect(first.purgedCount).toBe(2);
    const second = await store.runTtlSweeperWorker(2);
    expect(second.purgedCount).toBe(1);
    const third = await store.runTtlSweeperWorker(2);
    expect(third.purgedCount).toBe(0);
    expect(await store.getDocument(TENANT, "orders/future")).not.toBeNull();
    expect(await store.getDocument(TENANT, "orders/never")).not.toBeNull();
  });
});
