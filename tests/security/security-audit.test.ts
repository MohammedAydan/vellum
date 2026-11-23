/**
 * Comprehensive security, RLS & OWASP Top 10 audit suite (`tests/security/security-audit.test.ts`)
 * Covers:
 * 1. Cross-Tenant Data Isolation
 * 2. HMAC-SHA256 Cursor Tampering & Query Shape Binding
 * 3. Declarative Security Rules AST Boundary Defenses & Traversal Resistance
 * 4. Zero Secret Leakage & Observability Redaction
 * 5. OWASP Top 10 Security Posture Verification
 */

import { describe, it, expect } from "vitest";
import { VellumError, parseDocumentPath } from "@vellum/core";
import {
  encodeQueryCursor,
  decodeAndVerifyQueryCursor,
  computeQueryShapeHash,
} from "@vellum/query-engine";
import {
  validateSecurityRulesetAst,
  evaluateAstNode,
  type SecurityRulesetAst,
  type RuleEvaluationContext,
} from "@vellum/authorization";
import { createVellumPlatform } from "../../apps/api/src/index.js";
import { CustomerDashboardService } from "../../apps/dashboard/src/index.js";
import { PlatformAdminService } from "../../apps/admin/src/index.js";
import type { DataPlaneStore } from "@vellum/storage";

