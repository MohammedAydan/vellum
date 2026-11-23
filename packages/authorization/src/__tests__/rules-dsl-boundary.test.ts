import { describe, expect, it } from "vitest";
import {
  authorizeOperation,
  compileRulesDsl,
  matchRulePathPattern,
  type ApiKeyRecord,
  type SecurityRulesetRecord,
} from "../index.js";

const publicKey: ApiKeyRecord = {
  id: "key-1",
  projectId: "p1",
  name: "pk",
  keyType: "public",
  keyPrefix: "pk_1234567890",
  secretHash: "h",
  scopes: ["documents:read", "documents:write"],
  rateLimitRps: 100,
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdBy: null,
  createdAt: "",
};

function rulesetFrom(source: string): SecurityRulesetRecord {
  const { ast } = compileRulesDsl(source);
  return {
    id: "r1",
    projectId: "p1",
    version: 1,
    isActive: true,
    createdBy: null,
    createdAt: "",
    rulesAst: ast,
  } as SecurityRulesetRecord;
}

describe("rules DSL output through real authorization", () => {
  const ruleset = rulesetFrom(`
    match /users/{userId} {
      allow read: if request.auth.uid == path.userId;
    }
  `);

  it("allows a real (slash-less) document path for the owner", () => {
    const result = authorizeOperation({
      apiKeyRecord: publicKey,
      rulesetRecord: ruleset,
      operation: "get",
      path: "users/u1",
      authContext: { uid: "u1", claims: {} },
    });
    expect(result.allowed).toBe(true);
  });

  it("still denies another user on the same path", () => {
    expect(() =>
      authorizeOperation({
        apiKeyRecord: publicKey,
        rulesetRecord: ruleset,
        operation: "get",
        path: "users/u1",
        authContext: { uid: "u2", claims: {} },
      })
    ).toThrow();
  });

  it("matches patterns and targets identically with or without a leading slash", () => {
    expect(matchRulePathPattern("/users/{id}", "users/u1")).toEqual({ id: "u1" });
    expect(matchRulePathPattern("users/{id}", "/users/u1")).toEqual({ id: "u1" });
    expect(matchRulePathPattern("/users/{id}", "/users/u1")).toEqual({ id: "u1" });
    expect(matchRulePathPattern("/users/{id}", "users/u1/extra")).toBeNull();
  });
});

describe("rules DSL path parameters", () => {
  it("treats a bare path parameter name as path.<name>", () => {
    const bare = rulesetFrom("match /users/{userId} { allow read: if request.auth.uid == userId; }");
    const result = authorizeOperation({
      apiKeyRecord: publicKey,
      rulesetRecord: bare,
      operation: "get",
      path: "users/u1",
      authContext: { uid: "u1", claims: {} },
    });
    expect(result.allowed).toBe(true);
    expect(() =>
      authorizeOperation({
        apiKeyRecord: publicKey,
        rulesetRecord: bare,
        operation: "get",
        path: "users/u1",
        authContext: { uid: "u2", claims: {} },
      })
    ).toThrow();
  });
});

describe("rules DSL array literals", () => {
  it("keeps boolean elements instead of replacing them with null", () => {
    const { ast, diagnostics } = compileRulesDsl(
      "match /x/{id} { allow read: if resource.data.flag in [true, false, 1, 'a']; }"
    );
    const expr = ast.rules[0]!.allow["get"] as { right: { val: unknown[] } };
    expect(expr.right.val).toEqual([true, false, 1, "a"]);
    expect(JSON.stringify(diagnostics ?? [])).not.toContain("non-literal");
  });
});

describe("rules DSL quoted keyword strings", () => {
  it("keeps 'null', 'true' and 'false' as string literals", () => {
    const { ast } = compileRulesDsl(
      "match /x/{id} { allow read: if isType(resource.data.v, 'null') || resource.data.s in ['true', 'false']; }"
    );
    const json = JSON.stringify(ast.rules[0]!.allow["get"]);
    expect(json).toContain('{"val":"null"}');
    expect(json).toContain('["true","false"]');
  });
});
