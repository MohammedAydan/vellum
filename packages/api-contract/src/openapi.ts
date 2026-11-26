/**
 * @vellum/api-contract - OpenAPI 3.1.0 Specification Generator
 * Generates the full OpenAPI 3.1 spec for Document Database SaaS v1.
 */

import { SYSTEM_LIMITS } from "@vellum/core";

export function generateOpenApiSpec(serverUrl = "https://api.vellum.dev") {
  return {
    openapi: "3.1.0",
    info: {
      title: "Document Database SaaS Public HTTP & Realtime API",
      version: "0.0.6",
      description:
        "Firestore-inspired multi-tenant document database API with Tagged Wire Format, composite indexes, OCC transactions, and WebSocket realtime listeners. " +
        "The tenant is the project: every resource is addressed as `/v1/projects/{projectId}/...`. " +
        "API keys use the `pk_`/`sk_` prefixes and are scoped to a project.",
    },
    servers: [{ url: serverUrl }],
    // Both schemes are aliases: either header authenticates the same project key.
    security: [{ ProjectKeyAuth: [] }, { VellumApiKeyAuth: [] }],
    components: {
      securitySchemes: {
        ProjectKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "X-Project-Key",
          description: "Public (`pk_...`) or Server (`sk_...`) project key.",
        },
        VellumApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "X-Vellum-Api-Key",
          description: "Canonical alias for the project key (`pk_...` / `sk_...`).",
        },
        EndUserBearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Optional end-user JWT providing `auth.uid` and `auth.claims` for Security Rules AST.",
        },
      },
      schemas: {
        RealtimeSubscribe: {
          type: "object", required: ["type", "subId"],
          description: "WebSocket subscribe frame. Supply path or query. resolveIncludes is opt-in, depth 1 only. Included targets are snapshots at event processing; target-only edits do not retrigger the parent. Deleted/removed parents are not hydrated.",
          properties: {
            type: { type: "string", enum: ["subscribe"] }, subId: { type: "string", maxLength: 128 },
            path: { type: "string" }, query: { $ref: "#/components/schemas/QuerySpec" },
            resolveIncludes: { type: "boolean", default: false },
            include: { type: "array", maxItems: 10, items: { $ref: "#/components/schemas/IncludeSpec" } },
            resumeSeqId: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          },
        },
        IncludeSpec: {
          type: "object", required: ["field"],
          description: "Relation include, maximum depth 3, at most 10 specs per level.",
          properties: {
            field: { type: "string" }, collection: { type: "string" }, as: { type: "string" },
            select: { type: "array", maxItems: 100, items: { type: "string" } },
            include: { type: "array", maxItems: 10, items: { $ref: "#/components/schemas/IncludeSpec" } },
            onDelete: { type: "string", enum: ["restrict", "cascade", "set_null"] },
          },
        },
        DocumentPayload: {
          type: "object",
          required: ["path", "collectionPath", "documentId", "data", "version", "createdAt", "updatedAt"],
          properties: {
            _included: { type: "object", additionalProperties: true },
            _redactedRefs: { type: "array", items: { type: "string" } },
            path: { type: "string", example: "users/u_123" },
            collectionPath: { type: "string", example: "users" },
            collectionGroup: { type: "string", example: "users" },
            documentId: { type: "string", example: "u_123" },
            data: { type: "object", additionalProperties: true },
            sizeBytes: { type: "integer", maximum: SYSTEM_LIMITS.MAX_DOCUMENT_BYTES },
            version: { type: "integer", minimum: 1 },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        ErrorEnvelope: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "requestId"],
              properties: {
                code: { type: "string", example: "PERMISSION_DENIED" },
                message: { type: "string" },
                requestId: { type: "string" },
                details: { type: "object", additionalProperties: true },
              },
            },
          },
        },
        QuerySpec: {
          type: "object",
          properties: {
            collectionPath: { type: "string", example: "orders" },
            collectionGroup: { type: "string", example: "orders" },
            where: {
              type: "array",
              maxItems: SYSTEM_LIMITS.MAX_WHERE_CLAUSES,
              items: {
                type: "object",
                required: ["field", "op", "value"],
                properties: {
                  field: { type: "string" },
                  op: {
                    type: "string",
                    enum: [
                      "==", "!=", "<", "<=", ">", ">=", "in", "not-in", "array-contains", "array-contains-any",
                      "contains_ci", "starts_with_ci", "text_search",
                    ],
                  },
                  value: {},
                },
              },
            },
            or: {
              type: "array",
              description: "Disjunctive filter groups; each group is ANDed internally and groups are ORed together.",
              items: { type: "array", items: { type: "object" } },
            },
            orderBy: {
              type: "array",
              maxItems: SYSTEM_LIMITS.MAX_ORDER_BY_FIELDS,
              items: {
                type: "object",
                required: ["field"],
                properties: {
                  field: { type: "string" },
                  direction: { type: "string", enum: ["asc", "desc"], default: "asc" },
                },
              },
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: SYSTEM_LIMITS.MAX_QUERY_LIMIT,
              default: SYSTEM_LIMITS.DEFAULT_QUERY_LIMIT,
            },
            cursor: { type: "string" },
            select: { type: "array", items: { type: "string" }, description: "Dot-notation projection paths." },
            include: { type: "array", items: { type: "object" }, description: "Batch-resolved document relations (max depth 3)." },
            ttlSeconds: { type: "integer", description: "Document TTL in seconds from write time." },
            expiresAt: { type: "string", format: "date-time" },
          },
        },
        AggregateRequest: {
          type: "object",
          required: ["collectionPath", "metrics"],
          properties: {
            collectionPath: { type: "string", example: "orders" },
            where: { type: "array", items: { type: "object" } },
            or: { type: "array", items: { type: "array", items: { type: "object" } } },
            groupBy: { type: "array", items: { type: "string" } },
            metrics: {
              type: "object",
              additionalProperties: {
                type: "object",
                required: ["op"],
                properties: {
                  op: { type: "string", enum: ["count", "sum", "avg", "min", "max"] },
                  field: { type: "string" },
                },
              },
            },
          },
        },
        BulkDeleteRequest: {
          type: "object",
          required: ["collectionPath"],
          properties: {
            collectionPath: { type: "string" },
            where: { type: "array", items: { type: "object" } },
            or: { type: "array", items: { type: "array", items: { type: "object" } } },
            limit: { type: "integer", minimum: 1, maximum: 5000, default: 1000 },
          },
        },
        BatchWriteRequest: {
          type: "object",
          required: ["operations"],
          properties: {
            operations: {
              type: "array",
              minItems: 1,
              maxItems: SYSTEM_LIMITS.MAX_BATCH_OPERATIONS,
              items: {
                type: "object",
                required: ["type", "path"],
                properties: {
                  type: { type: "string", enum: ["create", "set", "update", "delete"] },
                  path: { type: "string" },
                  data: { type: "object", additionalProperties: true },
                  options: { type: "object", properties: { merge: { type: "boolean" } } },
                  precondition: {
                    type: "object",
                    properties: {
                      exists: { type: "boolean" },
                      version: { type: "integer" },
                      lastUpdateTime: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
          },
        },
        Organization: {
          type: "object",
          required: ["id", "name", "slug", "planTier", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            slug: { type: "string" },
            planTier: { type: "string", enum: ["free", "developer", "pro", "enterprise"] },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        Project: {
          type: "object",
          required: ["id", "organizationId", "name", "slug", "createdAt", "updatedAt"],
          properties: {
            id: { type: "string", format: "uuid" },
            organizationId: { type: "string", format: "uuid" },
            name: { type: "string" },
            slug: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        ApiKey: {
          type: "object",
          required: ["id", "projectId", "name", "keyType", "keyPrefix", "createdAt"],
          properties: {
            id: { type: "string", format: "uuid" },
            projectId: { type: "string", format: "uuid" },
            name: { type: "string" },
            keyType: { type: "string", enum: ["publishable", "secret"] },
            keyPrefix: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            expiresAt: { type: "string", format: "date-time", nullable: true },
            lastUsedAt: { type: "string", format: "date-time", nullable: true },
          },
        },
      },
    },
    paths: {
      "/v1/health": {
        get: {
          summary: "Liveness and Dual Data-Plane connectivity check",
          responses: { "200": { description: "Healthy" } },
        },
      },
      "/v1/organizations": {
        get: { summary: "List organizations for authenticated user" },
        post: { summary: "Create a new organization" },
      },
      "/v1/organizations/{orgId}/projects": {
        get: { summary: "List projects under organization" },
        post: { summary: "Create a project" },
      },
      "/v1/projects/{projectId}/api-keys": {
        get: { summary: "List API keys for a project" },
        post: { summary: "Generate a new publishable or secret API key" },
      },
      "/v1/projects/{projectId}/api-keys/{keyId}": {
        delete: { summary: "Revoke an API key" },
      },
      "/v1/projects/{projectId}/rulesets": {
        get: { summary: "Get current active security ruleset" },
        post: { summary: "Deploy a new version of security ruleset" },
      },
      "/v1/projects/{projectId}/relation-rules": {
        get: { summary: "List the project's referential-integrity (relation) rules with their version" },
        put: { summary: "Replace the project's relation rules (optimistic concurrency via expectedVersion / If-Match)" },
      },
      "/v1/projects/{projectId}/documents/{path}": {
        get: { summary: "Get a single document by full path or list a collection" },
        post: { summary: "Create a new document (fails if exists)" },
        put: { summary: "Create or overwrite/merge a document" },
        patch: { summary: "Update document fields or apply atomic field transforms ($op)" },
        delete: { summary: "Soft-delete a document" },
      },
      "/v1/projects/{projectId}/query": {
        post: {
          summary: "Execute a structured collection query with filters, sort, and HMAC cursor",
          description: "Uncovered composite queries return x-vellum-index-suggestion and x-vellum-index-url response headers (one-click dashboard deep link).",
          responses: {
            "200": {
              description: "Query page",
              headers: {
                "x-vellum-index-suggestion": { schema: { type: "string" }, description: "JSON index suggestion payload (uncovered queries only)." },
                "x-vellum-index-url": { schema: { type: "string" }, description: "One-click dashboard deep link (uncovered queries only)." },
              },
            },
          },
        },
      },
      "/v1/projects/{projectId}/batchWrite": {
        post: { summary: "Execute up to 100 atomic write mutations in a single transaction" },
      },
      "/v1/projects/{projectId}/transactions:begin": {
        post: { summary: "Begin an interactive OCC transaction and receive a signed transactionToken" },
      },
      "/v1/projects/{projectId}/transactions:commit": {
        post: { summary: "Verify read-set versions and commit mutations atomically" },
      },
      "/v1/projects/{projectId}/indexes": {
        get: { summary: "List composite indexes for the project" },
        post: { summary: "Create and asynchronously backfill a composite index" },
      },
      "/v1/projects/{projectId}/indexes/{indexId}": {
        delete: { summary: "Delete a composite index and its index entries" },
      },
      "/v1/projects/{projectId}/documents:referencedBy": {
        post: {
          summary: "Find readable documents referencing an exact target path",
          description: "Target get permission and dependent get/list permissions are required. Rows denied by Security Rules are omitted. Cursor is encrypted, caller/query-bound, expires after one hour. At most 1000 candidates are inspected per request; an empty page can have a nextCursor. The target must exist and be readable. Exact stored paths only; no inferred bare IDs. Includes use the same redaction rules as ordinary reads.",
          parameters: [{ name: "projectId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", required: ["targetPath"], additionalProperties: false,
            properties: {
              targetPath: { type: "string" }, collection: { type: "string" }, field: { type: "string" },
              limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
              cursor: { type: "string", maxLength: 32768 },
              select: { type: "array", items: { type: "string" }, maxItems: 100 },
              include: { type: "array", items: { $ref: "#/components/schemas/IncludeSpec" }, maxItems: 10 },
            },
          } } } },
          responses: {
            "200": { description: "Readable dependent documents and opaque nextCursor (null when complete)",
              content: { "application/json": { schema: {
                type: "object", required: ["documents", "nextCursor"], properties: {
                  documents: { type: "array", maxItems: 100, items: { $ref: "#/components/schemas/DocumentPayload" } },
                  nextCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
                },
              } } },
            },
            "400": { description: "Invalid request or invalid/expired/query-mismatched cursor" },
            "403": { description: "Target read denied" },
            "404": { description: "Readable target does not exist" },
            "413": { description: "Response exceeds 4 MiB" },
          },
        },
      },
      "/v1/projects/{projectId}/documents:aggregate": {
        post: {
          summary: "Native SQL aggregations (count/sum/avg/min/max with optional groupBy)",
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/AggregateRequest" } } } },
          responses: { "200": { description: "Aggregate rows" } },
        },
      },
      "/v1/projects/{projectId}/documents:bulk-delete": {
        post: {
          summary: "Rule-checked parameterized bulk delete",
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/BulkDeleteRequest" } } } },
          responses: { "200": { description: "Deleted count" } },
        },
      },
      "/v1/projects/{projectId}/rules/compile": {
        post: { summary: "Compile human-readable Rules DSL into version-1 JSON AST with diagnostics" },
      },
      "/v1/projects/{projectId}/rules/decompile": {
        post: { summary: "Decompile an existing JSON AST ruleset into readable DSL" },
      },
      "/v1/projects/{projectId}/rules/simulate": {
        post: { summary: "Dry-run a rule against mock auth/resource/incoming data with an evaluation trace" },
      },
      "/v1/projects/{projectId}/indexes/recommendations": {
        get: {
          summary: "List smart index advisor recommendations",
          description: "Populated asynchronously from unindexed query telemetry; never blocks the read path.",
        },
      },
      "/v1/projects/{projectId}/indexes/recommendations/{id}/apply": {
        post: { summary: "Create the recommended composite index in one click and mark it applied" },
      },
      "/v1/projects/{projectId}/indexes/recommendations/{id}/dismiss": {
        post: { summary: "Dismiss a recommendation" },
      },
      "/v1/projects/{projectId}/auth/sign-up/email": {
        post: { summary: "Create an end-user account with email and password" },
      },
      "/v1/projects/{projectId}/auth/sign-in/email": {
        post: { summary: "Sign in an end-user with email and password (may return an MFA ticket)" },
      },
      "/v1/projects/{projectId}/auth/sign-in/anonymous": {
        post: { summary: "Create a temporary anonymous end-user session" },
      },
      "/v1/projects/{projectId}/auth/sign-in/provider": {
        post: { summary: "Sign in or register an end-user via a configured identity provider" },
      },
      "/v1/projects/{projectId}/auth/token/refresh": {
        post: { summary: "Rotate a refresh token and issue a fresh access token" },
      },
      "/v1/projects/{projectId}/auth/sign-out": {
        post: { summary: "Revoke the presented refresh token / all user sessions" },
      },
      "/v1/projects/{projectId}/auth/user": {
        get: { summary: "Get the authenticated end-user profile" },
        patch: { summary: "Update the authenticated end-user profile" },
      },
      "/v1/projects/{projectId}/auth/password/reset": {
        post: { summary: "Request a password reset token" },
      },
      "/v1/projects/{projectId}/auth/password/confirm": {
        post: { summary: "Consume a password reset token and set a new password" },
      },
      "/v1/projects/{projectId}/auth/email/verify/request": {
        post: { summary: "Request an email verification token" },
      },
      "/v1/projects/{projectId}/auth/email/verify/confirm": {
        post: { summary: "Consume an email verification token" },
      },
      "/v1/projects/{projectId}/auth/mfa/enroll": {
        post: { summary: "Begin TOTP MFA enrollment" },
      },
      "/v1/projects/{projectId}/auth/mfa/verify": {
        post: { summary: "Confirm TOTP MFA enrollment" },
      },
      "/v1/projects/{projectId}/auth/mfa/disable": {
        post: { summary: "Turn MFA off for the signed-in user (needs a current code)" },
      },
      "/v1/projects/{projectId}/auth/mfa/challenge": {
        post: { summary: "Answer an MFA challenge and receive session tokens" },
      },
      "/v1/projects/{projectId}/auth/.well-known/jwks.json": {
        get: { summary: "Public JWKS for verifying end-user access tokens" },
      },
      "/v1/projects/{projectId}/auth/admin/users": {
        get: { summary: "List end-users with cursor pagination and filters" },
        post: { summary: "Create an end-user" },
      },
      "/v1/projects/{projectId}/auth/admin/users/{uid}": {
        get: { summary: "Get end-user detail (identities, sessions, MFA status)" },
        patch: { summary: "Update an end-user" },
        delete: { summary: "Delete an end-user" },
      },
      "/v1/projects/{projectId}/auth/admin/users/{uid}/claims": {
        put: { summary: "Replace an end-user's custom claims (max 1000 bytes)" },
      },
      "/v1/projects/{projectId}/auth/admin/users/{uid}/revoke": {
        post: { summary: "Revoke all sessions for an end-user" },
      },
      "/v1/projects/{projectId}/auth/admin/users:import": {
        post: { summary: "Import up to 100 end-users" },
      },
      "/v1/projects/{projectId}/auth/admin/config": {
        get: { summary: "Get sanitized project auth configuration" },
        patch: { summary: "Update project auth configuration" },
      },
      "/v1/admin/auth/overview": {
        get: { summary: "Platform-wide end-user auth metrics" },
      },
      "/v1/admin/auth/projects": {
        get: { summary: "List projects with end-user auth enabled" },
      },
      "/v1/admin/auth/projects/{projectId}/control": {
        patch: { summary: "Update a project's auth controls" },
      },
      "/v1/admin/auth/projects/{projectId}/rotate-signing-key": {
        post: { summary: "Rotate a project's Ed25519 signing key" },
      },
      "/v1/admin/auth/settings": {
        get: { summary: "Get platform auth global settings" },
        patch: { summary: "Update platform auth global settings" },
      },
    },
  };
}
