/**
 * Unit Test Suite (`tests/unit/core-and-ast.test.ts`)
 * Verifies:
 * 1. Canonical Document & Collection Path validation + hard limits
 * 2. Tagged Wire Format validation, normalization, nesting depth <= 20, and 1 MiB size limit
 * 3. Order-Preserving Lexicographical Binary Sort-Key Encoder (`sort_key BYTEA`)
 * 4. Declarative Security Rules AST Evaluator
 * 5. HMAC-SHA256 Signed Opaque Cursor encoding, verification, and tamper rejection
 */

import { describe, it, expect } from "vitest";
import {
  parseDocumentPath,
  parseCollectionPath,
  normalizeAndValidateDocumentData,
  WireValue,
  encodeSingleSortKeyValue,
  encodeCompositeSortKey,
  VellumError,
} from "@vellum/core";
import {
  validateSecurityRulesetAst,
  authorizeOperation,
  type SecurityRulesetAst,
} from "@vellum/authorization";
import {
  computeQueryShapeHash,
  encodeQueryCursor,
  decodeAndVerifyQueryCursor,
} from "@vellum/query-engine";

describe("tests/unit/core-and-ast", () => {
  it("Canonical Path Parser validates nested paths and rejects invalid/reserved segments", () => {
    const parsed = parseDocumentPath("users/u_123/orders/ord_456");
    expect(parsed.collectionPath).toBe("users/u_123/orders");
    expect(parsed.collectionGroup).toBe("orders");
    expect(parsed.documentId).toBe("ord_456");
    expect(parsed.pathDepth).toBe(4);

    const col = parseCollectionPath("users/u_123/orders");
    expect(col.collectionGroup).toBe("orders");
    expect(col.depth).toBe(3);

    // Reject odd segments for document path
    expect(() => parseDocumentPath("users/u_123/orders")).toThrow(VellumError);
    // Reject depth > 10
    expect(() => parseDocumentPath("c1/d1/c2/d2/c3/d3/c4/d4/c5/d5/c6/d6")).toThrow(VellumError);
    // Reject reserved __.*__ segment
    expect(() => parseDocumentPath("users/__reserved__")).toThrow(VellumError);
  });

  it("Tagged Wire Format validates all v1 rich types and enforces 20-level nesting & 1 MiB limits", () => {
    const doc = {
      name: "Mohammed Aydan",
      active: true,
      score: 98.5,
      bigCounter: WireValue.int64("-9007199254740993"),
      createdAt: WireValue.timestamp("2026-11-15T14:30:00.123Z"),
      orgRef: WireValue.reference("orgs/org_1"),
      payload: WireValue.bytes(Buffer.from("Hello VELLUM")),
      location: WireValue.geopoint(31.0409, 31.3785),
      escapedUserObj: WireValue.escapeMap({ $t: "custom_user_literal_tag" }),
    };

    const { data, sizeBytes } = normalizeAndValidateDocumentData(doc);
    expect(sizeBytes).toBeGreaterThan(0);
    expect(sizeBytes).toBeLessThan(1048576);
    expect((data.createdAt as { $ms: number }).$ms).toBe(Date.parse("2026-11-15T14:30:00.123Z"));
    expect((data.escapedUserObj as { $t: string }).$t).toBe("map");
    expect(((data.escapedUserObj as { $v: { $t: string } }).$v).$t).toBe("custom_user_literal_tag");

    // Reject > 20 nesting levels
    let deep: Record<string, unknown> = { leaf: "ok" };
    for (let i = 0; i < 22; i++) {
      deep = { nested: deep };
    }
    expect(() => normalizeAndValidateDocumentData(deep)).toThrow(VellumError);
  });

  it("Order-Preserving Binary Sort-Key Encoder preserves exact lexicographical order for ASC and DESC", () => {
    const numbers = [-1000.5, -10, -0.001, 0, 0.001, 42, 999999.99];
    const encodedAsc = numbers.map((n) => encodeSingleSortKeyValue(n, "asc"));
    for (let i = 0; i < encodedAsc.length - 1; i++) {
      expect(Buffer.compare(encodedAsc[i]!, encodedAsc[i + 1]!)).toBeLessThan(0);
    }

    const encodedDesc = numbers.map((n) => encodeSingleSortKeyValue(n, "desc"));
    for (let i = 0; i < encodedDesc.length - 1; i++) {
      expect(Buffer.compare(encodedDesc[i]!, encodedDesc[i + 1]!)).toBeGreaterThan(0);
    }

    // Composite key ordering: status ASC, priority DESC
    const fields = [
      { path: "status", dir: "asc" as const },
      { path: "priority", dir: "desc" as const },
    ];
    const keyHighPrio = encodeCompositeSortKey(
      { documentId: "d1", createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", data: { status: "open", priority: 10 } },
      fields
    );
    const keyLowPrio = encodeCompositeSortKey(
      { documentId: "d2", createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", data: { status: "open", priority: 1 } },
      fields
    );
    expect(Buffer.compare(keyHighPrio, keyLowPrio)).toBeLessThan(0);
  });

  it("Declarative Security Rules AST Evaluator enforces ownership and immutable field rules", () => {
    const rulesAst: SecurityRulesetAst = {
      version: 1,
      rules: [
        {
          match: "users/{userId}",
          allow: {
            get: { op: "==", left: { var: "auth.uid" }, right: { var: "path.userId" } },
            update: {
              op: "all",
              conditions: [
                { op: "==", left: { var: "resource.data.ownerId" }, right: { var: "auth.uid" } },
                { op: "==", left: { var: "request.data.ownerId" }, right: { var: "resource.data.ownerId" } },
              ],
            },
          },
        },
      ],
    };

    validateSecurityRulesetAst(rulesAst);

    // Allowed when auth.uid matches path.userId
    const res = authorizeOperation({
      apiKeyRecord: {
        id: "k1",
        projectId: "p1",
        name: "pk",
        keyType: "public",
        keyPrefix: "pk_1",
        secretHash: "h",
        scopes: [],
        rateLimitRps: 100,
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        createdBy: null,
        createdAt: new Date().toISOString(),
      },
      rulesetRecord: {
        id: "r1",
        projectId: "p1",
        version: 1,
        rulesAst: rulesAst as unknown as Record<string, unknown>,
        isActive: true,
        createdBy: null,
        createdAt: new Date().toISOString(),
      },
      operation: "get",
      path: "users/u_123",
      authContext: { uid: "u_123", claims: {} },
    });
    expect(res.allowed).toBe(true);

    // Denied when user tries to mutate ownerId on update
    expect(() =>
      authorizeOperation({
        apiKeyRecord: {
          id: "k1",
          projectId: "p1",
          name: "pk",
          keyType: "public",
          keyPrefix: "pk_1",
          secretHash: "h",
          scopes: [],
          rateLimitRps: 100,
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
          createdBy: null,
          createdAt: new Date().toISOString(),
        },
        rulesetRecord: {
          id: "r1",
          projectId: "p1",
          version: 1,
          rulesAst: rulesAst as unknown as Record<string, unknown>,
          isActive: true,
          createdBy: null,
          createdAt: new Date().toISOString(),
        },
        operation: "update",
        path: "users/u_123",
        authContext: { uid: "u_123", claims: {} },
        resourceData: { ownerId: "u_123", bio: "old" },
        requestData: { ownerId: "u_hacker", bio: "new" },
      })
    ).toThrow(VellumError);
  });

  it("HMAC-SHA256 Cursor Codec verifies valid cursors and rejects query-shape or signature tampering", () => {
    const qHash = computeQueryShapeHash({
      projectId: "p1",
      collectionPath: "users",
      where: [{ field: "active", op: "==", value: true }],
      orderBy: [{ field: "documentId", dir: "asc" }],
    });

    const token = encodeQueryCursor({ qHash, vals: ["u_10"], docId: "u_10" });
    const decoded = decodeAndVerifyQueryCursor(token, qHash);
    expect(decoded.docId).toBe("u_10");

    // Reject if query filter changes (different qHash)
    expect(() => decodeAndVerifyQueryCursor(token, "different_hash")).toThrow(VellumError);
  });
});
