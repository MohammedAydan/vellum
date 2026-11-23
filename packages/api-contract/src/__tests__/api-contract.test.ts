import { describe, it, expect } from "vitest";
import {
  validateClientWsFrame,
  generateOpenApiSpec,
  VALID_QUERY_OPERATORS,
  ApiErrorSchema,
  DocumentPayloadSchema,
  TaggedValueSchema,
  TaggedFieldTransformSchema,
  QuerySpecSchema,
  BatchWriteSchema,
  CommitTransactionSchema,
  OrganizationSchema,
  ProjectSchema,
  ApiKeySchema,
  CreateIndexRequestSchema,
  SignUpEmailRequestSchema,
  SignInProviderRequestSchema,
  TokenRefreshRequestSchema,
  UpdateProfileRequestSchema,
  MfaChallengeRequestSchema,
  AdminSetClaimsRequestSchema,
  AuthConfigPatchSchema,
  SuperAdminSettingsPatchSchema,
  AdminImportUsersRequestSchema,
} from "../index.js";
import { VellumError } from "@vellum/core";

describe("@vellum/api-contract", () => {
  describe("Path validation", () => {
    it("rejects invalid document and collection path schemas", async () => {
      const { DocumentPathSchema, CollectionPathSchema } = await import("../schemas/limits.js");
      expect(DocumentPathSchema.safeParse("users").success).toBe(false);
      expect(DocumentPathSchema.safeParse("users//u1").success).toBe(false);
      expect(CollectionPathSchema.safeParse("users/u1").success).toBe(false);
      expect(CollectionPathSchema.safeParse("").success).toBe(false);
    });
  });

  describe("WebSocket client frames", () => {
    it("validates auth frame", () => {
      const auth = validateClientWsFrame({
        type: "auth",
        projectId: "proj_123",
        apiKey: "pk_testkey",
      });
      expect(auth.type).toBe("auth");
    });

    it("validates subscribe frame for document path", () => {
      const sub = validateClientWsFrame({
        type: "subscribe",
        subId: "sub_1",
        path: "users/u_1",
      });
      expect(sub.type).toBe("subscribe");
    });

    it("validates subscribe frame for query", () => {
      const sub = validateClientWsFrame({
        type: "subscribe",
        subId: "sub_2",
        query: {
          collectionPath: "users",
          limit: 10,
        },
      });
      expect(sub.type).toBe("subscribe");
    });

    it("rejects subscribe frame without path or query", () => {
      expect(() =>
        validateClientWsFrame({
          type: "subscribe",
          subId: "sub_3",
        })
      ).toThrow(VellumError);
    });

    it("validates unsubscribe and ping frames", () => {
      const unsub = validateClientWsFrame({
        type: "unsubscribe",
        subId: "sub_1",
      });
      expect(unsub.type).toBe("unsubscribe");

      const ping = validateClientWsFrame({
        type: "ping",
        ts: Date.now(),
      });
      expect(ping.type).toBe("ping");
    });

    it("rejects invalid frame types", () => {
      expect(() => validateClientWsFrame({ type: "unknown" })).toThrow(VellumError);
      expect(() => validateClientWsFrame(null)).toThrow(VellumError);
    });
  });

  describe("Error Schemas", () => {
    it("parses valid error envelopes matching §11.2", () => {
      const payload = {
        error: {
          code: "PERMISSION_DENIED",
          message: "Write denied by security rules",
          requestId: "req_test_123",
          details: { path: "users/u_1" },
        },
      };
      const parsed = ApiErrorSchema.safeParse(payload);
      expect(parsed.success).toBe(true);
    });

    it("rejects invalid error codes", () => {
      const payload = {
        error: {
          code: "NOT_AN_ERROR_CODE",
          message: "Failed",
          requestId: "req_1",
        },
      };
      const parsed = ApiErrorSchema.safeParse(payload);
      expect(parsed.success).toBe(false);
    });
  });

  describe("Document & Tagged Wire Format Schemas", () => {
    it("parses valid DocumentPayload", () => {
      const doc = {
        path: "users/u_1",
        collectionPath: "users",
        collectionGroup: "users",
        documentId: "u_1",
        data: { name: "Alice", age: 30 },
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const parsed = DocumentPayloadSchema.safeParse(doc);
      expect(parsed.success).toBe(true);
    });

    it("validates tagged wire format values", () => {
      expect(TaggedValueSchema.safeParse({ $t: "int", $v: "9007199254740992" }).success).toBe(true);
      expect(TaggedValueSchema.safeParse({ $t: "time", $v: "2026-01-01T00:00:00.000Z" }).success).toBe(true);
      expect(TaggedValueSchema.safeParse({ $t: "ref", $v: "users/u_1" }).success).toBe(true);
      expect(TaggedValueSchema.safeParse({ $t: "bytes", $v: "aGVsbG8=" }).success).toBe(true);
      expect(TaggedValueSchema.safeParse({ $t: "geo", $v: { latitude: 37.7749, longitude: -122.4194 } }).success).toBe(true);

      // Invalid tagged values
      expect(TaggedValueSchema.safeParse({ $t: "int", $v: "not-a-number" }).success).toBe(false);
      expect(TaggedValueSchema.safeParse({ $t: "geo", $v: { latitude: 100, longitude: 0 } }).success).toBe(false);
    });

    it("validates field transforms", () => {
      expect(TaggedFieldTransformSchema.safeParse({ $op: "increment", $v: 5 }).success).toBe(true);
      expect(TaggedFieldTransformSchema.safeParse({ $op: "arrayUnion", $v: ["a", "b"] }).success).toBe(true);
      expect(TaggedFieldTransformSchema.safeParse({ $op: "serverTimestamp" }).success).toBe(true);
      expect(TaggedFieldTransformSchema.safeParse({ $op: "deleteField" }).success).toBe(true);
    });
  });

  describe("Query Schemas", () => {
    it("validates a structured query spec", () => {
      const q = {
        collectionPath: "orders",
        where: [
          { field: "status", op: "==", value: "pending" },
          { field: "tags", op: "in", value: ["electronics", "home"] },
        ],
        orderBy: [{ field: "createdAt", direction: "desc" }],
        limit: 100,
      };
      const parsed = QuerySpecSchema.safeParse(q);
      expect(parsed.success).toBe(true);
    });

    it("rejects disjunctive values > 30 items", () => {
      const items = Array.from({ length: 31 }, (_, i) => `item_${i}`);
      const q = {
        collectionPath: "orders",
        where: [{ field: "tag", op: "in", value: items }],
      };
      const parsed = QuerySpecSchema.safeParse(q);
      expect(parsed.success).toBe(false);
    });

    it("rejects empty disjunctive array or non-array for in operator", () => {
      expect(QuerySpecSchema.safeParse({ collectionPath: "orders", where: [{ field: "tag", op: "in", value: [] }] }).success).toBe(false);
      expect(QuerySpecSchema.safeParse({ collectionPath: "orders", where: [{ field: "tag", op: "in", value: "not-array" }] }).success).toBe(false);
    });

    it("rejects query without collectionPath and without collectionGroup", () => {
      const q = {
        where: [{ field: "status", op: "==", value: "pending" }],
      };
      const parsed = QuerySpecSchema.safeParse(q);
      expect(parsed.success).toBe(false);
    });

    it("rejects query with both collectionPath and collectionGroup", () => {
      const q = {
        collectionPath: "orders",
        collectionGroup: "orders",
      };
      const parsed = QuerySpecSchema.safeParse(q);
      expect(parsed.success).toBe(false);
    });

    it("exposes VALID_QUERY_OPERATORS", () => {
      expect(VALID_QUERY_OPERATORS.has("==")).toBe(true);
      expect(VALID_QUERY_OPERATORS.has("array-contains")).toBe(true);
      expect(VALID_QUERY_OPERATORS.size).toBe(10);
    });
  });

  describe("Batch Write & OCC Transaction Schemas", () => {
    it("rejects create/set/update without data", () => {
      expect(BatchWriteSchema.safeParse({ operations: [{ type: "create", path: "users/u_1" }] }).success).toBe(false);
      expect(BatchWriteSchema.safeParse({ operations: [{ type: "set", path: "users/u_1" }] }).success).toBe(false);
      expect(BatchWriteSchema.safeParse({ operations: [{ type: "update", path: "users/u_1" }] }).success).toBe(false);
    });

    it("validates batch write operations <= 100", () => {
      const batch = {
        operations: [
          { type: "create", path: "users/u_1", data: { name: "Bob" } },
          { type: "delete", path: "users/u_2" },
        ],
      };
      expect(BatchWriteSchema.safeParse(batch).success).toBe(true);
    });

    it("rejects empty batch write operations", () => {
      expect(BatchWriteSchema.safeParse({ operations: [] }).success).toBe(false);
    });

    it("validates commit transaction with read set", () => {
      const tx = {
        transactionToken: "signed_jwt_or_hmac_token",
        mutations: [{ type: "set", path: "accounts/acc_1", data: { balance: 100 } }],
        reads: [{ path: "accounts/acc_1", readVersion: 3 }],
      };
      expect(CommitTransactionSchema.safeParse(tx).success).toBe(true);
    });
  });

  describe("Control Plane Schemas", () => {
    it("validates Organization and Project schemas", () => {
      const org = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        name: "Acme Corp",
        slug: "acme-corp",
        planTier: "pro",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      expect(OrganizationSchema.safeParse(org).success).toBe(true);

      const proj = {
        id: "123e4567-e89b-12d3-a456-426614174001",
        organizationId: org.id,
        name: "Main App",
        slug: "main-app",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      expect(ProjectSchema.safeParse(proj).success).toBe(true);
    });

    it("validates the ApiKey schema", () => {
      const apiKey = {
        id: "123e4567-e89b-12d3-a456-426614174003",
        projectId: "123e4567-e89b-12d3-a456-426614174001",
        name: "Frontend Key",
        keyType: "publishable",
        keyPrefix: "pk_1234",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      expect(ApiKeySchema.safeParse(apiKey).success).toBe(true);
    });

    it("validates composite index creation request", () => {
      const req = {
        collectionPath: "users/u_1/orders",
        fields: [
          { fieldPath: "status", order: "asc" },
          { fieldPath: "total", order: "desc" },
        ],
      };
      expect(CreateIndexRequestSchema.safeParse(req).success).toBe(true);
    });
  });

  describe("OpenAPI Spec Generation & Stability", () => {
    it("generates valid OpenAPI 3.1.0 document matching snapshot", () => {
      const spec = generateOpenApiSpec("https://test.vellum.dev");
      expect(spec.openapi).toBe("3.1.0");
      expect(spec.info.title).toBe("Document Database SaaS Public HTTP & Realtime API");
      expect(spec.servers[0]?.url).toBe("https://test.vellum.dev");

      // Check required paths exist
      expect(spec.paths["/v1/health"]).toBeDefined();
      expect(spec.paths["/v1/projects/{projectId}/documents/{path}"]).toBeDefined();
      expect(spec.paths["/v1/projects/{projectId}/query"]).toBeDefined();
      expect(spec.paths["/v1/projects/{projectId}/batchWrite"]).toBeDefined();
      expect(spec.paths["/v1/projects/{projectId}/transactions:begin"]).toBeDefined();
      expect(spec.paths["/v1/projects/{projectId}/transactions:commit"]).toBeDefined();
      expect(spec.paths["/v1/projects/{projectId}/indexes"]).toBeDefined();
      expect(spec.paths["/v1/organizations"]).toBeDefined();

      // Check components
      expect(spec.components.schemas.DocumentPayload).toBeDefined();
      expect(spec.components.schemas.ErrorEnvelope).toBeDefined();
      expect(spec.components.securitySchemes.ProjectKeyAuth).toBeDefined();
      expect(spec.components.securitySchemes.VellumApiKeyAuth).toBeDefined();
      expect(spec.components.securitySchemes.EndUserBearerAuth).toBeDefined();
      expect(spec.components.securitySchemes.VellumApiKeyAuth.name).toBe("X-Vellum-Api-Key");
      expect(spec.paths["/v1/projects/{projectId}/auth/.well-known/jwks.json"]).toBeDefined();
    });
  });

  describe("End-User Auth Request Schemas", () => {
    it("validates email sign-up and normalizes the email", () => {
      const parsed = SignUpEmailRequestSchema.safeParse({
        email: " User@Example.COM ",
        password: "correct-horse-9",
        displayName: "Ada",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.email).toBe("user@example.com");
      expect(SignUpEmailRequestSchema.safeParse({ email: "bad", password: "short" }).success).toBe(false);
    });

    it("requires a provider identifier for provider sign-in", () => {
      expect(SignInProviderRequestSchema.safeParse({ provider: "google" }).success).toBe(false);
      expect(
        SignInProviderRequestSchema.safeParse({ provider: "google", idToken: "jwt-like-value" }).success
      ).toBe(true);
    });

    it("validates token refresh, profile patch and MFA challenge bodies", () => {
      expect(TokenRefreshRequestSchema.safeParse({ refreshToken: "rt_1" }).success).toBe(true);
      expect(UpdateProfileRequestSchema.safeParse({}).success).toBe(false);
      expect(UpdateProfileRequestSchema.safeParse({ displayName: "Grace" }).success).toBe(true);
      expect(MfaChallengeRequestSchema.safeParse({ mfaTicket: "ticket", code: "123456" }).success).toBe(true);
      expect(MfaChallengeRequestSchema.safeParse({ mfaTicket: "ticket", code: "abc" }).success).toBe(false);
    });

    it("enforces the 1000-byte custom claims limit for admin claims updates", () => {
      const small = AdminSetClaimsRequestSchema.safeParse({ claims: { role: "editor" } });
      expect(small.success).toBe(true);
      const large = AdminSetClaimsRequestSchema.safeParse({ claims: { blob: "x".repeat(1200) } });
      expect(large.success).toBe(false);
    });

    it("validates admin config and platform settings patches", () => {
      expect(AuthConfigPatchSchema.safeParse({}).success).toBe(false);
      expect(AuthConfigPatchSchema.safeParse({ enableTotpMfa: false }).success).toBe(true);
      expect(SuperAdminSettingsPatchSchema.safeParse({ globalSignupsEnabled: false }).success).toBe(true);
      expect(AdminImportUsersRequestSchema.safeParse({ users: [] }).success).toBe(false);
    });
  });
});
