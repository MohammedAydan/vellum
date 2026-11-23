import { describe, it, expect, beforeEach } from "vitest";
import {
  generateProjectApiKey,
  hashApiKey,
  verifyApiKey,
  invalidateApiKeyCache,
  signEndUserJwt,
  verifyEndUserJwt,
  verifyEndUserJwtSync,
  validateSecurityRulesetAst,
  matchRulePathPattern,
  evaluateAstNode,
  authorizeOperation,
  type AstExpression,
  type AstExpressionNode,
} from "../index.js";
import { VellumError } from "@vellum/core";
import type { ApiKeyRecord, SecurityRulesetRecord } from "@vellum/database-control";

describe("@vellum/authorization", () => {
  beforeEach(() => {
    invalidateApiKeyCache();
  });

  describe("API Keys", () => {
    it("generates public and server keys with the canonical prefix", () => {
      const pk = generateProjectApiKey({ keyType: "public" });
      expect(pk.fullKey.startsWith("pk_")).toBe(true);
      expect(pk.keyPrefix.length).toBe(16);
      expect(pk.secretHash).toBeDefined();

      const sk = generateProjectApiKey({ keyType: "server" });
      expect(sk.fullKey.startsWith("sk_")).toBe(true);
      expect(sk.fullKey.length).toBeGreaterThan(pk.fullKey.length);
    });

    it("verifies a valid API key with constant-time check and caching", () => {
      const generated = generateProjectApiKey({ keyType: "public" });
      const record: ApiKeyRecord = {
        id: "key-1",
        projectId: "proj-1",
        name: "Test Key",
        keyType: "public",
        keyPrefix: generated.keyPrefix,
        secretHash: generated.secretHash,
        scopes: ["documents:read", "documents:write"],
        rateLimitRps: 100,
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        createdBy: null,
        createdAt: new Date().toISOString(),
      };

      const mockStore = {
        apiKeysByPrefix: new Map([[generated.keyPrefix, record]]),
      };

      const verified = verifyApiKey(generated.fullKey, mockStore);
      expect(verified.id).toBe("key-1");
      expect(verified.lastUsedAt).toBeDefined();

      // Second verification hits cache
      const cached = verifyApiKey(generated.fullKey, mockStore);
      expect(cached.id).toBe("key-1");
    });

    it("stops accepting a revoked key even while it is cached", () => {
      const generated = generateProjectApiKey({ keyType: "server" });
      const record: ApiKeyRecord = {
        id: "key-revoke",
        projectId: "proj-1",
        name: "Revocable Key",
        keyType: "server",
        keyPrefix: generated.keyPrefix,
        secretHash: generated.secretHash,
        scopes: ["documents:read", "documents:write"],
        rateLimitRps: 100,
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        createdBy: null,
        createdAt: new Date().toISOString(),
      };
      const store = { apiKeysByPrefix: new Map([[generated.keyPrefix, record]]) };

      expect(verifyApiKey(generated.fullKey, store).id).toBe("key-revoke");
      // Revocation removes the key from the live Control Plane store.
      store.apiKeysByPrefix.delete(generated.keyPrefix);
      expect(() => verifyApiKey(generated.fullKey, store)).toThrow(VellumError);
      expect(() => verifyApiKey(generated.fullKey, store)).toThrow("Invalid or revoked API key");
    });

    it("rejects malformed, revoked, expired, or tampered keys", () => {
      const mockStore = { apiKeysByPrefix: new Map() };
      expect(() => verifyApiKey("short", mockStore)).toThrow(VellumError);

      const gen = generateProjectApiKey({ keyType: "public" });
      // Non-existent
      expect(() => verifyApiKey(gen.fullKey, mockStore)).toThrow(VellumError);

      // Revoked
      const revokedRecord: ApiKeyRecord = {
        id: "k-revoked",
        projectId: "p1",
        name: "Revoked",
        keyType: "public",
        keyPrefix: gen.keyPrefix,
        secretHash: gen.secretHash,
        scopes: [],
        rateLimitRps: 10,
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: new Date().toISOString(),
        createdBy: null,
        createdAt: new Date().toISOString(),
      };
      mockStore.apiKeysByPrefix.set(gen.keyPrefix, revokedRecord);
      expect(() => verifyApiKey(gen.fullKey, mockStore)).toThrow(VellumError);

      // Expired
      const expiredRecord = {
        ...revokedRecord,
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      };
      mockStore.apiKeysByPrefix.set(gen.keyPrefix, expiredRecord);
      expect(() => verifyApiKey(gen.fullKey, mockStore)).toThrow(VellumError);

      // Tampered
      const activeRecord = {
        ...revokedRecord,
        revokedAt: null,
        expiresAt: null,
        secretHash: hashApiKey("different_key"),
      };
      mockStore.apiKeysByPrefix.set(gen.keyPrefix, activeRecord);
      expect(() => verifyApiKey(gen.fullKey, mockStore)).toThrow(VellumError);
    });
  });

  describe("End-User JWT", () => {
    it("signs and verifies tokens synchronously and asynchronously", async () => {
      const payload = { sub: "user_123", email: "user@test.com", role: "member" };
      const token = signEndUserJwt(payload, "secret-123");

      const syncRes = verifyEndUserJwtSync(token, "secret-123");
      expect(syncRes.uid).toBe("user_123");
      expect(syncRes.claims["email"]).toBe("user@test.com");

      await expect(
        verifyEndUserJwt(`Bearer ${token}`, { secret: "secret-123" })
      ).rejects.toThrow(/HS256 fallback is disabled/);
    });

    it("rejects expired or tampered tokens", async () => {
      const expiredToken = signEndUserJwt({ sub: "u1", exp: Math.floor(Date.now() / 1000) - 10 });
      expect(() => verifyEndUserJwtSync(expiredToken)).toThrow(VellumError);

      const validToken = signEndUserJwt({ sub: "u1", exp: Math.floor(Date.now() / 1000) + 3600 }, "secret-1");
      expect(() => verifyEndUserJwtSync(validToken, "wrong-secret")).toThrow(VellumError);

      expect(() => verifyEndUserJwtSync("not.a.valid.jwt.token")).toThrow(VellumError);
    });

    it("returns null context when no token provided", async () => {
      const res = await verifyEndUserJwt(null);
      expect(res.uid).toBeNull();
      expect(res.claims).toEqual({});
    });
  });

  describe("Declarative Security Rules AST", () => {
    it("validates rule AST against quotas (maxDepth <= 10, maxNodes <= 100)", () => {
      const validAst = {
        version: 1,
        rules: [
          {
            match: "users/{userId}",
            allow: {
              read: true,
              write: {
                op: "==",
                left: { var: "auth.uid" },
                right: { var: "path.userId" },
              },
            },
          },
        ],
      };
      expect(validateSecurityRulesetAst(validAst)).toBe(true);

      // Invalid version
      expect(() => validateSecurityRulesetAst({ version: 2, rules: [] })).toThrow(VellumError);

      // Deep nesting exceeds 10
      let deepExpr: AstExpressionNode = { op: "==", left: { val: 1 }, right: { val: 1 } };
      for (let i = 0; i < 11; i++) {
        deepExpr = { op: "all", conditions: [deepExpr] };
      }
      expect(() =>
        validateSecurityRulesetAst({
          version: 1,
          rules: [{ match: "col/{id}", allow: { read: deepExpr } }],
        })
      ).toThrow(VellumError);
    });

    it("matches rule path patterns and wildcards", () => {
      expect(matchRulePathPattern("users/{userId}", "users/u_100")).toEqual({ userId: "u_100" });
      expect(matchRulePathPattern("users/{userId}", "orders/o_100")).toBeNull();
      expect(matchRulePathPattern("users/{userId}/orders/{orderId}", "users/u_1/orders/o_99")).toEqual({
        userId: "u_1",
        orderId: "o_99",
      });
      // Recursive wildcard
      expect(matchRulePathPattern("orgs/{orgId}/docs/{path=**}", "orgs/acme/docs/folder/subfolder/file.txt")).toEqual({
        orgId: "acme",
        path: "folder/subfolder/file.txt",
      });
    });

    it("evaluates AST operators correctly", () => {
      const ctx = {
        auth: { uid: "user_1", claims: { role: "admin" } },
        pathParams: { userId: "user_1" },
        resourceData: { score: 95, tags: ["pro", "active"], profile: { level: 2 }, isSpecial: true, nullVal: null, taggedInt: { $t: "int", $v: "10" } },
        requestData: { score: 100 },
        requestTimeMs: 1000,
      };

      // == and !=
      expect(evaluateAstNode({ op: "==", left: { var: "auth.uid" }, right: { var: "path.userId" } }, ctx)).toBe(true);
      expect(evaluateAstNode({ op: "!=", left: { var: "auth.uid" }, right: { val: "other" } }, ctx)).toBe(true);

      // comparisons
      expect(evaluateAstNode({ op: ">", left: { var: "resource.data.score" }, right: { val: 90 } }, ctx)).toBe(true);
      expect(evaluateAstNode({ op: "<=", left: { var: "resource.data.score" }, right: { val: 95 } }, ctx)).toBe(true);
      expect(evaluateAstNode({ op: "<", left: { var: "resource.data.score" }, right: { val: 100 } }, ctx)).toBe(true);
      expect(evaluateAstNode({ op: ">=", left: { var: "resource.data.score" }, right: { val: 95 } }, ctx)).toBe(true);

      // in array
      expect(evaluateAstNode({ op: "in", left: { val: "pro" }, right: { var: "resource.data.tags" } }, ctx)).toBe(true);
      expect(evaluateAstNode({ op: "in", left: { val: "unknown" }, right: { var: "resource.data.tags" } }, ctx)).toBe(false);

      // hasKey and isType
      expect(evaluateAstNode({ op: "hasKey", left: { var: "resource.data" }, right: { val: "profile" } }, ctx)).toBe(true);
      expect(evaluateAstNode({ op: "isType", left: { var: "resource.data.score" }, right: { val: "number" } }, ctx)).toBe(true);
      expect(evaluateAstNode({ op: "isType", left: { var: "resource.data.tags" }, right: { val: "array" } }, ctx)).toBe(true);
      expect(evaluateAstNode({ op: "isType", left: { var: "resource.data.isSpecial" }, right: { val: "bool" } }, ctx)).toBe(true);
      expect(evaluateAstNode({ op: "isType", left: { var: "resource.data.nullVal" }, right: { val: "null" } }, ctx)).toBe(true);
      expect(evaluateAstNode({ op: "isType", left: { var: "resource.data.profile" }, right: { val: "map" } }, ctx)).toBe(true);
      expect(evaluateAstNode({ op: "isType", left: { var: "resource.data.taggedInt" }, right: { val: "int" } }, ctx)).toBe(true);
      expect(evaluateAstNode({ op: "isType", left: { var: "resource.data.score" }, right: { val: "string" } }, ctx)).toBe(false);

      // combinators
      expect(
        evaluateAstNode(
          {
            op: "all",
            conditions: [
              { op: "==", left: { var: "auth.claims.role" }, right: { val: "admin" } },
              { op: ">", left: { var: "resource.data.score" }, right: { val: 50 } },
            ],
          },
          ctx
        )
      ).toBe(true);

      expect(evaluateAstNode({ op: "any", conditions: [{ op: "==", left: { val: 1 }, right: { val: 2 } }, { op: "==", left: { val: 1 }, right: { val: 1 } }] }, ctx)).toBe(true);
      expect(evaluateAstNode({ op: "not", condition: { op: "==", left: { val: 1 }, right: { val: 2 } } }, ctx)).toBe(true);
      expect(evaluateAstNode({ op: "unknown_op" } as unknown as AstExpression, ctx)).toBe(false);
    });

    it("authorizes operation based on server key vs public key rules AST", () => {
      const serverKey: ApiKeyRecord = {
        id: "k-srv",
        projectId: "p1",
        name: "Srv",
        keyType: "server",
        keyPrefix: "sk_1234567890",
        secretHash: "h",
        scopes: ["documents:read", "documents:write", "indexes:manage"],
        rateLimitRps: 100,
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        createdBy: null,
        createdAt: "",
      };

      // Server key bypasses AST
      const srvRes = authorizeOperation({
        apiKeyRecord: serverKey,
        rulesetRecord: null,
        operation: "get",
        path: "users/u_1",
      });
      expect(srvRes.allowed).toBe(true);
      expect(srvRes.mode).toBe("server_key_scope");

      // Server key lacking scope is rejected
      const restrictedSrvKey = { ...serverKey, scopes: ["documents:read"] };
      expect(() =>
        authorizeOperation({
          apiKeyRecord: restrictedSrvKey,
          rulesetRecord: null,
          operation: "create",
          path: "users/u_1",
        })
      ).toThrow(VellumError);

      // Public key evaluates AST
      const publicKey: ApiKeyRecord = {
        ...serverKey,
        keyType: "public",
        keyPrefix: "pk_1234567890",
      };

      const ruleset: SecurityRulesetRecord = {
        id: "r1",
        projectId: "p1",
        version: 1,
        isActive: true,
        createdBy: null,
        createdAt: "",
        rulesAst: {
          version: 1,
          rules: [
            {
              match: "users/{userId}",
              allow: {
                read: true,
                write: {
                  op: "==",
                  left: { var: "auth.uid" },
                  right: { var: "path.userId" },
                },
              },
            },
          ],
        },
      };

      // Public key allowed read
      const pubRead = authorizeOperation({
        apiKeyRecord: publicKey,
        rulesetRecord: ruleset,
        operation: "get",
        path: "users/u_1",
      });
      expect(pubRead.allowed).toBe(true);

      // Public key allowed write when uid matches
      const pubWriteOk = authorizeOperation({
        apiKeyRecord: publicKey,
        rulesetRecord: ruleset,
        operation: "create",
        path: "users/u_1",
        authContext: { uid: "u_1", claims: {} },
      });
      expect(pubWriteOk.allowed).toBe(true);

      // Public key denied write when uid does not match
      expect(() =>
        authorizeOperation({
          apiKeyRecord: publicKey,
          rulesetRecord: ruleset,
          operation: "create",
          path: "users/u_1",
          authContext: { uid: "u_different", claims: {} },
        })
      ).toThrow(VellumError);

      // Public key cannot manage indexes
      expect(() =>
        authorizeOperation({
          apiKeyRecord: publicKey,
          rulesetRecord: ruleset,
          operation: "indexes:manage",
          path: "users",
        })
      ).toThrow(VellumError);
    });
  });
});
