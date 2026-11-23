# Changelog

## 0.0.1

First public beta release of the VELLUM Flutter/Dart SDK.

- Full `/v1` data plane: documents CRUD with OCC (`ifVersion`), merge, dot-path `select`, and Tagged Wire Format encoding
- Queries: `where`, `or`, `orderBy`, keyset cursor pagination, aggregations, and `bulk-delete`
- Relationships: `.include()` eager loading, `referencedBy()` reverse lookup with pagination, `_included` / `_redactedRefs`, and relation rule errors
- Realtime: WebSocket subscriptions with resume, opt-in `resolveIncludes`, and full-jitter backoff
- End-user auth: email/password, anonymous, OAuth, silent token refresh, password reset, email verification, and TOTP MFA
- Transactions and chunked batch writes
- `withConverter<T>()` type-safe model mapping
