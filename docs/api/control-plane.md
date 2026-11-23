# Document Database SaaS — Control Plane REST API Reference

The Control Plane manages platform tenants, organizations, projects, API keys, versioned declarative security rulesets, and audit logs. It runs independently on `control_db` with zero circular dependencies on the Data Plane. The project is the sole tenant.

---

## 1. System Health & Metadata

### `GET /v1/health`
Checks liveness and connectivity to Control Plane, Data Plane, and Realtime pub/sub subsystems.

**Response `200 OK`:**
```json
{
  "status": "ok",
  "version": "0.0.1",
  "planes": {
    "controlDb": "connected",
    "dataDb": "connected",
    "realtimePubSub": "connected"
  },
  "timestamp": "2026-11-15T18:00:00.000Z"
}
```

### `GET /v1/openapi.json`
Exports the complete OpenAPI 3.1.0 specification for all public HTTP REST and realtime endpoints.

---

## 2. Organizations

### `POST /v1/organizations`
Creates a new customer organization.

**Request Body:**
```json
{
  "name": "Acme Cloud",
  "slug": "acme-cloud",
  "planTier": "pro"
}
```
*Constraints:* `slug` must match `^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$`.

**Response `201 Created`:**
```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "slug": "acme-cloud",
  "name": "Acme Cloud",
  "billingEmail": "acme-cloud@example.com",
  "planId": "pro",
  "status": "active",
  "createdAt": "2026-11-15T18:00:00.000Z",
  "updatedAt": "2026-11-15T18:00:00.000Z"
}
```
*Audit Log:* Generates `organization.created`.

### `GET /v1/organizations`
Lists organizations accessible to the authenticated developer session.

---

## 3. Projects

### `POST /v1/organizations/:orgId/projects`
Provisions a new project under the organization.

**Request Body:**
```json
{
  "name": "Mobile Backend",
  "slug": "mobile-backend"
}
```

**Response `201 Created`:**
```json
{
  "project": {
    "id": "123e4567-e89b-12d3-a456-426614174001",
    "organizationId": "123e4567-e89b-12d3-a456-426614174000",
    "slug": "mobile-backend",
    "name": "Mobile Backend",
    "status": "active",
    "clusterId": "cluster_shared_01",
    "createdAt": "2026-11-15T18:00:00.000Z",
    "updatedAt": "2026-11-15T18:00:00.000Z"
  },
  "project": {
    "id": "uuid-proj",
    "softDeleteRetentionDays": 7
  }
}
```
*Audit Log:* Generates `project.created`.

### `GET /v1/organizations/:orgId/projects`
Lists all projects within the organization.

### `GET /v1/projects/:projectId`
Returns the project. There are no environment records.

All `/v1/projects/:projectId/...` endpoints below are scoped to the project. Keys use only the `pk_`/`sk_` prefixes.

---

## 4. API Key Management

### `POST /v1/projects/:projectId/api-keys`
Generates a new Public (`pk_`) or Server (`sk_`) API key.

**Request Body:**
```json
{
  "name": "Web Client Key",
  "keyType": "publishable",
  "expiresAt": null
}
```

**Response `201 Created`:**
```json
{
  "apiKey": {
    "id": "uuid-key-1",
    "projectId": "uuid-proj-1",
    "name": "Web Client Key",
    "keyType": "public",
    "keyPrefix": "pk_abc12345",
    "createdAt": "2026-11-15T18:00:00.000Z"
  },
  "rawKey": "pk_abc12345678901234567890123456789"
}
```
> [!IMPORTANT]
> The `rawKey` is displayed exactly once upon generation. Plaintext keys are never stored in the database; only a peppered SHA-256 digest is persisted.

*Audit Log:* Generates `api_key.created`.

### `GET /v1/projects/:projectId/api-keys`
Lists metadata for API keys in the project (without raw secrets).

### `DELETE /v1/projects/:projectId/api-keys/:keyId`
Immediately revokes an API key and purges it from memory cache.

**Response `200 OK`:**
```json
{
  "success": true,
  "revoked": {
    "id": "uuid-key-1",
    "revokedAt": "2026-11-15T18:00:00.000Z"
  }
}
```
*Audit Log:* Generates `api_key.revoked`.

---

## 5. Declarative Security Rulesets

### `POST /v1/projects/:projectId/rulesets`
Deploys a new version of the declarative Security Rules AST for the project. The new version is atomically made active; the previous version is marked inactive.

**Request Body:**
```json
{
  "rulesAst": {
    "version": 1,
    "rules": [
      {
        "match": "users/{userId}",
        "allow": {
          "read": true,
          "write": {
            "op": "==",
            "left": { "var": "auth.uid" },
            "right": { "var": "path.userId" }
          }
        }
      }
    ]
  }
}
```
*Validation:* Enforces AST maximum depth $\le 10$ and maximum node count $\le 100$.

*Audit Log:* Generates `ruleset.published`.

### `GET /v1/projects/:projectId/rulesets`
Fetches the currently active security ruleset for the project.

---

## 6. Error Handling

All Control Plane errors conform to Specification Section 11.2:
```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "Security rule AST exceeds maximum depth of 10",
    "requestId": "req_01HPX7K9M2J14NVQZ8C8F0E2D1",
    "details": {
      "maxDepth": 10
    }
  }
}
```
- `400`: `INVALID_ARGUMENT`
- `401`: `UNAUTHENTICATED`
- `403`: `PERMISSION_DENIED`
- `404`: `NOT_FOUND`
- `500`: `INTERNAL`
