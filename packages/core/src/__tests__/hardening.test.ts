import { describe, it, expect } from "vitest";
import {
  BoundedLruCache,
  VellumError,
  getFieldByPath,
  normalizeAndValidateDocumentData,
  parseCollectionPath,
  parseDocumentPath,
  validateFieldName,
  validateWireValue,
  wireValuesEqual,
} from "../index.js";

describe("@vellum/core - Security & Reliability Hardening", () => {
  it("blocks prototype pollution keys in validateFieldName and document normalization", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(() => validateFieldName(key)).toThrow(VellumError);
    }

    const polluted = JSON.parse('{"__proto__":{"isAdmin":true},"safe":"ok"}');
    expect(() => normalizeAndValidateDocumentData(polluted)).toThrow(VellumError);
    expect(({} as Record<string, unknown>)["isAdmin"]).toBeUndefined();

    const nestedConstructor = { nested: { constructor: { prototype: { pwned: true } } } };
    expect(() => normalizeAndValidateDocumentData(nestedConstructor)).toThrow(VellumError);
  });

  it("blocks prototype-chain traversal in getFieldByPath", () => {
    const doc = { profile: { name: "Alice" } };
    expect(getFieldByPath(doc, "__proto__")).toBeUndefined();
    expect(getFieldByPath(doc, "constructor")).toBeUndefined();
    expect(getFieldByPath(doc, "constructor.constructor")).toBeUndefined();
    expect(getFieldByPath(doc, "profile.toString")).toBeUndefined();
    expect(getFieldByPath(doc, "profile.hasOwnProperty")).toBeUndefined();
    expect(getFieldByPath(doc, "profile.name")).toBe("Alice");
  });

  it("rejects circular references, oversized arrays, and pathological int64/timestamp inputs", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular["self"] = circular;
    expect(() => validateWireValue(circular)).toThrow(VellumError);

    const hugeArr = new Array<number>(10_001).fill(1);
    expect(() => validateWireValue(hugeArr)).toThrow(VellumError);

    // Huge digit string should be rejected before BigInt parsing DoS
    expect(() => validateWireValue({ $t: "int", $v: "9".repeat(50_000) })).toThrow(VellumError);

    // Out-of-range $ms that would throw RangeError in Date.toISOString()
    expect(() => validateWireValue({ $t: "ts", $v: "2026-11-15T00:00:00Z", $ms: 9e15 })).toThrow(VellumError);
    expect(() => validateWireValue({ $t: "ts", $v: "2026-11-15T00:00:00Z", $ms: Infinity })).toThrow(VellumError);
  });

  it("rejects encoded traversal, DEL chars, and overlong paths while caching safely", () => {
    expect(() => parseDocumentPath("users/%5csecret")).toThrow(VellumError);
    expect(() => parseDocumentPath("users/%00null")).toThrow(VellumError);
    expect(() => parseDocumentPath("users/bad\x7fchar")).toThrow(VellumError);
    expect(() => parseDocumentPath("a/".repeat(20_000) + "b")).toThrow(VellumError);

    // Cached path results must not share mutable segment arrays
    const first = parseDocumentPath("users/u_1");
    first.segments.push("mutated");
    const second = parseDocumentPath("users/u_1");
    expect(second.segments).toEqual(["users", "u_1"]);

    const c1 = parseCollectionPath("users/u_1/orders");
    c1.segments.push("mutated");
    const c2 = parseCollectionPath("users/u_1/orders");
    expect(c2.segments).toEqual(["users", "u_1", "orders"]);
  });

  it("guards wireValuesEqual against deep recursion and prototype keys", () => {
    expect(wireValuesEqual({ a: 1 }, { a: 1 })).toBe(true);
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    let curA = a;
    let curB = b;
    for (let i = 0; i < 40; i++) {
      curA["n"] = {};
      curB["n"] = {};
      curA = curA["n"] as Record<string, unknown>;
      curB = curB["n"] as Record<string, unknown>;
    }
    expect(wireValuesEqual(a, b)).toBe(false);
  });

  it("handles NaN/Infinity options safely in BoundedLruCache", () => {
    const cache = new BoundedLruCache<string, number>({
      maxEntries: Number.NaN,
      ttlMs: Number.POSITIVE_INFINITY,
      now: () => 1_000,
    });
    try {
      cache.set("a", 1);
      cache.set("b", 2);
      expect(cache.size()).toBe(1);
    } finally {
      cache.dispose();
    }
  });
});
