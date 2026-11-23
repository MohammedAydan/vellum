import { describe, it, expect } from "vitest";
import { validateAndNormalizeQuery, compileQueryToParameterizedSql, createQueryEvaluator, computeQueryShapeHash } from "../index.js";

describe("dataset substring search", () => {
  it("binds escaped literal patterns before LIMIT", () => {
    const normalizedQuery = validateAndNormalizeQuery({ collection: "tasks", search: "50%_\\", limit: 2 });
    const compiled = compileQueryToParameterizedSql({ projectId: "00000000-0000-0000-0000-000000000001", normalizedQuery });
    expect(compiled.sql).toContain("d.document_id ILIKE");
    expect(compiled.sql).toContain("d.data::text ILIKE");
    expect(compiled.params).toContain("%50\\%\\_\\\\%");
    expect(compiled.sql.indexOf("ILIKE")).toBeLessThan(compiled.sql.indexOf("LIMIT"));
  });
  it("matches ID and data case-insensitively in the memory adapter", () => {
    const evaluator = createQueryEvaluator(validateAndNormalizeQuery({ collection: "tasks", search: "needle" }));
    const base = { collectionPath: "tasks", documentId: "a", data: { title: "NEEDLE" }, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    expect(evaluator(base)).toBe(true);
    expect(evaluator({ ...base, data: {}, documentId: "needle-2" })).toBe(true);
    expect(evaluator({ ...base, data: {} })).toBe(false);
    expect(evaluator({ ...base, collectionPath: "other" })).toBe(false);
  });
  it("binds cursors to their search value and validates search bounds", () => {
    const shape = { projectId: "p", collectionPath: "tasks", where: [], orderBy: [] };
    expect(computeQueryShapeHash({ ...shape, search: "a" })).not.toBe(computeQueryShapeHash({ ...shape, search: "b" }));
    expect(() => validateAndNormalizeQuery({ collection: "tasks", search: "x".repeat(201) })).toThrow();
  });
});
