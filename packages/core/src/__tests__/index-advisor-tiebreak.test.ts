import { describe, it, expect } from "vitest";
import { analyzeQueryIndexCoverage } from "../index-advisor.js";

const options = { projectId: "p", orgId: "o", dashboardBaseUrl: "https://dash.example" };

describe("index advisor", () => {
  it("does not ask for a composite index for one field plus the engine's documentId tie-breaker", () => {
    const res = analyzeQueryIndexCoverage(
      {
        collectionPath: "posts",
        where: [{ field: "title", op: "contains_ci", value: "a" }],
        orderBy: [{ field: "documentId", dir: "asc" }],
      } as never,
      [],
      options
    );
    expect(res.covered).toBe(true);
  });

  it("omits the dashboard link when no dashboard origin is configured", () => {
    const res = analyzeQueryIndexCoverage(
      {
        collectionPath: "posts",
        where: [{ field: "a", op: "==", value: 1 }, { field: "b", op: ">", value: 1 }],
        orderBy: [{ field: "c", dir: "asc" }],
      } as never,
      [],
      { ...options, dashboardBaseUrl: "" }
    );
    expect(res.covered).toBe(false);
    expect(res.dashboardUrl).toBeUndefined();
    expect(res.suggestPayload).toBeTruthy();
  });
});
