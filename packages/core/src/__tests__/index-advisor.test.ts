import { describe, it, expect } from "vitest";
import {
  analyzeQueryIndexCoverage,
  decodeSuggestPayload,
  buildIndexSuggestionHeaders,
  type IndexAdvisorOptions,
  type IndexAdvisorQuery,
} from "../index-advisor.js";

const OPTIONS: IndexAdvisorOptions = {
  projectId: "11111111-1111-4111-8111-111111111111",
  orgId: "org_acme",
  dashboardBaseUrl: "https://dash.example.com",
};

const fieldsOf = (result: ReturnType<typeof analyzeQueryIndexCoverage>) =>
  result.recommendedFields ?? [];

describe("@vellum/core index advisor", () => {
  it("classifies E/S/R into canonical ESR order with correct directions", () => {
    const result = analyzeQueryIndexCoverage(
      {
        collectionPath: "posts",
        where: [
          { field: "status", op: "==" },
          { field: "type", op: "in" },
          { field: "score", op: ">=" },
          { field: "age", op: ">" },
        ],
        orderBy: [{ field: "createdAt", dir: "desc" }],
      },
      [],
      OPTIONS
    );
    expect(result.equalityFields).toEqual(["status", "type"]);
    expect(result.sortFields).toEqual(["createdAt"]);
    expect(result.rangeFields).toEqual(["age", "score"]);
    expect(fieldsOf(result)).toEqual([
      { path: "status", dir: "asc" },
      { path: "type", dir: "asc" },
      { path: "createdAt", dir: "desc" },
      { path: "age", dir: "asc" },
      { path: "score", dir: "asc" },
    ]);
    expect(result.covered).toBe(false);
  });

  it("dedupes equality/range fields and skips sort-overlapped fields", () => {
    const result = analyzeQueryIndexCoverage(
      {
        collectionPath: "posts",
        where: [
          { field: "status", op: "==" },
          { field: "status", op: "array-contains-any" },
          { field: "age", op: ">=" },
          { field: "age", op: "<=" },
          { field: "createdAt", op: "starts_with_ci" },
        ],
        orderBy: [
          { field: "createdAt", dir: "desc" },
          { field: "name", dir: "asc" },
        ],
      },
      [],
      OPTIONS
    );
    expect(result.equalityFields).toEqual(["status"]);
    expect(result.sortFields).toEqual(["createdAt", "name"]);
    expect(result.rangeFields).toEqual(["age"]);
    expect(fieldsOf(result)).toEqual([
      { path: "status", dir: "asc" },
      { path: "createdAt", dir: "desc" },
      { path: "name", dir: "asc" },
      { path: "age", dir: "asc" },
    ]);
  });

  it("treats a ready index whose fields start with the ESR sequence as covering", () => {
    const query: IndexAdvisorQuery = {
      collectionPath: "posts",
      where: [
        { field: "status", op: "==" },
        { field: "age", op: ">" },
      ],
      orderBy: [{ field: "createdAt", dir: "desc" }],
    };
    const exact = analyzeQueryIndexCoverage(
      query,
      [
        {
          collectionPath: "posts",
          status: "ready",
          fields: [
            { path: "status", dir: "asc" },
            { path: "createdAt", dir: "desc" },
            { path: "age", dir: "asc" },
          ],
        },
      ],
      OPTIONS
    );
    expect(exact.covered).toBe(true);
    expect(exact.recommendedFields).toBeUndefined();

    const prefix = analyzeQueryIndexCoverage(
      query,
      [
        {
          collectionPath: "posts",
          fields: [
            { path: "status", dir: "asc" },
            { path: "createdAt", dir: "desc" },
            { path: "age", dir: "asc" },
            { path: "irrelevantTrailingField", dir: "asc" },
          ],
        },
      ],
      OPTIONS
    );
    expect(prefix.covered).toBe(true);
  });

  it("rejects an index with the right fields in the wrong ESR order", () => {
    const result = analyzeQueryIndexCoverage(
      {
        collectionPath: "posts",
        where: [
          { field: "status", op: "==" },
          { field: "age", op: ">" },
        ],
        orderBy: [{ field: "createdAt", dir: "desc" }],
      },
      [
        {
          collectionPath: "posts",
          status: "ready",
          fields: [
            { path: "age", dir: "asc" },
            { path: "status", dir: "asc" },
            { path: "createdAt", dir: "desc" },
          ],
        },
      ],
      OPTIONS
    );
    expect(result.covered).toBe(false);
    expect(result.fingerprint).toBeDefined();
  });

  it("covers a fully inverted index via reverse scan but not a partially inverted one", () => {
    const query: IndexAdvisorQuery = {
      collectionPath: "posts",
      where: [{ field: "status", op: "==" }],
      orderBy: [{ field: "createdAt", dir: "desc" }],
    };
    const reversed = analyzeQueryIndexCoverage(
      query,
      [
        {
          collectionPath: "posts",
          status: "ready",
          fields: [
            { path: "status", dir: "desc" },
            { path: "createdAt", dir: "asc" },
          ],
        },
      ],
      OPTIONS
    );
    expect(reversed.covered).toBe(true);
    expect(reversed.reason).toContain("reverse scan");

    const partial = analyzeQueryIndexCoverage(
      query,
      [
        {
          collectionPath: "posts",
          status: "ready",
          fields: [
            { path: "status", dir: "desc" },
            { path: "createdAt", dir: "desc" },
          ],
        },
      ],
      OPTIONS
    );
    expect(partial.covered).toBe(false);
  });

  it("ignores non-ready indexes and treats a missing status as ready", () => {
    const query: IndexAdvisorQuery = {
      collectionPath: "posts",
      where: [{ field: "status", op: "==" }],
      orderBy: [{ field: "createdAt", dir: "desc" }],
    };
    const coveringFields = [
      { path: "status", dir: "asc" as const },
      { path: "createdAt", dir: "desc" as const },
    ];
    for (const status of ["building", "failed", "deleting"]) {
      const result = analyzeQueryIndexCoverage(
        query,
        [{ collectionPath: "posts", status, fields: coveringFields }],
        OPTIONS
      );
      expect(result.covered).toBe(false);
    }
    const missingStatus = analyzeQueryIndexCoverage(
      query,
      [{ collectionPath: "posts", fields: coveringFields }],
      OPTIONS
    );
    expect(missingStatus.covered).toBe(true);
  });

  it("uses the single-field fast path for system and ordinary single fields", () => {
    for (const field of ["_id", "documentId", "__name__", "createdAt", "updatedAt", "title"]) {
      const result = analyzeQueryIndexCoverage(
        { collectionPath: "posts", where: [{ field, op: "==" }], orderBy: [] },
        [],
        OPTIONS
      );
      expect(result.covered).toBe(true);
      expect(result.reason).toContain(field);
    }
  });

  it("requires a composite index once two distinct fields are involved", () => {
    const result = analyzeQueryIndexCoverage(
      {
        collectionPath: "posts",
        where: [{ field: "status", op: "==" }],
        orderBy: [{ field: "createdAt", dir: "asc" }],
      },
      [],
      OPTIONS
    );
    expect(result.covered).toBe(false);
    expect(result.reason).toBe(
      "Composite index needed for equality filter on [status] + sort on [createdAt ASC]"
    );
  });

  it("produces deterministic fingerprints sensitive to tenant, collection and fields", () => {
    const query: IndexAdvisorQuery = {
      collectionPath: "posts",
      where: [{ field: "status", op: "==" }],
      orderBy: [{ field: "createdAt", dir: "desc" }],
    };
    const a = analyzeQueryIndexCoverage(query, [], OPTIONS);
    const b = analyzeQueryIndexCoverage(query, [], OPTIONS);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const otherCollection = analyzeQueryIndexCoverage(
      { ...query, collectionPath: "comments" },
      [],
      OPTIONS
    );
    expect(otherCollection.fingerprint).not.toBe(a.fingerprint);

    const otherTenant = analyzeQueryIndexCoverage(query, [], {
      ...OPTIONS,
      projectId: "33333333-3333-4333-8333-333333333333",
    });
    expect(otherTenant.fingerprint).not.toBe(a.fingerprint);
  });

  it("round-trips the base64url suggestion payload with validated fields", () => {
    const result = analyzeQueryIndexCoverage(
      {
        collectionPath: "posts",
        where: [{ field: "status", op: "==" }],
        orderBy: [{ field: "createdAt", dir: "desc" }],
      },
      [],
      OPTIONS
    );
    expect(result.suggestPayload).toBeDefined();
    expect(result.suggestPayload).not.toContain("+");
    expect(result.suggestPayload).not.toContain("/");
    const decoded = decodeSuggestPayload(result.suggestPayload!);
    expect(decoded).not.toBeNull();
    expect(decoded).toMatchObject({
      orgId: "org_acme",
      projectId: OPTIONS.projectId,
      collectionPath: "posts",
      fingerprint: result.fingerprint,
      fields: [
        { path: "status", dir: "asc" },
        { path: "createdAt", dir: "desc" },
      ],
    });
    expect(decoded?.reason).toBe(result.reason);
  });

  it("builds the dashboard deep link in the documented shape", () => {
    const result = analyzeQueryIndexCoverage(
      {
        collectionPath: "posts",
        where: [{ field: "status", op: "==" }],
        orderBy: [{ field: "createdAt", dir: "desc" }],
      },
      [],
      OPTIONS
    );
    expect(result.dashboardUrl).toBe(
      `https://dash.example.com/app/orgs/org_acme/projects/${OPTIONS.projectId}/indexes?suggest=${result.suggestPayload}`
    );
  });

  it("emits suggestion headers only for uncovered queries", () => {
    const uncovered = analyzeQueryIndexCoverage(
      {
        collectionPath: "posts",
        where: [{ field: "status", op: "==" }],
        orderBy: [{ field: "createdAt", dir: "desc" }],
      },
      [],
      OPTIONS
    );
    const headers = buildIndexSuggestionHeaders(uncovered);
    expect(Object.keys(headers).sort()).toEqual([
      "x-vellum-index-suggestion",
      "x-vellum-index-url",
    ]);
    expect(headers["x-vellum-index-url"]).toBe(uncovered.dashboardUrl);
    expect(JSON.parse(headers["x-vellum-index-suggestion"]!)).toEqual(
      decodeSuggestPayload(uncovered.suggestPayload!)
    );

    const covered = analyzeQueryIndexCoverage(
      { collectionPath: "posts", where: [{ field: "title", op: "==" }], orderBy: [] },
      [],
      OPTIONS
    );
    expect(buildIndexSuggestionHeaders(covered)).toEqual({});
  });

  it("treats text_search / contains_ci as unclassified and stays covered for a single field", () => {
    const single = analyzeQueryIndexCoverage(
      {
        collectionPath: "posts",
        where: [{ field: "title", op: "text_search" }],
        orderBy: [],
      },
      [],
      OPTIONS
    );
    expect(single.covered).toBe(true);
    expect(single.recommendedFields).toBeUndefined();
    expect(single.reason).toContain("title");
  });

  it("recommends a conservative sorted prefix for multiple unclassified V2 operators", () => {
    const result = analyzeQueryIndexCoverage(
      {
        collectionPath: "search",
        where: [
          { field: "title", op: "contains_ci" },
          { field: "body", op: "text_search" },
        ],
        orderBy: [],
      },
      [],
      OPTIONS
    );
    expect(result.covered).toBe(false);
    expect(result.recommendedFields).toEqual([
      { path: "body", dir: "asc" },
      { path: "title", dir: "asc" },
    ]);
    expect(decodeSuggestPayload(result.suggestPayload!)?.collectionPath).toBe("search");
  });

  it("rejects malformed, oversized and structurally invalid payloads", () => {
    const result = analyzeQueryIndexCoverage(
      {
        collectionPath: "posts",
        where: [{ field: "status", op: "==" }],
        orderBy: [{ field: "createdAt", dir: "desc" }],
      },
      [],
      OPTIONS
    );
    expect(decodeSuggestPayload("not-base64%%%")).toBeNull();
    expect(decodeSuggestPayload("x".repeat(9 * 1024))).toBeNull();
    expect(decodeSuggestPayload(Buffer.from("{bad json", "utf8").toString("base64url"))).toBeNull();
    expect(
      decodeSuggestPayload(Buffer.from(JSON.stringify({ orgId: "org" }), "utf8").toString("base64url"))
    ).toBeNull();

    const payload = JSON.parse(Buffer.from(result.suggestPayload!, "base64url").toString("utf8")) as Record<string, unknown>;
    const badDir = { ...payload, fields: [{ path: "status", dir: "sideways" }] };
    expect(
      decodeSuggestPayload(Buffer.from(JSON.stringify(badDir), "utf8").toString("base64url"))
    ).toBeNull();
    const badFields = { ...payload, fields: "status" };
    expect(
      decodeSuggestPayload(Buffer.from(JSON.stringify(badFields), "utf8").toString("base64url"))
    ).toBeNull();
  });
});
