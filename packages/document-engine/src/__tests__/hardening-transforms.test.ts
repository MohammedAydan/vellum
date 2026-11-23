/**
 * ENGINE-HARDENING §12 — atomic field transform hardening.
 */
import { describe, it, expect } from "vitest";
import { applyFieldTransforms } from "../transforms.js";

const NOW = "2026-11-19T12:00:00.000Z";
const expectCode = (code: string) => expect.objectContaining({ code });

describe("hardening/transforms — inc on tagged integers", () => {
  it("rejects a non-integer increment on a tagged int with INVALID_ARGUMENT", () => {
    const base = { counter: { $t: "int", $v: "100" } };
    expect(() => applyFieldTransforms(base, { counter: { $op: "inc", by: 1.5 } }, NOW))
      .toThrowError(expectCode("INVALID_ARGUMENT"));
    expect(() => applyFieldTransforms(base, { counter: { $op: "increment", by: -0.25 } }, NOW))
      .toThrowError(expectCode("INVALID_ARGUMENT"));
  });

  it("accepts integer increments, including negative values", () => {
    const base = { counter: { $t: "int", $v: "100" } };
    const plus = applyFieldTransforms(base, { counter: { $op: "inc", by: 25 } }, NOW);
    expect(plus["counter"]).toEqual({ $t: "int", $v: "125" });
    const minus = applyFieldTransforms(base, { counter: { $op: "inc", by: -30 } }, NOW);
    expect(minus["counter"]).toEqual({ $t: "int", $v: "70" });
  });

  it("reports a malformed tagged $v as FAILED_PRECONDITION", () => {
    for (const bad of ["not-a-number", "", null, {}]) {
      const base = { counter: { $t: "int", $v: bad } };
      expect(() => applyFieldTransforms(base, { counter: { $op: "inc", by: 1 } }, NOW))
        .toThrowError(expectCode("FAILED_PRECONDITION"));
    }
  });

  it("treats null and undefined as zero before incrementing", () => {
    expect(applyFieldTransforms({ counter: null }, { counter: { $op: "inc", by: 5 } }, NOW)["counter"]).toBe(5);
    expect(applyFieldTransforms({}, { counter: { $op: "inc", by: 7 } }, NOW)["counter"]).toBe(7);
  });

  it("still rejects inc on non-numeric, non-tagged fields", () => {
    expect(() => applyFieldTransforms({ title: "x" }, { title: { $op: "inc", by: 1 } }, NOW))
      .toThrowError(expectCode("FAILED_PRECONDITION"));
  });
});

describe("hardening/transforms — bounded array transforms", () => {
  it("rejects arrayUnion with more than 10,000 elements", () => {
    const elements = Array.from({ length: 10_001 }, (_, i) => i);
    expect(() =>
      applyFieldTransforms({}, { tags: { $op: "arrayUnion", elements } }, NOW)
    ).toThrowError(expectCode("INVALID_ARGUMENT"));
  });

  it("rejects arrayRemove with more than 10,000 elements", () => {
    const elements = Array.from({ length: 10_001 }, (_, i) => `v${i}`);
    expect(() =>
      applyFieldTransforms({}, { tags: { $op: "arrayRemove", elements } }, NOW)
    ).toThrowError(expectCode("INVALID_ARGUMENT"));
  });

  it("allows arrays below the cap and deduplicates wire-equal values", () => {
    // The 10,001-element rejection above exercises the cap; keep the accepted
    // case small so the O(n²) dedup does not dominate suite runtime.
    const elements = Array.from({ length: 100 }, (_, i) => i);
    const result = applyFieldTransforms({}, { tags: { $op: "arrayUnion", elements } }, NOW);
    expect((result["tags"] as unknown[]).length).toBe(100);
    const dupes = applyFieldTransforms({}, { tags: { $op: "arrayUnion", elements: [1, 1, 2] } }, NOW);
    expect(dupes["tags"]).toEqual([1, 2]);
  });
});
