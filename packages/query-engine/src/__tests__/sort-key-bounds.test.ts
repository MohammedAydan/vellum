import { describe, expect, it } from "vitest";
import { encodeCompositeSortKey } from "@vellum/core";
import { compositeSortKeyBounds, validateAndNormalizeQuery } from "../compiler.js";

type Dir = "asc" | "desc";
const mk = (fields: Array<{ path: string; dir: Dir }>) => ({ id: "i", collectionPath: "c/*/d", fields, status: "ready" as const });
const docs: Array<Record<string, unknown>> = [];
for (const a of ["a", "ab", "b", "", "zz"]) for (const n of [-5, 0, 1, 2.5, 10, 100]) docs.push({ a, n });
for (const n of [1, 10]) docs.push({ a: "a", n: String(n) }); // other type on the range field
docs.push({ a: "a" }, { n: 3 }, { a: null, n: 1 }, { a: true, n: 2 });

const ops: Array<[string, (x: number, v: number) => boolean]> = [
  [">=", (x, v) => x >= v], [">", (x, v) => x > v], ["<=", (x, v) => x <= v], ["<", (x, v) => x < v],
];

describe("compositeSortKeyBounds is a superset bound of every matching entry", () => {
  for (const dirN of ["asc", "desc"] as Dir[]) {
    for (const dirA of ["asc", "desc"] as Dir[]) {
      it(`a ${dirA}, n ${dirN}: equality prefix and range clauses`, () => {
        const fields = [{ path: "a", dir: dirA }, { path: "n", dir: dirN }];
        const idx = mk(fields);
        for (const eqA of ["a", "ab", "zz", "nope"]) {
          for (const [op, fn] of ops) {
            for (const v of [-5, 0, 2.5, 10, 100, 1000]) {
              const q = validateAndNormalizeQuery({
                collectionPath: "c/x/d",
                where: [{ field: "a", op: "==", value: eqA }, { field: "n", op, value: v }],
                limit: 10,
              });
              const { lower, upper } = compositeSortKeyBounds(q, idx as never);
              for (const d of docs) {
                const matches = d["a"] === eqA && typeof d["n"] === "number" && fn(d["n"] as number, v);
                if (!matches) continue;
                const key = encodeCompositeSortKey({ documentId: "x", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", data: d }, fields as never);
                if (lower) expect(Buffer.compare(key, lower), `${eqA} ${op} ${v} lower`).toBeGreaterThanOrEqual(0);
                if (upper) expect(Buffer.compare(key, upper), `${eqA} ${op} ${v} upper`).toBeLessThan(0);
              }
            }
          }
        }
      });
    }
  }

  it("narrows: a range on the leading column excludes entries outside the interval", () => {
    const fields = [{ path: "n", dir: "asc" as const }];
    const q = validateAndNormalizeQuery({ collectionPath: "c/x/d", where: [{ field: "n", op: ">=", value: 10 }], limit: 5 });
    const { lower, upper } = compositeSortKeyBounds(q, mk(fields) as never);
    const key = (n: unknown) => encodeCompositeSortKey({ documentId: "x", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", data: { n } }, fields);
    expect(Buffer.compare(key(2), lower!)).toBeLessThan(0);
    expect(Buffer.compare(key(10), lower!)).toBeGreaterThanOrEqual(0);
    expect(Buffer.compare(key("text"), upper!)).toBeGreaterThanOrEqual(0);
  });
});
