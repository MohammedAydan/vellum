/**
 * reusable, deterministic fixtures shared by the mitata benchmark
 * runner (`scripts/bench.ts`) and its Vitest correctness gate. Keeping the
 * fixtures in one place guarantees the benchmarked functions are the exact
 * ones exercised by the test suite.
 */

import {
  encodeCompositeSortKey,
  normalizeAndValidateDocumentData,
  validateWireValue,
  WireValue,
  type IndexFieldSpec,
} from "../../../packages/core/src/index.js";
import {
  compileQueryToParameterizedSql,
  validateAndNormalizeQuery,
  type CompositeIndexMetadata,
  type NormalizedQuery,
} from "../../../packages/query-engine/src/index.js";

export const BENCH_PROJECT_ID = "11111111-1111-1111-1111-111111111111";

/** A realistic mixed tagged-wire document (~1 KB). */
export function makeWireDocument(seed = 1): Record<string, unknown> {
  return {
    name: `user-${seed}`,
    email: `user-${seed}@example.com`,
    age: 20 + (seed % 60),
    active: seed % 2 === 0,
    score: seed * 1.25,
    createdAt: WireValue.timestamp(Date.UTC(2026, 0, 1 + (seed % 28))),
    balance: WireValue.int64(`922337203685477000${seed % 10}`),
    tags: ["alpha", "beta", `segment-${seed % 7}`],
    profile: {
      city: "Berlin",
      coords: WireValue.geopoint(52.52 + seed / 1000, 13.405),
      bio: "x".repeat(600),
    },
    revision: seed % 5 === 0 ? null : seed,
  };
}

/** Encode path: canonicalize tagged values, validate, and serialize. */
export function encodeWire(document: Record<string, unknown>): { data: Record<string, unknown>; sizeBytes: number; json: string } {
  const normalized = normalizeAndValidateDocumentData(document);
  return { data: normalized.data, sizeBytes: normalized.sizeBytes, json: JSON.stringify(normalized.data) };
}

/** Decode path: parse, validate the tagged wire format, and read a field. */
export function decodeWire(json: string): unknown {
  const parsed: unknown = JSON.parse(json);
  validateWireValue(parsed, 1);
  return parsed;
}

export interface SortableDoc {
  documentId: string;
  path: string;
  data: Record<string, unknown>;
}

export function makeSortableDoc(seed: number): SortableDoc {
  return {
    documentId: `doc-${String(seed).padStart(8, "0")}`,
    path: `customers/doc-${String(seed).padStart(8, "0")}`,
    data: {
      status: seed % 3 === 0 ? "active" : "pending",
      score: (seed * 7919) % 100_000,
      tier: seed % 5,
    },
  };
}

export const SORT_FIELDS: IndexFieldSpec[] = [
  { path: "status", dir: "asc" },
  { path: "score", dir: "desc" },
  { path: "__name__", dir: "asc" },
];

export function encodeSortKey(doc: SortableDoc): Buffer {
  return encodeCompositeSortKey(doc, SORT_FIELDS);
}

export function makeNormalizedQuery(): NormalizedQuery {
  return validateAndNormalizeQuery({
    collectionPath: "customers",
    where: [
      { field: "status", op: "==", value: "active" },
      { field: "score", op: ">=", value: 10 },
    ],
    orderBy: [{ field: "score", dir: "desc" }],
    limit: 50,
  });
}

export function makeCompositeIndex(): CompositeIndexMetadata {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    collectionPath: "customers",
    fields: SORT_FIELDS.map((field) => ({ path: field.path, dir: field.dir })),
    status: "ready",
  };
}

/** Query compilation path: validator + parameterized SQL compiler. */
export function compileQuery(normalized: NormalizedQuery, withIndex: boolean) {
  const raw = {
    collectionPath: normalized.collectionPath,
    where: normalized.where,
    orderBy: normalized.orderBy,
    limit: normalized.limit,
  };
  const validated = validateAndNormalizeQuery(raw);
  return compileQueryToParameterizedSql({
    projectId: BENCH_PROJECT_ID,
    normalizedQuery: validated,
    ...(withIndex ? { matchedCompositeIndex: makeCompositeIndex() } : {}),
  });
}
