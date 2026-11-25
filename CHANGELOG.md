# Changelog

## Unreleased

### Security

- Account-keeping changes now prove the account owner, not only the access token: linking a provider (`link: true`), `DELETE /auth/identities/:provider`, `POST /auth/password/change` and `DELETE /auth/user` need `currentPassword` (`password` for delete) for accounts with a password, and a sign-in within the last 10 minutes for accounts without one. Wrong passwords lock out per user, and these endpoints are rate limited (10 per 15 minutes per IP). sdk-js: `linkWithPopup(..., { currentPassword })`, `unlinkProvider(provider, { currentPassword })`; `vellum_flutter` must send the same field.
- Changing an account email through `PATCH /auth/user` needs `currentPassword` (sdk-js `updateProfile` accepts it). Accounts without a password can only change email with a server key.
- Development tokens (`devToken`) in password reset and email verification responses are returned only when `NODE_ENV` is `test` or `development`, or `VELLUM_ALLOW_DEV_TOKENS=1` is set.
- End-user access tokens are bound to their session (`sid` claim): signing out or revoking a session ends its access token at once. Tokens issued before this change keep working until they expire. Realtime connections of revoked sessions are closed.
- The control plane refuses anonymous access unless `NODE_ENV` is `test` or `development`, or `VELLUM_ALLOW_ANONYMOUS_CONTROL_PLANE=1` is set. Set this only for local setups.
- Rules: a negated or `isType` rule over `resource` no longer passes the collection-level check, so queries and aggregates that returned every row are now denied.
- Provider sign-in that proves an unverified account's email clears that account's password and sessions (blocks email pre-hijacking). Sign-in takes the same time whether or not the account exists.
- Project SMTP hosts that are private, loopback or link-local are refused. Self-hosted relays opt in with `VELLUM_ALLOW_PRIVATE_SMTP=1`. nodemailer is upgraded to 10.6.1.
- Social sign-in no longer puts the API key in a URL. `POST /auth/oauth/:provider/start` takes the key in the `X-Vellum-Api-Key` header and returns the provider's authorize URL. The old `GET .../start?apiKey=...` is refused. sdk-js and `vellum_flutter` use the new call; apps must update to the next SDK release.
- Redirect-less sign-in and provider linking now end with a confirmation code. Without it, an attacker could send a victim the authorize URL and collect the victim's session by polling with their own PKCE verifier (device-code phishing), or make a victim's Google account link to the attacker's account. The callback no longer releases the session or links the identity itself: it shows a page naming the project and a warning, and asks the person to type a 6-symbol code that only the initiating app displays (derived from the PKCE challenge). Five wrong codes end the attempt. Redirect-less sign-in is now opt-in per project (Auth Studio > Providers > Redirect-less sign-in, `__settings.allowPollSignIn`, default off) because a fake app can still show the code; start, poll and the callback refuse with "Redirect-less sign-in is turned off for this project" until it is enabled. New `POST /auth/oauth/confirm`. `createVellumOAuth` / `VellumOAuth.polling` require `onConfirmationCode`; sdk-js `linkWithPopup` shows the code (built-in box or `onConfirmationCode`).

### Features

- Redirect-less social sign-in for mobile and desktop apps: `POST /auth/oauth/:provider/start` with `{"delivery":"poll","codeChallenge":...}` needs no redirect URI; the app collects the result with `POST /auth/oauth/poll` and its PKCE verifier (202 `{"status":"pending"}` until the browser step is done). `createVellumOAuth(auth:)` in `vellum_flutter` uses it when no `redirectUri` is given, so Android and iOS need no manifest, Info.plist or Auth Studio setup.

- End-user `POST /auth/password/change` (current password required, other sessions ended, fresh session returned) and `DELETE /auth/user` (password accounts confirm with their password). sdk-js `changePassword` / `deleteAccount`, `vellum_flutter` `changePassword` / `deleteAccount`.

- End-user `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `GET /auth/identities` and `DELETE /auth/identities/:provider` (refused when it would remove the last way to sign in). sdk-js `listSessions` / `revokeSession` / `listLinkedProviders` / `unlinkProvider`; `vellum_flutter` same names.
- Docs: Flutter social sign-in now leads with the redirect-less flow (EN + AR); the deep link is optional.

- Link a provider to the signed-in account: `POST /auth/oauth/:provider/start` with `"link": true` and the user's bearer token adds Google or GitHub (any email) to that user; a provider account that belongs to another user is refused. sdk-js `linkWithPopup`, `vellum_flutter` `VellumOAuth.link`.

- `vellum_flutter` session storage: Keychain accessibility is `first_unlock_this_device` on iOS and macOS; the first launch after a fresh install clears the SDK's own session keys (the Keychain survives uninstall; marker kept in `shared_preferences`, so one existing session is signed out on the first launch after updating). Android keeps the plugin's current default cipher. `updateProfile` accepts `currentPassword` (sdk-js too) for email changes.
- Docs: App Links / Universal Links recommended over custom schemes, Android backup exclusion rules, and when Android/iOS Google client IDs must be added for native Google sign-in.

### Fixes

- Desktop and native sign-in: a loopback redirect (`http://127.0.0.1:<port>/...` or `[::1]`) is always accepted, as RFC 8252 describes, so it no longer needs an entry in the allowed redirect list.
- sdk-js popup sign-in with Google: providers that set Cross-Origin-Opener-Policy cut the popup link, so the popup looked closed and the result was lost. The return page now forwards the result automatically and a closed-looking popup is no longer treated as a cancel.

