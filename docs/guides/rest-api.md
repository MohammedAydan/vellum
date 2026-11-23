---
title: REST API Orientation
order: 13
group: Reference
description: A short map of the /v1 HTTP endpoint families, with a link to the full reference.
---

# REST API Orientation

The HTTP API is mounted under `/v1` and returns JSON for every response, attaching `X-Request-Id`. Document-plane endpoints authenticate with the `x-project-key` header; console endpoints use a session bearer token. A machine-readable OpenAPI 3.1 document is served at `GET /v1/openapi.json`.

:::note
Prefer the [SDK](./quickstart.md) for application code. Use raw HTTP when calling from a language without an official SDK or when debugging. The full endpoint-by-endpoint reference lives in the [HTTP API reference](./reference/rest-data-plane.md).
:::

## Scenario

You are integrating VELLUM from a language that has no official SDK. You discover the available endpoints from `/v1/openapi.json`, then make a signed `x-project-key` request to read a document and a `POST` to `/query` to fetch a filtered page — checking `X-Request-Id` on each response for support.

```bash
# Discover the live contract before writing integration code.
curl -fsS "https://api.example.com/v1/openapi.json" | jq '.paths | keys[]'
```

## Endpoint families

| Family | Base path | Auth | What it does |
| :--- | :--- | :--- | :--- |
| Health | `/v1/health/live`, `/v1/health/ready` | Public | Liveness and real SQL readiness probes. |
| Metadata | `/v1/openapi.json` | Public | OpenAPI 3.1 specification. |
| Documents | `/v1/projects/:projectId/documents/*path` | `x-project-key` | `GET` doc/collection, `POST` create, `PUT` set, `PATCH` update + transforms, `DELETE` soft delete. |
| Query | `/v1/projects/:projectId/query` | `x-project-key` + rules | Structured `where` / `orderBy` / `select` / cursor query. |
| Batch | `/v1/projects/:projectId/batchWrite` | `x-project-key` + rules | Up to 100 atomic mutations. |
| Transactions | `/v1/.../transactions:begin`, `.../transactions:commit` | `x-project-key` + rules | OCC token issuance and atomic commit. |
| Indexes | `/v1/.../indexes`, `/v1/.../indexes/:indexId` | Server key, `indexes:manage` | List, create, and delete composite indexes. |
| Collections | `/v1/.../collections` | `x-project-key` | List real collection paths (studio helper). |
| Auth | `/v1/auth/sign-up/email`, `/v1/auth/sign-in/email`, `/v1/auth/session`, `/v1/auth/sign-out` | Session / public | Email auth and session management. |
| MFA | `/v1/auth/mfa/status`, `/setup`, `/verify`, `/disable` | Session | TOTP enrollment and verification. |
| Console | `/v1/console/...` | Session JWT + org check | Dashboards; audited control-plane mutations. |
| Rulesets | `/v1/projects/:projectId/rulesets` | Session | Publish and read security rulesets. |
| Realtime | `/v1/realtime` (WebSocket) | `auth` frame | Live document and query streams. |

## A raw request

```bash
curl "https://api.example.com/v1/projects/<PROJECT_ID>/documents/users/u_123" \
  -H "x-project-key: <YOUR_API_KEY>"
```

```json
{
  "path": "users/u_123",
  "collectionPath": "users",
  "collectionGroup": "users",
  "documentId": "u_123",
  "data": { "name": "Ada", "role": "admin" },
  "sizeBytes": 96,
  "version": 3,
  "createdAt": "2026-11-15T14:30:00.123Z",
  "updatedAt": "2026-11-17T09:00:00.000Z"
}
```

For a query, `POST` a query spec to `.../query`; the response is `{ documents, nextCursor, meta }`:

```bash
curl -X POST "https://api.example.com/v1/projects/<PROJECT_ID>/query" \
  -H "x-project-key: <YOUR_API_KEY>" \
  -H "content-type: application/json" \
  -d '{"collectionPath":"users","where":[{"field":"status","op":"==","value":"active"}],"limit":25}'
```

See [Query](./query.md) and [Pagination](./pagination.md).

:::warning
Never place a server key or session token in a URL or commit it to source control. Use placeholders and pass credentials in headers from a secret store.
:::

## Common pitfalls

- **Putting the key in the URL.** Always send `x-project-key` (or `Authorization: Bearer`) in a header.
- **Mixing up auth surfaces.** Document endpoints take an API key; console endpoints take a session bearer token.
- **Forgetting `X-Request-Id`.** Capture it on every response so support can correlate incidents safely.
- **Skipping the OpenAPI spec.** `GET /v1/openapi.json` is the authoritative, up-to-date request/response schema.

## Verified example

:::example-tabs rest-api

## What to read next

- [Full HTTP API reference](./reference/rest-data-plane.md) — request/response schemas for every endpoint.
- [Authentication](./authentication.md) — header formats, scopes, and sessions.
- [Realtime](./realtime.md) — the WebSocket frame protocol.
