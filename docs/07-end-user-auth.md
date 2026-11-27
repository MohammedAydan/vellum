# End-User Authentication & the Three Realms (v1)

This document is the authoritative reference for authentication across the whole platform. It supersedes the older two-surface description in `docs/04-security-rules-ast.md` and complements the HTTP/WS wire reference in `docs/05-http-and-realtime-api.md`. Client-side usage is covered in [the JavaScript SDK guide](./08-sdk-js-guide.md) and [the Flutter SDK guide](./09-sdk-flutter-guide.md).

> Everything below is live-verified against the API at `http://127.0.0.1:8080` (real PostgreSQL control + data planes).

## 1. Three isolated authentication realms

Authentication is split into **three realms**. They deliberately share only *stateless crypto primitives* from `@vellum/auth` (scrypt password hashing, AES-256-GCM envelope encryption, SHA-256, TOTP, base64url/random token generators, generic rotation math). Storage tables, signing secrets, JWT `typ`/`iss`/`aud`, claim shapes, session services and middleware are **100% isolated** per realm. A token minted for one realm is rejected by the other two.

| Realm | Session store | Signing secret / key | Algorithm | JWT header `typ` | `iss` | `aud` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `super_admin` | `control_db.control_plane_refresh_sessions` (rows with `realm = 'super_admin'`) | `SUPER_ADMIN_JWT_SECRET` (non-production fallback `JWT_SECRET`; never both in production) | `HS256` (HMAC-SHA256 via `node:crypto`) | `vellum+superadmin+jwt` | `vellum:control-plane:super-admin` | `vellum-super-admin` |
| `customer_console` | `control_db.control_plane_refresh_sessions` (rows with `realm = 'customer_console'`) | `CONSOLE_JWT_SECRET` (non-production fallback `JWT_SECRET`) | `HS256` | `vellum+console+jwt` | `vellum:control-plane:console` | `vellum-customer-console` |
| `project_end_user` | `data_db.project_auth_*` tables with `ENABLE` + `FORCE ROW LEVEL SECURITY` | Per-project Ed25519 private key, AES-256-GCM encrypted with a key derived from `MASTER_ENCRYPTION_KEY` | `EdDSA` (Ed25519) | `vellum+enduser+jwt` | `https://api.vellum.dev/v1/projects/<projectId>/auth` | `<projectId>` |

The realm session service (`packages/auth/src/realm-session.ts`, `createRealmSessionService`) signs access and refresh tokens with the realm's `typ`, `iss`, `aud` and `realm` claim, and `verifyAccess` / `verifyRefresh` reject any mismatch. `apps/api/src/index.ts` creates two instances — `consoleSessionService` and `superAdminSessionService` — exposed on `VellumPlatformContext`; `platform.sessionService` remains a backward-compatible alias of the console service.

**The document plane is EdDSA-only.** `resolveEndUserAuth` (`apps/api/src/middleware/tenant-auth.ts`) and the WebSocket hub (`packages/realtime/src/hub.ts`) verify end-user tokens with `verifyEndUserAccessToken()` against the target project's Ed25519 public key. There is **no HS256 fallback** anymore: a console or super-admin HS256 token, or any raw HS256 token signed with a platform secret, is rejected on a document-plane route even when a valid project API key is present. A console/admin token presented to a document route fails because it is neither `EdDSA` nor `vellum+enduser+jwt`. The three-realm isolation suite (`tests/security/three-realm-isolation.test.ts`) asserts all of these cross-realm rejections.

Bootstrap, operator login and API-key verification read only `control_db`; they never depend on the public document API.

### Where each kind of state lives

| Concern | Plane / store | Notes |
| :--- | :--- | :--- |
| Platform users, orgs, projects, API keys, rulesets, quotas, audit logs | `control_db` | Existing tables. `users.is_platform_super_admin` gates super-admin routes (migration `0005`). |
| Auth config per project, global signup/SMTP settings | `control_db` | `project_auth_configs`, `platform_auth_global_settings` (migration `0004`). Secrets AES-256-GCM encrypted. |
| Console + super-admin refresh sessions | `control_db` | `control_plane_refresh_sessions` (migration `0005`), keyed by SHA-256 refresh hash with `previous_refresh_token_hash` and a 15 s grace window. |
| End-users, identities, sessions, MFA factors, action tokens | `data_db` | `project_auth_*` tables, `ENABLE` + `FORCE ROW LEVEL SECURITY` with per-command `(project_id)` policies (migration `0005`). |
| End-user session rotation metadata | `data_db` | `project_auth_sessions.rotated_at` (migration `0006`) powers the 15 s concurrency grace window. |
| Documents / indexes / realtime outbox | `data_db` | Existing data plane. Projection writes go here through `DocumentEngine` with a system bypass. |

