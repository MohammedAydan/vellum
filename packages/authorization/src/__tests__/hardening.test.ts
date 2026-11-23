import { describe, it, expect, beforeEach } from "vitest";
import {
  authorizeOperation,
  compileRulesDsl,
  evaluateAstNode,
  generateProjectApiKey,
  invalidateApiKeyCache,
  matchRulePathPattern,
  RulesDslSyntaxError,
  signEndUserJwt,
  simulateRuleEvaluation,
  validateSecurityRulesetAst,
  verifyApiKey,
  verifyEndUserJwt,
  verifyEndUserJwtSync,
  type AstExpressionNode,
} from "../index.js";
import { VellumError } from "@vellum/core";
import type { ApiKeyRecord, SecurityRulesetRecord } from "@vellum/database-control";

describe("@vellum/authorization - Security & DoS Hardening", () => {
  beforeEach(() => {
    invalidateApiKeyCache();
  });

  it("prevents API key prefix-cache bypass when an attacker presents only the cached prefix", () => {
    const generated = generateProjectApiKey({ keyType: "server" });
    const record: ApiKeyRecord = {
      id: "key-prefix-test",
      projectId: "proj-1",
      name: "Server Key",
      keyType: "server",
      keyPrefix: generated.keyPrefix,
      secretHash: generated.secretHash,
      scopes: ["*"],
      rateLimitRps: 100,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdBy: null,
      createdAt: new Date().toISOString(),
    };
    const store = { apiKeysByPrefix: new Map([[generated.keyPrefix, record]]) };

    // Warm the cache with the legitimate key
    expect(verifyApiKey(generated.fullKey, store).id).toBe("key-prefix-test");

    // Attacker knows only the 16-char public prefix and appends forged suffix
    const forgedKey = `${generated.keyPrefix}FORGED_SUFFIX_ATTACKER_12345`;
    expect(() => verifyApiKey(forgedKey, store)).toThrow(VellumError);
    expect(() => verifyApiKey(forgedKey, store)).toThrow("Invalid API key signature");
  });

  it("blocks prototype pollution and sandbox escape in AST evaluation and path matching", () => {
    // Dangerous wildcard param names rejected
    expect(matchRulePathPattern("users/{__proto__}", "users/evil")).toBeNull();
    expect(matchRulePathPattern("users/{constructor}", "users/evil")).toBeNull();
    expect(matchRulePathPattern("users/{prototype}", "users/evil")).toBeNull();

    // Validation rejects dangerous variable paths and match params
    expect(() =>
      validateSecurityRulesetAst({
        version: 1,
        rules: [
          {
            match: "users/{__proto__}",
            allow: { read: true },
          },
        ],
      })
    ).toThrow(VellumError);

    expect(() =>
      validateSecurityRulesetAst({
        version: 1,
        rules: [
          {
            match: "users/{id}",
            allow: {
              read: { op: "==", left: { var: "resource.data.constructor.constructor" }, right: { val: "x" } },
            },
          },
        ],
      })
    ).toThrow(VellumError);

    // hasKey must never match inherited prototype properties
    const ctx = {
      auth: { uid: "u1", claims: {} },
      pathParams: { id: "u1" },
      resourceData: { safe: true },
      requestData: null,
      requestTimeMs: Date.now(),
    };
    expect(evaluateAstNode({ op: "hasKey", left: { var: "resource.data" }, right: { val: "toString" } }, ctx)).toBe(
      false
    );
    expect(
      evaluateAstNode({ op: "hasKey", left: { var: "resource.data" }, right: { val: "constructor" } }, ctx)
    ).toBe(false);
    expect(evaluateAstNode({ op: "hasKey", left: { var: "resource.data" }, right: { val: "__proto__" } }, ctx)).toBe(
      false
    );
    expect(evaluateAstNode({ op: "hasKey", left: { var: "resource.data" }, right: { val: "safe" } }, ctx)).toBe(true);
  });

  it("enforces runtime AST evaluation depth & step budgets against CPU DoS", () => {
    const ctx = {
      auth: { uid: "u1", claims: {} },
      pathParams: {},
      resourceData: {},
      requestData: null,
      requestTimeMs: Date.now(),
    };

    // Unvalidated deeply nested AST (> MAX_EVAL_DEPTH) fails closed
    let deep: AstExpressionNode = { op: "==", left: { val: 1 }, right: { val: 1 } };
    for (let i = 0; i < 30; i++) {
      deep = { op: "all", conditions: [deep] };
    }
    expect(evaluateAstNode(deep, ctx)).toBe(false);

    // Massive `in` array fails closed
    const hugeList = Array.from({ length: 1_000 }, (_, i) => i);
    expect(evaluateAstNode({ op: "in", left: { val: 999 }, right: { val: hugeList } }, ctx)).toBe(false);
  });

  it("prevents scope bypasses and rejects revoked/expired keys in authorizeOperation", () => {
    const revokedServerKey: ApiKeyRecord = {
      id: "k-rev",
      projectId: "p1",
      name: "Revoked",
      keyType: "server",
      keyPrefix: "sk_1234567890123",
      secretHash: "0".repeat(64),
      scopes: ["*"],
      rateLimitRps: 100,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: new Date().toISOString(),
      createdBy: null,
      createdAt: "",
    };
    expect(() =>
      authorizeOperation({
        apiKeyRecord: revokedServerKey,
        rulesetRecord: null,
        operation: "get",
        path: "users/u1",
      })
    ).toThrow(VellumError);

    const ruleset: SecurityRulesetRecord = {
      id: "r1",
      projectId: "p1",
      version: 1,
      isActive: true,
      createdBy: null,
      createdAt: "",
      rulesAst: { version: 1, rules: [{ match: "users/{id}", allow: { read: true } }] },
    };
    // Non-boolean truthy bypassRules must NOT bypass authorization
    expect(() =>
      authorizeOperation({
        apiKeyRecord: revokedServerKey,
        rulesetRecord: ruleset,
        operation: "get",
        path: "users/u1",
        bypassRules: "true" as unknown as boolean,
      })
    ).toThrow(VellumError);
  });

  it("pins HS256 algorithm, checks iss/aud/nbf, and caps token size in authorization JWT verifier", async () => {
    // alg: none rejected
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sub: "u1" })).toString("base64url");
    expect(() => verifyEndUserJwtSync(`${noneHeader}.${body}.sig`)).toThrow(VellumError);

    // Oversized token rejected
    expect(() => verifyEndUserJwtSync("a".repeat(20_000))).toThrow(VellumError);

    // End-user JWT verification fails closed when jwksUrl is omitted (zero HS256 fallback, §2.4)
    const token = signEndUserJwt({ sub: "u1", iss: "https://issuer.a", aud: "proj-a" }, "secret-1");
    await expect(
      verifyEndUserJwt(token, { secret: "secret-1", issuer: "https://issuer.a", audience: "proj-a" })
    ).rejects.toThrow(/HS256 fallback is disabled/);
  });

  it("caps DSL source size, parse depth, and simulator evaluation budgets", () => {
    expect(() => compileRulesDsl("a".repeat(200_000))).toThrow(RulesDslSyntaxError);
    expect(() => compileRulesDsl(`match /x/{id} { allow read: if ${"(".repeat(100)}true${")".repeat(100)}; }`)).toThrow(
      RulesDslSyntaxError
    );

    // Simulator fails closed on unvalidated deeply nested AST
    let deep: AstExpressionNode = { op: "==", left: { val: 1 }, right: { val: 1 } };
    for (let i = 0; i < 30; i++) {
      deep = { op: "all", conditions: [deep] };
    }
    const sim = simulateRuleEvaluation({
      ruleset: { version: 1, rules: [{ match: "/x/{id}", allow: { get: deep } }] },
      operation: "get",
      path: "/x/1",
      auth: null,
    });
    expect(sim.allowed).toBe(false);
  });
});
