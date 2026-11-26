# Changelog

## Unreleased

## 0.0.7

Fixes found by building a real chat app on 0.0.6: realtime and requests from a browser, batch writes, and missing documents. Upgrade the SDKs together with the API.

### Upgrade notes

- No migrations. API keys that list `allowedOrigins` now also work for same-origin GET requests and for realtime (WebSocket and SSE) from those origins.
- `batchWriteChunked` (JS) and `writeBatchChunked` (Flutter) now default to 100 operations per request, the server limit. Larger `chunkSize` values are capped at 100.
- `doc.get()` on a missing document now returns `exists: false` instead of throwing NOT_FOUND. Code that relied on the exception should check `snapshot.exists`.
- A plain Vercel `rewrites` rule buffers SSE and cannot carry WebSockets. Point the SDK `endpoint` at the API origin for realtime.

### Fixed

- **fix(sdk-js):** in a browser every request failed with "Illegal invocation" unless the app passed `customFetch`, because the transport called `globalThis.fetch` as a method of itself. The transport and the SSE socket now call fetch as a plain function, and the default is looked up at call time.
- **fix:** an API key with `allowedOrigins` rejected same-origin GET requests, because browsers send no `Origin` header on them. A GET or HEAD with `Sec-Fetch-Site: same-origin` (a header page scripts cannot set) is now checked against the origin of the request's own host. Every other request without an `Origin` header is still refused.
- **fix(realtime):** realtime now works for a developer's own web app. Before, per-project CORS (origins on an API key) only covered `/v1/projects/...`, so the WebSocket handshake answered 403 and the SSE stream failed its preflight. `POST /v1/realtime/stream` now returns `Access-Control-Allow-Origin` when an active key of the project in the auth frame lists the origin, and the WebSocket accepts such an origin provisionally and closes it (1008) unless the auth frame names a project whose active keys list it. Null, wildcard and malformed origins are still refused at the handshake, other origins are refused at the auth frame, and third-party origins never receive `Access-Control-Allow-Credentials` (this also applies to the existing `/v1/projects/...` responses).
- **fix(api):** the API no longer rejects ordinary 100-operation batches with "Total object keys exceed 500". The object-key limit now applies per write (500 keys each) and the body total scales with the number of writes (at most 100). The 5 MiB body cap and depth limits are unchanged. The SDK chunk size defaults to 100 in JS and Flutter.
- **fix(sdk-js, flutter):** `doc.get()` on a document that does not exist (for example right after `delete()`) returns a snapshot with `exists: false` instead of throwing NOT_FOUND. A missing project still throws. In JS, `snapshot.metadata.fromCache` is now `true` when a snapshot comes from the client read cache.
- **fix(realtime):** a write that committed while a new `onSnapshot` was reading its initial snapshot could be delivered before `initial_sync` and then overwritten by it, so the update was lost. Live events are now held until `initial_sync` is sent, then delivered in order, skipping any the snapshot already contains.

### Docs

- Realtime page: plain Vercel rewrites buffer event streams and cannot carry WebSockets.

## 0.0.6

Performance and reliability release for busy projects: realtime that holds up on Vercel, fewer control-database reads, and safer big-table queries. Upgrade the SDKs together with the API.

### Upgrade notes

- Build indexes on large tables with `CREATE INDEX CONCURRENTLY` so writes are not blocked.
- Migration 0015 drops the duplicate index `idx_docs_collection_cover_active`; it takes a very short exclusive lock.
- Vercel Hobby plan: a function runs at most 300 s and cron runs once a day. The in-process 60 s purge tick stays the main purge path; the cron call to the maintenance endpoint is a daily backstop.
- Set `DATA_POOL_MAX` (default 50 per instance) to a small number such as 4 when the data database is behind a pooler.
- The default rate limit is 100 requests per second per API key (429 `RATE_LIMITED`).

- **fix:** concurrent blind writes (`set`, `PUT`) to a document that does not exist yet could report success while losing writes and reusing version numbers, because there was no row to lock. Writers of the same path are now serialised with a per-path advisory lock, so every successful write gets its own version.

- **perf(realtime):** the hub routes each event through a per-project index (document path and collection), so it only visits subscriptions that can match. With 20,000 subscriptions an event costs about 3 ms instead of about 32 ms, and the result is identical to the full scan.

