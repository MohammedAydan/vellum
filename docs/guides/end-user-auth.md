---
title: End-User Authentication
order: 4
group: Authentication
description: EdDSA-only end-user tokens, refresh rotation with a 15 s grace window, profile projection, REST surfaces, WS auth and rate limits.
---

# End-User Authentication

Project end-user tokens are fully isolated from every other credential. The token layer shares only stateless crypto primitives from `@vellum/auth` (scrypt, AES-256-GCM, SHA-256, TOTP, token generators, rotation math) with other surfaces; storage, signing keys, JWT `typ`/`iss`/`aud`, claims, session services and middleware are 100% separate, so a token from another surface is always rejected here.

| Surface | Sessions | Secret | Algorithm | `typ` | `iss` | `aud` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| project end users | `data_db.project_auth_*` (FORCE RLS) | project Ed25519 key | **EdDSA** | `vellum+enduser+jwt` | `https://api.vellum.dev/v1/projects/<projectId>/auth` | `<projectId>` |

:::important No HS256 fallback
End-user tokens are verified **EdDSA-only** on both HTTP and WebSocket, against the project's Ed25519 public key. Any HS256 token is rejected on the document plane even with a valid project API key.
:::

## End-user tokens and JWKS

Access tokens carry `iss`, `sub`, `aud=projectId`, `email`, `email_verified`, `is_anonymous`, `claims`, `iat`, `exp`, `auth_time` and `jti`, signed per project. Verification requires `alg=EdDSA`, `typ=vellum+enduser+jwt`, exact `aud`/`iss`, and reports expired tokens as `TOKEN_EXPIRED` with `retryableWithRefresh: true`. Public keys are served at `GET /v1/projects/:projectId/auth/.well-known/jwks.json` (OKP/Ed25519, no API key). Each project has one Ed25519 key pair.

Refresh tokens are opaque 32-byte values; only SHA-256 hashes are stored. Rotation keeps the previous hash plus `rotated_at`:

- current hash → normal rotation;
- previous hash within **15 s** → benign concurrent tab, a brand-new session is issued and no session is revoked;
- previous hash after 15 s → replay → **all sessions revoked** with reason `refresh_token_replay_detected`.

Both client SDKs pre-flight refresh 60 s before `exp`, deduplicate with a single-flight mutex, and react to a `401` with one forced refresh plus one transparent replay.

**Revocation semantics (known limitation):** admin revoke, password reset and sign-out revoke *sessions and refresh tokens immediately*. Access JWTs are stateless (verified by signature + `exp` without a store lookup), so an already-issued access token stays valid until it expires. The TTL defaults to **1 hour** and is configurable per project via `accessTokenTtlSeconds` in the auth config — lower it for projects where revoke must take effect faster. Per-request session checks were rejected to keep document reads free of a control-plane lookup.

## Automatic user projection

With `enable_user_projection` on (default), auth writes `users/{uid}` via `DocumentEngine.setDocument` with `system_bypass` (`bypassRules: true`) and `merge: true`. The document is re-synced after sign-up, `updateProfile`, email-verification confirmation, and claims changes — all live-verified.

## REST surfaces

- **End-user** (`/v1/projects/:p/auth`): `sign-up/email`, `sign-in/email`, `sign-in/anonymous`, `sign-in/provider` (secret `sk_` key only, 403 with a publishable `pk_` key; for trusted backends that verify provider identity themselves), `token/refresh`, `sign-out`, `GET|PATCH /user`, `password/reset`, `password/confirm`, `email/verify/request`, `email/verify/confirm`, `mfa/enroll`, `mfa/verify`, `mfa/disable` (needs a signed-in user and a current code), `mfa/challenge`, `/.well-known/jwks.json`.

See the [full REST reference](../../docs/07-end-user-auth.md).

## WebSocket auth and subscribe frames

The `auth` frame sends `{ type:"auth", projectId, apiKey, authToken }`; `authToken` is the EdDSA JWT verified with the project public key. Query subscriptions nest the spec:

```json
{ "type": "subscribe", "subId": "sub_ab12cd34",
  "query": { "collectionPath": "tasks", "where": [{ "field": "done", "op": "==", "value": false }],
             "orderBy": [{ "field": "priority", "direction": "asc" }], "limit": 20 } }
```

After token rotation the SDK re-sends the `auth` frame on the live connection.

## Account enumeration behavior

- `sign-up/email` returns `409 ALREADY_EXISTS` when the email is taken, the same as Firebase's `email-already-in-use`. Sign-up must return a session, so it cannot hide that an account exists.
- `sign-in/email` takes the same time and returns the same `UNAUTHENTICATED` error for an unknown email and a wrong password.
- `password/reset` and `email/verify/request` always answer `{ "success": true, "sent": true }`, including when the email is unknown or the project has no SMTP configured. A successful `sendPasswordResetEmail()` therefore does not prove an email was delivered. Configure SMTP for the project and check delivery on your side.
- Password policy failures return `INVALID_ARGUMENT` with a message that names the unmet rule, such as the minimum length.

## Rate limits

In-process sliding windows (no Redis): 10 failed logins / 15 min per `(ip,email)`; 5 reset/verify requests / 15 min (keyed by `(ip,email)` or `ip + SHA-256(signed bearer)` when no email); 5 failed MFA attempts / 5 min (also counted in the database, so it holds across serverless instances). A TOTP code works once. Enrolling again while MFA is on is refused; turn it off first with a current code. Social sign-in (Google, GitHub) also asks for the second factor when the user has MFA on. Throttled responses are `429 TOO_MANY_REQUESTS` with `Retry-After`.

## Read next

- [JavaScript SDK](./sdks/javascript.md) · [Flutter SDK](./sdks/flutter.md)
