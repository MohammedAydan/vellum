# Changelog

## 0.0.10

Lockstep release with the platform (beta). Upgrade the API, JS SDK and Flutter SDK together.

- Missing-document `doc.snapshots()` lifecycle: `exists == false` first, then the document when it is created, then `exists == false` again on delete or TTL expiry.
- `VellumOutbox` flushes automatically when the connection returns.
- Realtime uses pooled sockets (up to 25 subscriptions per socket), and a server `SUBSCRIPTION_LIMIT_EXCEEDED` frame now carries `limit`.
- Backoff on 5xx and `Retry-After` handling are covered by tests.
- pub.dev score: the library no longer shares a name with its re-export (dartdoc could not generate docs), the package ships an `example/`, and this changelog lists the current version.

## 0.0.9

Lockstep release with the platform (beta). Works with the 0.0.8 API, and the 0.0.9 API is recommended. Upgrade the API, JS SDK and Flutter SDK together.

- `connectionState` / `connectionStateStream` report the live transport (`websocket` or `sse`), with a deduplicated initial emit.
- A missing or deleted document delivers a snapshot with `exists == false`, and identical `(exists, version)` states are delivered once.
- The WebSocket to SSE fallback timer is cleared on the first delivered frame, not on open, so the fallback no longer stalls.
- An identity switch ends the old identity's live subscriptions, and one transport error is delivered per subscription per outage instead of one per reconnect attempt.
- `client.auth.upgradeAnonymousWithEmailAndPassword({email, password})` keeps the uid, links a password identity and revokes other sessions. A taken email returns 409 and a non-anonymous caller 412.
- `listIdentities()` is the canonical name, with a deprecated alias. `disableMfa` accepts a code or `{ code }`.
- A `Retry-After` floor of 250 ms, and 5xx/4xx errors carry a `retryable` flag.

Full platform notes are in the root CHANGELOG.

## 0.0.8

Lockstep release with the platform. Works with the 0.0.7 API, and the 0.0.8 API is recommended.

- `addWithRelated` accepts at most 100 documents, the batch write limit.
- A deleted document in `doc.snapshots()` has `exists == false`.
- Network failures throw a `VellumException` with code `NETWORK_ERROR` and status 0.
- A realtime update older than the version already held is ignored.

Full platform notes are in the root CHANGELOG.

## 0.0.7

Lockstep release with the platform. Works with the 0.0.6 API, and the 0.0.7 API is recommended.

- `writeBatchChunked` and `commitChunked` default to 100 operations per request (the server limit) and cap larger `chunkSize` values at 100.
- `get()` on a document that does not exist returns a snapshot with `exists == false` instead of throwing NOT_FOUND. A missing project still throws.

Full platform notes are in the root CHANGELOG.

## 0.0.6

Lockstep release with the platform. Works with the 0.0.5 API, and the 0.0.6 API is recommended.

- The default HTTP transport reuses one `http.Client` instead of opening a new one per request.
- Realtime over SSE has an idle timeout (45 s, three server keep-alives); a silent stream reconnects and resumes.
- A server close with 1001 "Reconnect" on WebSocket reconnects and resumes from the watermark.

Full platform notes are in the root CHANGELOG.

## 0.0.5

Lockstep release with the platform. Requires the 0.0.5 API for batch preconditions and transaction rollback.

- Write batches take `exists` next to `ifVersion` and have `create`; a stale precondition fails the whole batch with 412.
- `runTransaction` rolls the transaction back on the server when the callback or the commit fails.
- Offline support: `PersistentDocumentCacheStore` and `VellumOutbox` keep an encrypted cache and queue writes while offline.
- Breaking: `customClaims` is removed from `signUpWithEmailAndPassword` and `updateProfile`. Set claims with a server key.

Full platform notes are in the root CHANGELOG.

## 0.0.4

Lockstep release with the platform. Requires the 0.0.4 API: social sign-in now starts with a `POST` and the key in a header, so 0.0.3 cannot start it.

- `signInWithOAuth` returns `VellumAuthResult` and resolves to `VellumMfaRequired` when a second factor is needed.
- Redirect-less sign-in and provider linking show a confirmation code (`onConfirmationCode`). Redirect-less sign-in must be enabled per project in Auth Studio.
- `link` and `unlink` take `currentPassword`; email change needs it too.
- Loopback sign-in on desktop can use a free port (session factory).
- `tx.create`, and `tx.get` reports `exists: false` for a missing document.
- Sign in with Apple (web and native ID token).
- iOS and macOS Keychain accessibility is stricter: people signed in with a 0.0.3 app are signed out once.

Full platform notes are in the root CHANGELOG.

## 0.0.3

Lockstep release with the platform. `vellum_flutter` is now a single Flutter package.

- Persistent encrypted session storage is built in and on by default (with an in-memory fallback). It replaces the unpublished `vellum_flutter_secure_storage` companion.
- Google and GitHub sign-in through the system browser is built in (`createVellumOAuth`, `VellumOAuth`; deep link for custom schemes, loopback redirect for desktop, no webview). It replaces the unpublished `vellum_flutter_oauth` companion. Not covered: Flutter web (pass your own launcher).
- Reference values in writes with atomic `addWithRelated`, a cache policy with an offline document store, optional document ids with local auto-ID generation, a 60 second token refresh window with `setCustomToken`, ID-token sign-in, and an SSE fallback for realtime.
- **Breaking:** requires the Flutter SDK (`>=3.22.0`); it can no longer be used from plain Dart servers or CLIs. Tools on the plain Dart VM can import `package:vellum_flutter/vellum_flutter_core.dart` after `flutter pub get`.
- Native Google account picker: use the official `google_sign_in` package yourself and pass its ID token to `signInWithGoogleIdToken`.

## 0.0.2

Reliability and security hardening, in lockstep with the platform release.

- Auth sessions are validated and cached state is isolated across auth changes, so signing out or switching users never serves another user's cached data.
- Active realtime credentials are renewed automatically after token refresh instead of subscriptions silently losing authorization.
- Project URLs are validated and collection clear requests send valid bodies.

**Server-side breaking change in this platform release:** `POST /auth/sign-in/provider` now requires a secret (`sk_`) key and returns 403 with a publishable (`pk_`) key. Move provider sign-in into your own backend (verify the identity with the provider there, then call the endpoint with the secret key) before redeploying the API. See the root CHANGELOG for the full notes.

## 0.0.1

First public beta release of the VELLUM Flutter/Dart SDK.

- Full `/v1` data plane: documents CRUD with OCC (`ifVersion`), merge, dot-path `select`, and Tagged Wire Format encoding
- Queries: `where`, `or`, `orderBy`, keyset cursor pagination, aggregations, and `bulk-delete`
- Relationships: `.include()` eager loading, `referencedBy()` reverse lookup with pagination, `_included` / `_redactedRefs`, and relation rule errors
- Realtime: WebSocket subscriptions with resume, opt-in `resolveIncludes`, and full-jitter backoff
- End-user auth: email/password, anonymous, OAuth, silent token refresh, password reset, email verification, and TOTP MFA
- Transactions and chunked batch writes
- `withConverter<T>()` type-safe model mapping