describe("Deep Security Audit", () => {
  describe("4.1.1 — Cross-Tenant Isolation", () => {
    it("Tenant A cannot access, query, or mutate Tenant B documents with exact path knowledge", async () => {
      const platform = createVellumPlatform();
      const dashboard = new CustomerDashboardService({ platform });

      const orgA = platform.controlStore.createOrganization({
        slug: "org-alpha-sec",
        name: "Alpha Secure Org",
        billingEmail: "alpha@sec.io",
      });
      const orgB = platform.controlStore.createOrganization({
        slug: "org-beta-sec",
        name: "Beta Secure Org",
        billingEmail: "beta@sec.io",
      });

      const projA = platform.controlStore.createProject({
        organizationId: orgA.id,
        slug: "app-a",
        name: "Alpha App",
      });
      const projB = platform.controlStore.createProject({
        organizationId: orgB.id,
        slug: "app-b",
        name: "Beta App",
      });

      const { plaintextKeyOnce: keyA } = dashboard.createProjectApiKey({
        projectId: projA.project.id,
        name: "Alpha Server Key",
        keyType: "server",
        scopes: ["documents:read", "documents:write"],
      });

      const { plaintextKeyOnce: keyB } = dashboard.createProjectApiKey({
        projectId: projB.project.id,
        name: "Beta Server Key",
        keyType: "server",
        scopes: ["documents:read", "documents:write"],
      });

      // Write document in Alpha
      const putRes = await platform.fetch(
        new Request(`http://localhost:8080/v1/projects/${projA.project.id}/documents/users/usr_sec_1`, {
          method: "PUT",
          headers: { "x-project-key": keyA, "content-type": "application/json" },
          body: JSON.stringify({ data: { confidential: "alpha-classified" } }),
        })
      );
      expect(putRes.status).toBe(200);

      // Attempt 1: Tenant B key reading Tenant A document path -> 403 Forbidden
      const readRes = await platform.fetch(
        new Request(`http://localhost:8080/v1/projects/${projA.project.id}/documents/users/usr_sec_1`, {
          method: "GET",
          headers: { "x-project-key": keyB },
        })
      );
      expect(readRes.status).toBe(403);

      // Attempt 2: Tenant B querying collection with Tenant B key on Tenant A URL -> 403 Forbidden
      const queryRes = await platform.fetch(
        new Request(`http://localhost:8080/v1/projects/${projA.project.id}/query`, {
          method: "POST",
          headers: { "x-project-key": keyB, "content-type": "application/json" },
          body: JSON.stringify({ collectionPath: "users" }),
        })
      );
      expect(queryRes.status).toBe(403);

      // Attempt 3: Querying Tenant B own project returns ZERO Alpha documents
      const queryOwnRes = await platform.fetch(
        new Request(`http://localhost:8080/v1/projects/${projB.project.id}/query`, {
          method: "POST",
          headers: { "x-project-key": keyB, "content-type": "application/json" },
          body: JSON.stringify({ collectionPath: "users" }),
        })
      );
      expect(queryOwnRes.status).toBe(200);
      const queryOwnData = await queryOwnRes.json();
      expect(queryOwnData.documents).toHaveLength(0);
    });

    it("Revoked API key immediately rejects subsequent requests", async () => {
      const platform = createVellumPlatform();
      const dashboard = new CustomerDashboardService({ platform });

      const org = platform.controlStore.createOrganization({ slug: "rev-org", name: "Rev Org", billingEmail: "rev@io.com" });
      const proj = platform.controlStore.createProject({ organizationId: org.id, slug: "rev-app", name: "Rev App" });

      const { plaintextKeyOnce: key, apiKeyRecord } = dashboard.createProjectApiKey({
        projectId: proj.project.id,
        name: "Temp Key",
        keyType: "server",
        scopes: ["documents:read", "documents:write"],
      });

      // Key works initially
      const okRes = await platform.fetch(
        new Request(`http://localhost:8080/v1/projects/${proj.project.id}/documents/items/item_1`, {
          method: "PUT",
          headers: { "x-project-key": key, "content-type": "application/json" },
          body: JSON.stringify({ data: { title: "active" } }),
        })
      );
      expect(okRes.status).toBe(200);

      // Revoke the key
      platform.controlStore.revokeApiKey(apiKeyRecord.id);

      // Subsequent request is rejected with 401 UNAUTHENTICATED
      const revokedRes = await platform.fetch(
        new Request(`http://localhost:8080/v1/projects/${proj.project.id}/documents/items/item_1`, {
          method: "GET",
          headers: { "x-project-key": key },
        })
      );
      expect(revokedRes.status).toBe(401);
    });

    it("RLS fails closed if tenant transaction context is omitted", () => {
      const platform = createVellumPlatform();
      const memStore = platform.dataStore as DataPlaneStore;

      expect(() => {
        memStore.runInTenantTransaction(null as unknown as string, () => {});
      }).toThrowError(VellumError);

      try {
        memStore.runInTenantTransaction("", () => {});
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(VellumError);
        expect((err as VellumError).code).toBe("PERMISSION_DENIED");
      }
    });
  });

  describe("4.1.2 — HMAC-SHA256 Cursor Tampering Defense", () => {
    const SECRET = "test_hmac_secret_32_characters_123456";
    const qHash = computeQueryShapeHash({
      projectId: "proj_1",
      collectionPath: "users",
      where: [{ field: "age", op: ">=", value: 21 }],
      orderBy: [{ field: "age", direction: "asc" }],
    });

    it("Accepts legitimate HMAC-SHA256 cursor with exact query shape hash", () => {
      const validCursor = encodeQueryCursor(
        { qHash, vals: [25], docId: "user_42" },
        SECRET
      );

      const decoded = decodeAndVerifyQueryCursor(validCursor, qHash, SECRET);
      expect(decoded.docId).toBe("user_42");
      expect(decoded.vals).toEqual([25]);
    });

    it("Detects and rejects bit flip in cursor values payload", () => {
      const validCursor = encodeQueryCursor(
        { qHash, vals: [25], docId: "user_42" },
        SECRET
      );

      // Tamper with values: change 25 to 999 without updating HMAC
      const parsed = JSON.parse(Buffer.from(validCursor, "base64url").toString("utf8"));
      parsed.vals = [999]; // attacker trying to skip 974 records
      const tampered = Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");

      expect(() => {
        decodeAndVerifyQueryCursor(tampered, qHash, SECRET);
      }).toThrowError(VellumError);

      try {
        decodeAndVerifyQueryCursor(tampered, qHash, SECRET);
      } catch (err) {
        expect((err as VellumError).code).toBe("INVALID_CURSOR");
        expect((err as VellumError).message).toContain("HMAC signature verification failed");
      }
    });

    it("Detects and rejects bit flip in HMAC signature", () => {
      const validCursor = encodeQueryCursor(
        { qHash, vals: [25], docId: "user_42" },
        SECRET
      );

      const parsed = JSON.parse(Buffer.from(validCursor, "base64url").toString("utf8"));
      // Invert last character of signature hex
      const lastChar = parsed.sig.slice(-1);
      parsed.sig = parsed.sig.slice(0, -1) + (lastChar === "a" ? "b" : "a");
      const tampered = Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");

      expect(() => {
        decodeAndVerifyQueryCursor(tampered, qHash, SECRET);
      }).toThrowError(VellumError);
    });

    it("Rejects cursor swap between different queries (query shape hash mismatch)", () => {
      const otherQHash = computeQueryShapeHash({
        projectId: "proj_1",
        collectionPath: "orders", // different collection
        where: [],
        orderBy: [{ field: "createdAt", direction: "desc" }],
      });

      // Cursor signed for "orders" query
      const ordersCursor = encodeQueryCursor(
        { qHash: otherQHash, vals: ["2026-01-01"], docId: "ord_1" },
        SECRET
      );

      // Attempt to use ordersCursor for "users" query
      expect(() => {
        decodeAndVerifyQueryCursor(ordersCursor, qHash, SECRET);
      }).toThrowError(VellumError);

      try {
        decodeAndVerifyQueryCursor(ordersCursor, qHash, SECRET);
      } catch (err) {
        expect((err as VellumError).code).toBe("INVALID_CURSOR");
        expect((err as VellumError).message).toContain("shape hash does not match");
      }
    });
  });

  describe("4.1.3 — Rules AST Boundary Defenses & Traversal Resistance", () => {
    it("Rejects Security Rules AST with depth > 10 (QUERY_TOO_COMPLEX)", () => {
      // Build nested AST tree of depth 12
      let nested: any = { op: "==", left: { var: "auth.uid" }, right: { val: "admin" } };
      for (let i = 0; i < 11; i++) {
        nested = { op: "all", conditions: [nested] };
      }

      const ruleset: SecurityRulesetAst = {
        version: 1,
        rules: [{ match: "users/{userId}", allow: { read: nested } }],
      };

      expect(() => {
        validateSecurityRulesetAst(ruleset);
      }).toThrowError(VellumError);

      try {
        validateSecurityRulesetAst(ruleset);
      } catch (err) {
        expect((err as VellumError).code).toBe("QUERY_TOO_COMPLEX");
      }
    });

    it("Rejects Security Rules AST with nodes > 100 (QUERY_TOO_COMPLEX)", () => {
      const conditions: any[] = [];
      for (let i = 0; i < 105; i++) {
        conditions.push({ op: "==", left: { val: i }, right: { val: i } });
      }

      const ruleset: SecurityRulesetAst = {
        version: 1,
        rules: [{ match: "items/{itemId}", allow: { read: { op: "all", conditions } } }],
      };

      expect(() => {
        validateSecurityRulesetAst(ruleset);
      }).toThrowError(VellumError);

      try {
        validateSecurityRulesetAst(ruleset);
      } catch (err) {
        expect((err as VellumError).code).toBe("QUERY_TOO_COMPLEX");
      }
    });

    it("Rejects circular Security Rules AST reference safely without call stack overflow", () => {
      const circularNode: any = { op: "all", conditions: [] };
      circularNode.conditions.push(circularNode); // circular self-reference

      const ruleset: SecurityRulesetAst = {
        version: 1,
        rules: [{ match: "docs/{id}", allow: { read: circularNode } }],
      };

      expect(() => {
        validateSecurityRulesetAst(ruleset);
      }).toThrowError(VellumError);

      try {
        validateSecurityRulesetAst(ruleset);
      } catch (err) {
        expect((err as VellumError).code).toBe("INVALID_ARGUMENT");
        expect((err as VellumError).message).toContain("Circular reference");
      }
    });

    it("Evaluates safely when auth.uid is undefined without throwing or crashing", () => {
      const expr = { op: "==", left: { var: "auth.uid" }, right: { val: "admin_user" } };
      const ctx: RuleEvaluationContext = {
        auth: { token: null, claims: {}, uid: undefined, isServerKey: false },
        pathParams: {},
        resourceData: { name: "Public Doc" },
        requestData: null,
        requestTimeMs: Date.now(),
      };

      const result = evaluateAstNode(expr, ctx);
      expect(result).toBe(false); // fails closed safely
    });

    it("Evaluates safely when resource.data is missing field without throwing or crashing", () => {
      const expr = { op: ">=", left: { var: "resource.data.missingProperty" }, right: { val: 50 } };
      const ctx: RuleEvaluationContext = {
        auth: { token: null, claims: {}, uid: "user_1", isServerKey: false },
        pathParams: {},
        resourceData: { otherProperty: "hello" },
        requestData: null,
        requestTimeMs: Date.now(),
      };

      const result = evaluateAstNode(expr, ctx);
      expect(result).toBe(false); // fails closed safely
    });

    it("Rejects directory traversal in document paths (.. / relative / percent-encoded)", () => {
      expect(() => parseDocumentPath("users/../../etc/passwd")).toThrowError(VellumError);
      expect(() => parseDocumentPath("users/%2e%2e%2fadmin")).toThrowError(VellumError);
      expect(() => parseDocumentPath("users/%2e%2e/admin")).toThrowError(VellumError);
      expect(() => parseDocumentPath("users/./admin")).toThrowError(VellumError);
    });
  });

  describe("4.1.4 — Secret Hygiene & Observability Redaction", () => {
    it("Admin inspection never renders customer documents.data payloads", () => {
      const platform = createVellumPlatform();
      const admin = new PlatformAdminService({ platform });
      const owner = platform.controlStore.createUser({ email: "ops@vellum.dev", name: "Ops", platformRole: "owner" });

      const org = platform.controlStore.createOrganization({ slug: "privacy-org", name: "Privacy Org", billingEmail: "p@io.com" });
      const proj = platform.controlStore.createProject({ organizationId: org.id, slug: "priv-app", name: "Priv App" });

      const metadata = admin.inspectProjectMetadata(owner, proj.project.id);
      expect("data" in metadata).toBe(false);
      expect("documents" in metadata).toBe(false);
      expect(metadata.stats).toBeDefined();
    });

    it("API keys table does not store plaintext secrets", () => {
      const platform = createVellumPlatform();
      const dashboard = new CustomerDashboardService({ platform });

      const org = platform.controlStore.createOrganization({ slug: "sec-keys", name: "Sec Keys", billingEmail: "k@io.com" });
      const proj = platform.controlStore.createProject({ organizationId: org.id, slug: "sec-app", name: "Sec App" });

      const { plaintextKeyOnce, apiKeyRecord } = dashboard.createProjectApiKey({
        projectId: proj.project.id,
        name: "Backend Key",
        keyType: "server",
        scopes: ["documents:read"],
      });

      // Verify apiKeyRecord stored in database only has hashed key
      expect("plaintextKey" in apiKeyRecord).toBe(false);
      expect(apiKeyRecord.secretHash).toBeDefined();
      expect(apiKeyRecord.secretHash).not.toEqual(plaintextKeyOnce);

      // Subsequent fetch from store never returns plaintext
      const fetchedKey = platform.controlStore.getApiKey(apiKeyRecord.id);
      expect(fetchedKey).toBeDefined();
      expect("plaintextKey" in (fetchedKey as any)).toBe(false);
    });
  });
});
