import { describe, it, expect } from "vitest";
import {
  validateAndNormalizeQuery,
  computeQueryShapeHash,
  encodeQueryCursor,
  decodeAndVerifyQueryCursor,
  compileQueryToParameterizedSql,
  documentMatchesWhereClause,
  documentMatchesQuery,
  selectCompositeIndexForQuery,
  computeIndexDefinitionHash,
  compileWhereClause,
  escapeLikePattern,
  compileDeleteSelectQuery,
} from "../index.js";
import { VellumError } from "@vellum/core";

describe("@vellum/query-engine", () => {
  describe("Query Validator & Normalizer", () => {
    it("normalizes query and appends tie-breaker documentId asc", () => {
      const q = validateAndNormalizeQuery({
        collectionPath: "users",
        where: [{ field: "status", op: "==", value: "active" }],
        orderBy: [{ field: "createdAt", dir: "desc" }],
        limit: 25,
      });

      expect(q.collectionPath).toBe("users");
      expect(q.where.length).toBe(1);
      expect(q.orderBy).toEqual([
        { field: "createdAt", dir: "desc" },
        { field: "documentId", dir: "asc" },
      ]);
      expect(q.limit).toBe(25);
    });

    it("rejects where clauses > 10 with QUERY_TOO_COMPLEX", () => {
      const where = Array.from({ length: 11 }, (_, i) => ({
        field: `field_${i}`,
        op: "==" as const,
        value: "val",
      }));
      expect(() => validateAndNormalizeQuery({ collectionPath: "col", where })).toThrow(VellumError);
    });

    it("rejects disjunctive values > 30 items with QUERY_TOO_COMPLEX", () => {
      const items = Array.from({ length: 31 }, (_, i) => `item_${i}`);
      expect(() =>
        validateAndNormalizeQuery({
          collectionPath: "col",
          where: [{ field: "tag", op: "in", value: items }],
        })
      ).toThrow(VellumError);
    });

    it("rejects invalid limit", () => {
      expect(() => validateAndNormalizeQuery({ collectionPath: "col", limit: 0 })).toThrow(VellumError);
      expect(() => validateAndNormalizeQuery({ collectionPath: "col", limit: 501 })).toThrow(VellumError);
    });

    it("normalizes empty 'or' to an array and accepts valid groups", () => {
      const q = validateAndNormalizeQuery({ collectionPath: "col" });
      expect(q.or).toEqual([]);

      const withOr = validateAndNormalizeQuery({
        collectionPath: "col",
        or: [
          [{ field: "status", op: "==", value: "active" }],
          [{ field: "score", op: ">", value: 10 }, { field: "flag", op: "==", value: true }],
        ],
      });
      expect(withOr.or.length).toBe(2);
      expect(withOr.or[1]?.length).toBe(2);
    });

    it("rejects more than 10 'or' groups and more than 10 clauses per group", () => {
      const tenGroups = Array.from({ length: 10 }, () => [{ field: "f", op: "==" as const, value: 1 }]);
      expect(() => validateAndNormalizeQuery({ collectionPath: "col", or: tenGroups })).not.toThrow();
      expect(() =>
        validateAndNormalizeQuery({ collectionPath: "col", or: [...tenGroups, [{ field: "f", op: "==", value: 1 }]] })
      ).toThrow(VellumError);

      const elevenClauses = Array.from({ length: 11 }, (_, i) => ({ field: `f${i}`, op: "==" as const, value: 1 }));
      expect(() => validateAndNormalizeQuery({ collectionPath: "col", or: [elevenClauses] })).toThrow(VellumError);
    });

    it("rejects empty or non-array 'or' groups", () => {
      expect(() => validateAndNormalizeQuery({ collectionPath: "col", or: [[]] })).toThrow(VellumError);
      expect(() => validateAndNormalizeQuery({ collectionPath: "col", or: "nope" })).toThrow(VellumError);
    });

    it("requires string operands for the V2 text operators", () => {
      for (const op of ["contains_ci", "starts_with_ci", "text_search"] as const) {
        expect(() =>
          validateAndNormalizeQuery({ collectionPath: "col", where: [{ field: "title", op, value: 42 }] })
        ).toThrow(VellumError);
      }
    });

    it("enforces the same field-name checks inside 'or' groups", () => {
      expect(() =>
        validateAndNormalizeQuery({
          collectionPath: "col",
          or: [[{ field: "", op: "==", value: 1 }]],
        })
      ).toThrow(VellumError);
    });
  });

  describe("V2 text operators", () => {
    it("escapeLikePattern escapes backslash, percent and underscore", () => {
      expect(escapeLikePattern("a\\b%c_d")).toBe("a\\\\b\\%c\\_d");
      expect(escapeLikePattern("plain")).toBe("plain");
    });

    it("compiles contains_ci / starts_with_ci with escaped parameter and ESCAPE clause", () => {
      const params: unknown[] = [];
      const contains = compileWhereClause({ field: "title", op: "contains_ci", value: "50%_off\\" }, params);
      expect(contains).toContain("ILIKE '%' || $2 || '%' ESCAPE '\\'");
      expect(params[1]).toBe("50\\%\\_off\\\\");

      const prefixParams: unknown[] = [];
      const prefix = compileWhereClause({ field: "title", op: "starts_with_ci", value: "ab_c" }, prefixParams);
      expect(prefix).toContain("ILIKE $2 || '%' ESCAPE '\\'");
      expect(prefixParams[1]).toBe("ab\\_c");
    });

    it("compiles text_search to a tsvector/plainto_tsquery predicate", () => {
      const params: unknown[] = [];
      const sql = compileWhereClause({ field: "anything", op: "text_search", value: "hello world" }, params);
      expect(sql).toContain("to_tsvector('simple', coalesce(d.data::text,'')) @@ plainto_tsquery('simple', $1)");
      expect(params[0]).toBe("hello world");
    });

    it("matches the new operators in memory (case-insensitive, literal wildcards, token search)", () => {
      const doc = {
        documentId: "d1",
        collectionPath: "col",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        data: { title: "Hello World", tags: ["alpha"] },
      };
      expect(documentMatchesWhereClause(doc, { field: "title", op: "contains_ci", value: "WORLD" })).toBe(true);
      expect(documentMatchesWhereClause(doc, { field: "title", op: "starts_with_ci", value: "hello" })).toBe(true);
      expect(documentMatchesWhereClause(doc, { field: "title", op: "starts_with_ci", value: "world" })).toBe(false);
      expect(documentMatchesWhereClause(doc, { field: "anything", op: "text_search", value: "hello alpha" })).toBe(true);
      expect(documentMatchesWhereClause(doc, { field: "anything", op: "text_search", value: "missing" })).toBe(false);
    });
  });

  describe("Disjunctive 'or' groups", () => {
    it("compiles groups ORed together and ANDed with base predicates", () => {
      const normalized = validateAndNormalizeQuery({
        collectionPath: "col",
        where: [{ field: "active", op: "==", value: true }],
        or: [
          [{ field: "role", op: "==", value: "admin" }],
          [{ field: "score", op: ">", value: 10 }, { field: "verified", op: "==", value: true }],
        ],
      });
      const compiled = compileQueryToParameterizedSql({
        projectId: "123e4567-e89b-12d3-a456-426614174000",
        normalizedQuery: normalized,
      });
      expect(compiled.sql).toContain(") OR (");
      // Base predicate plus both parenthesized groups are ANDed together.
      expect(compiled.sql).toContain("d.data @> $3::jsonb");
      expect(compiled.sql).toContain("d.deleted_at IS NULL");
    });

    it("evaluates OR groups in memory", () => {
      const doc = {
        documentId: "d1",
        collectionPath: "col",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        data: { role: "viewer", score: 50 },
        deletedAt: null,
      };
      const query = validateAndNormalizeQuery({
        collectionPath: "col",
        where: [{ field: "score", op: ">", value: 10 }],
        or: [
          [{ field: "role", op: "==", value: "admin" }],
          [{ field: "role", op: "==", value: "viewer" }],
        ],
      });
      expect(documentMatchesQuery(doc, query)).toBe(true);
      const unmatched = validateAndNormalizeQuery({
        collectionPath: "col",
        or: [[{ field: "role", op: "==", value: "admin" }]],
      });
      expect(documentMatchesQuery(doc, unmatched)).toBe(false);
    });
  });

  describe("TTL & maintenance selects", () => {
    it("adds the live-TTL predicate to the fallback query path", () => {
      const normalized = validateAndNormalizeQuery({ collectionPath: "col" });
      const compiled = compileQueryToParameterizedSql({
        projectId: "123e4567-e89b-12d3-a456-426614174000",
        normalizedQuery: normalized,
      });
      expect(compiled.sql).toContain("(d.expires_at IS NULL OR d.expires_at > now())");
      expect(compiled.sql).toContain("FROM documents d WHERE");
    });

    it("adds the live-TTL predicate to the composite-index path too", () => {
      const normalized = validateAndNormalizeQuery({
        collectionPath: "col",
        orderBy: [{ field: "rank", dir: "asc" }],
      });
      const compiled = compileQueryToParameterizedSql({
        projectId: "123e4567-e89b-12d3-a456-426614174000",
        normalizedQuery: normalized,
        matchedCompositeIndex: {
          id: "33333333-3333-3333-3333-333333333333",
          collectionPath: "col",
          fields: [{ path: "rank", dir: "asc" }],
          status: "ready",
        },
      });
      expect(compiled.sql).toContain("FROM document_index_entries ie");
      expect(compiled.sql).toContain("(d.expires_at IS NULL OR d.expires_at > now())");
    });

    it("compileDeleteSelectQuery disables the scan cap and orders by documentId", () => {
      const compiled = compileDeleteSelectQuery({
        projectId: "123e4567-e89b-12d3-a456-426614174000",
        collectionPath: "col",
        where: [{ field: "status", op: "==", value: "stale" }],
        limit: 5000,
      });
      expect(compiled.maxScanRows).toBeNull();
      expect(compiled.fetchLimit).toBe(5001);
      expect(compiled.sql).toContain("ORDER BY d.document_id ASC");
      expect(compiled.sql).toContain("(d.expires_at IS NULL OR d.expires_at > now())");
    });
  });

  describe("HMAC-SHA256 Cursors", () => {
    it("encodes, decodes, and verifies valid cursor", () => {
      const qHash = computeQueryShapeHash({
        projectId: "p1",
        collectionPath: "users",
        where: [{ field: "status", op: "==", value: "active" }],
        orderBy: [{ field: "documentId", dir: "asc" }],
      });

      const token = encodeQueryCursor({
        qHash,
        vals: ["active"],
        docId: "doc_100",
      });

      expect(typeof token).toBe("string");

      const decoded = decodeAndVerifyQueryCursor(token, qHash);
      expect(decoded.docId).toBe("doc_100");
      expect(decoded.vals).toEqual(["active"]);
    });

    it("rejects cursor if shape hash mismatches or token tampered", () => {
      const qHash = computeQueryShapeHash({
        projectId: "p1",
        collectionPath: "users",
        where: [],
        orderBy: [{ field: "documentId", dir: "asc" }],
      });

      const token = encodeQueryCursor({ qHash, vals: [], docId: "doc_1" });

      // Wrong shape hash
      expect(() => decodeAndVerifyQueryCursor(token, "different_hash")).toThrow(VellumError);

      // Wrong secret
      expect(() => decodeAndVerifyQueryCursor(token, qHash, "wrong_secret")).toThrow(VellumError);

      // Malformed
      expect(() => decodeAndVerifyQueryCursor("not-a-valid-token", qHash)).toThrow(VellumError);
    });
  });

  describe("SQL Compiler", () => {
    it("compiles equality and range queries into parameterized SQL", () => {
      const normalized = validateAndNormalizeQuery({
        collectionPath: "orders",
        where: [
          { field: "customerId", op: "==", value: "c_1" },
          { field: "tags", op: "array-contains", value: "urgent" },
        ],
        limit: 50,
      });

      const compiled = compileQueryToParameterizedSql({
        projectId: "123e4567-e89b-12d3-a456-426614174000",
        normalizedQuery: normalized,
      });

      expect(compiled.sql).toContain('d.document_id AS "documentId"');
      expect(compiled.sql).toContain("FROM documents d WHERE");
      expect(compiled.sql).toContain("d.project_id = $1::uuid");
      expect(compiled.sql).toContain("d.collection_path = $2");
      expect(compiled.sql).toContain("d.data @> $3::jsonb");
      expect(compiled.params.length).toBe(5);
      expect(compiled.indexUsed).toBe("idx_docs_data_gin_active");
    });
  });

  describe("In-Memory Predicate Matching", () => {
    it("evaluates document against query filters", () => {
      const doc = {
        documentId: "doc_1",
        collectionPath: "users",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        data: {
          age: 30,
          status: "active",
          tags: ["pro", "dev"],
        },
      };

      expect(documentMatchesWhereClause(doc, { field: "age", op: "==", value: 30 })).toBe(true);
      expect(documentMatchesWhereClause(doc, { field: "age", op: ">", value: 25 })).toBe(true);
      expect(documentMatchesWhereClause(doc, { field: "status", op: "!=", value: "disabled" })).toBe(true);
      expect(documentMatchesWhereClause(doc, { field: "tags", op: "array-contains", value: "pro" })).toBe(true);
      expect(documentMatchesWhereClause(doc, { field: "status", op: "in", value: ["active", "pending"] })).toBe(true);

      const query = validateAndNormalizeQuery({
        collectionPath: "users",
        where: [
          { field: "age", op: ">=", value: 30 },
          { field: "status", op: "==", value: "active" },
        ],
      });

      expect(documentMatchesQuery(doc, query)).toBe(true);
    });
  });

  describe("Composite Index Matcher", () => {
    it("selects composite index when multi-field sort is present", () => {
      const query = validateAndNormalizeQuery({
        collectionPath: "orders",
        orderBy: [
          { field: "status", dir: "asc" },
          { field: "amount", dir: "desc" },
        ],
      });

      const indexes = [
        {
          id: "idx-1",
          collectionPath: "orders",
          fields: [
            { path: "status", dir: "asc" as const },
            { path: "amount", dir: "desc" as const },
          ],
          status: "ready" as const,
        },
      ];

      const { matchedIndex, requiresCompositeIndex } = selectCompositeIndexForQuery(query, indexes);
      expect(requiresCompositeIndex).toBe(true);
      expect(matchedIndex?.id).toBe("idx-1");

      const defHash = computeIndexDefinitionHash("orders", indexes[0]!.fields);
      expect(defHash.length).toBe(32);
    });
  });
});

  describe("Security Hardening & Edge Cases", () => {
    it("blocks prototype-polluting field paths in validation and nested object building", () => {
      for (const bad of ["__proto__.polluted", "a.constructor.b", "x.prototype.y"]) {
        expect(() =>
          validateAndNormalizeQuery({
            collectionPath: "col",
            where: [{ field: bad, op: "==", value: 1 }],
          })
        ).toThrow(VellumError);
      }

      const doc = {
        documentId: "d1",
        collectionPath: "col",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        data: { name: "Ada" },
      };
      // Must never leak Object.prototype methods like `toString` or `constructor`.
      expect(documentMatchesWhereClause(doc, { field: "toString", op: "!=", value: "x" })).toBe(false);
      expect(documentMatchesWhereClause(doc, { field: "constructor", op: "!=", value: "x" })).toBe(false);
    });

    it("validates orderBy, select, startAt/startAfter mutual exclusion, and text length caps", () => {
      expect(() =>
        validateAndNormalizeQuery({ collectionPath: "col", orderBy: [null] as unknown[] })
      ).toThrow(VellumError);

      expect(() =>
        validateAndNormalizeQuery({
          collectionPath: "col",
          orderBy: [
            { field: "age", dir: "asc" },
            { field: "age", dir: "desc" },
          ],
        })
      ).toThrow(VellumError);

      expect(() =>
        validateAndNormalizeQuery({
          collectionPath: "col",
          select: Array.from({ length: 51 }, (_, i) => `f_${i}`),
        })
      ).toThrow(VellumError);

      expect(() =>
        validateAndNormalizeQuery({
          collectionPath: "col",
          startAt: ["a"],
          startAfter: ["b"],
        })
      ).toThrow(VellumError);

      expect(() =>
        validateAndNormalizeQuery({
          collectionPath: "col",
          where: [{ field: "bio", op: "contains_ci", value: "a".repeat(1025) }],
        })
      ).toThrow(VellumError);
    });

    it("rejects oversized cursor tokens, unauthenticated extra properties, and invalid hex sortKey", () => {
      const qHash = computeQueryShapeHash({
        projectId: "p1",
        collectionPath: "users",
        where: [],
        orderBy: [{ field: "documentId", dir: "asc" }],
      });

      // Oversized token DoS check
      expect(() => decodeAndVerifyQueryCursor("a".repeat(20_000), qHash)).toThrow(VellumError);

      // Invalid hex sortKey
      expect(() =>
        encodeQueryCursor({ qHash, vals: [], docId: "d1", sortKey: "not-hex!" })
      ).toThrow(VellumError);

      // Inject an unauthenticated property into an otherwise validly signed cursor token
      const validToken = encodeQueryCursor({ qHash, vals: [], docId: "d1" });
      const raw = JSON.parse(Buffer.from(validToken, "base64url").toString("utf8"));
      raw.injectedRole = "superadmin";
      const tampered = Buffer.from(JSON.stringify(raw), "utf8").toString("base64url");
      expect(() => decodeAndVerifyQueryCursor(tampered, qHash)).toThrow(VellumError);
    });

    it("supports zero-downtime cursor secret rotation via secret array", () => {
      const qHash = computeQueryShapeHash({
        projectId: "p1",
        collectionPath: "users",
        where: [],
        orderBy: [{ field: "documentId", dir: "asc" }],
      });
      const oldToken = encodeQueryCursor({ qHash, vals: [], docId: "d1" }, "old_secret_v1");
      const decoded = decodeAndVerifyQueryCursor(oldToken, qHash, ["new_secret_v2", "old_secret_v1"]);
      expect(decoded.docId).toBe("d1");
    });

    it("hashes semantically identical nested object filters identically regardless of key order", () => {
      const h1 = computeQueryShapeHash({
        projectId: "p1",
        collectionPath: "users",
        where: [{ field: "meta", op: "==", value: { a: 1, b: 2 } }],
        orderBy: [{ field: "documentId", dir: "asc" }],
      });
      const h2 = computeQueryShapeHash({
        projectId: "p1",
        collectionPath: "users",
        where: [{ field: "meta", op: "==", value: { b: 2, a: 1 } }],
        orderBy: [{ field: "documentId", dir: "asc" }],
      });
      expect(h1).toBe(h2);
    });
  });

  describe("SQL Correctness & Keyset Pagination", () => {
    it("uses row-value tuple comparison for composite-index cursors and respects documentId DESC", () => {
      const descQuery = validateAndNormalizeQuery({
        collectionPath: "orders",
        orderBy: [{ field: "documentId", dir: "desc" }],
      });
      const compiledDesc = compileQueryToParameterizedSql({
        projectId: "123e4567-e89b-12d3-a456-426614174000",
        normalizedQuery: descQuery,
        cursor: { qHash: "h", vals: [], docId: "doc_50" },
        cursorMode: "startAfter",
      });
      expect(compiledDesc.sql).toContain("d.document_id < $3");

      const indexedQuery = validateAndNormalizeQuery({
        collectionPath: "orders",
        orderBy: [{ field: "rank", dir: "asc" }],
      });
      const compiledIdx = compileQueryToParameterizedSql({
        projectId: "123e4567-e89b-12d3-a456-426614174000",
        normalizedQuery: indexedQuery,
        matchedCompositeIndex: {
          id: "33333333-3333-3333-3333-333333333333",
          collectionPath: "orders",
          fields: [{ path: "rank", dir: "asc" }],
          status: "ready",
        },
        cursor: { qHash: "h", vals: [10], docId: "doc_10", sortKey: "01020304" },
        cursorMode: "startAt",
      });
      expect(compiledIdx.sql).toContain("(ie.sort_key, ie.document_id) >= ($3::bytea, $4)");
    });

    it("compiles createdAt/updatedAt filters as native timestamptz and enforces exact equality for objects", () => {
      const tsParams: unknown[] = [];
      const tsSql = compileWhereClause(
        { field: "createdAt", op: ">", value: { $t: "ts", $v: "2026-01-01T00:00:00.000Z" } },
        tsParams
      );
      expect(tsSql).toBe("(d.created_at > $1::timestamptz)");
      expect(tsParams[0]).toBe("2026-01-01T00:00:00.000Z");

      const objParams: unknown[] = [];
      const objSql = compileWhereClause(
        { field: "meta", op: "==", value: { a: 1 } },
        objParams
      );
      expect(objSql).toContain("d.data @> $1::jsonb AND (d.data #> $2::text[]) = $3::jsonb");
    });

    it("enforces SQL range type-parity and TTL expiry in memory", () => {
      const doc = {
        documentId: "d1",
        collectionPath: "col",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2020-01-01T00:00:00.000Z",
        data: { label: "hello", score: 10 },
      };
      // Cross-type range comparison must return false (matching SQL jsonb_typeof guard)
      expect(documentMatchesWhereClause(doc, { field: "label", op: ">", value: 5 })).toBe(false);
      // Expired TTL document must not match live query
      const q = validateAndNormalizeQuery({ collectionPath: "col" });
      expect(documentMatchesQuery(doc, q)).toBe(false);
    });

    it("matches composite indexes commutatively on equality prefix and picks the narrowest index", () => {
      const query = validateAndNormalizeQuery({
        collectionPath: "orders",
        where: [
          { field: "status", op: "==", value: "paid" },
          { field: "region", op: "==", value: "eu" },
        ],
        orderBy: [{ field: "createdAt", dir: "desc" }],
      });

      const indexes = [
        {
          id: "idx-wide",
          collectionPath: "orders",
          fields: [
            { path: "region", dir: "asc" as const },
            { path: "status", dir: "asc" as const },
            { path: "createdAt", dir: "desc" as const },
            { path: "extra", dir: "asc" as const },
          ],
          status: "ready" as const,
        },
        {
          id: "idx-exact",
          collectionPath: "orders",
          fields: [
            { path: "region", dir: "asc" as const },
            { path: "status", dir: "asc" as const },
            { path: "createdAt", dir: "desc" as const },
          ],
          status: "ready" as const,
        },
      ];

      const { matchedIndex } = selectCompositeIndexForQuery(query, indexes);
      expect(matchedIndex?.id).toBe("idx-exact");
    });
  });
