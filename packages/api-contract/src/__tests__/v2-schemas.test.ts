import { describe, it, expect } from "vitest";
import {
  V2QueryOperatorEnum,
  QueryOperatorEnum,
  QueryFilterSchema,
  QuerySpecSchema,
  OrGroupsSchema,
  IncludeSpecSchema,
  DotPathSchema,
  TTL_SECONDS_SCHEMA,
  ExpiresAtSchema,
  AggregateRequestSchema,
  AggregateResultSchema,
  BulkDeleteRequestSchema,
  BulkDeleteResultSchema,
  CompileRulesDslSchema,
  DecompileRulesSchema,
  SimulateRulesSchema,
  SecurityRulesetAstSchema,
  IndexRecommendationSchema,
  IndexRecommendationListResponseSchema,
} from "../index.js";

const MINIMAL_AST = {
  version: 1 as const,
  rules: [
    {
      match: "posts/{postId}",
      allow: {
        get: true,
        list: { op: "==" as const, left: { var: "auth.uid" }, right: { var: "path.postId" } },
      },
    },
  ],
};

describe("@vellum/api-contract - V2 schemas", () => {
  describe("V2 query operators and filters", () => {
    it("adds the three text operators without mutating the v1 operator set", () => {
      expect(V2QueryOperatorEnum.options).toContain("contains_ci");
      expect(V2QueryOperatorEnum.options).toContain("starts_with_ci");
      expect(V2QueryOperatorEnum.options).toContain("text_search");
      expect(V2QueryOperatorEnum.options).toHaveLength(13);
      expect(QueryOperatorEnum.options).toHaveLength(10);
      expect(QueryOperatorEnum.options).not.toContain("text_search");
    });

    it("accepts V2 operators on a QueryFilter", () => {
      for (const op of ["contains_ci", "starts_with_ci", "text_search"] as const) {
        const result = QueryFilterSchema.safeParse({ field: "title", op, value: "hello" });
        expect(result.success, op).toBe(true);
      }
    });

    it("requires a non-empty string value for text operators", () => {
      expect(QueryFilterSchema.safeParse({ field: "t", op: "contains_ci", value: 42 }).success).toBe(false);
      expect(QueryFilterSchema.safeParse({ field: "t", op: "text_search", value: "" }).success).toBe(false);
    });

    it("accepts V2 operators inside QuerySpecSchema", () => {
      const parsed = QuerySpecSchema.safeParse({
        collectionPath: "posts",
        where: [{ field: "title", op: "contains_ci", value: "hello" }],
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe("or groups", () => {
    it("accepts up to 10 disjunctive groups", () => {
      const groups = Array.from({ length: 10 }, () => [{ field: "status", op: "==", value: "x" }]);
      expect(OrGroupsSchema.safeParse(groups).success).toBe(true);
    });

    it("rejects more than 10 groups and invalid inner filters", () => {
      const groups = Array.from({ length: 11 }, () => [{ field: "status", op: "==", value: "x" }]);
      expect(OrGroupsSchema.safeParse(groups).success).toBe(false);
      expect(OrGroupsSchema.safeParse([[{ field: "x", op: "not-an-op", value: 1 }]]).success).toBe(false);
    });

    it("flows through QuerySpecSchema", () => {
      const parsed = QuerySpecSchema.safeParse({
        collectionPath: "posts",
        or: [
          [{ field: "status", op: "==", value: "published" }],
          [{ field: "ownerId", op: "==", value: "u1" }],
        ],
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.or).toHaveLength(2);
    });
  });

  describe("dot paths, include, ttl and select", () => {
    it("accepts dot paths and rejects empty segments", () => {
      expect(DotPathSchema.safeParse("author.profile.name").success).toBe(true);
      expect(DotPathSchema.safeParse("author..name").success).toBe(false);
      expect(DotPathSchema.safeParse("").success).toBe(false);
    });

    it("accepts nested includes up to three levels only", () => {
      const level3 = { field: "grandparent" };
      const level2 = { field: "parent", include: [level3] };
      const level1 = { field: "ownerId", collection: "users", as: "owner", select: ["name"], include: [level2] };
      expect(IncludeSpecSchema.safeParse(level1).success).toBe(true);

      const tooDeep = {
        field: "ownerId",
        include: [{ field: "parent", include: [{ field: "grandparent", include: [{ field: "tooDeep" }] }] }],
      };
      expect(IncludeSpecSchema.safeParse(tooDeep).success).toBe(false);
    });

    it("validates ttlSeconds and expiresAt on QuerySpec", () => {
      expect(TTL_SECONDS_SCHEMA.safeParse(0).success).toBe(true);
      expect(TTL_SECONDS_SCHEMA.safeParse(-1).success).toBe(false);
      expect(ExpiresAtSchema.safeParse("2030-01-01T00:00:00.000Z").success).toBe(true);
      expect(ExpiresAtSchema.safeParse("not-a-date").success).toBe(false);

      const parsed = QuerySpecSchema.safeParse({
        collectionPath: "sessions",
        select: ["token.value", "user.name"],
        include: [{ field: "ownerId", collection: "users" }],
        ttlSeconds: 3600,
        expiresAt: "2030-01-01T00:00:00.000Z",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.ttlSeconds).toBe(3600);
        expect(parsed.data.select).toEqual(["token.value", "user.name"]);
      }
    });
  });

  describe("AggregateRequestSchema", () => {
    it("accepts a valid aggregate request with defaults", () => {
      const parsed = AggregateRequestSchema.safeParse({
        collectionPath: "orders",
        where: [{ field: "status", op: "==", value: "paid" }],
        groupBy: ["customerId"],
        metrics: {
          total: { op: "sum", field: "amount" },
          count: { op: "count" },
        },
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.where).toEqual([{ field: "status", op: "==", value: "paid" }]);
        expect(parsed.data.groupBy).toEqual(["customerId"]);
      }

      const withDefaults = AggregateRequestSchema.safeParse({
        collectionPath: "orders",
        metrics: { count: { op: "count" } },
      });
      expect(withDefaults.success).toBe(true);
      if (withDefaults.success) {
        expect(withDefaults.data.where).toEqual([]);
        expect(withDefaults.data.groupBy).toEqual([]);
      }
    });

    it("rejects empty metrics and non-count metrics without a field", () => {
      expect(AggregateRequestSchema.safeParse({ collectionPath: "orders", metrics: {} }).success).toBe(false);
      expect(
        AggregateRequestSchema.safeParse({ collectionPath: "orders", metrics: { avg: { op: "avg" } } }).success
      ).toBe(false);
    });

    it("validates aggregate results", () => {
      expect(AggregateResultSchema.safeParse({ rows: [{ total: 10 }], executionTimeMs: 1.2 }).success).toBe(true);
    });
  });

  describe("BulkDeleteRequestSchema", () => {
    it("accepts where, or and limit", () => {
      const parsed = BulkDeleteRequestSchema.safeParse({
        collectionPath: "sessions",
        where: [{ field: "expired", op: "==", value: true }],
        or: [[{ field: "ownerId", op: "==", value: "u1" }]],
        limit: 25,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.limit).toBe(25);
    });

    it("rejects an out-of-range limit", () => {
      expect(BulkDeleteRequestSchema.safeParse({ collectionPath: "sessions", limit: 0 }).success).toBe(false);
      // 5,000 is the engine's hard bulk-delete ceiling; 5,001 must be rejected.
      expect(BulkDeleteRequestSchema.safeParse({ collectionPath: "sessions", limit: 5001 }).success).toBe(false);
      expect(BulkDeleteRequestSchema.safeParse({ collectionPath: "sessions", limit: 1000 }).success).toBe(true);
      expect(BulkDeleteResultSchema.safeParse({ deletedCount: 3 }).success).toBe(true);
    });
  });

  describe("Rules DSL schemas", () => {
    it("accepts source and its aliases for compile", () => {
      expect(CompileRulesDslSchema.safeParse({ source: "rules_version = '2';" }).success).toBe(true);
      const aliased = CompileRulesDslSchema.safeParse({ dsl: "rules_version = '2';" });
      expect(aliased.success).toBe(true);
      if (aliased.success) expect(aliased.data.source).toBe("rules_version = '2';");
      expect(CompileRulesDslSchema.safeParse({}).success).toBe(false);
    });

    it("validates the v1 AST shape", () => {
      expect(SecurityRulesetAstSchema.safeParse(MINIMAL_AST).success).toBe(true);
      expect(SecurityRulesetAstSchema.safeParse({ version: 2, rules: [] }).success).toBe(false);
      expect(SecurityRulesetAstSchema.safeParse({ version: 1, rules: [{ match: "x" }] }).success).toBe(false);
    });

    it("accepts wrapped or bare AST for decompile", () => {
      expect(DecompileRulesSchema.safeParse({ rulesAst: MINIMAL_AST }).success).toBe(true);
      expect(DecompileRulesSchema.safeParse(MINIMAL_AST).success).toBe(true);
    });

    it("validates simulate requests", () => {
      const base = {
        operation: "get",
        path: "posts/p1",
        auth: { uid: "u1" },
        resourceData: { ownerId: "u1" },
        incomingData: null,
      };
      expect(SimulateRulesSchema.safeParse(base).success).toBe(true);
      expect(SimulateRulesSchema.safeParse({ ...base, rulesAst: MINIMAL_AST }).success).toBe(true);
      expect(SimulateRulesSchema.safeParse({ ...base, operation: "execute" }).success).toBe(false);
      expect(SimulateRulesSchema.safeParse({ ...base, path: "" }).success).toBe(false);
    });
  });

  describe("IndexRecommendationSchema", () => {
    const row = {
      id: "rec_1",
      projectId: "proj_1",
      fingerprint: "abc123",
      collectionPath: "posts",
      recommendedFields: [{ path: "status", dir: "asc" }, { path: "createdAt", dir: "desc" }],
      sampleQuery: { collectionPath: "posts" },
      reason: "Composite index needed",
      hitCount: 4,
      totalDurationMs: 120,
      maxDurationMs: 40,
      status: "pending",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    it("validates a recommendation row and list response", () => {
      expect(IndexRecommendationSchema.safeParse(row).success).toBe(true);
      expect(IndexRecommendationListResponseSchema.safeParse({ recommendations: [row] }).success).toBe(true);
    });

    it("rejects invalid directions and statuses", () => {
      expect(IndexRecommendationSchema.safeParse({ ...row, recommendedFields: [{ path: "x", dir: "sideways" }] }).success).toBe(false);
      expect(IndexRecommendationSchema.safeParse({ ...row, status: "unknown" }).success).toBe(false);
    });
  });
});