## 2. Tokens and claims

### 2.1 End-user access token (`project_end_user`)

- Header: `{ alg: "EdDSA", typ: "vellum+enduser+jwt", kid: <jwtKeyId> }`.
- Payload: `iss` (the canonical issuer string above), `sub` (user id), `aud` (`projectId`) (`projectId`), `email`, `email_verified`, `is_anonymous`, `claims` (custom claims), `iat`, `exp`, `auth_time`, and `jti` (random UUID).
- Verification **requires** `alg === "EdDSA"`, `typ === "vellum+enduser+jwt"`, `payload.aud === projectId`, ` === projectId` and `payload.iss === expected.issuer`. A signature-valid but expired token yields `VellumError("TOKEN_EXPIRED", …, { retryableWithRefresh: true })`, which `errorHandler` hoists into the error envelope as `retryableWithRefresh: true`.
- `iss` is a fixed logical identifier (`https://api.vellum.dev/v1/projects/<projectId>/auth`), not a URL your deployment serves or that clients should fetch. It stays the same on every host so tokens keep verifying when you move or rename a deployment. Fetch keys from the JWKS endpoint below, on your own API host.
- Public JWKS: `GET /v1/projects/:projectId/auth/.well-known/jwks.json` (RFC 8037 OKP / Ed25519; no API key required).
- The per-project key pair is generated on first use (`generateEd25519KeyPair()`), the public PEM is stored in plain text and the private key is encrypted at rest. `POST .../auth/rotate-signing-key` rotates it under the super-admin realm.

### 2.2 Console and super-admin access tokens

`HS256`, realm-bound JWKS-free tokens. In addition to `sub`, `uid`, `role`, `orgIds`, `jti` and `exp`, the payload carries `iss`, `aud` and `realm`. Both guards emit a renewed access token in the `x-refreshed-session-token` response header when the presented token is within 24 hours of expiry (sliding renewal).

- `requireCustomerConsoleSession()` verifies with `consoleSessionService` and enforces org/project membership.
- `requireSuperAdminSession()` verifies with `superAdminSessionService`, loads the user from `control_db` and requires `user.isPlatformSuperAdmin === true`, otherwise `403 PERMISSION_DENIED` with `Platform Super Admin privileges required`.

Routes under `/v1/console/*` use the console guard; every `/v1/admin/*` route uses the super-admin guard **except** `/v1/admin/login`, `/v1/admin/setup-status` and `/v1/admin/setup-owner`.

### 2.3 Refresh tokens (all three realms)

Opaque 32-byte base64url strings; **only SHA-256 hashes are stored**. Session rows keep both the current hash and `previous_refresh_token_hash`, plus `rotated_at`. End-user refresh uses the data-plane `AuthSessionService`; console/admin refresh uses `refreshControlSession()` over `control_plane_refresh_sessions`. Both implement the same rotation and grace semantics described next.

## 3. Refresh rotation, grace window and silent refresh

`rotateAuthSession` / `rotateControlRefreshSession` set `rotated_at = now()` and increment the rotation counter. On refresh, the presented hash is matched against both the current and previous hash columns:

1. `refreshTokenHash === hash` → normal rotation: previous hash is stored, a new hash is written, `rotated_at` is refreshed, a fresh access + refresh pair is returned.
2. `previousRefreshTokenHash === hash` **and** `Date.now() - Date.parse(rotatedAt) <= 15_000` → benign concurrent tab. **No revocation**; a brand-new session is created for the same user and a fresh token pair is returned. Five truly simultaneous refreshes all succeed and return five distinct refresh tokens (verified by both SDK testbeds).
   This means that presenting a just-rotated refresh token again within 15 s returns `200` with a new session instead of an error. That is intended (concurrent tabs, retries after a lost response). Reuse after the window is rejected.
3. `previousRefreshTokenHash === hash` **after** the 15 s window → replay. `revokeAllUserSessions(ctx, userId, "refresh_token_replay_detected")` runs and the request fails with `UNAUTHENTICATED`. This is a theft signal, not a retryable error.

For the control-plane realms the same logic is implemented in `apps/api/src/routes/auth-endpoints.ts`, and the refresh token is also carried in an HttpOnly cookie `vellum_refresh_token` (`SameSite=Lax`, `Secure` in production). Login/sign-up for both realms issue both tokens, set the cookie and return the same JSON shape as refresh:

