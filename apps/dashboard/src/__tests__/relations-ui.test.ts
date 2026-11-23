import { describe, expect, it } from "vitest";
import {
  MAX_RELATION_RULES_PER_PROJECT,
  draftsToPayload,
  findCascadeCycles,
  findSelfReferentialRules,
  isVersionConflictError,
  toDraft,
  validateRelationRuleDrafts,
  type RelationRuleDraft,
} from "../routes/_app/orgs.$orgId.projects.$projectId.relations.js";

const rule = (overrides: Partial<RelationRuleDraft> = {}): RelationRuleDraft => ({
  collection: "posts",
  field: "authorId",
  targetCollection: "",
  onDelete: "cascade",
  ...overrides,
});

describe("relations ui — draft validation", () => {
  it("accepts a valid set", () => {
    expect(validateRelationRuleDrafts([rule()])).toEqual([]);
  });

  it("rejects missing collection or field", () => {
    expect(validateRelationRuleDrafts([rule({ collection: " " })])).toContain(
      "relations.errors.missingFields"
    );
    expect(validateRelationRuleDrafts([rule({ field: "" })])).toContain(
      "relations.errors.missingFields"
    );
  });

  it("rejects duplicate collection/field pairs", () => {
    const drafts = [rule(), rule()];
    expect(validateRelationRuleDrafts(drafts)).toContain("relations.errors.duplicate");
  });

  it("enforces the project cap", () => {
    const drafts = Array.from({ length: MAX_RELATION_RULES_PER_PROJECT + 1 }, (_, i) =>
      rule({ field: `ref${i}` })
    );
    expect(validateRelationRuleDrafts(drafts)).toContain("relations.errors.tooMany");
  });

  it("dedupes repeated error kinds", () => {
    const drafts = [rule({ collection: "" }), rule({ collection: "a", field: "" })];
    expect(
      validateRelationRuleDrafts(drafts).filter((key) => key === "relations.errors.missingFields")
    ).toHaveLength(1);
  });
});

describe("relations ui — payload mapping", () => {
  it("trims fields and drops an empty targetCollection", () => {
    const payload = draftsToPayload([
      rule({ collection: " posts ", field: " authorId ", targetCollection: " " }),
      rule({ field: "editorId", targetCollection: "users" }),
    ]);
    expect(payload[0]).toEqual({ collection: "posts", field: "authorId", onDelete: "cascade" });
    expect(payload[0]).not.toHaveProperty("targetCollection");
    expect(payload[1]?.targetCollection).toBe("users");
  });

  it("maps server rules into editable drafts", () => {
    expect(
      toDraft({ collection: "posts", field: "authorId", onDelete: "restrict", targetCollection: null })
    ).toEqual({ collection: "posts", field: "authorId", targetCollection: "", onDelete: "restrict" });
  });
});

describe("relations ui - warnings", () => {
  it("handles a dense 50-rule graph without enumerating paths", () => {
    const drafts = Array.from({ length: 50 }, (_, i) => rule({ collection: `c${i}` }));
    expect(findCascadeCycles(drafts).length).toBeGreaterThan(0);
  });

  it("preserves case-sensitive collection/field identities", () => {
    expect(validateRelationRuleDrafts([rule(), rule({ collection: "POSTS" })])).toEqual([]);
    expect(findSelfReferentialRules([rule({ targetCollection: "POSTS" })])).toEqual([]);
  });
  it("flags rules whose explicit target is their own collection", () => {
    const drafts = [
      rule({ collection: "categories", field: "parentId", targetCollection: "categories" }),
      rule({ collection: "categories", field: "ownerId", targetCollection: "categories" }),
      rule(),
    ];
    expect(findSelfReferentialRules(drafts)).toHaveLength(2);
  });

  it("does not flag target-less rules, which fire on any delete", () => {
    expect(findSelfReferentialRules([rule({ collection: "categories", field: "parentId" })])).toEqual([]);
  });

  it("detects a two-collection cascade cycle once", () => {
    const drafts = [
      rule({ collection: "a", field: "bId", targetCollection: "b" }),
      rule({ collection: "b", field: "aId", targetCollection: "a" }),
    ];
    const cycles = findCascadeCycles(drafts);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(["a", "b"]);
  });

  it("detects a three-collection cycle and ignores self-loops", () => {
    const drafts = [
      rule({ collection: "a", field: "bId", targetCollection: "b" }),
      rule({ collection: "b", field: "cId", targetCollection: "c" }),
      rule({ collection: "c", field: "aId", targetCollection: "a" }),
      rule({ collection: "categories", field: "parentId", targetCollection: "categories" }),
    ];
    const cycles = findCascadeCycles(drafts);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(["a", "b", "c"]);
  });

  it("ignores cycles when one edge is not cascade", () => {
    const drafts = [
      rule({ collection: "a", field: "bId", targetCollection: "b" }),
      rule({ collection: "b", field: "aId", targetCollection: "a", onDelete: "restrict" }),
    ];
    expect(findCascadeCycles(drafts)).toEqual([]);
  });

  it("treats a target-less cascade rule as fanning out to every known collection", () => {
    const drafts = [
      rule({ collection: "a", field: "bId", targetCollection: "b" }),
      rule({ collection: "b", field: "refId" }),
    ];
    const cycles = findCascadeCycles(drafts);
    expect(cycles).toHaveLength(1);
  });
});

describe("relations ui — conflict detection", () => {
  it("recognizes the server conflict message", () => {
    expect(
      isVersionConflictError(new Error("Relation rules version conflict: expected 3, found 4"))
    ).toBe(true);
    expect(isVersionConflictError(new Error("Network request failed"))).toBe(false);
    expect(isVersionConflictError("nope")).toBe(false);
  });
});
