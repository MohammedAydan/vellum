/**
 * Query compiler operator matrix.
 *
 * Verifies that EVERY supported operator compiles to parameterized JSONB SQL
 * (never a `TRUE` placeholder), that range predicates are type-guarded, that
 * select projection is pushed down, that keyset cursors bind the query-shape
 * hash, and that index selection is prefix/direction aware.
 */

import { describe, it, expect } from "vitest";
import {
  validateAndNormalizeQuery,
  compileQueryToParameterizedSql,
  selectCompositeIndexForQuery,
  computeQueryShapeHash,
  encodeQueryCursor,
  decodeAndVerifyQueryCursor,
  UNINDEXED_SCAN_CAP,
  type CompositeIndexMetadata,
} from "@vellum/query-engine";

const PROJECT = "123e4567-e89b-12d3-a456-426614174000";

function compile(where: Array<{ field: string; op: never; value: unknown }>, extra: Record<string, unknown> = {}) {
  const normalized = validateAndNormalizeQuery({ collectionPath: "items", where, ...extra });
  return compileQueryToParameterizedSql({ projectId: PROJECT, normalizedQuery: normalized });
}

describe("SQL compiler operator matrix", () => {
  it("uses @> containment for == and array-contains", () => {
    const c = compile([
      { field: "status", op: "==", value: "active" },
      { field: "tags", op: "array-contains", value: "urgent" },
    ] as never);
    expect(c.sql).toContain("d.data @> $3::jsonb");
    expect(c.sql).toContain("d.data @> $4::jsonb");
    expect(c.sql).not.toContain("/* filter");
    expect(c.sql).not.toContain(" TRUE");
    expect(c.params[2]).toBe(JSON.stringify({ status: "active" }));
    expect(c.params[3]).toBe(JSON.stringify({ tags: ["urgent"] }));
  });

  it("requires field existence for != (not merely non-containment)", () => {
    const c = compile([{ field: "status", op: "!=", value: "banned" }] as never);
    expect(c.sql).toContain(`(d.data #> $3::text[]) IS NOT NULL`);
    expect(c.sql).toContain("NOT (d.data @> $4::jsonb)");
    expect(c.sql).not.toContain(" TRUE");
  });

  it("compiles numeric/string/tagged-int/tagged-ts ranges with type guards", () => {
    const numeric = compile([{ field: "age", op: ">", value: 25 }] as never);
    expect(numeric.sql).toContain(`jsonb_typeof((d.data #> $3::text[])) = 'number'`);
    expect(numeric.sql).toContain(")::numeric > $4::numeric");

    const str = compile([{ field: "name", op: "<=", value: "m" }] as never);
    expect(str.sql).toContain(`jsonb_typeof((d.data #> $3::text[])) = 'string'`);
    expect(str.sql).toContain(`COLLATE "C" <=`);

    const int64 = compile([{ field: "counter", op: ">=", value: { $t: "int", $v: "9007199254740993" } }] as never);
    expect(int64.sql).toContain(`= 'int' AND (d.data #>> $5::text[])::numeric >= $6::numeric`);

    const ts = compile([{ field: "created", op: "<", value: { $t: "ts", $v: "2026-01-01T00:00:00.000Z", $ms: 1767225600000 } }] as never);
    expect(ts.sql).toContain(`= 'ts' AND (d.data #>> $5::text[])::bigint < $6::bigint`);
  });

  it("rejects range bounds that cannot be cast safely", () => {
    expect(() => compile([{ field: "ok", op: ">", value: true }] as never)).toThrow();
  });

  it("compiles in / not-in via = ANY(jsonb[]) with existence semantics", () => {
    const inQ = compile([{ field: "status", op: "in", value: ["a", "b", "c"] }] as never);
    expect(inQ.sql).toContain("d.data @> ANY($4::jsonb[])");
    expect((inQ.params[3] as unknown[]).length).toBe(3);

    const ninQ = compile([{ field: "status", op: "not-in", value: ["a", "b"] }] as never);
    expect(ninQ.sql).toContain("NOT (d.data @> ANY($4::jsonb[]))");
    expect(ninQ.sql).toContain(`(d.data #> $3::text[]) IS NOT NULL`);
  });

  it("compiles array-contains-any as an OR of containments", () => {
    const c = compile([{ field: "tags", op: "array-contains-any", value: ["a", "b", "c"] }] as never);
    const ors = c.sql.match(/d\.data @> \$\d+::jsonb/g) ?? [];
    expect(ors).toHaveLength(3);
    expect(c.sql).toContain(" OR ");
  });

  it("pushes down select projection with jsonb_build_object and full dot paths", () => {
    const c = compile([], { select: ["name", "profile.age"] });
    expect(c.sql).toContain('AS "projectedData"');
    expect(c.sql).toContain("jsonb_build_object($3::text");
    expect(c.params).toContain("profile.age");
    expect(c.projectionFields).toEqual(["name", "profile.age"]);
  });

  it("fetches limit+1 for deterministic next-cursor detection", () => {
    const c = compile([], { limit: 25 });
    expect(c.fetchLimit).toBe(26);
    expect(c.params[c.params.length - 1]).toBe(26);
    expect(c.maxScanRows).toBe(UNINDEXED_SCAN_CAP);
  });

  it("emits composite-index keyset predicate with bytea sort key", () => {
    const normalized = validateAndNormalizeQuery({
      collectionPath: "items",
      orderBy: [{ field: "score", dir: "asc" }],
      limit: 10,
    });
    const qHash = computeQueryShapeHash({
      projectId: PROJECT,
      collectionPath: normalized.collectionPath,
      where: normalized.where,
      orderBy: normalized.orderBy,
    });
    const cursor = decodeAndVerifyQueryCursor(
      encodeQueryCursor({ qHash, vals: [5, "doc_5"], docId: "doc_5", sortKey: "abcd" }),
      qHash
    );
    const idx: CompositeIndexMetadata = {
      id: "111e4567-e89b-12d3-a456-426614174000",
      collectionPath: "items",
      fields: [{ path: "score", dir: "asc" }],
      status: "ready",
    };
    const c = compileQueryToParameterizedSql({
      projectId: PROJECT,
      normalizedQuery: normalized,
      matchedCompositeIndex: idx,
      cursor,
      cursorMode: "startAfter",
    });
    // Row-value tuple comparison: B-Tree friendly and exact for the document_id tie-breaker.
    expect(c.sql).toMatch(/\(ie\.sort_key, ie\.document_id\) > \(\$\d+::bytea, \$\d+\)/);
    expect(c.sql).toContain("::bytea");
    expect(c.params).toContainEqual(Buffer.from("abcd", "hex"));
    expect(c.params).toContain("doc_5");
    const inclusive = compileQueryToParameterizedSql({
      projectId: PROJECT,
      normalizedQuery: normalized,
      matchedCompositeIndex: idx,
      cursor,
      cursorMode: "startAt",
    });
    expect(inclusive.sql).toMatch(/\(ie\.sort_key, ie\.document_id\) >= \(\$\d+::bytea, \$\d+\)/);
    expect(c.sql).toContain("encode(ie.sort_key, 'hex') AS \"sortKeyHex\"");
    expect(c.compositeIndexId).toBe(idx.id);
    expect(c.maxScanRows).toBeNull();
  });

  it("emits system-field keyset predicate on (updated_at, document_id)", () => {
    const normalized = validateAndNormalizeQuery({
      collectionPath: "items",
      orderBy: [{ field: "updatedAt", dir: "desc" }],
      limit: 10,
    });
    const qHash = computeQueryShapeHash({
      projectId: PROJECT,
      collectionPath: normalized.collectionPath,
      where: normalized.where,
      orderBy: normalized.orderBy,
    });
    const cursor = decodeAndVerifyQueryCursor(
      encodeQueryCursor({
        qHash,
        vals: [{ $t: "ts", $v: "2026-01-01T00:00:00.000Z", $ms: 1767225600000 }, "doc_5"],
        docId: "doc_5",
      }),
      qHash
    );
    const c = compileQueryToParameterizedSql({
      projectId: PROJECT,
      normalizedQuery: normalized,
      cursor,
      cursorMode: "startAfter",
    });
    expect(c.sql).toContain("d.updated_at < $");
    expect(c.sql).toContain("::timestamptz");
    expect(c.sql).toContain("d.document_id > $");
  });
});