- **perf(realtime):** the per-event API key recheck keeps an active key for 3 s (`REALTIME_KEY_RECHECK_TTL_MS`, `0` disables), so an event stream no longer queries the control database for every event. A revoked key is dropped from live sessions within that window.

- **perf:** the API caches project, active ruleset, auth config and relation rules in process for up to 5 s (`CONTROL_READ_CACHE_TTL_MS`, `0` disables, max 1000 entries, results are cloned on read). Changes made on one instance clear its cache at once and reach other instances through the cache-invalidation channel; if that channel is down they apply within 5 s. API keys are not cached, so revocation stays immediate.
- **fix(realtime):** on Vercel a WebSocket is closed with 1001 "Reconnect" after about 265 s (`REALTIME_WS_MAX_LIFETIME_MS`, `0` disables) instead of being cut at the 300 s function limit; the SDK reconnects and resumes from its watermark.

- **Behavior change:** queries that no index can serve (a range filter, `!=`, `not-in`, text filters, `search`, or an order on a field other than `documentId`, `createdAt` and `updatedAt`) are now refused with `FAILED_PRECONDITION` and a `suggestedIndex` when the collection has more than 50,000 live documents. Create the composite index named in the error, or raise or disable the limit with `VELLUM_UNINDEXED_QUERY_MAX_DOCS` (`0` disables). Smaller collections are unaffected. Before, such queries read the whole collection and failed at the 5 second statement timeout on large ones.
### Fixes

- `vellum_flutter`: the default HTTP transport opened and closed a new `http.Client` for every request, so every operation paid a fresh DNS lookup, TCP and TLS handshake. It now uses one shared keep-alive client (five requests, one connection). The persistent cache seals its whole blob on the main isolate, so it now debounces for 5 seconds (was 1) and is capped at 2 MB by default (was 5 MB).
- `vellum_flutter` realtime: the SSE stream now has an idle timeout (45s, three server keep-alives); a silent or half-open stream is failed and reopened with resume instead of hanging forever (before, the channel answered heartbeat pings itself, so the dead stream was never noticed). On WebSocket any inbound frame counts as liveness, and a dead socket is detected within about 50s (15s ping, 35s timeout; was about 85s).

## 0.0.5

Transaction rollback, conditional batch writes, an offline cache for Flutter, a stricter Content Security Policy and a billing race fix. Every package and SDK stays on one shared version. Upgrade the SDKs together with the API. **Breaking:** `customClaims` is removed from the end-user sign-up and profile calls in both SDKs (see Breaking below).

### Features

- `batchWrite` takes `ifVersion` and `exists` on every operation (flat, or inside `preconditions` / `precondition`), so a multi-document write is conditional in one round trip: all preconditions are checked first, and a stale one fails the whole batch with 412 and writes nothing. sdk-js exports the `BatchWriteOperation` type. The sdk-js guide now says 100 operations per batch, the real server limit.

- `vellum_flutter`: write batches take `exists` next to `ifVersion` on `set`, `update` and `delete`, and have `create`. The wire format is flat (`type`, `path`, `data`, `ifVersion`, `exists`); a stale version fails the batch with 412.

- `vellum_flutter`: `runTransaction` calls `POST /transactions:rollback` (best effort, never replacing the original error) when the callback or the commit fails, before a conflict retry. It skips the call after `SESSION_CHANGED` and after a successful commit.

- `POST /transactions:rollback` ends a transaction right away instead of leaving it to expire. sdk-js `runTransaction` calls it (best effort) when the callback throws, the call is aborted, or a commit conflict is about to be retried, so abandoned attempts no longer hold their read set until the 15 s window ends.

- `vellum_flutter`: offline support. `PersistentDocumentCacheStore` keeps the document cache across restarts and `VellumOutbox` queues document writes while offline and replays them in order with idempotency keys. Everything on disk is AES-256-GCM encrypted with a device key held in the Keychain or Keystore (not iCloud-synced), bound to the project (endpoint + project id), and for the cache to the signed-in user. A secure-store read failure gives a memory-only key and writes nothing. The queue takes document writes only (strict path allow-list), stores no tokens, is per user, stops on user change or sign-out, and is bounded (200 writes, 256 KB each, 2 MB total, 23 hours). Auth errors and network errors keep entries; permission, not-found and conflict errors drop them with a reason (`rejected`, `conflict`, `expired`, `otherUser`, `failed`); optional `ifVersion` guards. Web is memory-only unless `allowWeb`. Adds the `cryptography` dependency. New `defaultSecureKeyValue()`, `VellumClient.addSignOutHook`.

