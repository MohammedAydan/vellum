# 15 — Security, Threat Detection & Defense in Depth

> **Scope:** Authoritative security architecture covering three-realm isolation, cryptographic constant-time verification, Security Fortress boundary guards, Security Rules AST budgets, tamper-evident audit chains, and internal document-engine hardening.  
> **Grounded in:** `packages/authorization/src/api-keys.ts`, `packages/authorization/src/rules-ast.ts`, `packages/query-engine/src/cursor.ts`, `apps/api/src/middleware/security.ts`, `apps/api/src/ws-rfc6455.ts`, `packages/security/src/`, `packages/database-data/src/rls.ts`, `docs/SECURITY-BILLING-CONTRACT.md`.

VELLUM enforces deterministic, fail-closed defense in depth across every layer—transport, authentication, authorization, query compilation, document engine, and PostgreSQL RLS—without introducing Redis or any secondary stateful service.

---

## 1. Threat Model & Defense Pipeline

### 1.1 Request Defense Order (`apps/api/src/app.ts`)
Every HTTP request passes through ordered, fail-closed middleware before any handler executes:

```text
Incoming Request
  1. requestId()                ──▶ Attach X-Request-Id
  2. Security Headers           ──▶ HSTS, X-Content-Type-Options, X-Frame-Options, COOP, Permissions-Policy, CSP (HTML)
  3. Blocklist Check            ──▶ threatDetector.isBlocked(extractClientIp(c)) ──▶ 403 immediately (< 0.002 ms)
  4. Body Size Cap              ──▶ 5 MiB raw/chunked cap (node-server.ts + bodyLimit()), 1 MiB single-doc cap ──▶ 413
  5. Payload Guard              ──▶ assertSafeJsonPayload(): depth <= 20, keys <= 500, array <= 5,000, no __proto__ / NUL
  6. CSRF Origin Verification   ──▶ verifyCsrfOrigin() on cookie-authenticated POST/PATCH/PUT/DELETE to /v1/console/* & /v1/admin/*
  7. API Key Restrictions       ──▶ Verify Origin/Referer allowlist, IP allowlist, & expiry ──▶ 403 ORIGIN/IP_NOT_ALLOWED
  8. O(1) QuotaGuard            ──▶ Check plan quotas & hard spend cap ──▶ 429 QUOTA_EXCEEDED / 402 MONTHLY_SPEND_CAP_REACHED
  9. Realm Auth & Rules AST     ──▶ 3-realm session / Ed25519 JWT / pk_|sk_ key + 256-step AST evaluator
 10. Handler + PostgreSQL RLS   ──▶ Single-round-trip set_config(..., true) + FORCE RLS on all 12 tables
 11. Async Metering & Audit     ──▶ Non-blocking O(1) counters & circuit-broken audit sinks
```

---

## 2. Three-Realm Authentication Isolation

Authentication is partitioned into three strictly isolated realms that share only stateless cryptographic primitives from `@vellum/auth`. Tokens, signing secrets, `iss`/`aud`/`typ` claims, cookies, and middleware are completely disjoint:

| Realm | Actor | Credential & Cryptographic Verification | Protected Surface |
| :--- | :--- | :--- | :--- |
| `super_admin` | Platform operator | HS256 session signed with `SUPER_ADMIN_JWT_SECRET` + `vellum_refresh_token` HttpOnly cookie; requires `claims.realm === "super_admin"` **and** `users.isPlatformSuperAdmin === true` | `/v1/admin/*`, `/admin/` SPA |
| `customer_console` | Org owner/admin/member | HS256 session signed with `CONSOLE_JWT_SECRET` (must differ from `SUPER_ADMIN_JWT_SECRET` in production) + HttpOnly refresh cookie + `assertOrgAccess` | `/v1/console/*`, `/` Dashboard |
| `project_end_user` | Application end user | **EdDSA-only (Ed25519)** JWT (`vellum+enduser+jwt`) verified against the project's Ed25519 public key (`iss: https://api.vellum.dev/v1/projects/${projectId}/auth`). Zero HS256 fallback. | `/v1/projects/:projectId/...` HTTP & `/v1/realtime` WS |

- **Cross-Realm Rejection:** Customer console tokens receive `403` on every `/v1/admin/security/*` and `/v1/admin/billing/*` endpoint.
- **Admin Privacy by Default:** Super-admin endpoints expose metadata, quotas, index health, threats, and audit logs only—never customer `documents.data` payloads.

---

## 3. Universal Constant-Time Verification (`crypto.timingSafeEqual`)

To prevent timing side-channel attacks across every authentication and integrity boundary, VELLUM uses `crypto.timingSafeEqual` uniformly across the codebase:

