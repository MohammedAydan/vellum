---
title: Control Plane & Console REST API
order: 1
group: Reference
description: Endpoint-by-endpoint reference for authentication, organizations, projects, keys, rulesets, indexes, documents, query, transactions, usage, audit and admin routes.
---

# Control Plane & Console REST API

This page is the authoritative endpoint reference for every route mounted under `/v1` that is **not** the public document plane (for that, see [REST Data Plane](./rest-data-plane.md)) or the WebSocket protocol (see [Realtime Protocol](./realtime-protocol.md)).

Source of truth: `apps/api/src/routes/{auth-endpoints,mfa,control-plane,console,admin,usage,health}.ts`, `apps/api/src/app.ts`, and the Zod schemas in `packages/api-contract/src/schemas/*`. All endpoints are mounted by `app.route("/v1", …)` in `apps/api/src/app.ts`.

:::note
Every response carries `X-Request-Id`. Error bodies always use the canonical envelope `{ "error": { "code", "message", "requestId", "details"? } }` — see [Errors](./errors.md).
:::

## Authentication schemes

| Scheme | Header | Used by | Meaning |
| :--- | :--- | :--- | :--- |
| None (public) | — | sign-up, sign-in, setup, login, health, OpenAPI | No token required |
| Optional session | `Authorization: Bearer <access JWT>` | legacy `/v1/organizations`, `/v1/projects/...` control-plane routes | Callable without a session, but **any token presented must be valid** (fail closed). Implemented by `optionalSession`. |
| Session | `Authorization: Bearer <access JWT>` | `/v1/console/**`, `/v1/auth/mfa/**`, `/v1/**/usage` | Missing, malformed, expired or revoked token → `401 UNAUTHENTICATED` |
| Operator session | `Authorization: Bearer <access JWT>` | `/v1/admin/**` | Session whose `role` is `owner`, `admin`, or (read-only) `support_readonly` |

Console roles accepted: `customer`, `owner`, `admin`, `support_readonly` (`CONSOLE_ROLES`). Operator read roles: `owner`, `admin`, `support_readonly`, `customer` for usage; admin surface uses `owner`, `admin`, `support_readonly`. Operator write roles: `owner`, `admin`.

Tokens are HS256 session access tokens from the shared `SessionService` (`signAccess`), with lifetime configured by that service (admin login/setup responses report `expiresAt` 15 minutes out; customer sign-up/sign-in report 7 days out).

---

## 1. Authentication (`auth-endpoints.ts`)

| Method | Path | Auth | Request body | Success response | Errors |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `POST` | `/v1/auth/sign-up/email` | None | `{ email, name, password }` (`password` ≥ 6 chars, `name` ≥ 2) | `201{ success, user:{id,name,email,platformRole}, token, organization, project, apiKey:{id,keyPrefix}\|null, expiresAt }` | `INVALID_ARGUMENT`, `ALREADY_EXISTS` |
| `POST` | `/v1/auth/sign-in/email` | None | `{ email, password }` | `200{ success, user:{id,name,email,platformRole}, token, expiresAt }` | `INVALID_ARGUMENT`, `UNAUTHENTICATED`, `PERMISSION_DENIED` (suspended) |
| `GET` | `/v1/auth/session` | Bearer (verifies token) | — | `{ session: null }` when no `Authorization` header; otherwise `{ session:{ valid:true, uid, claims, expiresAt } }` | `UNAUTHENTICATED` |
| `POST` | `/v1/auth/sign-out` | Optional Bearer | — | `{ success:true, message:"Signed out successfully" }` | — (invalid refresh token is a no-op) |

Notes:

- Passwords are hashed with asynchronous scrypt (`N=2^14, r=8, p=1`, format `scrypt$<saltHex>$<hashHex>`); a legacy PBKDF2 path is supported for migration only. A user with no stored password hash cannot sign in.
- All other Better-Auth-style routes matching `/v1/auth/**` (`POST`/`GET`) are delegated to `createBetterAuth().handler` in `app.ts`. Those route shapes are defined by the Better Auth library, not this repository.

