import { describe, it, expect } from "vitest";
import {
  SYSTEM_LIMITS,
  VellumError,
  parseDocumentPath,
  parseCollectionPath,
  validatePathSegment,
  validateFieldName,
  validateWireValue,
  normalizeAndValidateDocumentData,
  WireValue,
  encodeSortableFloat64,
  encodeSortableInt64,
  encodeSingleSortKeyValue,
  encodeCompositeSortKey,
  compareWireValues,
  wireValuesEqual,
  getFieldByPath,
} from "../index.js";

describe("@vellum/core - Paths", () => {
  it("validates nested paths and decomposes segments properly", () => {
    const parsed = parseDocumentPath("users/u_123/orders/ord_456");
    expect(parsed.collectionPath).toBe("users/u_123/orders");
    expect(parsed.collectionGroup).toBe("orders");
    expect(parsed.documentId).toBe("ord_456");
    expect(parsed.pathDepth).toBe(4);
    expect(parsed.segments).toEqual(["users", "u_123", "orders", "ord_456"]);

    const col = parseCollectionPath("users/u_123/orders");
    expect(col.collectionGroup).toBe("orders");
    expect(col.depth).toBe(3);
    expect(col.segments).toEqual(["users", "u_123", "orders"]);
  });

  it("rejects odd segment counts for document paths", () => {
    expect(() => parseDocumentPath("users/u_123/orders")).toThrow(VellumError);
    expect(() => parseDocumentPath("users")).toThrow(VellumError);
  });

  it("rejects depth > 10", () => {
    expect(() => parseDocumentPath("c1/d1/c2/d2/c3/d3/c4/d4/c5/d5/c6/d6")).toThrow(VellumError);
  });

  it("rejects reserved system segments and invalid characters", () => {
    expect(() => parseDocumentPath("users/__reserved__")).toThrow(VellumError);
    expect(() => parseDocumentPath("users/.")).toThrow(VellumError);
    expect(() => parseDocumentPath("users/..")).toThrow(VellumError);
    expect(() => parseDocumentPath("")).toThrow(VellumError);
    expect(() => parseDocumentPath("/users/u_1")).toThrow(VellumError);
    expect(() => parseDocumentPath("users/u_1/")).toThrow(VellumError);
    expect(() => parseDocumentPath("users/\x00evil")).toThrow(VellumError);
    expect(() => parseCollectionPath("")).toThrow(VellumError);
    expect(() => parseCollectionPath("/users")).toThrow(VellumError);
    expect(() => parseCollectionPath("users/u_1/orders/")).toThrow(VellumError);
    expect(() => parseCollectionPath("users/\x1fevil/orders")).toThrow(VellumError);
    expect(() => validatePathSegment("", "empty")).toThrow(VellumError);
    expect(() => validatePathSegment("normal", "users/normal")).not.toThrow();
  });

  it("rejects segments exceeding max byte length", () => {
    const longSegment = "a".repeat(1501);
    expect(() => validatePathSegment(longSegment, `users/${longSegment}`)).toThrow(VellumError);
  });
});