### Security

- drizzle-orm upgraded from 0.38 to 0.45.4. Versions before 0.45.2 do not escape SQL identifiers safely (GHSA-gpj5-g38j-94v9). Vellum builds identifiers from fixed schema names only, so no exploitable path was found, but the fix is taken anyway.

- The console, admin and public site now send an enforced `Content-Security-Policy` with `script-src 'self'` (no inline scripts, no `unsafe-eval`), plus `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` and `frame-ancestors 'none'`. The inline bootstrap and site scripts moved to files (`vellum-bootstrap.js`, `site-early.js`, `site.js`). `style-src` still allows inline styles because the UI uses style attributes. A stale prototype `apps/dashboard/public/index.html` that loaded Tailwind and fonts from third-party hosts was removed. Check a Vercel preview for CSP errors in the browser console before the production deploy.

- A request body over the size limit and sent without a `Content-Length` header (chunked uploads) hung until the platform timeout instead of failing with 413, because the body cap awaited `cancel()` on a cloned stream. Any client could hold connections open this way. It now answers 413 at once.

### Breaking

- sdk-js and `vellum_flutter`: `customClaims` is removed from the end-user `signUpWithEmailAndPassword` and `updateProfile` inputs. The API has rejected it for end users since 0.0.4, so passing it only produced an error. Set claims with a server key instead. Reading `user.customClaims` is unchanged.

### Changed

- Behavior change: queries with an unknown key are now rejected with `INVALID_ARGUMENT` instead of the key being ignored silently. `collectionGroup` queries return a clear not-supported error.

## 0.0.4

Security hardening, sign-in fixes and Sign in with Apple. Every package and SDK stays on one shared version. **Upgrade the SDKs together with the API:** 0.0.3 SDKs cannot start social sign-in against this API (the start call moved from `GET` with the key in the URL to `POST` with the key in a header). Update `@vellumdb/sdk-js` and `vellum_flutter` to 0.0.4.

**Effect for existing users:** on iOS and macOS the Flutter SDK now stores sessions with a stricter Keychain setting, so people signed in with a 0.0.3 app are signed out once after updating. Redirect-less (mobile/desktop polling) sign-in is now off by default for each project: turn it on in Auth Studio (Providers > Redirect-less sign-in) before using it.


### Security

- Security rules: a query, export or batch read with a public key now also checks each returned row against its own `get` rule when one matches the path. Before, `allow list: if isSignedIn(); allow get: if isParticipant(...)` returned every row to any signed-in user. Hidden rows are skipped and pages are refilled (up to 5 extra batches per request). Aggregates and counts are refused for public keys when the `get` rule depends on the document, since a GROUP BY cannot be filtered per row. Paths with only a `list` rule behave as before. Server keys are unchanged.
- `GET /collections/:name/export` now needs a server key, like import and clear.
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

- sdk-js `addWithRelated` matches Flutter: it takes `idempotencyKey` (sent as `Idempotency-Key`) and runs the collection converter's `toDoc` on the parent document.




- `vellum_flutter`: `signInWithOAuth` now returns `VellumAuthResult` and resolves to `VellumMfaRequired` when the account has a second factor, like the other sign-in methods (it returned `VellumUser` before; no session is stored in the MFA case). Transactions: `tx.create()`, `tx.get` on a missing document returns an `exists == false` snapshot instead of throwing, and the document cache is cleared before `runTransaction` returns. Loopback sign-in accepts port 0 (`http://127.0.0.1:0/callback`): the port is bound per attempt and the real one is sent to the API.

- Sign in with Apple. Web (Services ID, `form_post` callback) and native (`POST /auth/oauth/apple/id-token`, ID token plus raw or hashed nonce, bundle IDs as audiences). The `.p8` key is encrypted at rest, Team ID and Key ID are validated, the first-sign-in name is kept, and the Apple grant is revoked when the user deletes their account or unlinks Apple. Auth Studio has an Apple card (EN+AR). sdk-js `signInWithAppleIdToken` and `popup/redirect("apple")`; `vellum_flutter` `signInWithAppleIdToken` and `VellumOAuth.signIn('apple')`. Docs EN+AR.

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
