import { afterEach, describe, expect, it } from "vitest";
import { DocumentEngine } from "../engine.js";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { compileQueryToParameterizedSql, selectFullTextIndexForQuery, suggestCompositeIndex, validateAndNormalizeQuery } from "@vellum/query-engine";

const TENANT = { projectId: "22222222-2222-2222-2222-222222222222", internal: true as const };
class Control { getActiveRuleset() { return null; } incrementUsage() {} }

describe("full-text index (dir: text)", () => {
  const previous = process.env["VELLUM_UNINDEXED_QUERY_MAX_DOCS"];
  afterEach(() => {
    if (previous === undefined) delete process.env["VELLUM_UNINDEXED_QUERY_MAX_DOCS"];
    else process.env["VELLUM_UNINDEXED_QUERY_MAX_DOCS"] = previous;
  });

  it("suggests a full-text index (not a composite one) for text_search", () => {
    const q = validateAndNormalizeQuery({ collectionPath: "chats/a/messages", where: [{ field: "text", op: "text_search", value: "launch" }], limit: 5 });
    expect(suggestCompositeIndex(q)).toEqual([{ path: "text", dir: "text" }]);
  });

  it("compiles text_search to a GIN lookup on the index entries when a ready full-text index covers it", () => {
    const q = validateAndNormalizeQuery({ collectionPath: "chats/a/messages", where: [{ field: "text", op: "text_search", value: "launch" }], limit: 5 });
    const idx = { id: "33333333-3333-3333-3333-333333333333", collectionPath: "chats/*/messages", fields: [{ path: "text", dir: "text" as const }], status: "ready" as const };
    expect(selectFullTextIndexForQuery(q, [idx])?.id).toBe(idx.id);
    expect(selectFullTextIndexForQuery(q, [{ ...idx, status: "failed" as const }])).toBeNull();
    expect(selectFullTextIndexForQuery(q, [{ ...idx, collectionPath: "other/*/messages" }])).toBeNull();
    const plan = compileQueryToParameterizedSql({ projectId: TENANT.projectId, normalizedQuery: q, fullTextIndex: idx });
    expect(plan.sql).toContain("document_index_entries fe");
    expect(plan.sql).toContain("fe.tsv @@ plainto_tsquery('simple'");
    expect(plan.sql).not.toContain("to_tsvector('simple', coalesce(d.data");
    expect(plan.indexUsed).toBe(`fulltext:${idx.id}`);
    expect(plan.maxScanRows).toBeNull();
    const scan = compileQueryToParameterizedSql({ projectId: TENANT.projectId, normalizedQuery: q });
    expect(scan.sql).toContain("to_tsvector('simple', coalesce(d.data");
  });

  it("refuses text_search above the cap, accepts a full-text index definition, and rejects mixed fields", async () => {
    process.env["VELLUM_UNINDEXED_QUERY_MAX_DOCS"] = "5";
    const store = new DataPlaneStore();
    const engine = new DocumentEngine({ controlStore: new Control() as never, dataStore: store });
    for (let i = 0; i < 8; i++) await engine.createDocument({ ...TENANT, path: `chats/c1/messages/m${i}`, data: { text: i % 4 === 0 ? "launch day" : "hello" } });
    const q = { ...TENANT, querySpec: { collectionPath: "chats/c1/messages", where: [{ field: "text", op: "text_search", value: "launch" }], limit: 10 } as never };
    await expect(engine.executeQuery(q)).rejects.toMatchObject({
      code: "FAILED_PRECONDITION",
      details: { suggestedIndex: { collectionPath: "chats/*/messages", fields: [{ path: "text", dir: "text" }] } },
    });
    await store.createCompositeIndex(TENANT, "chats/*/messages", [{ path: "text", dir: "text" }]);
    await store.runIndexBuilderWorker();
    const res = await engine.executeQuery(q);
    expect(res.documents.map((d) => d.data["text"])).toEqual(["launch day", "launch day"]);
    await expect(store.createCompositeIndex(TENANT, "chats/*/messages", [{ path: "text", dir: "text" }, { path: "seq", dir: "asc" }])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