```json
{ "token": "<access JWT>", "accessToken": "<access JWT>", "refreshToken": "<opaque>",
  "expiresAt": "<ISO-8601>", "user": { "id": "...", "name": "...", "email": "...", "platformRole": "..." } }
```

Both refresh endpoints accept `{ "refreshToken": "..." }` **or** the cookie:

- `POST /v1/console/auth/refresh` — realm `customer_console`, exempt from the console guard.
- `POST /v1/admin/auth/session/refresh` — realm `super_admin`, public.

Cross-realm refresh tokens are rejected: a super-admin refresh token fails on the console endpoint and vice versa.

### Client silent refresh

Every first-party client performs a **pre-flight refresh 60 seconds before `exp`** and a **reactive 401 refresh + one transparent replay**, both deduplicated with a single-flight mutex:

| Client | Storage | Refresh endpoint | Single-flight |
| :--- | :--- | :--- | :--- |
| `@vellumdb/sdk-js` (`VellumAuthClient`) | `AuthStorage` (memory by default since 0.0.9; browser `localStorage` via `authPersistence: "local"`) | `POST /auth/token/refresh` | `refreshInFlightPromise` |
| `vellum_flutter` (`VellumAuth`) | `AuthTokenStorage` (memory default; secure storage hook) | `POST /auth/token/refresh` | `_inFlightRefresh` |
| Customer dashboard (`apiFetch` / `consoleFetch`) | `vellum_auth_session` | `/v1/console/auth/refresh` | per-client mutex |
| Admin dashboard (`adminFetch`) | `vellum_admin_session` | `/v1/admin/auth/session/refresh` | per-client mutex |

The refresh call never attaches the expiring bearer, and the raw message `Invalid, expired, or revoked session token` is never surfaced to a user. On refresh failure the client clears its session, redirects to `/login` and shows a friendly toast rather than reaching a React error boundary.

## 4. Automatic user-profile projection

When `enable_user_projection` is true (the default), the auth routes write the public user record to `{projectionCollectionPath}/{user.id}` — by default `users/<uid>` — through `DocumentEngine.setDocument` with:

- `bypassRules: true`, surfaced internally as `EngineContext.bypassRules` / `AuthorizeOperationParams` mode `system_bypass`. It is never derived from request input, so deny rules on the collection do not block the projection.
- `merge: true`, so developer-authored fields on the same document (e.g. `bio`, `theme`) are preserved.

**Re-projection is live-verified after every auth-record mutation:** sign-up, self-service `PATCH /auth/user` (`updateProfile`), `POST /auth/email/verify/confirm`, customer-admin `PATCH /auth/admin/users/:uid`, and customer-admin `PUT /auth/admin/users/:uid/claims`. Before the fix, `updateProfile` and the admin claims grant updated the auth record but left the projected `users/{uid}` document stale; both SDK testbed apps assert the refreshed fields.

## 5. Dual-token document requests

SDKs send both headers on every document-plane request:

```http
x-vellum-api-key: pk_...        # canonical alias; x-project-key is also sent
authorization: Bearer <end-user-jwt>
```

`pk_...` keys set `isAdminServer = false`: the JWT is verified EdDSA-only against the project public key and its identity is exposed to the rules AST as both `auth.uid` / `auth.claims.role` and `request.auth.uid` / `request.auth.claims.role` (with `email`, `email_verified`, `is_anonymous` and the raw `token` also available). `sk_...` keys set `isAdminServer = true` and bypass the rules AST for trusted server code.

## 6. Complete REST reference

Base paths:

- End-user: `/v1/projects/:projectId/auth`
- Customer admin: `/v1/projects/:projectId/auth/admin`
- Super admin: `/v1/admin/auth`

All end-user and customer-admin routes require a publishable or server API key (`x-vellum-api-key` or legacy `x-project-key`) **except** JWKS. Suspension, the global signup kill-switch and `max_users_quota` are enforced before sign-up/sign-in.

### 6.1 End-user (`.../auth`)