## 0.0.3

Control-plane state moves into the database, social sign-in, serverless realtime, and Relations tooling. Every package and SDK remains on one shared version.

### Platform

- API keys and per-project CORS origins, session revocations, organization memberships, auth throttles, MFA lockouts, sign-up budgets, usage counters, quota and plan checks, rulesets, auth config, projects, users and operator lists are read from PostgreSQL on every request. Nothing that decides access lives only in one instance's memory, so behaviour is identical across serverless instances.
- Migrations 0014 to 0017 (additive only).
- Realtime works on serverless: WebSocket first, with an automatic SSE fallback; responses stream on Vercel.
- TOTP MFA hardening: no enroll downgrade, disable, replay and lockout protections.
- Google and GitHub sign-in on the server (code + PKCE, verified identities).
- Per-project CORS derived from API key origins.
- Composite indexes build in-request and stuck building states reconcile.
- Privacy Policy and Terms include a contact email.

### SDK (JavaScript) - `@vellumdb/sdk-js`

- `signInWithPopup`, `signInWithRedirect`, `getRedirectResult`, `signInWithGoogleIdToken`.
- Reference values in writes and atomic `addWithRelated`.
- `CachePolicy` with an offline document store; 60s refresh window, `setCustomToken`, `autoRefresh` switch.
- Optional `doc()` id with local auto-ID generation.
- Edge runtime and React Native bundler safety checks.

### SDK (Flutter) - `vellum_flutter`

- **One package.** `vellum_flutter` now includes persistent encrypted session storage (Keychain, Keystore, libsecret, Windows credential store, encrypted web storage, with an in-memory fallback) and Google and GitHub sign-in through the system browser (`createVellumOAuth`: deep link for custom schemes, loopback redirect for desktop; no webview). No extra package.
- **Breaking:** `vellum_flutter` is now a Flutter package. It requires the Flutter SDK (`>=3.22.0`) and no longer works from plain Dart servers or CLIs. Dart tooling on the plain VM can import `package:vellum_flutter/vellum_flutter_core.dart` after `flutter pub get`.
- Native Google account picker: install the official `google_sign_in` package yourself and pass its ID token to `signInWithGoogleIdToken` (no dependency on it from `vellum_flutter`).
- Parity with the JavaScript additions above: ID-token sign-in, reference values and `addWithRelated`, cache policy, optional document ids, SSE fallback for realtime.

### Console

- Relations page: preview related records and try `include` queries from the UI.

## 0.0.2

Security and reliability fixes across the platform, plus JS/Flutter SDK parity work. Every package and SDK remains on one shared version.

### Breaking (server): provider sign-in requires a secret key

- `POST /v1/projects/:p/auth/sign-in/provider` now requires a secret (`sk_`) server key and returns `403 PERMISSION_DENIED` when called with a publishable (`pk_`) key. The server never verified provider identities itself: `providerUserId`, `email` and `emailVerified` are claims only a trusted backend may assert.
- **Impact:** client-side `signInWithOAuth()` called with a publishable key stops working in both SDKs (`@vellumdb/sdk-js` and `vellum_flutter`) when the API is redeployed with this release. The SDK methods and signatures are unchanged.
- **Migration:** move provider sign-in into your own backend. Verify the identity with the provider there, then call `/auth/sign-in/provider` with your secret key. Linking a provider identity to an existing account by email now also requires the backend to assert a verified email, and users with a verified second factor receive an MFA challenge instead of an immediate session.

### Security fixes

- Control plane: the legacy `/v1` control-plane routes now require a console or super-admin session in production and enforce organization membership (write role for mutations) on project creation, API key list/create and ruleset get/publish. Creating an API key no longer returns the stored secret digest. Anonymous access remains available outside production for local development and examples.
- End users can no longer self-assign `customClaims` or `phoneVerified`.
- MFA recovery codes are burned after a successful challenge, and MFA tickets allow bounded challenge retries before being consumed.
- Revoked sessions can no longer be resurrected through the refresh grace window, and replay identity stays stable across end-user token refresh.
- End-user auth is throttled per account (IP-independent), attempts are counted before the handler runs so parallel requests cannot exceed the window, and the hourly sign-up slot is reserved atomically. Sign-in and sign-up guards are separated.
- Realtime enforces the snapshot authorization projection and API key revocation.
- Security rules: an unauthenticated identity never equals `null` in rule comparisons; relation rules fire when `targetCollection` is null (treated as unscoped); rules match slash-less paths and keep boolean array literals; quoted keyword strings parse as string literals in the rules DSL.
- Relations enforce SQL reference parity and fail closed at cascade limits.
- Storage: memory rollback races and unsafe driver fallback removed.

