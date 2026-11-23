---
title: Authentication
order: 3
group: Getting started
description: API keys, end-user tokens, key rotation, and least-privilege access.
---

# Authentication

VELLUM credentials are **fully isolated** per surface. They share only stateless crypto primitives; storage, signing secrets, JWT `typ`/`iss`/`aud`, claims and middleware are fully separate, so a token minted for one surface is rejected anywhere else.

The **document plane** (`/v1/projects/...`) uses API keys via `x-vellum-api-key` (legacy `x-project-key`), with an optional **EdDSA-only** end-user bearer. There is no HS256 fallback, anonymous fallback or implicit master key.

See [End-User Authentication](./end-user-auth.md) for tokens, refresh rotation, the full REST reference and rate limits.

:::note
A public API key can safely appear in a browser or mobile app, but it grants **zero implicit data access**. Every operation is evaluated against the project's active security ruleset. A server key bypasses rules only for the explicit scopes it carries.
:::

## Scenario

You are adding a feature where users sign in to your app and the client reads only its own documents. You issue a public `pk_` key for the browser, attach the signed-in user's JWT on each request, and rely on security rules to enforce ownership — keeping the master `sk_` key on your server only.

```bash
# Every document-plane call presents the key in a header, never in the URL.
curl "https://api.example.com/v1/projects/<PROJECT_ID>/documents/users/u_123" \
  -H "x-project-key: <YOUR_PUBLIC_KEY>" \
  -H "Authorization: Bearer <END_USER_JWT>"
```

## API keys (`pk_` / `sk_`)

Keys are generated in the form `<prefix>_<envTag>_<random>`:

| Prefix | Type | Body length | Project tag |
| :--- | :--- | :--- | :--- |
| `pk_` | Public | 32 base62 chars | `live` (legacy `dev` / `stg` still valid) |
| `sk_` | Server | 48 base62 chars | `live` (legacy `dev` / `stg` still valid) |

Examples of the *shape* (not usable values): `pk_...` and `sk_...`. Keys use only the `pk_`/`sk_` prefixes and are scoped to the project.

Only a 16-character prefix and a digest are persisted. The digest is `SHA256(fullKey + ":" + API_KEY_PEPPER)`, compared in constant time. The plaintext key is returned only once, at creation. Verified keys are cached in-process for 30 seconds; revocation and rotation publish `NOTIFY vellum_cache_invalidate` so other instances drop their cached entry.

### Scopes

A server key carries explicit scopes. Required scope by operation:

| Operation | Required scope |
| :--- | :--- |
| `get`, `list`, `query` | `documents:read` |
| `create`, `set`, `update`, `delete`, `batchWrite`, transactions | `documents:write` |
| index management | `indexes:manage` |

The `*` scope grants everything. A public key cannot manage composite indexes. A missing scope yields `PERMISSION_DENIED` (403); a missing or invalid key yields `UNAUTHENTICATED` (401).

```ts
import { createClient } from "@vellumdb/sdk-js";

const db = createClient({
  endpoint: "https://api.example.com",
  projectId: "<YOUR_PROJECT_ID>",
  apiKey: "<YOUR_API_KEY>", // sent as x-project-key
  getAuthToken: async () => currentUserJwt(), // optional end-user token for auth.uid
});
```

## End-user tokens and rules evaluation

When a public key is used, an optional `Authorization: Bearer <jwt>` supplies the end-user identity. The SDK's `getAuthToken` callback supplies this token on each request. The rules AST can read `auth.uid` and `auth.claims.<field>`, so the same public key can serve many users safely. See [Security rules](./security-rules.md).

## Rotation and revocation

Keys are issued per project. The raw key value is returned only at creation; afterwards only prefixes, scopes, status and usage metadata are visible.

To rotate without downtime: create the new key, deploy it to clients, confirm traffic has moved, then revoke the old key. Because revocation is also enforced against the control-plane record, a cached key cannot be used after its `revokedAt` is set.

## Least privilege

- Use separate keys per project and never reuse a key across projects. Keys use only the `pk_`/`sk_` prefixes and are scoped to the project; there are no environment-scoped keys or deployment stages in the product.
- Prefer `pk_` keys in client apps and let security rules decide access; use `sk_` keys only on trusted servers.
- Grant the narrowest scope set: read-only services get `documents:read`, index tooling gets `indexes:manage`.
- Set an expiry on temporary keys and rotate them on a schedule.

:::warning
Never log raw `pk_`/`sk_` keys, bearer JWTs, or database URLs. The structured logger in `@vellum/observability` redacts these patterns automatically; keep all application logs on that path.
:::

## Common pitfalls

- **Confusing credentials.** Any credential minted outside the document plane is rejected on it, and an API key never authorizes anything beyond it.
- **Assuming a public key is privileged.** With no active ruleset, public-key access is denied; rules must explicitly allow each operation.
- **Using a `*` scope for convenience.** An over-scoped server key defeats least privilege; grant only what the service needs.
- **Forgetting to rotate.** Create the replacement first, move clients, then revoke — never revoke before the new key is deployed.

## What to read next

- [End-User Authentication](./end-user-auth.md) — credential isolation, refresh rotation, profile projection, WS auth, rate limits.
- [JavaScript SDK](./sdks/javascript.md) · [Flutter SDK](./sdks/flutter.md) — the auth façades and silent refresh in both clients.
- [Security rules](./security-rules.md) — the deny-by-default AST evaluated for public keys.
- [REST API](./rest-api.md) — how the key is sent on each endpoint.
- [Production checklist](./production-checklist.md) — release gates and secret hygiene.
