import { describe, it, expect } from "vitest";
import { ControlPlaneStore } from "../memory-store.js";
import { validateRelationRuleInputs, MAX_RELATION_RULES_PER_PROJECT } from "../relation-rules.js";

const PROJECT = "00000000-0000-4000-8000-000000000001";

describe("database-control / relation rules validation", () => {
  it("accepts a valid rule set and normalizes targetCollection", () => {
    const rules = validateRelationRuleInputs([
      { collection: "posts", field: "authorId", onDelete: "cascade" },
      { collection: "posts", field: "editorId", onDelete: "restrict", targetCollection: "users" },
    ]);
    expect(rules).toHaveLength(2);
    expect(rules[0]).not.toHaveProperty("targetCollection");
    expect(rules[1]?.targetCollection).toBe("users");
  });

  it("rejects duplicates on (collection, field)", () => {
    expect(() =>
      validateRelationRuleInputs([
        { collection: "posts", field: "authorId", onDelete: "cascade" },
        { collection: "posts", field: "authorId", onDelete: "restrict" },
      ])
    ).toThrowError(/Duplicate relation rule/);
  });

  it("rejects invalid onDelete and empty fields", () => {
    expect(() =>
      validateRelationRuleInputs([{ collection: "posts", field: "", onDelete: "cascade" }])
    ).toThrowError(/index 0/);
    expect(() =>
      validateRelationRuleInputs([
        { collection: "posts", field: "authorId", onDelete: "explode" as never },
      ])
    ).toThrowError(/index 0/);
  });

  it(`caps the rule set at ${MAX_RELATION_RULES_PER_PROJECT}`, () => {
    const rules = Array.from({ length: MAX_RELATION_RULES_PER_PROJECT + 1 }, (_, i) => ({
      collection: "posts",
      field: `ref${i}`,
      onDelete: "cascade" as const,
    }));
    expect(() => validateRelationRuleInputs(rules)).toThrowError(/at most/);
  });
});

describe("database-control / in-memory relation rules store", () => {
  it("starts empty with version 0", () => {
    const store = new ControlPlaneStore();
    expect(store.getRelationRules(PROJECT)).toEqual([]);
    expect(store.getRelationRulesVersion(PROJECT)).toBe(0);
  });

  it("replaces rules, bumps the version, and survives empty replacement", () => {
    const store = new ControlPlaneStore();
    const first = store.replaceRelationRules({
      projectId: PROJECT,
      rules: [{ collection: "posts", field: "authorId", onDelete: "cascade" }],
    });
    expect(first.version).toBe(1);
    expect(store.getRelationRules(PROJECT)).toHaveLength(1);

    const emptied = store.replaceRelationRules({ projectId: PROJECT, rules: [] });
    expect(emptied.version).toBe(2);
    expect(store.getRelationRules(PROJECT)).toEqual([]);
    expect(store.getRelationRulesVersion(PROJECT)).toBe(2);
  });

  it("enforces optimistic concurrency with expectedVersion", () => {
    const store = new ControlPlaneStore();
    store.replaceRelationRules({
      projectId: PROJECT,
      rules: [{ collection: "posts", field: "authorId", onDelete: "cascade" }],
    });
    expect(() =>
      store.replaceRelationRules({
        projectId: PROJECT,
        rules: [],
        expectedVersion: 7,
      })
    ).toThrowError(/version conflict/i);
    expect(() =>
      store.replaceRelationRules({
        projectId: PROJECT,
        rules: [],
        expectedVersion: 1,
      })
    ).not.toThrow();
  });
});