describe("@vellum/core - Wire Format", () => {
  it("validates all rich types and normalizes timestamps", () => {
    const doc = {
      name: "Mohammed Aydan",
      active: true,
      score: 98.5,
      bigCounter: WireValue.int64("-9007199254740993"),
      createdAt: WireValue.timestamp("2026-11-15T14:30:00.123Z"),
      orgRef: WireValue.reference("orgs/org_1"),
      payload: WireValue.bytes(Buffer.from("Hello VELLUM")),
      location: WireValue.geopoint(31.0409, 31.3785),
      escapedUserObj: WireValue.escapeMap({ $t: "custom_user_literal_tag" }),
    };

    const { data, sizeBytes } = normalizeAndValidateDocumentData(doc);
    expect(sizeBytes).toBeGreaterThan(0);
    expect(sizeBytes).toBeLessThan(SYSTEM_LIMITS.MAX_DOCUMENT_BYTES);
    expect((data["createdAt"] as { $ms: number }).$ms).toBe(Date.parse("2026-11-15T14:30:00.123Z"));
    expect((data["escapedUserObj"] as { $t: string; $v: { $t: string } }).$t).toBe("map");
    expect((data["escapedUserObj"] as { $t: string; $v: { $t: string } }).$v.$t).toBe("custom_user_literal_tag");
  });

  it("enforces max nesting depth of 20 levels", () => {
    let deep: Record<string, unknown> = { leaf: "ok" };
    for (let i = 0; i < 22; i++) {
      deep = { nested: deep };
    }
    expect(() => normalizeAndValidateDocumentData(deep)).toThrow(VellumError);
  });

  it("rejects non-finite numbers and invalid field names", () => {
    expect(() => validateWireValue(NaN)).toThrow(VellumError);
    expect(() => validateWireValue(Infinity)).toThrow(VellumError);
    expect(() => validateFieldName("")).toThrow(VellumError);
    expect(() => validateFieldName("a".repeat(257))).toThrow(VellumError);
  });

  it("validates atomic field transforms when allowed", () => {
    expect(() => validateWireValue({ $op: "serverTimestamp" }, 1, true)).not.toThrow();
    expect(() => validateWireValue({ $op: "inc", by: 10 }, 1, true)).not.toThrow();
    expect(() => validateWireValue({ $op: "deleteField" }, 1, true)).not.toThrow();
    expect(() => validateWireValue({ $op: "arrayUnion", elements: [1, 2] }, 1, true)).not.toThrow();
    expect(() => validateWireValue({ $op: "arrayRemove", elements: [2] }, 1, true)).not.toThrow();
    // Denied when allowFieldOps = false
    expect(() => validateWireValue({ $op: "serverTimestamp" }, 1, false)).toThrow(VellumError);
    expect(() => validateWireValue({ $op: "unknown" }, 1, true)).toThrow(VellumError);
  });

  it("validates wire format error cases", () => {
    expect(() => validateWireValue({ $t: "int", $v: "not_a_number" })).toThrow(VellumError);
    expect(() => validateWireValue({ $t: "int", $v: "999999999999999999999999999999" })).toThrow(VellumError);
    expect(() => validateWireValue({ $t: "int", $v: "-999999999999999999999999999999" })).toThrow(VellumError);
    expect(() => validateWireValue({ $t: "ts", $v: "invalid_date" })).toThrow(VellumError);
    expect(() => validateWireValue({ $t: "ts", $v: "2026-11-15T00:00:00Z", $ms: "not_number" })).toThrow(VellumError);
    expect(() => validateWireValue({ $t: "ref", $v: 123 })).toThrow(VellumError);
    expect(() => validateWireValue({ $t: "bytes", $v: 123 })).toThrow(VellumError);
    expect(() => validateWireValue({ $t: "bytes", $v: "!!!not_base64!!!" })).toThrow(VellumError);
    expect(() => validateWireValue({ $t: "geo", $v: "not_geo" })).toThrow(VellumError);
    expect(() => validateWireValue({ $t: "geo", $v: { lat: 200, lng: 50 } })).toThrow(VellumError);
    expect(() => validateWireValue({ $t: "geo", $v: { lat: 10, lng: 250 } })).toThrow(VellumError);
    expect(() => validateWireValue({ $t: "map", $v: "not_obj" })).toThrow(VellumError);
    expect(() => validateWireValue({ $t: "unknown_tag", $v: 1 })).toThrow(VellumError);
    expect(() => validateWireValue(Symbol("bad"))).toThrow(VellumError);
    expect(() => normalizeAndValidateDocumentData(null)).toThrow(VellumError);
    expect(() => normalizeAndValidateDocumentData([1, 2])).toThrow(VellumError);
    expect(() => normalizeAndValidateDocumentData({ $t: "map" })).toThrow(VellumError);
  });
});

