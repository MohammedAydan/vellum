# Changelog

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