| Method | Path | Purpose | Success shape |
| :--- | :--- | :--- | :--- |
| `POST` | `/sign-up/email` | Create user + session (`email`, `password`, optional profile fields) | Session |
| `POST` | `/sign-in/email` | Password sign-in (`email`, `password`) | Session, or `{ mfaRequired: true, mfaTicket, factors: ["totp"], expiresAt }` |
| `POST` | `/sign-in/anonymous` | Anonymous session (optional `displayName`, `metadata`) | Session |
| `POST` | `/upgrade-anonymous` | Converts the signed-in anonymous account to email/password; uid preserved, other sessions revoked. `412` non-anonymous, `409` email taken | User |
| `POST` | `/sign-in/provider` | Provider sign-in for backends that verified the identity with the provider themselves. **Secret (`sk_`) key only** — returns 403 with a publishable `pk_` key | Session |
| `POST` | `/token/refresh` | Rotate refresh token (`{ refreshToken }`); 15 s grace | Session |
| `POST` | `/sign-out` | Revoke one session (`refreshToken`) or all (`{}` + bearer) | `{ success: true }` |
| `GET` | `/user` | Latest public user record | `{ user }` |
| `PATCH` | `/user` | Update profile; re-projects | `{ user }` |
| `POST` | `/password/reset` | Request reset token (`email`) | `{ success: true, devToken?, expiresAt? }` |
| `POST` | `/password/confirm` | Consume reset token (`token`, `newPassword`) | `{ success: true }` |
| `POST` | `/email/verify/request` | Request verification (bearer or `email`) | `{ success: true, devToken?, expiresAt? }` |
| `POST` | `/email/verify/confirm` | Consume verification token (`token`); re-projects | `{ verified: true, user? }` |
| `POST` | `/mfa/enroll` | Begin TOTP enrollment | `{ secret, otpauthUri, recoveryCodes }` |
| `POST` | `/mfa/verify` | Confirm enrollment (`code`) | `{ success: true }` |
| `POST` | `/mfa/challenge` | Solve MFA (`mfaTicket`, `code`, optional `factorType`) | Session |
| `GET` | `/.well-known/jwks.json` | Public Ed25519 verification keys (no API key) | `{ keys: [...] }` |

**Session shape** (sign-up, all sign-ins, refresh, MFA challenge):

```json
{ "user": { "id": "...", "email": "...", "emailVerified": false, "customClaims": {} },
  "accessToken": "<EdDSA JWT>", "refreshToken": "<opaque>", "tokenType": "Bearer",
  "sessionId": "...", "expiresAt": "..." }
```

When TOTP is enrolled, sign-in returns no tokens until `/mfa/challenge` succeeds. Password reset and email verification are non-enumerating: in production they always return `200 { sent: true }` for unknown emails; without SMTP in development they additionally return a one-time `devToken` when the user exists.

### 6.2 Customer admin (`.../auth/admin`)

Guarded by a `customer_console` session or an `sk_...` key. Password hashes, token hashes and encrypted secrets are never returned (`sanitizeAdminPayload` strips them).

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `GET` | `/users` | Keyset paginated directory (`limit`, `cursor`, `search`, filters) |
| `POST` | `/users` | Create a user (re-projects) |
| `GET` | `/users/:uid` | Fetch one user |
| `PATCH` | `/users/:uid` | Patch user fields (re-projects) |
| `DELETE` | `/users/:uid` | Delete a user |
| `PUT` | `/users/:uid/claims` | Set custom claims (≤ 1000 bytes; re-projects) |
| `POST` | `/users/:uid/revoke` | Revoke all sessions of a user |
| `POST` | `/users:import` | Bulk import (re-projects) |
| `GET` | `/config` | Read project auth config |
| `PATCH` | `/config` | Update project auth config |

### 6.3 Super admin (`/v1/admin/auth`)

Owner/admin session only; no customer `documents.data` is ever rendered (privacy invariant).

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `GET` | `/overview` | Global end-user auth metrics |
| `GET` | `/projects` | Projects with auth configuration |
| `PATCH` | `/projects/:projectId/control` | Suspension, quotas, provider/policy toggles |
| `POST` | `/projects/:projectId/rotate-signing-key` | Rotate the project Ed25519 signing key |
| `GET` | `/settings` | Platform-wide auth settings |
| `PATCH` | `/settings` | Update platform-wide auth settings |
| `POST` | `/session/refresh` | **Super-admin refresh endpoint** (realm `super_admin`; body token or cookie) |

### 6.4 Console & admin session endpoints

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `POST` | `/v1/console/auth/refresh` | **Console refresh endpoint** (realm `customer_console`; body token or cookie) |
| `POST` | `/v1/admin/login` | Super-admin login; issues access + refresh and sets the cookie |

## 7. WebSocket authentication (`/v1/realtime`)

The `auth` frame carries the same material the HTTP layer uses:

