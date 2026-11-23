/**
 * Property-based executor/reference equivalence (fast-check).
 *
 * `fast-check` generates randomized documents and query shapes. For each case
 * the compiled plan is executed by the storage adapter (`queryDocuments`) and
 * compared against an independent reference computed directly from the stored
 * rows. This exercises filtering, ordering, projection, unindexed scan capping
 * and keyset pagination. Reproducibility is pinned with a fixed seed.
 *
 * The companion integration test (`tests/integration/query/query-sql.test.ts`)
 * runs the *same* compiled SQL against PostgreSQL and compares with this
 * in-memory evaluator when a Neon DATA_DATABASE_URL is available.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  compareWireValues,
  VellumError,
} from "@vellum/core";
import { type DocumentRecord } from "@vellum/storage";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { DocumentEngine } from "@vellum/document-engine";
import {
  extractDocFieldValue,
  documentMatchesQuery,
  validateAndNormalizeQuery,
  compileQueryToParameterizedSql,
  computeQueryShapeHash,
  encodeQueryCursor,
  decodeAndVerifyQueryCursor,
  UNINDEXED_SCAN_CAP,
  type CompiledQuery,
} from "@vellum/query-engine";

const PID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
// Memory adapter keys are length-prefixed for tenant isolation: `${len}:${projectId}:${path}`.
const memoryKey = (path: string): string => `${PID.length}:${PID}:${path}`;
const COLLECTION = "widgets";
const SEED = 20261116;
const NUM_RUNS = 40;

type DocShape = {
  score: number;
  label: string;
  active: boolean;
  tags: string[];
  level: number;
  day: number;
};

const docShapeArb: fc.Arbitrary<DocShape> = fc.record({
  score: fc.integer({ min: 0, max: 40 }),
  label: fc.constantFrom("alpha", "beta", "gamma"),
  active: fc.boolean(),
  tags: fc.array(fc.constantFrom("red", "blue", "green"), { minLength: 1, maxLength: 3 }),
  level: fc.integer({ min: 0, max: 10 }),
  day: fc.integer({ min: 1, max: 28 }),
});

const whereArb: fc.Arbitrary<Record<string, unknown> | null> = fc.oneof(
  fc.constant(null),
  fc.record({ field: fc.constant("score"), op: fc.constantFrom(">", ">=", "<", "<="), value: fc.integer({ min: 0, max: 40 }) }),
  fc.record({ field: fc.constant("label"), op: fc.constantFrom("==", "!="), value: fc.constantFrom("alpha", "beta", "gamma") }),
  fc.record({ field: fc.constant("label"), op: fc.constantFrom("in", "not-in"), value: fc.array(fc.constantFrom("alpha", "beta", "gamma"), { minLength: 1, maxLength: 3 }) }),
  fc.record({ field: fc.constant("tags"), op: fc.constant("array-contains"), value: fc.constantFrom("red", "blue", "green") }),
  fc.record({ field: fc.constant("tags"), op: fc.constant("array-contains-any"), value: fc.array(fc.constantFrom("red", "blue", "green"), { minLength: 1, maxLength: 3 }) }),
  fc.record({ field: fc.constant("profile.level"), op: fc.constantFrom(">=", "<"), value: fc.integer({ min: 0, max: 10 }) }),
);

const orderByArb = fc.constantFrom(
  [{ field: "documentId", dir: "asc" as const }],
  [{ field: "updatedAt", dir: "desc" as const }],
  [{ field: "createdAt", dir: "asc" as const }],
);

function makeDoc(i: number, shape: DocShape): DocumentRecord {
  const iso = new Date(Date.UTC(2026, 0, shape.day)).toISOString();
  return {
    projectId: PID,
    path: `${COLLECTION}/w_${String(i).padStart(3, "0")}`,
    collectionPath: COLLECTION,
    collectionGroup: COLLECTION,
    documentId: `w_${String(i).padStart(3, "0")}`,
    pathDepth: 2,
    data: {
      score: shape.score,
      label: shape.label,
      active: shape.active,
      tags: shape.tags,
      profile: { level: shape.level },
    },
    sizeBytes: 128,
    version: 1,
    createdAt: iso,
    updatedAt: iso,
    deletedAt: null,
  };
}

function referenceIds(store: DataPlaneStore, compiled: CompiledQuery): string[] {
  const q = compiled.normalizedQuery;
  const docs = Array.from(store.documents.values()).filter(
    (d) =>
      d.projectId === PID && documentMatchesQuery(d, q)
  );
  docs.sort((a, b) => {
    for (const o of q.orderBy) {
      const cmp = compareWireValues(
        extractDocFieldValue(a, o.field),
        extractDocFieldValue(b, o.field),
        o.dir
      );
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
  return docs.slice(0, compiled.fetchLimit).map((d) => d.documentId);
}

function compile(spec: Record<string, unknown>): CompiledQuery {
  return compileQueryToParameterizedSql({
    projectId: PID,
    normalizedQuery: validateAndNormalizeQuery({ collectionPath: COLLECTION, ...spec }),
  });
}

describe("fast-check executor/reference equivalence", () => {
  it("matches the independent reference across randomized documents and query shapes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(docShapeArb, { minLength: 1, maxLength: 60 }),
        whereArb,
        orderByArb,
        fc.integer({ min: 1, max: 15 }),
        fc.oneof(fc.constant(null), fc.constant(["label", "score"])),
        async (shapes, where, orderBy, limit, select) => {
          const store = new DataPlaneStore();
          shapes.forEach((shape, i) => {
            const doc = makeDoc(i, shape);
            store.documents.set(memoryKey(doc.path), doc);
          });

          const compiled = compile({
            ...(where ? { where: [where] } : {}),
            orderBy,
            limit,
            ...(select ? { select } : {}),
          });
          const result = await store.withTransaction({ projectId: PID }, (tx) =>
            tx.queryDocuments(compiled)
          );
          expect(result.map((r) => r.documentId)).toEqual(referenceIds(store, compiled));
          expect(result.length).toBeLessThanOrEqual(compiled.maxScanRows ?? Infinity);
        }
      ),
      { seed: SEED, numRuns: NUM_RUNS, timeout: 20_000 }
    );
  });

  it("unindexed scan cap throws deterministically instead of truncating", async () => {
    const bigStore = new DataPlaneStore();
    for (let i = 0; i < 1005; i++) {
      const doc = makeDoc(i, { score: i % 40, label: "alpha", active: true, tags: ["red"], level: i % 10, day: 1 + (i % 28) });
      bigStore.documents.set(memoryKey(doc.path), doc);
    }
    const compiled = compile({ limit: 500 });
    expect(compiled.maxScanRows).toBe(UNINDEXED_SCAN_CAP);
    await expect(
      bigStore.withTransaction({ projectId: PID }, (tx) =>
        tx.queryDocuments(compiled)
      )
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
  });

  it("projection keeps only requested (including nested) paths", async () => {
    const store = new DataPlaneStore();
    for (let i = 0; i < 5; i++) {
      const doc = makeDoc(i, { score: i, label: "alpha", active: true, tags: ["red"], level: i, day: 1 });
      store.documents.set(memoryKey(doc.path), doc);
    }
    const compiled = compile({ select: ["label", "profile.level"], limit: 3 });
    const rows = await store.withTransaction({ projectId: PID }, (tx) =>
      tx.queryDocuments(compiled)
    );
    expect(rows).toHaveLength(compiled.fetchLimit); // limit + 1 for next-cursor detection
    expect(Object.keys(rows[0]!.data).sort()).toEqual(["label", "profile.level"]);
  });
});

describe("fast-check end-to-end keyset pagination", () => {
  class MockControlStore {
    getActiveRuleset() {
      return null;
    }
    incrementUsage() {
      /* no-op */
    }
  }

  it("pages deterministically with no duplicates or gaps (documentId keyset)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 5 }),
        async (docCount, pageSize) => {
          const localStore = new DataPlaneStore();
          const engine = new DocumentEngine({
            controlStore: new MockControlStore(),
            dataStore: localStore,
          });
          for (let i = 0; i < docCount; i++) {
            await engine.createDocument({
              projectId: PID,
              internal: true,
              path: `${COLLECTION}/w_${String(i).padStart(3, "0")}`,
              data: { score: i, label: "alpha" },
            });
          }

          const collected: string[] = [];
          let cursor: string | null = null;
          for (let page = 0; page < docCount + 2; page++) {
            const res = await engine.executeQuery({
              projectId: PID,
              internal: true,
              querySpec: {
                collectionPath: COLLECTION,
                orderBy: [{ field: "documentId", dir: "asc" }],
                limit: pageSize,
                ...(cursor ? { startAfter: cursor } : {}),
              },
            });
            collected.push(...res.documents.map((d) => d.documentId));
            cursor = res.nextCursor;
            if (!cursor) break;
          }

          expect(collected).toEqual(
            Array.from({ length: docCount }, (_, i) => `w_${String(i).padStart(3, "0")}`)
          );
        }
      ),
      { seed: SEED, numRuns: 15, timeout: 30_000 }
    );
  });

  it("rejects a cursor whose query-shape hash does not match", () => {
    const h = computeQueryShapeHash({
      projectId: PID,
      collectionPath: COLLECTION,
      where: [],
      orderBy: [{ field: "documentId", dir: "asc" }],
    });
    const token = encodeQueryCursor({ qHash: h, vals: ["w_001"], docId: "w_001" });
    expect(() => decodeAndVerifyQueryCursor(token, "different-shape")).toThrow(VellumError);
  });
});
