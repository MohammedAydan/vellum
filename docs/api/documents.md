# Document Plane HTTP REST & Transactional API Specification

## 1. Overview & Base URL

All document operations are partitioned by `(projectId)` and mounted at:

```http
https://api.vellum.dev/v1/projects/{projectId}
```

Where:
- `{projectId}`: UUIDv4 of the tenant project.

---

## 2. Authentication & Authorization Headers

Every request to the Document Plane requires authentication via request headers:

| Header | Description | Required |
|---|---|---|
| `X-Project-Key` | Public (`pk_*`) or Secret (`sk_*`) API key issued for the project. | **Yes** |
| `Authorization` | `Bearer <JWT>` containing verified end-user claims (`uid`, `email`, custom claims). | Optional (required for rules using `auth.uid`) |
| `X-Request-Id` | Tracing UUID. Automatically generated if omitted and returned in the response. | Optional |
| `X-Transaction-Token` | Signed HMAC-SHA256 token when operating within an OCC interactive transaction. | Optional |

---

## 3. Document CRUD Endpoints

### 3.1 Get Document
```http
GET /v1/projects/{projectId}/documents/{path}
```
**Headers:** `X-Project-Key: sk_...`
**Query Parameters:**
- `transactionToken` (optional): Interactive transaction token.

**Response `200 OK`:**
```json
{
  "documentId": "user_123",
  "path": "users/user_123",
  "collectionPath": "users",
  "collectionGroup": "users",
  "data": {
    "displayName": "Alice Smith",
    "email": "alice@example.com",
    "score": 1500
  },
  "sizeBytes": 142,
  "version": 3,
  "createdAt": "2026-11-15T18:00:00.000Z",
  "updatedAt": "2026-11-15T19:30:00.000Z"
}
```

### 3.2 List Documents in Collection
```http
GET /v1/projects/{projectId}/documents/{collectionPath}
```
**Query Parameters:**
- `limit`: Integer (1 to 500, default 50).
- `startAfter`: Signed opaque cursor from previous page.

**Response `200 OK`:**
```json
{
  "documents": [ ... ],
  "nextCursor": "eyJ...",
  "meta": {
    "count": 50,
    "indexUsed": "users_score_desc",
    "executionTimeMs": 2.15,
    "compiledSql": "SELECT ..."
  }
}
```

### 3.3 Create Document (Auto-Generated ID)
```http
POST /v1/projects/{projectId}/documents/{collectionPath}
```
**Body:**
```json
{
  "data": {
    "title": "Welcome to Vellum",
    "published": true
  }
}
```
**Response `201 Created`:** Public document representation with assigned `documentId`.

### 3.4 Set Document (Upsert or Merge)
```http
PUT /v1/projects/{projectId}/documents/{path}
```
**Body:**
```json
{
  "data": {
    "status": "active",
    "loginCount": { "$op": "increment", "value": 1 }
  },
  "merge": true,
  "ifVersion": 2
}
```
**Response `200 OK`:** Updated public document representation.

### 3.5 Update Document (Strict Exists)
```http
PATCH /v1/projects/{projectId}/documents/{path}
```
Fails with `NOT_FOUND` if document does not exist, or `ABORTED_CONFLICT` if `ifVersion` does not match.

### 3.6 Delete Document (Soft Delete with Tombstone)
```http
DELETE /v1/projects/{projectId}/documents/{path}?ifVersion=3
```
**Response `200 OK`:**
```json
{
  "path": "users/user_123",
  "status": "deleted",
  "version": 4,
  "updatedAt": "2026-11-15T21:00:00.000Z"
}
```

---

## 4. Structured Query Endpoint

```http
POST /v1/projects/{projectId}/query
```

**Body:**
```json
{
  "collectionPath": "orders",
  "where": [
    { "field": "status", "op": "==", "value": "paid" },
    { "field": "totalAmount", "op": ">=", "value": 100 }
  ],
  "orderBy": [
    { "field": "totalAmount", "dir": "desc" },
    { "field": "createdAt", "dir": "asc" }
  ],
  "limit": 50,
  "startAfter": null
}
```

**Supported Filter Operators (§7.1):**
- Equality / Inequality: `==`, `!=`
- Relational: `<`, `<=`, `>`, `>=`
- Disjunctive / Membership: `in`, `not-in`, `array-contains`, `array-contains-any`

---

## 5. Atomic Batch Write

```http
POST /v1/projects/{projectId}/batchWrite
```

**Limits:** Maximum 100 operations, maximum 5 MiB total payload.

**Body:**
```json
{
  "mutations": [
    {
      "type": "set",
      "path": "accounts/acc_1",
      "data": { "balance": { "$op": "increment", "value": -50 } }
    },
    {
      "type": "update",
      "path": "accounts/acc_2",
      "data": { "balance": { "$op": "increment", "value": 50 } },
      "ifVersion": 10
    }
  ]
}
```

**Response `200 OK`:**
```json
{
  "results": [ ... ],
  "committedAt": "2026-11-15T21:10:00.000Z"
}
```

---

## 6. Optimistic Concurrency Control (OCC) Transactions

Interactive multi-document ACID transactions with client-side retry:

### Step 1: Begin Transaction
```http
POST /v1/projects/{projectId}/transactions:begin
```
**Response `200 OK`:**
```json
{
  "transactionId": "tx_a1b2c3d4",
  "transactionToken": "eyJhbGciOi...",
  "expiresAt": "2026-11-15T21:10:05.000Z"
}
```

### Step 2: Read Under Transaction
Provide `X-Transaction-Token` in `GET` requests to record read versions in the OCC token.

### Step 3: Commit Transaction
```http
POST /v1/projects/{projectId}/transactions:commit
```
**Body:**
```json
{
  "transactionToken": "eyJhbGciOi...",
  "mutations": [ ... ]
}
```
If any observed read version changed, the transaction aborts with `409 ABORTED_CONFLICT`. Client SDKs automatically retry up to 5 times with randomized exponential full jitter backoff.
