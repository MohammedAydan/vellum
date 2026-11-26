import { afterEach, describe, expect, it } from "vitest";
import { DocumentEngine } from "../engine.js";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { isScanRiskQuery, resolveUnindexedQueryMaxDocs, suggestCompositeIndex, validateAndNormalizeQuery } from "@vellum/query-engine";

const TENANT = { projectId: "11111111-1111-1111-1111-111111111111", internal: true as const };
class Control { getActiveRuleset() { return null; } incrementUsage() {} }
const norm = (q: Record<string, unknown>) => validateAndNormalizeQuery(q);

describe("unindexed query guard", () => {
  const previous = process.env["VELLUM_UNINDEXED_QUERY_MAX_DOCS"];
  afterEach(() => {
    if (previous === undefined) delete process.env["VELLUM_UNINDEXED_QUERY_MAX_DOCS"];
    else process.env["VELLUM_UNINDEXED_QUERY_MAX_DOCS"] = previous;
  });

  it("classifies shapes", () => {
    expect(isScanRiskQuery(norm({ collectionPath: "c", limit: 5 }))).toBe(false);
    expect(isScanRiskQuery(norm({ collectionPath: "c", where: [{ field: "a", op: "==", value: 1 }], limit: 5 }))).toBe(false);
    expect(isScanRiskQuery(norm({ collectionPath: "c", where: [{ field: "a", op: "in", value: [1, 2] }], limit: 5 }))).toBe(false);
    expect(isScanRiskQuery(norm({ collectionPath: "c", orderBy: [{ field: "updatedAt", dir: "desc" }], limit: 5 }))).toBe(false);
    expect(isScanRiskQuery(norm({ collectionPath: "c", where: [{ field: "a", op: ">", value: 1 }], limit: 5 }))).toBe(true);
    expect(isScanRiskQuery(norm({ collectionPath: "c", orderBy: [{ field: "a", dir: "asc" }], limit: 5 }))).toBe(true);
    expect(isScanRiskQuery(norm({ collectionPath: "c", search: "x", limit: 5 }))).toBe(true);
  });

  it("suggests equality fields first, then order or range", () => {
    const q = norm({ collectionPath: "c", where: [{ field: "city", op: "==", value: "x" }, { field: "age", op: ">", value: 1 }], orderBy: [{ field: "score", dir: "desc" }], limit: 5 });
    expect(suggestCompositeIndex(q)).toEqual([{ path: "city", dir: "asc" }, { path: "score", dir: "desc" }, { path: "age", dir: "asc" }]);
  });

  it("reads the env override; 0 disables, junk falls back to the default", () => {
    expect(resolveUnindexedQueryMaxDocs({})).toBe(50_000);
    expect(resolveUnindexedQueryMaxDocs({ VELLUM_UNINDEXED_QUERY_MAX_DOCS: "123" })).toBe(123);
    expect(resolveUnindexedQueryMaxDocs({ VELLUM_UNINDEXED_QUERY_MAX_DOCS: "0" })).toBe(0);
    expect(resolveUnindexedQueryMaxDocs({ VELLUM_UNINDEXED_QUERY_MAX_DOCS: "abc" })).toBe(50_000);
  });

  it("rejects a risky query on a big collection and allows it below the limit or when disabled", async () => {
    process.env["VELLUM_UNINDEXED_QUERY_MAX_DOCS"] = "5";
    const engine = new DocumentEngine({ controlStore: new Control() as never, dataStore: new DataPlaneStore() });
    for (let i = 0; i < 8; i++) await engine.createDocument({ ...TENANT, path: `big/b${i}`, data: { n: i } });
    for (let i = 0; i < 3; i++) await engine.createDocument({ ...TENANT, path: `tiny/t${i}`, data: { n: i } });
    const range = (c: string) => ({ ...TENANT, querySpec: { collectionPath: c, where: [{ field: "n", op: ">", value: 0 }], limit: 10 } as never });
    await expect(engine.executeQuery(range("big"))).rejects.toMatchObject({ code: "FAILED_PRECONDITION", details: { suggestedIndex: { fields: [{ path: "n", dir: "asc" }] } } });
    expect((await engine.executeQuery(range("tiny"))).documents).toHaveLength(2);
    process.env["VELLUM_UNINDEXED_QUERY_MAX_DOCS"] = "0";
    expect((await engine.executeQuery(range("big"))).documents).toHaveLength(7);
  });
});