describe("composite index selection", () => {
  const idx: CompositeIndexMetadata = {
    id: "idx-1",
    collectionPath: "orders",
    fields: [
      { path: "status", dir: "asc" },
      { path: "amount", dir: "desc" },
    ],
    status: "ready",
  };

  it("matches equality prefix then direction-aware orderBy", () => {
    const q = validateAndNormalizeQuery({
      collectionPath: "orders",
      where: [{ field: "status", op: "==", value: "open" }],
      orderBy: [{ field: "amount", dir: "desc" }],
    });
    const { matchedIndex } = selectCompositeIndexForQuery(q, [idx]);
    expect(matchedIndex?.id).toBe("idx-1");
  });

  it("rejects the same index when the orderBy direction differs", () => {
    const q = validateAndNormalizeQuery({
      collectionPath: "orders",
      where: [{ field: "status", op: "==", value: "open" }],
      orderBy: [{ field: "amount", dir: "asc" }],
    });
    expect(selectCompositeIndexForQuery(q, [idx]).matchedIndex).toBeNull();
  });

  it("requires a composite index for multi-field and range+order shapes", () => {
    const multi = validateAndNormalizeQuery({
      collectionPath: "orders",
      orderBy: [{ field: "status", dir: "asc" }, { field: "amount", dir: "desc" }],
    });
    expect(selectCompositeIndexForQuery(multi, [idx]).requiresCompositeIndex).toBe(true);

    const rangeMismatch = validateAndNormalizeQuery({
      collectionPath: "orders",
      where: [{ field: "amount", op: ">", value: 10 }],
      orderBy: [{ field: "status", dir: "asc" }],
    });
    expect(selectCompositeIndexForQuery(rangeMismatch, [idx]).requiresCompositeIndex).toBe(true);
  });

  it("does not select an index for a plain documentId-only scan", () => {
    const plain = validateAndNormalizeQuery({ collectionPath: "orders" });
    expect(selectCompositeIndexForQuery(plain, [idx]).matchedIndex).toBeNull();
  });
});