| Surface | Module | Implementation |
| :--- | :--- | :--- |
| **API Keys (`pk_` / `sk_`)** | `packages/authorization/src/api-keys.ts` | Generated via rejection-sampled Base62 (`byte < 248`, zero modulo bias: `pk_<32>` / `sk_<48>`). Stored as `SHA-256("${fullKey}:${API_KEY_PEPPER}")`. Even on 30 s LRU cache hits (`VERIFIED_CACHE_MAX_ENTRIES = 10_000`), `verifyApiKey()` checks live revocation and runs `timingSafeEqual` against the full 32-byte digest on every request. |
| **Query Cursors** | `packages/query-engine/src/cursor.ts` | `decodeAndVerifyQueryCursor()` verifies both the 64-hex HMAC-SHA256 signature and `qHash` via `timingSafeEqual` with key-rotation array support. |
| **OCC Transaction Tokens** | `packages/document-engine/src/transactions.ts` | HMAC-SHA256 verification via `timingSafeEqual` with `txSecretPrev` rotation support. |
| **Sessions, Passwords & MFA** | `packages/auth/src/`, `packages/authorization/src/`, `packages/storage/src/auth-store.ts` | Password hashes, refresh token rotation hashes, MFA TOTP/recovery codes, and realm session MACs all compare via `timingSafeEqual`. |
| **Stripe Webhooks** | `packages/billing/src/webhook-verifier.ts` | `HMAC-SHA256(secret, "${t}.${rawBody}")` compared via `timingSafeEqual` with a `300 s` replay window. |
| **Audit & Billing Hash Chains** | `packages/security/src/hash-chain.ts` | `verifyHashChain()` recomputes every entry's HKDF HMAC-SHA256 digest and verifies with `timingSafeEqual`. |
| **Shared HTTP Primitive** | `apps/api/src/middleware/security.ts` | `constantTimeEqual(a, b)` hashes both strings with SHA-256 to fixed 32-byte digests before `timingSafeEqual`, hiding both content and length. |

---

## 4. Security Rules AST & Runtime CPU Budgets (`packages/authorization/src/rules-ast.ts`)

Public `pk_` keys evaluate declarative Security Rulesets (authored as JSON AST or V2 Rules DSL) on every document read, write, query, and realtime fan-out event. To prevent CPU exhaustion from crafted or deeply nested expressions, the evaluator enforces hard validation and runtime budgets:

| Budget / Limit | Value | Enforcement |
| :--- | --: | :--- |
| `SYSTEM_LIMITS.RULES_AST_MAX_DEPTH` | `10` | Enforced at ruleset publish/validation time. |
| `SYSTEM_LIMITS.RULES_AST_MAX_NODES` | `100` | Maximum AST nodes per rule at validation time. |
| `MAX_EVAL_STEPS` | `256` | Hard runtime step counter across expression evaluation and `in` loops; exceeding fails closed (`false`). |
| `MAX_EVAL_DEPTH` | `12` (`RULES_AST_MAX_DEPTH + 2`) | Runtime recursion ceiling; exceeding fails closed (`false`). |
| `MAX_IN_OPERAND_ELEMENTS` | `256` | Caps `in` array evaluation inside rules. |

---

## 5. Transport Hardening, CORS, CSRF & Spoof-Resistant IP Extraction

### 5.1 Spoof-Resistant Client IP Extraction (`extractClientIp` in `apps/api/src/middleware/security.ts`)
- `node-server.ts` **strips** any client-supplied `x-vellum-remote-addr` header and injects the real TCP `req.socket.remoteAddress`.
- `TRUST_PROXY_HOPS` (integer `0..10`, default `1`):
  - When `TRUST_PROXY_HOPS > 0`: on Vercel uses `x-vercel-forwarded-for`; uses `cf-connecting-ip` only when `TRUST_CLOUDFLARE_IP=true` (the deployment is only reachable through Cloudflare); otherwise selects the **rightmost untrusted hop** from `X-Forwarded-For` (`hops[hops.length - trustedProxyHops]`)—never the client-spoofable leftmost entry—falling back to `x-real-ip` and then `x-vellum-remote-addr`.
  - When `TRUST_PROXY_HOPS = 0` (direct internet exposure): ignores all forwarded headers and uses `x-vellum-remote-addr` exclusively.
- Normalizes IPv4-mapped IPv6 addresses (`::ffff:203.0.113.9` → `203.0.113.9`) and rejects malformed/control-character candidates.