## 2. TOTP MFA (`mfa.ts`)

All four endpoints require a valid session (`requireSession`). Wire shapes are locked by the route contract in `mfa.ts`.

| Method | Path | Request body | Success response | Errors |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/v1/auth/mfa/status` | — | `{ enabled: boolean }` | `UNAUTHENTICATED` |
| `POST` | `/v1/auth/mfa/setup` | — | `{ secret, otpauthUri, recoveryCodes: string[] }` | `UNAUTHENTICATED`, `ALREADY_EXISTS`, `INTERNAL_ERROR` |
| `POST` | `/v1/auth/mfa/verify` | `{ code }` (6-digit TOTP) | `{ enabled: true }` | `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `RATE_LIMITED` |
| `POST` | `/v1/auth/mfa/disable` | `{ code }` (TOTP or recovery code) | `{ enabled: false }` | `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `RATE_LIMITED` |

Notes:

- `setup` is idempotent while unverified: calling it again returns the same `secret` and derived plaintext `recoveryCodes`. Only hashed codes and an encrypted secret are persisted.
- Verification accepts ±30 s TOTP skew (one 30 s step, SHA-1, 6 digits). `disable` also accepts one of the 8 recovery codes.
- Failed `verify`/`disable` attempts are throttled in-process: default 5 attempts per 60,000 ms per user, then `RATE_LIMITED` (429).
- MFA state is durable in the control-plane `mfa_secrets` table (or in-memory store in hermetic mode).

---

## 3. Organizations, projects (`control-plane.ts`)

Legacy control-plane routes use `optionalSession`. Customer sessions only see organizations they are a member of; `owner`/`admin` sessions see all.

| Method | Path | Request body | Success response | Errors |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/v1/organizations` | `CreateOrganizationRequestSchema`: `{ name (1–100), slug (1–100, /^[a-z0-9-]+$/), planTier?: "free"\|"developer"\|"pro"\|"enterprise" }` | `201Organization{id,name,slug,planTier,createdAt,updatedAt}` | `INVALID_ARGUMENT` |
| `GET` | `/v1/organizations` | — | `200Organization[]` | — |
| `GET` | `/v1/organizations/:orgId/projects` | — | `200Project[]` | `PERMISSION_DENIED` (session not a member) |

## 4. API keys (`control-plane.ts`)

| Method | Path | Request body | Success response | Errors |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/v1/projects/:projectId/api-keys` | `CreateApiKeyRequestSchema`: `{ name, keyType:"publishable"\|"secret", expiresAt? }` | `201{ apiKey: ApiKey, rawKey }` | `INVALID_ARGUMENT` |
| `GET` | `/v1/projects/:projectId/api-keys` | — | `200ApiKey[]` | — |
| `DELETE` | `/v1/projects/:projectId/api-keys/:keyId` | — | `200{ success:true, revoked }` | `NOT_FOUND`, `PERMISSION_DENIED` |

Notes:

- `keyType:"secret"` maps to a **server** key with scopes `documents:read`, `documents:write`, `indexes:manage`; `publishable` maps to a **public** key with `documents:read`, `documents:write`. Server keys use the `sk_` family, public keys the `pk_` family.
- `rawKey` is returned **only once**, at creation. Store it securely; the control plane persists only `keyPrefix` and a HMAC `secretHash`.
- Revocation validates that the key belongs to the addressed `(projectId)` before deleting (cross-tenant revocation → `PERMISSION_DENIED`), then publishes a cache invalidation via `NOTIFY vellum_cache_invalidate`.
- `ApiKeySchema`: `{ id, projectId, projectId, name, keyType:"publishable"\|"secret", keyPrefix, createdAt, expiresAt?, lastUsedAt? }`.

## 5. Security rulesets (`control-plane.ts`)

| Method | Path | Request body | Success response | Errors |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/v1/projects/:projectId/rulesets` | `UpdateRulesetRequestSchema`: `{ rulesAst: object }` | `201` published ruleset `{ id, projectId, projectId, version, rulesAst, publishedAt, … }` | `INVALID_ARGUMENT` (schema or AST validation failure) |
| `GET` | `/v1/projects/:projectId/rulesets` | — | `200` active ruleset, or a synthesized default v1 ruleset `{ id:"default_<projectId>", version:1, rulesAst:{schemaVersion:"1.0", rules:[…]} }` | — |