### SDK (JavaScript) — `@vellumdb/sdk-js`

- Fixed a cross-auth-session cache leak: cached reads and in-flight async work are isolated per auth session. Signing out or switching users clears cached reads and ends session subscriptions, and stale requests fail with `SESSION_CHANGED` instead of serving another user's data.
- Fixed a realtime crash: closing a socket that is still CONNECTING no longer crashes the host process with an unhandled `error` event (hit by rapid subscribe/unsubscribe cycles and heartbeat timeouts).
- A 2xx response with an unparseable body now throws `MALFORMED_RESPONSE` instead of silently returning an empty result. Error responses keep the status-derived fallback.
- `create`/`set`/`update`/`delete` accept an `idempotencyKey` option, sent as the `Idempotency-Key` header the API dedupes on; its presence makes the write retriable on transient failures (Flutter parity).
- `doc()` rejects collection paths with a clear error.
- Endpoint origins are validated and collection clear bodies are encoded.
- Validated document reference creation.

### SDK (Flutter/Dart) — `vellum_flutter`

- Auth sessions are validated and cached state is isolated across auth changes.
- Active realtime credentials are renewed after token refresh instead of subscriptions silently losing authorization.
- Project URLs are validated and collection clear requests send valid bodies.

### Engine and API

- Blind writes retry on contended CAS conflicts instead of returning 409.
- Mutation idempotency headers are honored and replay races are serialized.
- Non-object document write bodies are rejected instead of corrupting data.
- Numeric types are preserved in fallback ordering and cursor seeks; collection export forwards pagination options; composite indexes created with the legacy field shape are matched.
- Shutdown signal handlers are registered only when the API runs as the entrypoint.

### Documentation

- End-user auth guide (English and Arabic): provider sign-in documented as secret-key only with the 403 behavior; access-JWT revocation semantics documented.
- Rules syntax and access semantics documented from verified behavior; relation creation explained with tested SDK examples.

## 0.0.1

### Version alignment (0.0.1)

- The whole project and every SDK now share one version: `0.0.1`. This covers all workspace `package.json` files (`apps/*`, `packages/*`, `examples/js-testbed-app`), the Flutter/Dart pubspecs (`sdks/flutter`, testbeds, e2e app, dart-verify) and their lockfile entries, the `/v1/health*` and `/admin/overview` runtime version fields, and the OpenAPI contract info version (source and generated artifact).
- `node scripts/check-version-sync.mjs` (`pnpm version:check`) keeps them in sync and runs in CI.

### Flutter/Dart SDK parity

- `DocumentReference.referencedBy()` and `referencedByAs<D>()` wrap `POST /documents:referencedBy`: permission-filtered reverse lookup with opaque cursor pagination, optional collection/field narrowing, `select` and `include`. Results preserve empty continuation pages and never apply the target's converter to dependents.
- `DocumentReference.snapshots()` and `Query.snapshots()` accept `resolveIncludes` and `include`: opt-in point-in-time relation resolution on realtime frames (max 10 specs, depth 1). Resolved payloads surface on `DocumentSnapshot.included`, redacted targets on `DocumentSnapshot.redactedRefs`.
- Renamed the primary test file to `vellum_flutter_test.dart`; example secure-storage keys in docs now use `vellum_*` names. The HTTP wire headers (`x-vellum-api-key`, `x-vellum-index-*`) are intentionally unchanged: they remain the canonical server contract.

### SDK naming compatibility

- The JavaScript client implementation now lives in `client/vellum-client.ts`. The old source path remains a re-export shim; neither source path is a supported package subpath export.
- Import `VellumClient` and `VellumAuthClient` from `@vellumdb/sdk-js` in new code. Existing root exports `VellumClient`, `VellumAuthClient` and the `Vellum*` type aliases remain available. Class aliases refer to the same constructors, not wrappers.
- In Flutter/Dart, use `package:vellum_flutter/vellum_flutter.dart` and the `Vellum*` names. The `vellum_flutter.dart` compatibility barrel and existing `Vellum*` typedefs remain available without a removal date. No new Dart analyzer deprecation diagnostics are introduced in this release.
- No aliases are removed here. Removal, if needed, requires a separate major-version change with migration notes. This release does not rename npm/pub package IDs, HTTP headers, wire fields, SQL roles, stored keys, cookies, or existing persisted identifiers.

See [SDK naming migration](docs/SDK-NAMING-MIGRATION.md).
