/**
 * Property/fuzz tests for the canonical Tagged Wire Format.
 *
 * Deterministic seeds (`SEED`) make every failure reproducible. The properties:
 *
 *   P1  Accepted documents survive a JSON wire round-trip unchanged and are
 *       idempotent under re-normalization (timestamp `$ms` canonicalization).
 *   P2  The reported `sizeBytes` is always the real UTF-8 JSON byte length.
 *   P3  Arbitrary JSON / hostile input never escapes as an uncaught
 *       TypeError/RangeError: any rejection is a `VellumError`.
 *   P4  Tagged int64 constructors accept exactly the signed 64-bit range.
 *
 * Explicit boundary cases cover limits, malformed tags, non-finite numbers,
 * Base64, geopoints and the 1 MiB document ceiling.
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  VellumError,
  SYSTEM_LIMITS,
  WireValue,
  normalizeAndValidateDocumentData,
  validateWireValue,
} from "@vellum/core";

const SEED = 20261116;
const NUM_RUNS = 120;

const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,12}$/;
const fieldNameArb = fc.stringMatching(SAFE_FIELD);
const safeSegmentArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,24}$/);

const int64Arb = fc.bigInt({
  min: -(1n << 63n),
  max: (1n << 63n) - 1n,
});

const timestampMsArb = fc.integer({ min: -4_000_000_000_000, max: 4_000_000_000_000 });

const taggedValueArb: fc.Arbitrary<unknown> = fc.oneof(
  int64Arb.map((value) => WireValue.int64(value)),
  timestampMsArb.map((ms) => WireValue.timestamp(ms)),
  safeSegmentArb.chain((collection) =>
    fc.integer({ min: 0, max: 9999 }).map((id) => WireValue.reference(`${collection}/doc_${id}`))
  ),
  fc.uint8Array({ maxLength: 24 }).map((bytes) => WireValue.bytes(bytes)),
  fc
    .tuple(
      fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true })
    )
    .map(([lat, lng]) => WireValue.geopoint(lat, lng))
);

const scalarArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc
    .double({ min: -1e9, max: 1e9, noNaN: true, noDefaultInfinity: true })
    .filter((value) => !Object.is(value, -0)),
  fc.string({ maxLength: 40 })
);

const leafOrTaggedArb: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 3, arbitrary: scalarArb },
  { weight: 2, arbitrary: taggedValueArb }
);

const valueArb: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown; array: unknown[]; object: Record<string, unknown> }>(
  (tie) => ({
    value: fc.oneof(
      { maxDepth: 4 },
      { weight: 4, arbitrary: leafOrTaggedArb },
      { weight: 1, arbitrary: tie("array") },
      { weight: 1, arbitrary: tie("object") }
    ),
    array: fc.array(tie("value"), { maxLength: 4 }),
    object: fc.dictionary(fieldNameArb, tie("value"), { maxKeys: 4 }),
  })
).value;

const documentArb = fc.dictionary(fieldNameArb, valueArb, { minKeys: 1, maxKeys: 6 });

function normalizeOrThrow(data: unknown): { data: Record<string, unknown>; sizeBytes: number } {
  return normalizeAndValidateDocumentData(data);
}

describe("fuzz: tagged wire format", () => {
  it("P1/P2: accepted documents JSON-round-trip, re-normalize identically and report real bytes", () => {
    fc.assert(
      fc.property(documentArb, (document) => {
        const first = normalizeOrThrow(document);
        const encoded = JSON.stringify(first.data);
        const decoded: unknown = JSON.parse(encoded);

        const second = normalizeOrThrow(decoded);
        expect(JSON.stringify(second.data)).toBe(encoded);
        expect(second.data).toEqual(first.data);

        expect(first.sizeBytes).toBe(Buffer.byteLength(encoded, "utf8"));
        expect(second.sizeBytes).toBe(first.sizeBytes);
        expect(first.sizeBytes).toBeLessThanOrEqual(SYSTEM_LIMITS.MAX_DOCUMENT_BYTES);
      }),
      { seed: SEED, numRuns: NUM_RUNS }
    );
  });

  it("P1: nested tagged maps remain canonical after a JSON round-trip", () => {
    const taggedMapArb = fc.dictionary(fieldNameArb, taggedValueArb, { maxKeys: 4 });
    fc.assert(
      fc.property(taggedMapArb, (inner) => {
        const document = { escaped: { $t: "map", $v: inner } };
        const first = normalizeOrThrow(document);
        const second = normalizeOrThrow(JSON.parse(JSON.stringify(first.data)));
        expect(JSON.stringify(second.data)).toBe(JSON.stringify(first.data));
        expect(second.sizeBytes).toBe(first.sizeBytes);
      }),
      { seed: SEED + 1, numRuns: 60 }
    );
  });

  it("P3: arbitrary JSON never escapes as an uncaught non-VellumError", () => {
    fc.assert(
      fc.property(
        fc.jsonValue({ maxDepth: 5 }),
        fc.string({ maxLength: 32 }),
        (jsonValue, extraField) => {
          const candidates: unknown[] = [
            jsonValue,
            { payload: jsonValue },
            { [extraField]: jsonValue },
            { hostile: { $t: "unknown-tag", $v: jsonValue } },
            { hostile: { $op: "deleteEverything" } },
          ];

          for (const candidate of candidates) {
            try {
              normalizeAndValidateDocumentData(candidate);
            } catch (error) {
              expect(error).toBeInstanceOf(VellumError);
            }

            try {
              validateWireValue(candidate, 0, false);
            } catch (error) {
              expect(error).toBeInstanceOf(VellumError);
            }
          }
        }
      ),
      { seed: SEED + 2, numRuns: NUM_RUNS }
    );
  });

  it("P4: tagged int64 accepts exactly the signed 64-bit range", () => {
    fc.assert(
      fc.property(int64Arb, (value) => {
        const tagged = WireValue.int64(value);
        expect(() => validateWireValue(tagged)).not.toThrow();
        expect(tagged.$v).toBe(value.toString());
        expect(BigInt(tagged.$v)).toBe(value);
      }),
      { seed: SEED + 3, numRuns: 200 }
    );

    const outOfRange = [1n << 63n, -(1n << 63n) - 1n, (1n << 64n) - 1n];
    for (const value of outOfRange) {
      try {
        validateWireValue({ $t: "int", $v: value.toString() });
        expect.unreachable(`int64 ${value.toString()} should have been rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(VellumError);
        expect((error as VellumError).code).toBe("INVALID_ARGUMENT");
      }
    }
  });

  it("rejects non-finite numbers only as VellumError (never RangeError)", () => {
    const nonFinite = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const value of nonFinite) {
      expect(() => normalizeAndValidateDocumentData({ value })).toThrowError(VellumError);
      try {
        normalizeAndValidateDocumentData({ value });
      } catch (error) {
        expect((error as VellumError).code).toBe("INVALID_ARGUMENT");
      }
    }
  });

  it("enforces the 20-level nesting ceiling with MAX_NESTING_EXCEEDED", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < SYSTEM_LIMITS.MAX_OBJECT_NESTING_DEPTH + 2; depth += 1) {
      nested = { child: nested };
    }

    try {
      normalizeAndValidateDocumentData(nested);
      expect.unreachable("nesting above the limit should have been rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(VellumError);
      expect((error as VellumError).code).toBe("MAX_NESTING_EXCEEDED");
    }
  });

  it("rejects malformed tagged values with INVALID_ARGUMENT", () => {
    const malformed: unknown[] = [
      { bad: { $t: "int", $v: "12.5" } },
      { bad: { $t: "int", $v: "not-a-number" } },
      { bad: { $t: "ts", $v: "not-a-date" } },
      { bad: { $t: "ts", $v: "2026-01-01T00:00:00.000Z", $ms: Number.NaN } },
      { bad: { $t: "ref", $v: "../escape" } },
      { bad: { $t: "bytes", $v: "!!!not-base64!!!" } },
      { bad: { $t: "geo", $v: { lat: 91, lng: 0 } } },
      { bad: { $t: "geo", $v: { lat: 0, lng: -181 } } },
      { bad: { $t: "map", $v: [1, 2, 3] } },
      { bad: { $t: "map", $v: { "": 1 } } },
      { bad: { $op: "inc", by: Number.POSITIVE_INFINITY } },
      { bad: { $op: "arrayUnion" } },
      { bad: { $op: "unknown-op" } },
      { bad: { $t: "wat", $v: "x" } },
      { bad: [Number.NaN] },
      { bad: undefined },
    ];

    for (const document of malformed) {
      let thrown: unknown;
      try {
        normalizeAndValidateDocumentData(document);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(VellumError);
      expect(["INVALID_ARGUMENT", "INVALID_DOCUMENT_PATH", "INVALID_FIELD_NAME"]).toContain(
        (thrown as VellumError).code
      );
    }

    // A tagged reference delegates to the canonical path parser.
    let invalidReference: unknown;
    try {
      normalizeAndValidateDocumentData({ ref: { $t: "ref", $v: "../escape" } });
    } catch (error) {
      invalidReference = error;
    }
    expect(invalidReference).toBeInstanceOf(VellumError);
    expect((invalidReference as VellumError).code).toBe("INVALID_DOCUMENT_PATH");
  });

  it("allows atomic field ops only when the caller enables them", () => {
    const updateDocument = { counter: { $op: "inc", by: 2 } };
    expect(() => normalizeAndValidateDocumentData(updateDocument)).toThrowError(VellumError);
    expect(() => normalizeAndValidateDocumentData(updateDocument, true)).not.toThrow();

    expect(() =>
      normalizeAndValidateDocumentData({ stamp: { $op: "serverTimestamp" } }, true)
    ).not.toThrow();
    expect(() =>
      normalizeAndValidateDocumentData({ tags: { $op: "arrayUnion", elements: ["a", "b"] } }, true)
    ).not.toThrow();
  });

  it("rejects documents above 1 MiB with DOCUMENT_TOO_LARGE", () => {
    const oversized = { blob: "x".repeat(SYSTEM_LIMITS.MAX_DOCUMENT_BYTES + 1) };
    try {
      normalizeAndValidateDocumentData(oversized);
      expect.unreachable("oversized document should have been rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(VellumError);
      expect((error as VellumError).code).toBe("DOCUMENT_TOO_LARGE");
    }
  });

  it("accepts an exactly-at-limit payload (inclusive 1 MiB ceiling)", () => {
    const base = normalizeAndValidateDocumentData({ blob: "" });
    const filler = "x".repeat(SYSTEM_LIMITS.MAX_DOCUMENT_BYTES - base.sizeBytes);
    const exact = normalizeAndValidateDocumentData({ blob: filler });
    expect(exact.sizeBytes).toBe(SYSTEM_LIMITS.MAX_DOCUMENT_BYTES);
  });

  it("rejects a top-level array or tagged wrapper as document data", () => {
    for (const candidate of [[1, 2, 3], { $t: "map", $v: {} }, { $op: "inc", by: 1 }]) {
      try {
        normalizeAndValidateDocumentData(candidate);
        expect.unreachable("non-map top-level data should have been rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(VellumError);
        expect((error as VellumError).code).toBe("INVALID_ARGUMENT");
      }
    }
  });

  it("enforces field-name limits and control-character bans", () => {
    const invalidNames = ["", "a".repeat(SYSTEM_LIMITS.MAX_FIELD_NAME_LENGTH + 1), "bad\nname"];
    for (const name of invalidNames) {
      try {
        validateWireValue({ [name]: 1 });
        expect.unreachable(`field name '${name.slice(0, 16)}' should have been rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(VellumError);
        expect((error as VellumError).code).toBe("INVALID_FIELD_NAME");
      }
    }
  });
});
