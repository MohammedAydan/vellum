import { describe, expect, it } from "vitest";
import { buildIncludeQuery, referenceValue, relationState } from "../features/relations/relation-explorer.js";

describe("relation explorer", () => {
  it("builds a real include query bounded to 25 documents", () => {
    const rule = { collection: "orders", field: "customer", targetCollection: "users" };
    expect(buildIncludeQuery(rule, 5)).toEqual({ collection: "orders", limit: 5, include: ["customer"] });
    expect(buildIncludeQuery(rule, 500).limit).toBe(25);
    expect(buildIncludeQuery(rule, 0).limit).toBe(1);
    expect(buildIncludeQuery(rule, Number.NaN).limit).toBe(1);
  });

  it("reads the reference from flat or wrapped documents, including nested paths", () => {
    expect(referenceValue({ customer: "users/u1" }, "customer")).toBe("users/u1");
    expect(referenceValue({ data: { customer: "users/u1" } }, "customer")).toBe("users/u1");
    expect(referenceValue({ data: { a: { b: "x" } } }, "a.b")).toBe("x");
    expect(referenceValue({}, "customer")).toBeUndefined();
  });

  it("classifies resolved, dangling, empty and rule-hidden references", () => {
    expect(relationState({ customer: "users/u1", _included: { customer: { name: "A" } } }, "customer")).toBe("resolved");
    expect(relationState({ customer: "users/u1", _included: {} }, "customer")).toBe("dangling");
    expect(relationState({ customer: null }, "customer")).toBe("empty");
    expect(relationState({ customer: "users/u1", _redactedRefs: ["customer"] }, "customer")).toBe("hidden");
  });
});