### 5.2 Chunked Body Limits & Safe JSON Parsing
- **Dual-Layer Body Cap:** Both `node-server.ts` (raw TCP stream) and `bodyLimit()` middleware enforce the `5 MiB` (`5,242,880` bytes) cap on `Content-Length` **and** by streaming/counting chunked bodies when `Content-Length` is omitted (`Transfer-Encoding: chunked`), immediately returning `413 PAYLOAD_TOO_LARGE` and destroying the socket.
- **Prototype-Pollution & Structural Guards:** `safeJsonParse()` and `assertSafeJsonPayload()` reject `__proto__`, `constructor`, `prototype`, and `\u0000` NUL bytes before engine entry (`PAYLOAD_LIMITS`: `1 MiB` doc, `5 MiB` batch, depth `<= 20`, keys `<= 500`, array length `<= 5,000`).

### 5.3 Strict CORS, CSRF & Security Headers
- **CORS (`createCorsOriginValidator`):** Exact canonical origin allowlist from `CORS_ALLOWED_ORIGINS`. Never reflects `*` or `null` alongside `Access-Control-Allow-Credentials: true`.
- **CSRF (`verifyCsrfOrigin`):** Fail-closed on cookie-authenticated `POST`/`PATCH`/`PUT`/`DELETE` requests to `/v1/console/*` and `/v1/admin/*` (normalizes leading slashes so `//v1/admin/` cannot bypass prefix checks). Missing or mismatched `Origin`/`Referer` is denied (`CSRF_ORIGIN_MISSING` / `CSRF_ORIGIN_MISMATCH`).
- **Response Headers (`packages/security/src/csrf-and-headers.ts` & `deploy/caddy/Caddyfile`):**
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains` (production; Caddy adds `preload`)
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  - `Content-Security-Policy` (HTML responses): `default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` (zero `unsafe-inline` or `unsafe-eval`).
  - `Cache-Control: no-store` on auth, console, admin, and health surfaces.

---

## 6. Boundary Guards: Query-Cost, WebSocket, SSRF & Key Restrictions

### 6.1 Query-Cost Guard (`@vellum/security`)
`assertQueryCost()` enforces locked ceilings before query compilation and records breaches as `query_exhaustion` threat events:
`MAX_WHERE_CLAUSES = 15`, `MAX_OR_BRANCHES = 10`, `MAX_IN_ARRAY_SIZE = 50`, `MAX_INCLUDE_DEPTH = 3`, `MAX_INCLUDE_TOTAL_DOCS = 100`, `MAX_QUERY_LIMIT = 500`, `MAX_TEXT_SEARCH_LENGTH = 200`, `MAX_LIKE_WILDCARDS = 5`. (The query compiler additionally enforces its own strict `SYSTEM_LIMITS` caps—see [03 — Query Compiler](./03-query-and-indexing.md).)

### 6.2 WebSocket Hardening (`apps/api/src/ws-rfc6455.ts`)
- Exact `CORS_ALLOWED_ORIGINS` verification on browser upgrades (`403` on mismatch).
- Caps: `10,000` global connections, `50` per IP, `1,000` per tenant, `64 KiB` (`65,536` bytes) max frame (checked **before** allocation), `125` bytes max control frame, `5 s` auth timeout, `30 s` ping/pong & idle timeout, `25` subscriptions/socket, `60` messages/min/socket rolling window, `1 MiB` outbound backpressure buffer.
- Frame/rate/subscription violations close with RFC 6455 **`1008 Policy Violation`** and record a `ws_flood` threat event.

### 6.3 SSRF Guard (`packages/security/src/ssrf-guard.ts`)
`assertSafeExternalUrl()` resolves all DNS records via `dns.promises.lookup(hostname, { all: true })` and rejects any `https:` outbound target (JWKS, OAuth token endpoints, webhooks, SMTP) if **any** resolved IP falls in loopback (`127.0.0.0/8`, `::1`), RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local/cloud metadata (`169.254.0.0/16`, `fe80::/10`), CGNAT (`100.64.0.0/10`), IPv6 ULA (`fc00::/7`), or `0.0.0.0/8`.

### 6.4 API Key Restrictions
`api_keys` supports per-key `allowed_origins`, `allowed_ips`, and `expires_at` (`PATCH /v1/console/orgs/:orgId/projects/:projectId/keys/:keyId/restrictions`). Violations return `403 ORIGIN_NOT_ALLOWED`, `403 IP_NOT_ALLOWED`, or `403 API_KEY_EXPIRED` and emit a threat event.

---

## 7. Tamper-Evident Audit Log, Hash Chains & Threat Detector

### 7.1 Immutable Append-Only Tables & HKDF Hash Chains
`control_db.security_audit_logs` and `control_db.billing_ledger_entries` are protected by:
1. **PostgreSQL Immutability Trigger:** `prevent_immutable_table_mutation()` fires `BEFORE UPDATE OR DELETE` and raises `SECURITY_VIOLATION`.
2. **Domain-Separated HKDF HMAC-SHA256 Chain:**
   - Key: `crypto.hkdfSync('sha256', MASTER_ENCRYPTION_KEY, 'vellum-chain-salt-v1', domain, 32)` where `domain` is `'security-audit-v1'` or `'billing-ledger-v1'`.
   - Hash: `HMAC-SHA256(key, "${seq}|${prevHash}|${timestampIso}|${canonicalSerialize(payload)}")` starting from genesis `'0'.repeat(64)`.
   - Verification: Super-admins invoke `POST /v1/admin/security/audit-logs/verify-chain` and `POST /v1/admin/billing/ledger/verify-chain`, which detect any single-bit tamper and return `{ valid, totalChecked, firstCorruptedSeq, reason }`.

### 7.2 Threat Detector & Automatic Blocklist
`ThreatDetector` maintains bounded in-process state (`<= 10,000` IPs, `< 0.002 ms` `Set.has()` lookup) synced with `control_db.security_blocklist` on a `5 s` refresh:

| Signal | Threshold / Window | Severity | Automatic Mitigation |
| :--- | :--- | :--- | :--- |
| Auth failures | `>= 20` / 5 min per IP | `high` (`brute_force`) | Auto-block IP for **15 min** |
| `prototype_pollution` or `ssrf_attempt` | `>= 3` / 10 min per IP | `critical` | Auto-block IP for **60 min** |
| `cross_tenant_probe` / 403-admin attempts | `>= 5` / 5 min | `critical` | Alert super admin |
| WebSocket flood | `> 60` msg/min/socket | `high` (`ws_flood`) | Close `1008` + threat event |

---

## 8. Internal Document Engine Hardening

Beyond the HTTP boundary, `packages/document-engine` enforces internal invariants:
- **Fail-Closed Internal Contexts:** `bypassRules` is absent from public `EngineContext` and permitted only when paired with `internal: true` on `InternalEngineContext` (smuggled flags throw `PERMISSION_DENIED`).
- **TOCTOU / CAS Protection:** `conditionalPutDocument` and `SQL_CONDITIONAL_PUT_DOCUMENTS_UNNEST` close read-modify-write races (`expectedVersion === null` → `ALREADY_EXISTS`; `expectedVersion >= 1` → `ABORTED_CONFLICT`).
- **Deadlock-Free OCC Lock Ordering:** `transactions:commit` always locks the `transactions` row (`SELECT ... FOR UPDATE`) **first**, then locks all read-set documents in deterministic `ORDER BY path ASC FOR UPDATE` order before verifying versions (`ALREADY_COMMITTED` / `ALREADY_ROLLED_BACK` / `ABORTED_CONFLICT`).
- **24-Hour Idempotency Ledger:** `batch_idempotency_keys` (FORCE RLS) stores `response_hash` + `response_payload` so retried batches replay safely without double-applying mutations.
- **Bounded `.include()` Relations:** `MAX_INCLUDES = 10` per depth, `MAX_RELATION_DEPTH = 3`, `MAX_INCLUDED_TARGETS_PER_PAGE = 1,000`, `INCLUDE_BUDGET_BYTES = 1 MiB` (throws `RESPONSE_TOO_LARGE`), cycle stubs `{ _ref, _circular: true }`, and rules-denied targets redacted to `null` + `_redactedRefPaths`.
- **Timing & SQL Leak Controls:** `meta.compiledSql` is omitted unless `ctx.debug === true` (never settable from public requests), and public `executionTimeMs` is coarsened to 5 ms buckets.
- **Circuit Breakers for Best-Effort Sinks:** Independent `realtimeBreaker`, `meteringBreaker`, and `auditBreaker` instances open after 5 consecutive failures for 30 s with single half-open probes so sink failures never stall committed writes.

---

## 9. Verification

```bash
corepack pnpm test:security
```

Covers cross-tenant RLS isolation, 3-realm cross-access `403` enforcement, prototype pollution, 30-level JSON & oversized payload rejection, query-cost breaches, SSRF private-range blocking, `X-Forwarded-For` spoofing (`TRUST_PROXY_HOPS`), API key origin/IP restrictions, immutability triggers, and hash-chain tamper detection.

---

## Related Guides

- [04 — Authentication, API Keys & Security Rules AST](./04-security-rules-ast.md)
- [07 — End-User Authentication & the Three Realms](./07-end-user-auth.md)
- [Data Plane Row-Level Security (RLS) & Multi-Tenant Isolation](./data-plane-rls.md)
- [16 — Metering, Quotas & Billing](./16-metering-and-billing.md)