The AST is validated by `validateSecurityRulesetAst` (`maxDepth ≤ 10`, `maxNodes ≤ 100`, no dynamic code). See [Security Rules AST](../../04-security-rules-ast.md). Publishing invalidates the in-process ruleset cache via `NOTIFY vellum_cache_invalidate`.

---

## 6. Console API (`console.ts`)

Every `/v1/console/**` route requires a session with one of `CONSOLE_ROLES`. Mutations write an immutable audit-log entry. Console requests are authorized by session (not a long-lived key); a scoped synthetic server-key record lets the document engine apply its normal rules/scopes pipeline.

### 6.1 Organization / project discovery

| Method | Path | Success response | Errors |
| :--- | :--- | :--- | :--- |
| `GET` | `/v1/console/organizations` | `Organization[]` (membership-filtered; operators see all) | `UNAUTHENTICATED` |
| `GET` | `/v1/console/organizations/:orgId/projects` | `Project[]` | `PERMISSION_DENIED` (not a member) |

### 6.2 Documents, query, batch, transactions

| Method | Path | Request body | Success response | Errors |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/v1/console/projects/:projectId/documents/*` | — | Even segments → document; odd segments → `executeQuery` result | `INVALID_DOCUMENT_PATH`, `NOT_FOUND`, rules errors |
| `POST` | `/v1/console/projects/:projectId/documents/*` | `{ data }` or a bare data map | `201` created document | `INVALID_DOCUMENT_PATH`, `ALREADY_EXISTS`, `DOCUMENT_TOO_LARGE` |
| `PUT` | `/v1/console/projects/:projectId/documents/*` | `{ data, merge?, ifVersion? }` (`merge` may also be `?merge=true`) | `200` saved document | `FAILED_PRECONDITION`, `INVALID_DOCUMENT_PATH` |
| `PATCH` | `/v1/console/projects/:projectId/documents/*` | `{ data, ifVersion? }` | `200` updated document | `FAILED_PRECONDITION`, `INVALID_DOCUMENT_PATH` |
| `DELETE` | `/v1/console/projects/:projectId/documents/*` | — (`?ifVersion=<n>` optional) | `200` deletion result | `FAILED_PRECONDITION`, `NOT_FOUND` |
| `POST` | `/v1/console/projects/:projectId/query` | `QuerySpec` (see [Data Plane](./rest-data-plane.md)) | `200{ documents, nextCursor, hasMore, executionStats? }` | `QUERY_TOO_COMPLEX`, `LIMIT_EXCEEDED`, `INVALID_CURSOR`, `QUERY_DEADLINE_EXCEEDED` |
| `POST` | `/v1/console/projects/:projectId/batchWrite` | `{ writes }` or `{ operations }` (`BatchOperation[]`) | `200{ results:[{path,version,updatedAt}], commitTimestamp }` | `BATCH_SIZE_EXCEEDED`, `PAYLOAD_TOO_LARGE`, `ABORTED_CONFLICT` |
| `POST` | `/v1/console/projects/:projectId/transactions:begin` | — | `200{ transactionToken, expiresAt }` | `UNAUTHENTICATED` |
| `POST` | `/v1/console/projects/:projectId/transactions:commit` | `{ transactionToken, writes \| mutations \| ... }`; per-write `ifVersion` from `ifVersion`/`preconditions`/`precondition` | `200` commit result | `TRANSACTION_TIMEOUT`, `ABORTED_CONFLICT` |

A transaction token may also be passed on `GET .../documents/*` via `?transactionToken=`, `?txToken=`, or `x-transaction-token` header to read within the OCC snapshot.

### 6.3 Indexes, rulesets, keys

| Method | Path | Request body | Success response | Errors |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/v1/console/projects/:projectId/indexes` | — | `{ indexes: CompositeIndex[] }` | `UNAUTHENTICATED` |
| `POST` | `/v1/console/projects/:projectId/indexes` | `{ collectionPath, fields:[{fieldPath, order?}] }` | `201CompositeIndex` | `INVALID_ARGUMENT` (empty `fields`, bad path) |
| `DELETE` | `/v1/console/projects/:projectId/indexes/:indexId` | — | `{ deleted:true, indexId }` | `NOT_FOUND` |
| `GET` | `/v1/console/projects/:projectId/rulesets` | — | active ruleset or `{ projectId, version:0, rulesAst:null }` | — |
| `POST` | `/v1/console/projects/:projectId/rulesets` | `{ rulesAst }` | `201` published ruleset | `INVALID_ARGUMENT` |
| `GET` | `/v1/console/projects/:projectId/api-keys` | — | `ApiKey[]` | — |
| `POST` | `/v1/console/projects/:projectId/api-keys` | `{ name?, keyType }` — `publishable`/`public` → public, anything else → server | `201{ apiKey, rawKey }` | `UNAUTHENTICATED` |
| `DELETE` | `/v1/console/projects/:projectId/api-keys/:keyId` | — | `{ success:true, revoked }` | `NOT_FOUND`, `PERMISSION_DENIED` |

`CompositeIndexFieldSchema`: `{ fieldPath: string (min 1), order?: "asc"\|"desc" (default asc) }`. `CompositeIndexSchema`: `{ id, projectId, projectId, collectionPath, fields, status:"building"\|"ready"\|"failed", createdAt }`.

---

## 7. Metering & usage (`usage.ts`)

| Method | Path | Auth | Query parameters | Success response |
| :--- | :--- | :--- | :--- | :--- |

`UsageDailyRecord`: `{ projectId, usageDate, documentReads, documentWrites, documentDeletes, realtimeMessagesSent, egressBytes, storageBytes, updatedAt }`. `totals` is the same set of counters summed over the returned days. Data is read from `project_usage_daily` (control plane); the in-memory mirror is an offline/test fallback. Invalid `from`/`to` values are ignored (treated as `null`).

---

## 8. Admin / operator routes (`admin.ts`)

Admin responses pass through `sanitizeAdminPayload`, which strips `data`, `beforeData`, and `afterData` from document-shaped objects. **Platform operators can inspect tenant metadata, quotas, indexes and audit logs, but never customer document payloads.**

| Method | Path | Auth | Request / query | Success response | Errors |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `GET` | `/v1/admin/setup-status` | None | — | `{ initialized, ownerCount, requiresSetup, totalUsers, tokenRequired }` | — |
| `POST` | `/v1/admin/setup-owner` | One-time setup token (when no owner exists) | `{ name, email, password }` (password ≥ 8) + `x-setup-token` header (or `setupToken` body field) | `201{ success, user, token, refreshToken, expiresAt }` | `ALREADY_EXISTS`, `INVALID_ARGUMENT`, `UNAUTHENTICATED` (`INVALID_SETUP_TOKEN`) |

Production **always** requires `ADMIN_SETUP_TOKEN` for `setup-owner`; the token
is compared in constant time and is never returned by `setup-status` (which
only reports `tokenRequired`). Once an owner exists the endpoint is permanently
closed with `409 ALREADY_EXISTS`, so remove the env var after the one-time
bootstrap.
| `POST` | `/v1/admin/login` | None | `{ email, password }` | `{ success, user, token, refreshToken, expiresAt }` | `NOT_FOUND` (needs setup), `UNAUTHENTICATED`, `PERMISSION_DENIED` |
| `GET` | `/v1/admin/overview` | Operator | — | `{ status, version, tenantsCount, projectsCount, keysCount, usersCount, planes, metrics, nodes, telemetry }` | `UNAUTHENTICATED` |
| `GET` | `/v1/admin/tenants` | Operator | — | Tenant array with `storageMb`, `dailyReads`, `dailyWrites`, `projectsCount`, `plan`, `status` | `UNAUTHENTICATED` |
| `GET` | `/v1/admin/tenants/:orgId` | Operator | — | Tenant object + `projects` metadata | `NOT_FOUND` |
| `POST` | `/v1/admin/tenants/:orgId/suspend` | Operator write | — | `{ success:true, status:"suspended" }` | `NOT_FOUND` |
| `POST` | `/v1/admin/tenants/:orgId/reactivate` | Operator write | — | `{ success:true, status:"active" }` | `NOT_FOUND` |
| `GET` | `/v1/admin/audit-logs` | Operator | `limit`, `cursor`, `action`, `actorUserId`, `organizationId`, `projectId`, `from`, `to`, `envelope=true` | Array of audit views (default) or `{ items, total, nextCursor, hasMore }`. Headers: `X-Total-Count`, `X-Has-More`, `X-Next-Cursor` | `UNAUTHENTICATED` |
| `GET` | `/v1/admin/features` | Operator | — | `FeatureFlagRecord[]` | `UNAUTHENTICATED` |
| `GET` | `/v1/admin/features/:key` | Operator | — | `FeatureFlagRecord` | `NOT_FOUND` |
| `POST` | `/v1/admin/features` | Operator write | `{ key, description?, enabled?, rolloutPercent? }` | `200`/`201FeatureFlagRecord` | `INVALID_ARGUMENT` |
| `PUT` | `/v1/admin/features/:key` | Operator write | `{ description?, enabled?, rolloutPercent? }` | `200`/`201FeatureFlagRecord` | `INVALID_ARGUMENT` |
| `PATCH` | `/v1/admin/features/:key` | Operator write | Partial flag body (unspecified fields retain current values) | `200FeatureFlagRecord` | `INVALID_ARGUMENT` |
| `DELETE` | `/v1/admin/features/:key` | Operator write | — | `{ deleted:true, key }` | `NOT_FOUND` |

`FeatureFlagRecord`: `{ key, description, enabled, rolloutPercent, updatedBy?, createdAt?, updatedAt? }` (exact fields come from `@vellum/database-control`). Admin audit-log cursors are opaque base64url `(created_at, id)` pairs ordered descending; keyset pagination, never SQL `OFFSET`.

---

## 9. Health & OpenAPI (`health.ts`)

| Method | Path | Auth | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/v1/health/live` | None | Liveness; never touches PostgreSQL. Used by the container `HEALTHCHECK`. |
| `GET` | `/v1/health/ready` | None | Readiness; runs real SQL probes against control/data planes, migration tables and the dedicated LISTEN endpoint. Returns `503 SERVICE_UNAVAILABLE` when a probe fails. |
| `GET` | `/v1/health` | None | Deprecated compatibility alias; plane flags derived from real `SELECT 1` probes. |
| `GET` | `/v1/openapi.json` | None | Machine-readable OpenAPI 3.1 specification generated by `generateOpenApiSpec`. |

Any unmatched route returns `404 NOT_FOUND` via the catch-all in `app.ts`.

## Quick cross-reference

- Public, API-key-only document operations: [REST Data Plane](./rest-data-plane.md)
- WebSocket frames, resume, watermarks: [Realtime Protocol](./realtime-protocol.md)
- Canonical codes, statuses, retry guidance: [Errors](./errors.md)
- Tagged values and path grammar: [Wire Format](./wire-format.md)
