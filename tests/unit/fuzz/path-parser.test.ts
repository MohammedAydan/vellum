/**
 * Property/fuzz tests for the canonical Document/Collection
 * path parser.
 *
 * Deterministic seeds make failures reproducible. Invariants proved:
 *
 *   P1  Any generated even path of 2..10 valid segments parses and round-trips
 *       (`segments.join("/") === path`, `collectionPath + "/" + id === path`,
 *       `pathDepth === segments.length`), with no `..`-like segment accepted.
 *   P2  `parseCollectionPath` accepts every `collectionPath` produced by P1 and
 *       returns exactly the prefix segments.
 *   P3  Depth/parity violations, relative segments, encoded traversal,
 *       control characters and reserved `__x__` segments are always rejected
 *       with `INVALID_DOCUMENT_PATH`.
 *   P4  The 1,500-byte segment ceiling is inclusive at the boundary.
 *   P5  Arbitrary strings either parse consistently or raise a VellumError —
 *       never an uncaught TypeError/RangeError.
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  VellumError,
  SYSTEM_LIMITS,
  parseCollectionPath,
  parseDocumentPath,
} from "@vellum/core";

const SEED = 20261116;
const NUM_RUNS = 150;

const safeSegmentArb = fc
  .stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$/)
  .filter((segment) => !/^__.*__$/.test(segment));

const pairCountArb = fc.integer({ min: 1, max: 5 });

const documentSegmentsArb = pairCountArb.chain((pairs) =>
  fc.array(safeSegmentArb, { minLength: pairs * 2, maxLength: pairs * 2 })
);

const documentPathArb = documentSegmentsArb.map((segments) => segments.join("/"));

function expectPathError(action: () => unknown): void {
  try {
    action();
    expect.unreachable("path should have been rejected");
  } catch (error) {
    expect(error).toBeInstanceOf(VellumError);
    expect((error as VellumError).code).toBe("INVALID_DOCUMENT_PATH");
  }
}

describe("fuzz: document path parser", () => {
  it("P1/P2: valid document paths parse, round-trip and yield a parseable collection path", () => {
    fc.assert(
      fc.property(documentSegmentsArb, (segments) => {
        const rawPath = segments.join("/");
        const parsed = parseDocumentPath(rawPath);

        const lastSegment = segments[segments.length - 1];
        expect(lastSegment).toBeDefined();
        expect(parsed.path).toBe(rawPath);
        expect(parsed.segments).toEqual(segments);
        expect(parsed.segments.join("/")).toBe(rawPath);
        expect(parsed.pathDepth).toBe(segments.length);
        expect(parsed.pathDepth % 2).toBe(0);
        expect(parsed.pathDepth).toBeGreaterThanOrEqual(2);
        expect(parsed.pathDepth).toBeLessThanOrEqual(SYSTEM_LIMITS.MAX_PATH_DEPTH);

        expect(parsed.documentId).toBe(lastSegment);
        expect(parsed.collectionPath).toBe(segments.slice(0, -1).join("/"));
        expect(`${parsed.collectionPath}/${parsed.documentId}`).toBe(rawPath);
        expect(parsed.collectionGroup).toBe(segments[segments.length - 2]);

        const collection = parseCollectionPath(parsed.collectionPath);
        expect(collection.collectionPath).toBe(parsed.collectionPath);
        expect(collection.collectionGroup).toBe(parsed.collectionGroup);
        expect(collection.segments).toEqual(segments.slice(0, -1));
        expect(collection.depth).toBe(segments.length - 1);
        expect(collection.depth % 2).toBe(1);
      }),
      { seed: SEED, numRuns: NUM_RUNS }
    );
  });

  it("P3: a '..' segment is rejected at every position and casing", () => {
    fc.assert(
      fc.property(
        documentSegmentsArb,
        fc.nat({ max: SYSTEM_LIMITS.MAX_PATH_DEPTH - 1 }),
        (segments, rawIndex) => {
          const index = rawIndex % segments.length;
          const hostileSegments = [...segments];
          hostileSegments[index] = "..";
          expectPathError(() => parseDocumentPath(hostileSegments.join("/")));
        }
      ),
      { seed: SEED + 1, numRuns: 80 }
    );

    fc.assert(
      fc.property(
        documentSegmentsArb,
        fc.nat({ max: SYSTEM_LIMITS.MAX_PATH_DEPTH - 1 }),
        fc.constantFrom("..", ".", "%2e%2e", "%2E%2E", "%2f", "%2F", "__meta__", "__system__"),
        (segments, rawIndex, hostile) => {
          const index = rawIndex % segments.length;
          const hostileSegments = [...segments];
          hostileSegments[index] = hostile;
          expectPathError(() => parseDocumentPath(hostileSegments.join("/")));
        }
      ),
      { seed: SEED + 2, numRuns: 100 }
    );
  });

  it("P3: odd segment counts, over-depth paths and empty segments are rejected", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.array(safeSegmentArb, { minLength: 12, maxLength: 12 }),
        (pairs, pool) => {
          const evenSegments = pool.slice(0, pairs % 2 === 0 ? pairs : pairs + 1);
          const oddSegments = evenSegments.slice(0, Math.max(1, evenSegments.length - 1));

          if (oddSegments.length >= 1) {
            expectPathError(() => parseDocumentPath(oddSegments.join("/")));
          }

          const tooDeep = pool.slice(0, SYSTEM_LIMITS.MAX_PATH_DEPTH + 2);
          expect(tooDeep.length).toBe(SYSTEM_LIMITS.MAX_PATH_DEPTH + 2);
          expect(tooDeep.length % 2).toBe(0);
          expectPathError(() => parseDocumentPath(tooDeep.join("/")));

          expectPathError(() => parseDocumentPath(`/${evenSegments.join("/")}`));
          expectPathError(() => parseDocumentPath(`${evenSegments.join("/")}/`));
          expectPathError(() => parseDocumentPath(evenSegments.join("//")));
          expectPathError(() => parseDocumentPath(""));
          expectPathError(() => parseDocumentPath("single"));
        }
      ),
      { seed: SEED + 3, numRuns: 80 }
    );
  });

  it("P3: control characters are rejected anywhere in a segment", () => {
    fc.assert(
      fc.property(
        safeSegmentArb,
        safeSegmentArb,
        fc.integer({ min: 0, max: 31 }),
        (collection, documentId, controlCode) => {
          const poisoned = `bad${String.fromCharCode(controlCode)}name`;
          expectPathError(() => parseDocumentPath(`${collection}/${poisoned}`));
          expectPathError(() => parseDocumentPath(`${poisoned}/${documentId}`));
        }
      ),
      { seed: SEED + 4, numRuns: 80 }
    );
  });

  it("P4: the 1,500-byte segment ceiling is inclusive", () => {
    const exact = "a".repeat(SYSTEM_LIMITS.MAX_PATH_SEGMENT_BYTES);
    expect(Buffer.byteLength(exact, "utf8")).toBe(SYSTEM_LIMITS.MAX_PATH_SEGMENT_BYTES);

    const parsed = parseDocumentPath(`${exact}/doc`);
    expect(parsed.documentId).toBe("doc");
    expect(Buffer.byteLength(parsed.collectionGroup, "utf8")).toBe(
      SYSTEM_LIMITS.MAX_PATH_SEGMENT_BYTES
    );

    const over = "a".repeat(SYSTEM_LIMITS.MAX_PATH_SEGMENT_BYTES + 1);
    expectPathError(() => parseDocumentPath(`${over}/doc`));
    expectPathError(() => parseDocumentPath(`collection/${over}`));

    // The byte limit counts UTF-8 bytes, not UTF-16 code units (3 bytes each).
    const multibyte = "é".repeat(Math.ceil(SYSTEM_LIMITS.MAX_PATH_SEGMENT_BYTES / 2) + 1);
    expect(Buffer.byteLength(multibyte, "utf8")).toBeGreaterThan(
      SYSTEM_LIMITS.MAX_PATH_SEGMENT_BYTES
    );
    expectPathError(() => parseDocumentPath(`${multibyte}/doc`));
  });

  it("P5: arbitrary strings parse consistently or raise VellumError only", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (candidate) => {
        try {
          const parsed = parseDocumentPath(candidate);
          expect(parsed.path).toBe(candidate);
          expect(parsed.segments.join("/")).toBe(candidate);
          expect(parsed.pathDepth).toBe(parsed.segments.length);
          expect(parsed.pathDepth % 2).toBe(0);
          expect(parsed.segments.includes("..")).toBe(false);
          expect(parsed.segments.includes(".")).toBe(false);
        } catch (error) {
          expect(error).toBeInstanceOf(VellumError);
          expect((error as VellumError).code).toBe("INVALID_DOCUMENT_PATH");
        }

        try {
          const parsedCollection = parseCollectionPath(candidate);
          expect(parsedCollection.collectionPath).toBe(candidate);
          expect(parsedCollection.depth % 2).toBe(1);
          expect(parsedCollection.segments.includes("..")).toBe(false);
        } catch (error) {
          expect(error).toBeInstanceOf(VellumError);
          expect((error as VellumError).code).toBe("INVALID_DOCUMENT_PATH");
        }
      }),
      { seed: SEED + 5, numRuns: NUM_RUNS }
    );
  });
});
