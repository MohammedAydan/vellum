# Changelog

## 0.0.3

Lockstep release with the platform. `vellum_flutter` is now a single Flutter package.

- Persistent encrypted session storage is built in and on by default (with an in-memory fallback). It replaces the unpublished `vellum_flutter_secure_storage` companion.
- Google and GitHub sign-in in the system browser is built in (`createVellumOAuth`, `VellumOAuth`). It replaces the unpublished `vellum_flutter_oauth` companion.
- Reference values in writes with atomic `addWithRelated`, a cache policy with an offline document store, optional document ids with local auto-ID generation, a 60 second token refresh window with `setCustomToken`, ID-token sign-in, and an SSE fallback for realtime.
- **Breaking:** requires the Flutter SDK (`>=3.22.0`); it can no longer be used from plain Dart servers or CLIs. Tools on the plain Dart VM can import `package:vellum_flutter/vellum_flutter_core.dart` after `flutter pub get`.
- Optional native Google account picker: separate `vellum_flutter_google` package (uses `google_sign_in`).

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