```json
{ "type": "auth", "projectId": "<projectId>", "apiKey": "pk_...", "authToken": "<end-user EdDSA JWT>" }
```

The hub verifies `authToken` with `verifyEndUserAccessToken()` against the project's Ed25519 `jwtPublicKeyPem`, using the **exact same** issuer, `aud=projectId`, claim mapping as `resolveEndUserAuth`. It fails closed when no auth config exists, preserves `TOKEN_EXPIRED` semantics, and accepts neither HS256 tokens nor an anonymous bypass when a token is supplied. Claims (`uid`, `claims`, `email`, `email_verified`, `is_anonymous`, `token`) reach the subscription matcher identically to HTTP.

A query subscription nests the canonical query spec under `query` (the Flutter `watchCollection()` bug fix uses `toRealtimeQuerySpec()` — `direction` in order-by clauses, no opaque cursors in the WS frame):

```json
{ "type": "subscribe", "subId": "sub_ab12cd34",
  "query": { "collectionPath": "tasks", "where": [{ "field": "done", "op": "==", "value": false }],
             "orderBy": [{ "field": "priority", "direction": "asc" }], "limit": 20 } }
```

When the bearer rotates (silent refresh, forced refresh or reactive 401 replay), the SDK calls `reauthenticate()` on the live transport and re-sends the `auth` frame; the server replies with a fresh `auth_ack`.

## 8. Rate limiting

Throttles are counted in PostgreSQL (Zero-Redis doctrine: PostgreSQL is the only stateful service), so every API instance shares the same counters. They are keyed only by opaque identifiers — IP/email pairs, `SHA-256` bearer hashes, MFA ticket/user hashes — never logged or returned. A throttled response is `429 TOO_MANY_REQUESTS` with a `Retry-After` header (seconds).

| Scope | Budget | Counted requests | Key |
| :--- | :--- | :--- | :--- |
| Login / sign-up | 10 failures / 15 min | Failed responses only | `(ip, email)` |
| Routes | `/v1/auth/sign-in/email`, `/v1/auth/sign-up/email`, `/v1/admin/login` | | |
| Reset / verify | 5 requests / 15 min | **Every** request (`countAll`), non-enumerating | `(ip, email)` from body, else `ip + SHA-256(signed bearer token)` |
| Routes | `/v1/projects/:p/auth/password/reset`, `.../email/verify/request` | | |
| MFA | 5 failures / 5 min | Failed responses; invalidates the ticket | `SHA-256(mfaTicket \| userId \| bearer)` |
| Routes | `.../auth/mfa/challenge`, `.../auth/mfa/verify` | | |

The authenticated fallback key for email-less verification requests hashes the **signed** bearer token, so distinct end-user sessions get distinct buckets while rotating an unverified `sub`/`email` claim cannot bypass the throttle. Raw tokens are never stored, logged or returned. Without this fix, successive independent runs collapsed into one `email-verify-request:<ip>|` bucket and were throttled before this fix.

**Lockout and abuse.** The sign-in failure budget is counted per email (and per IP and email pair). Anyone who knows an account's email can send failed attempts and lock that account's sign-in for up to 15 minutes. This is the accepted trade-off against password guessing. Show users the `Retry-After` value when you receive a `429`.

> In this build `/v1/console/auth/login` is served by the Better Auth wildcard and is not separately registered with the login throttle middleware above; the console **refresh** endpoint is guarded by the realm session service instead.

## 9. Mailer

`createMailer()` is dual-mode:

1. Project or platform SMTP configured → real delivery via `nodemailer`.
2. No SMTP and `NODE_ENV !== "production"` → `{ devToken, expiresAt }` returned to the caller; the token is still persisted hashed in `project_auth_tokens`, so flows are testable without a mail server.
3. No SMTP in production → `SERVICE_UNAVAILABLE` (503). Tokens are never leaked.

## 10. Verification record and further reading

- `tests/integration/auth-tenant-isolation.test.ts`, `auth-replay-and-quotas.test.ts`, `auth-projection-and-rules.test.ts`, `tests/security/auth-jwt-and-signature.test.ts`, `tests/security/three-realm-isolation.test.ts` and `tests/integration/auth-silent-refresh-and-concurrency.test.ts` cover RLS fail-closed behaviour, replay revocation, quota/suspension enforcement, projection bypass, claim-gated writes, cross-realm rejection and refresh concurrency.
- [JavaScript SDK guide](./08-sdk-js-guide.md) · [Flutter SDK guide](./09-sdk-flutter-guide.md)
