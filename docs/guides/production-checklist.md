---
title: Production Checklist
order: 14
group: Operations
description: Hardening checklist for deploying VELLUM with @vellum/sdk-js and vellum_flutter — keys, auth storage, timeouts, retries, caching, streaming, realtime, and lifecycle disposal.
---

# Production Checklist

Verify every item below before shipping a VELLUM-backed application to production.

---

## 1. API Keys, Security Rules & Input Hygiene

- [ ] **Key separation**: Use publishable keys (`pk_...`) in browser and Flutter clients; keep secret keys (`sk_...`) strictly on trusted backend servers.
- [ ] **Default-deny Security Rules**: Ensure every user-accessible collection enforces `auth.uid` ownership or role claims rather than relying on client filtering.
- [ ] **No raw credentials in logs**: `vellum_flutter` automatically redacts `pk_`/`sk_`, `Bearer`, and JWTs in `toString()`, and `@vellum/sdk-js` never logs tokens or exposes them in `db.auth.toJSON()`. Still avoid dumping raw `AuthState` / `VellumUser` objects to telemetry sinks.
- [ ] **Path validation**: Both SDKs reject `..`, `%2e%2e`, `%2f`, `\`, `?`, `#`, and control characters in document/collection segments — still validate user-supplied IDs at your API boundary.

---

## 2. Authentication & Session Persistence

- [ ] **Secure storage on mobile**: In `vellum_flutter`, replace the default `InMemoryAuthTokenStorage` with an `AuthTokenStorage` backed by `flutter_secure_storage`, and call `await client.auth.restore()` during app bootstrap.
- [ ] **Handle MFA explicitly**: Handle `MfaRequiredResult` (`"mfaRequired" in res` in JS) and `VellumMfaRequired` (sealed `switch` in Dart) for accounts with TOTP enrolled.
- [ ] **Revoke on compromise**: Use `signOut({ allSessions: true })` (JS) or `client.auth.signOut(allSessions: true)` (Dart) when a user changes password or reports a lost device.

---

## 3. HTTP Resilience, Timeouts & Retries

- [ ] **Bound request timeouts**: Set explicit `timeoutMs` (JS, default `30_000`) and `requestTimeout` (Dart, default `30s`) appropriate to your SLA, and pass `AbortSignal` on user-cancellable actions in JS.
- [ ] **Reuse `http.Client` in Flutter/Dart**: Pass a single long-lived `http.Client` to `VellumClient(httpClient: ...)` for TCP/TLS connection pooling instead of creating short-lived sockets per request.
- [ ] **Idempotency keys on critical writes**: Supply `idempotencyKey` (Dart) or `Idempotency-Key` header so transient 429/5xx retries are safe for mutations; for bulk syncs use `idempotencyKeyPrefix` in `commitChunked()` / `writeBatchChunked()`.

---

## 4. Read Performance, Indexing & Bounded Streaming

- [ ] **Enable read caching & coalescing where appropriate**:
  - JS: Opt into `cache: { enabled: true, ttlMs: 30_000, maxEntries: 1_000 }` and `dedupeReads: true` for read-heavy UIs; call `doc.get({ bypassCache: true })` when strict freshness is required.
  - Flutter: Keep `coalesceInFlightGets: true` (default) to collapse duplicate widget fetches.
- [ ] **Resolve Index Advisor warnings before launch**: Wire `onIndexSuggestion` to staging/CI logging and create all recommended composite indexes before production traffic arrives.
- [ ] **Stream large datasets with hard caps**: Use `pages()` / `stream({ maxPages, maxDocs, signal })` in JS and `streamPages()` / `streamDocuments(maxPages: ...)` in Dart — never buffer unbounded collections in memory.
- [ ] **Use server-side `aggregate()`**: Compute dashboards (`count`, `sum`, `avg`, `min`, `max`, `groupBy`) on the server rather than downloading entire collections.

---

## 5. Realtime & Resource Lifecycle

- [ ] **Observe connection state**: In JS, bind `db.onConnectionStateChange(...)` to surface `reconnecting` / `disconnected` states cleanly in your UI.
- [ ] **Always unsubscribe**: Cancel every `onSnapshot` unsubscribe callback (JS) and `StreamSubscription` (Dart) when screens unmount.
- [ ] **Always call `dispose()`**: Invoke `db.dispose?.()` (JS) or `client.dispose()` / `client.close()` (Dart, plus `httpClient.close()`) on shutdown, logout boundaries, or DI scope disposal to prevent leaked timers and open WebSockets.
