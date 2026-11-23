import { describe, it, expect } from "vitest";
import { parseDashboardImport, batchDashboardImport } from "../lib/import.js";

describe("dashboard import/export contract", () => {
  it("accepts the unchanged export envelope and removes read-only metadata", () => {
    const row = { id: "a", path: "tasks/a", data: { title: "Ada" }, version: 9, createdAt: "now", updatedAt: "now" };
    expect(parseDashboardImport({ documents: [row], nextCursor: null })).toEqual([{ id: "a", data: { title: "Ada" } }]);
    expect(parseDashboardImport([row])).toEqual([{ id: "a", data: { title: "Ada" } }]);
  });
  it("rejects malformed rows without silently importing the wrong data", () => {
    for (const value of [{}, [null], [{ id: 4, data: {} }], [{ data: [] }]]) expect(() => parseDashboardImport(value)).toThrow();
  });
  it("batches 54 rows and honors aggregate key-count limits", () => {
    const rows = Array.from({ length: 54 }, (_, i) => ({ id: String(i), data: { title: String(i) } }));
    expect(batchDashboardImport(rows).map((batch) => batch.length)).toEqual([20, 20, 14]);
    const large = Array.from({ length: 3 }, () => ({ data: Object.fromEntries(Array.from({ length: 220 }, (_, i) => [String(i), i])) }));
    expect(batchDashboardImport(large).map((batch) => batch.length)).toEqual([2, 1]);
  });
});