describe("@vellum/core - Binary Sort Keys", () => {
  it("preserves exact lexicographical order across floats (ASC and DESC)", () => {
    const numbers = [-1000.5, -10, -0.001, 0, 0.001, 42, 999999.99];
    const encodedAsc = numbers.map((n) => encodeSingleSortKeyValue(n, "asc"));
    for (let i = 0; i < encodedAsc.length - 1; i++) {
      expect(Buffer.compare(encodedAsc[i]!, encodedAsc[i + 1]!)).toBeLessThan(0);
    }

    const encodedDesc = numbers.map((n) => encodeSingleSortKeyValue(n, "desc"));
    for (let i = 0; i < encodedDesc.length - 1; i++) {
      expect(Buffer.compare(encodedDesc[i]!, encodedDesc[i + 1]!)).toBeGreaterThan(0);
    }
  });

  it("encodes composite sort keys with mixed directions", () => {
    const fields = [
      { path: "status", dir: "asc" as const },
      { path: "priority", dir: "desc" as const },
    ];
    const keyHighPrio = encodeCompositeSortKey(
      {
        documentId: "d1",
        createdAt: "2026-11-15T00:00:00Z",
        updatedAt: "2026-11-15T00:00:00Z",
        data: { status: "open", priority: 10 },
      },
      fields
    );
    const keyLowPrio = encodeCompositeSortKey(
      {
        documentId: "d2",
        createdAt: "2026-11-15T00:00:00Z",
        updatedAt: "2026-11-15T00:00:00Z",
        data: { status: "open", priority: 1 },
      },
      fields
    );
    expect(Buffer.compare(keyHighPrio, keyLowPrio)).toBeLessThan(0);
  });

  it("compares wire values and checks deep equality", () => {
    expect(compareWireValues(10, 20)).toBeLessThan(0);
    expect(compareWireValues("apple", "banana")).toBeLessThan(0);
    expect(wireValuesEqual(10, WireValue.int64(10))).toBe(true);
    expect(wireValuesEqual(WireValue.int64(10), 10)).toBe(true);
    expect(wireValuesEqual(WireValue.timestamp("2026-11-15T00:00:00Z"), WireValue.timestamp("2026-11-15T00:00:00Z"))).toBe(true);
    expect(wireValuesEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(wireValuesEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("extracts nested fields by dot path", () => {
    const data = {
      user: {
        profile: {
          age: 30,
        },
      },
      escaped: {
        $t: "map",
        $v: {
          title: "lead",
        },
      },
    };
    expect(getFieldByPath(data, "user.profile.age")).toBe(30);
    expect(getFieldByPath(data, "escaped.title")).toBe("lead");
    expect(getFieldByPath(data, "user.profile.missing")).toBeUndefined();
    expect(getFieldByPath(null, "user")).toBeUndefined();
    expect(getFieldByPath({ arr: [1, 2] }, "arr.0")).toBeUndefined();
  });

  it("encodes tagged values into sort keys (int, ts, ref, bytes, geo, missing, null, boolean)", () => {
    const intKey = encodeSingleSortKeyValue(WireValue.int64("123456789"));
    expect(intKey[0]).toBe(0x20);

    const tsKey = encodeSingleSortKeyValue(WireValue.timestamp("2026-11-15T00:00:00Z"));
    expect(tsKey[0]).toBe(0x40);

    const refKey = encodeSingleSortKeyValue(WireValue.reference("users/u_1"));
    expect(refKey[0]).toBe(0x50);

    const bytesKey = encodeSingleSortKeyValue(WireValue.bytes("SGVsbG8="));
    expect(bytesKey[0]).toBe(0x60);

    const geoKey = encodeSingleSortKeyValue(WireValue.geopoint(30.0, 31.0));
    expect(geoKey[0]).toBe(0x70);

    const missingKey = encodeSingleSortKeyValue(undefined);
    expect(missingKey[0]).toBe(0x05);

    const nullKey = encodeSingleSortKeyValue(null);
    expect(nullKey[0]).toBe(0x0a);

    const boolKey = encodeSingleSortKeyValue(true);
    expect(boolKey[0]).toBe(0x10);

    const fallbackKey = encodeSingleSortKeyValue(() => {});
    expect(fallbackKey[0]).toBe(0x05);
  });

  it("handles wire values equality for geopoints, timestamps, and numbers", () => {
    const geo1 = WireValue.geopoint(10.0, 20.0);
    const geo2 = WireValue.geopoint(10.0, 20.0);
    const geo3 = WireValue.geopoint(10.0, 20.1);
    expect(wireValuesEqual(geo1, geo2)).toBe(true);
    expect(wireValuesEqual(geo1, geo3)).toBe(false);

    expect(wireValuesEqual(WireValue.bytes("AQID"), WireValue.bytes("AQID"))).toBe(true);
    expect(wireValuesEqual(WireValue.bytes("AQID"), WireValue.bytes("BAUG"))).toBe(false);
    expect(wireValuesEqual(null, undefined)).toBe(false);
    expect(wireValuesEqual(10, "10")).toBe(false);
    expect(wireValuesEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("tests sortable int64 and float64 helpers directly", () => {
    const f1 = encodeSortableFloat64(-0);
    const f2 = encodeSortableFloat64(0);
    expect(Buffer.compare(f1, f2)).toBe(0);

    const i1 = encodeSortableInt64(-100n);
    const i2 = encodeSortableInt64(100n);
    expect(Buffer.compare(i1, i2)).toBeLessThan(0);
  });
});

describe("@vellum/core - Errors & Envelope", () => {
  it("formats error envelopes per §11.2", () => {
    const err = new VellumError("PERMISSION_DENIED", "Denied access", { path: "users/u_1" });
    expect(err.status).toBe(403);
    const envelope = err.toEnvelope("req_123");
    expect(envelope).toEqual({
      error: {
        code: "PERMISSION_DENIED",
        message: "Denied access",
        requestId: "req_123",
        details: { path: "users/u_1" },
      },
    });
  });
});
