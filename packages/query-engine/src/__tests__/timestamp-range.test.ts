import { describe, expect, it } from "vitest";
import { compileWhereClause, documentMatchesWhereClause } from "../index.js";

const tagged = { $t: "ts", $v: "2026-01-02T00:00:00.000Z", $ms: Date.parse("2026-01-02T00:00:00.000Z") };
const doc = { documentId: "a", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", data: { stamp: tagged, name: "x" } } as never;

describe("range filters on server timestamps", () => {
  it("a tagged timestamp bound compiles with only referenced parameters", () => {
    const params: unknown[] = [];
    const sql = compileWhereClause({ field: "stamp", op: ">=", value: tagged } as never, params);
    const used = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    expect(used.size).toBe(params.length);
  });

  it("an ISO string bound also compiles against tagged timestamps with only referenced parameters", () => {
    const params: unknown[] = [];
    const sql = compileWhereClause({ field: "stamp", op: ">", value: "2026-01-01T12:00:00.000Z" } as never, params);
    const used = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    expect(used.size).toBe(params.length);
    expect(sql).toContain("'ts'");
  });

  it("a plain string bound stays a string comparison", () => {
    const params: unknown[] = [];
    const sql = compileWhereClause({ field: "name", op: ">", value: "a" } as never, params);
    expect(sql).not.toContain("'ts'");
  });

  it("matches in memory for ISO string, tagged and Date-serialized bounds", () => {
    expect(documentMatchesWhereClause(doc, { field: "stamp", op: ">", value: "2026-01-01T12:00:00.000Z" } as never)).toBe(true);
    expect(documentMatchesWhereClause(doc, { field: "stamp", op: "<", value: "2026-01-01T12:00:00.000Z" } as never)).toBe(false);
    expect(documentMatchesWhereClause(doc, { field: "stamp", op: ">=", value: tagged } as never)).toBe(true);
  });
});
