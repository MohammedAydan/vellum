# Changelog

## Unreleased

## 0.0.10 (beta)

Hardening release from the 0.0.10 sprint prompt. Beta. Each row names the test that fails on 0.0.9 where one could be run; "untested" means no automated proof exists yet.

### Upgrade notes

- No breaking API change. The realtime error frame for the 25-subscription cap now carries `limit: 25`. A same-identity token refresh keeps the realtime session; an identity switch still emits `SESSION_CHANGED` on purpose. There is no runtime `realtimeTransport` switch (constructor-time only).
- No new migrations.

### Fixes by ID

| ID | What shipped | Verified by |
| :-- | :-- | :-- |
| P0-1 | Outbox gap re-drain and 1s idle poll (no 28s-217s stalls); 1008 policy close root cause (per-socket frame budget and coalescing check in `ws-rfc6455.ts`); one LISTEN client per process; subscription-cap frame with `limit`; leak churn test | `packages/realtime` tests, `subscription-cap.test.ts`, `tests/integration/sdk-ws-realtime/recipes.test.ts` (Recipes 3A/3B/3C/4) |
| P0-2 | `.select([...])` projection under per-doc `allow get` rules | Recipe 1 test (incl. `or()` variant and key-leak assertion) |
| P0-3 | Missing-document realtime subscribe, TTL-expiry delete push | `missing-doc-subscribe.test.ts` |
| P0-4 | `data_db` outage 503 + health endpoints | health tests (503 test) |
| P1-1 | Wildcard index at 50,100 docs (PG), aggregate FAILED_PRECONDITION clarity, dev CORS localhost bypass and one-time rejected-origin warning, per-project `signupPerIpLimit` | `tests/integration/wildcard-index-pg.test.ts` (CI, PG16/18), `project-cors.test.ts`, `auth-signup-ip-limit.test.ts` |
| P1-2 | Flutter outbox auto-flush on reconnect | Flutter tests (CI) |
| P1-3 | Flutter missing-doc lifecycle and WS pooling parity | `sdks/flutter/test/realtime_removed_doc_test.dart` |
| P1-4 | JS missing-doc `onSnapshot`, WS auto-pooling, 5xx retry/backoff | `realtime-pooling.test.ts`, `realtime-removed-doc.test.ts`, `http-5xx-backoff.test.ts`, Recipes 2/3/4 |
| Track D | Docs synced (EN/AR), stale 0.0.1 caveats removed, ADR-006 corrected, ADR-008 added | docs checks in CI |

### Known gaps

- Project API-key allowed origins now accept `http(s)://localhost:*`, `http://127.0.0.1:*` and `http://[::1]:*` (any port, those hosts only). Applies to REST CORS, SSE and WebSocket through one shared matcher.
- Fail-on-0.0.9 results (the same test files run against the 0.0.9 source): FAIL on 0.0.9 and pass now: Recipe 2 case B, Recipe 2 TTL, Recipe 4.2 (1,000 subs), subscription-cap `limit` frame, Recipe 1, 3B, the 1008 test, the JS pooling test. PASS on 0.0.9 as well (they guard against regression, they do not reproduce a 0.0.9 failure): Recipe 2 case A, same-identity token refresh, Recipe 3C and Recipe 3A (WS and SSE). The 0.0.9 stalls (28s-217s, 153/157) came from the PostgreSQL poller and a per-socket frame budget; the in-memory server in these tests cannot reproduce them. 3B and the idle-poller test cover the PG path.
- Recipe 3A against real PostgreSQL with two server processes was not run (no PostgreSQL server in the sandbox).
- Scoped `aggregate()` over more than 10,000 member-scoped rows returns FAILED_PRECONDITION; this is proven by a cap-lowered unit test, not at 74,600 rows.
- `/llms-full.txt` is a rewrite to `/docs/llms-full.txt`; it needs a deploy to verify live.

## 0.0.9 (beta)

Remediation release across security, realtime, both SDKs and docs. The API, JS SDK and Flutter SDK ship together; the JS SDK contains one intentional breaking change (P0-4). The version constant bump lands with the final remediation track; this section maps every finding ID to what shipped, where, and how it was verified.

### Upgrade notes (breaking / behavior changes)

- **P0-4 (breaking, sdk-js):** `db.doc(path).onSnapshot` now delivers a `DocumentSnapshot` (`exists`, `data()`, `version`, timestamps, `included`, `redactedRefs`) instead of the query-style realtime snapshot. Missing and deleted documents deliver `exists === false` with `data() === null`, and identical `(exists, version)` states are delivered once. Query/collection listeners are unchanged. Migration: read `snap.exists` / `snap.data()` instead of iterating `snap.changes`; a delete arrives as `exists === false`, not a `removed` change entry. Flutter already used `DocumentSnapshot` streams and gains the same missing-doc and dedupe behavior.
- **S7 (behavior change, sdk-js):** auth sessions are memory-only by default everywhere; persistence is opt-in via `authPersistence: "local"` (or an explicit `authStorage`). Upgrading without opting in signs users out on reload once.
- **P1-2 (behavior change):** `count()`/`aggregate()` under member-scoped rules now return an aggregate over the rows the caller may see instead of failing 403. Set `VELLUM_AGGREGATE_ROW_FILTER_MAX=0` to restore the old fail-closed behavior.
- **D3 (behavior note):** after `upgradeAnonymousWithEmailAndPassword`, sibling sessions' refresh/session rows are revoked immediately (reason `anonymous_upgrade`), but an already-issued access token on a sibling session keeps working until its short TTL expires - access tokens are stateless and not individually revoked.
- **Deploy runbook (order matters):** run migrations BEFORE the 0.0.9 deploy - control `--only=control` (0019), then data `--only=data` (0016, 0017). Once data migration 0017 is applied, pre-0.0.9 code 500s on indexed document writes (its ON CONFLICT target no longer exists), and 0.0.9 code 500s on them before it is applied; unindexed reads/writes are unaffected on both sides. Keep the gap to minutes.
- Control-plane migration **0019** (sign-up per-IP limit, dev key flag) and data-plane migrations **0016** (`realtime_outbox.xid8`) and **0017** (`document_index_entries` primary key gains `collection_path`) run automatically on deploy. Control and data planes must stay separate physical databases (one migrations directory per plane, shared `schema_migrations` table).

### Track 1 - security & backend (PR #148)

| ID | What shipped | Files (entry points) | Verified by |
| :-- | :-- | :-- | :-- |
| S3 / P0-1 | Payload-budget 429s never feed the IP ban; only real `__proto__`/constructor-as-key attacks and SSRF count; `payload_limits` category; raw DSL `source` accepted by simulate/validate | `packages/security/src/fortress.ts`, `packages/api-contract/src/schemas/v2.ts` | `payload-limits-threat.test.ts`, `rules-simulate-regression.test.ts` (25 compile+simulate loops of a >2,200-key ruleset, 10 oversize payloads without a block, 3 real `__proto__` still block) |
| S1 / S2 / P0-5 | `/health/ready` public projection only (no filenames, checksums, SQL, error codes); degraded `/health` answers 503 when a plane is down; `/health/live` never touches the DB | `apps/api/src/routes/health.ts` | `health-hardening.test.ts` |
| S6 | DB connect-class errors map to JSON 503 + `Retry-After` + `X-Request-Id`; readiness cache 20s/5s with a single probe client; lazy Vercel init; pool connect timeouts | `apps/api/src/error-handler.ts`, `api/server/index.js`, `packages/storage/src/pg-store.ts` | `health-hardening.test.ts` |
| P0-3 | Three-valued missing-document reads: 404 only when absent AND authenticated AND list passes AND the rule passes with optimistic `resource.*`; everything else 403. `request.data` documented as the final merged state | `packages/authorization/src/rules-ast.ts`, `packages/document-engine/src/engine.ts` | `missing-doc-read-semantics.test.ts` (8 tests) |
| P1-1 | Rules compiler warns on wildcard overlap with a stricter explicit sibling | `packages/authorization/src/rules-dsl.ts` | `rules-wildcard-overlap.test.ts` (Rules Studio surfacing ships in Track 5) |
| P1-3 | Per-project sign-up per-IP limit (default 30, bounds 1-10,000); localhost CORS dev toggle for dev-flagged `pk_` keys with a clear preflight diagnostic | `apps/api/src/app.ts`, control-plane migration 0019 | apps/api suite |
| S8 | Anonymous email claim via mailbox confirmation (`pendingEmail`, single-use `email_claim` token, constant response shape, no `ALREADY_EXISTS` oracle) | `apps/api/src/routes/auth-enduser.ts` | `auth-email-claim.test.ts` |
| S9 | Single-use TOTP codes on `/mfa/verify` (end-user and console) | `apps/api/src/routes/auth-enduser.ts`, `apps/api/src/routes/mfa.ts` | `console-mfa-replay.test.ts` |
| S10 | Per-IP concurrent realtime stream cap (SSE parity with WS, 429 + `Retry-After`) | `apps/api/src/` realtime routes | apps/api suite |
| S7 | sdk-js sessions memory-only by default, opt-in persistence | `packages/sdk-js/src/auth/auth-storage.ts` | `auth-client.test.ts` |
| D1 | Per-request ruleset-load budget (memoized once per request; fail-closed cap of 4 ruleset store loads per request - separate from the per-rule `get()`/`exists()` limit of 10 document lookups; audit + telemetry) | `packages/document-engine/` | document-engine suite (168 tests) |

### Track 2 - realtime & performance (PR #149)

| ID | What shipped | Files | Verified by |
| :-- | :-- | :-- | :-- |
| P0-2 | Commit-order-safe realtime delivery: `xid8` outbox column, delivery strictly below `pg_snapshot_xmin`, bootstrap from `max(seq_id)` in the same transaction as `initial_sync`, resume via the safe watermark; fan-out skips sessions with no candidate subs, batched revocation check, bounded concurrency 32 with per-subscription order | `packages/realtime/`, data migration 0016 | late-commit, large-history bootstrap, 200x connect-write race (WS+SSE), forced-disconnect 0-miss/0-dup, 1,000-sub fan-out tests |
| P1-4 | Pool/lock policy: `lock_timeout` 1500ms on tenant setups, `55P03` -> `ABORTED_CONFLICT` + `retryAfterMs=50`, NOWAIT OCC locks on hot documents, LISTEN-healthy poll back-off | `packages/database-control/`, `apps/api/src/` | Benchmarks on a throwaway PostgreSQL 18.7 (60k docs, 50 workers x 20 increments on one hot document): WAIT mode p95 1447ms / wall 5.6s vs NOWAIT p95 232ms / wall 1.5s; outbox safe-watermark at 60k rows p95 19.6ms, capped 500-row page fetch p95 8ms (`tests/load/track2-realtime-bench.ts`) |

### Track 3 - SDKs (PR #150)

| ID | What shipped | Files | Verified by |
| :-- | :-- | :-- | :-- |
| P0-4 | `doc.onSnapshot` -> `DocumentSnapshot` (breaking, see upgrade notes); missing/deleted -> `exists: false`; `(exists, version)` dedupe | `packages/sdk-js/src/references/document-ref.ts`, Flutter `references.dart` | sdk-js suite 231 tests; Flutter tests via CI Dart leg (no local toolchain) |
| P1-5 | WS->SSE fallback stall fix in both SDKs (fallback timer cleared on the first delivered frame, not on open); `client.onIndexSuggestion(listener)` returns an unsubscribe function; optional persistent offline write outbox for sdk-js (IndexedDB with localStorage fallback, ordered flush, stable `Idempotency-Key` from the first attempt, cross-tab leader lock, dead-letter callback on permanent 4xx) | `packages/sdk-js/src/realtime/fallback-socket.ts`, `packages/sdk-js/src/offline/outbox.ts`, Flutter `sse_channel.dart` | `offline-outbox.test.ts`, fallback stall tests both SDKs |
| P1-6 | Flutter `connectionState` / `connectionStateStream` with transport kind (`websocket`/`sse`); deduplicated initial emit and missing-doc `exists: false` in both SDKs | Flutter `vellum_client.dart`, `realtime_manager.dart` | Flutter connection-state/dedupe tests via CI Dart leg |
| - | Session-changed fix: identity switch A->B kills live subscriptions (subject comparison; subjectless refreshed token treated as refresh); one transport error per subscription per outage instead of one per reconnect attempt; `Retry-After` floor 250ms; 5xx/4xx classification with `retryable`; `listIdentities()` canonical + deprecated alias in both SDKs; `disableMfa(code | { code })` | sdk-js `vellum-client.ts`, `http-transport.ts`; Flutter `auth_client.dart` | sdk-js suite, Flutter tests via CI |

### Track 4 - auth feature & docs (this PR)

| ID | What shipped | Files | Verified by |
| :-- | :-- | :-- | :-- |
| D3 | `upgradeAnonymousWithEmailAndPassword` end to end: `POST /auth/upgrade-anonymous` (uid preserved, password identity linked, other sessions revoked with reason `anonymous_upgrade`, 412 non-anonymous, 409 email taken), `auth.upgradeAnonymousWithEmailAndPassword(email, password)` in sdk-js, `client.auth.upgradeAnonymousWithEmailAndPassword({email, password})` in Flutter, docs in EN+AR | `apps/api/src/routes/auth-enduser.ts`, `packages/sdk-js`, `sdks/flutter` | `auth-upgrade-anonymous.test.ts` (server: upgrade flow, other-session revocation, collision/non-anonymous/unauthenticated rejections), SDK unit tests |
| D2 | Relation-rules management stays console-only in 0.0.9; docs/12 states it plainly; ADR-007 records the planned scope-gated `sk_`/SDK surface | `docs/12-relationships-and-advanced-queries.md`, `docs/decisions/ADR-007-relation-rules-sdk-surface.md` | docs pages test |
| D4 | llms.txt / llms-full.txt / per-page Markdown are generated from the pages at build; a drift-guard test re-renders every page in both languages through the generator pipeline and asserts index coverage | `apps/docs/src/__tests__/llms-drift.test.ts` | docs test leg |

### Track 5 - wildcard index templates, proxy-aware caps, aggregates, release (this PR)

| ID | What shipped | Files | Verified by |
| :-- | :-- | :-- | :-- |
| P1-3 (index templates) | Wildcard collection templates in full, all four layers together: canonicalization + segment-wise coverage in `packages/core/src/index-templates.ts`; template-aware advisor coverage, emission (`collectionPath` = template, `exampleCollectionPath` = concrete instance, fingerprint over template); segment-wise backfill with (collection_path, document_id) tuple pagination in the PG and Neon builders; compiler template selection with exact-path tie-break; template-aware memory-adapter maintenance; whole-cache invalidation on index create/delete | `packages/core`, `packages/query-engine`, `packages/storage`, `packages/document-engine`, `apps/api/src/routes/console.ts`, `apps/api/src/routes/v2.ts` | index-templates unit suites (core 8, storage 4, advisor 6, compiler 3) + `tests/load/track5-template-index-bench.ts` on throwaway PostgreSQL 18.7 (84k docs, 61 concrete chats): unindexed `orderBy` on a non-system field is refused with a template suggestion once the concrete path holds more than 50,000 live documents (bench: 60k-doc chat; exactly 50,000 stays under the gate and is served); backfill READY in ~13.5s; indexed orderBy p50 2.1ms / p95 5.3ms (60k-doc chat), p50 2.8ms / p95 10.0ms (second chat, same template); post-backfill writes land in the template index. `collectionGroup` queries remain unsupported; template indexes serve concrete collection paths only |
| P1-3 (schema fix) | Data migration **0017**: `document_index_entries` primary key gains `collection_path`. The benchmark caught `ON CONFLICT DO NOTHING` silently dropping entries whose (sort_key, document_id) repeated across concrete paths (60,000 of 84,000 backfilled while reporting ready). The compiled entry scan also pushes `collection_path` so template queries take a direct primary-key range scan (0.24ms for a 51-row page on a 60k-doc subcollection) | `packages/database-data/migrations/0017_index_entries_collection_path_pk.sql`, `packages/storage/src/tx-context.ts`, `packages/storage/src/memory-adapter.ts`, `packages/query-engine/src/compiler.ts` | the same benchmark, re-run: 84,000/84,000 entries across 61 concrete paths |
| S10 (WS parity) | WS upgrade path resolves the client IP through the exported `extractClientIpFromHeaders` (trusted-proxy hop counting, spoof rules unchanged) instead of raw `req.socket.remoteAddress`, so the per-IP concurrent-stream cap works behind the Vercel proxy | `packages/security/src/security.ts`, `packages/realtime/src/ws-rfc6455.ts` | `hardening.test.ts` (20 tests incl. 5 new header-parsing cases) |
| P1-1 (surfacing) | Rules Studio shows wildcard-overlap warnings before publish: DSL mode requires a second confirm click listing the warnings; JSON mode decompiles and recompiles best-effort to surface the same warnings | `apps/dashboard` rules page, i18n EN+AR | dashboard suite (67 tests) |
| P1-2 | `count()`/`aggregate()` under member-scoped rules no longer fail-closed 403: on PERMISSION_DENIED with a row-level get rule the engine aggregates over visible rows only (paged by documentId, limit <= MAX_QUERY_LIMIT 500, in-memory accumulation via `aggregateRowsInMemory`, per-page usage recorded). Cap env `VELLUM_AGGREGATE_ROW_FILTER_MAX` (default 10,000; 0 restores the old 403). Sums/averages never touch hidden docs, so no oracle/timing side channel opens | `packages/document-engine/src/engine.ts` | `row-level-reads.test.ts` (12 tests) |
| Console UI | Indexes page: template badge on template-backed indexes, suggestion banner shows the concrete example path, per-index generalize-to-template action (creates the template, then offers Drop concrete / Keep) | `apps/dashboard` indexes page, i18n EN+AR | dashboard suite (67 tests) |
| ADR-006 | Rewritten as the shipped design: canonicalization, coverage, builder, compiler, the 0017 entry-key fix the benchmark caught, migration of existing concrete indexes, acceptance numbers | `docs/decisions/ADR-006-wildcard-index-templates.md` | this PR |
| Release | Version bump to 0.0.9 (beta) across all 21 package.json, 5 pubspec.yaml, 3 lockfiles, health/admin/openapi surfaces | `scripts/check-version-sync.mjs` covers the set | version-sync check in CI |

## 0.0.8 (post-release backend patch)

Backend and console fixes shipped on top of the published 0.0.8 release. No SDK or API-contract changes, so the published 0.0.8 packages (npm, pub.dev) stay valid; the backend deploy carries these fixes.

### Fixed

- **Ruleset publishing:** publishing security or relation rules no longer hits the 500-object-key document guard, whose error message talked about batches. Ruleset routes (publish, compile, decompile, simulate) now have their own budget of 25,000 object keys per request and a dedicated error (HTTP 400, guardCode `RULESET_TOO_LARGE`) that says how to shrink the ruleset. This also fixes the console Rules Studio Request panel, which sends the whole ruleset to `/rules/simulate`.
- **Document key budget:** a single document may now carry up to 10,000 object keys (`DOCUMENT_MAX_OBJECT_KEYS`) instead of being rejected past 500 keys by the generic request guard, and each write inside a batch, transaction, collection import or auth users import gets that per-document budget rather than competing for one shared 500-key request cap. Oversized single documents fail with a message that actually says the document is too large; the 5 MiB batch byte cap and the 500-key cap on ordinary small request bodies are unchanged.
- **Sign-in lockout DoS:** the per-account sign-in ceiling (50 failed attempts / 15 minutes, shared across all client addresses) could keep the real owner locked out of their account — an attacker only needed the email address. While the bucket is full, wrong passwords still get `429 TOO_MANY_REQUESTS`, but the correct password now always signs in. The per-(IP, email) limit (10 failures / 15 minutes) is unchanged and has no bypass, so single-source guessing stays capped.
- **Weak passwords:** every self-service password choice (console sign-up, master-owner setup, end-user sign-up, password change and reset confirm) now rejects passwords from the well-known common lists (such as `12345678` or `password`, case-insensitive) with `INVALID_ARGUMENT`, in addition to the existing minimum-length and per-project composition rules.

### Changed

- **Docs:** the end-user `metadata` field is now clearly documented as user-controlled — never read it in security rules or use it for authorization decisions; trusted per-user data belongs in a developer-managed collection or in custom claims set with a server key. The errors-and-limits and end-user-auth pages (EN and AR) document the sign-in throttles, the password policy, and the ruleset publish budget.

## 0.0.8

One release for the realtime, security-rules, auth and SDK fixes found in audits and live tests. Upgrade the SDKs together with the API. The SDKs are in beta, so some behavior changes below are breaking. (See also the post-release backend patch notes above.)

### Upgrade notes

- Three control-plane migrations (`0016` to `0018`) run automatically when the API is deployed with its normal build.
- **JS behavior change:** `onAuthStateChanged` now calls its listener once right away with the current user (or `null`), like Flutter's `authStateChanges` and Firebase. A listener that only expected later changes will see one extra call.
- **`addWithRelated` accepts at most 100 documents** (parent plus related), the same limit as `batchWrite`. Before, the SDKs allowed 500 and the API rejected anything over 100.
- JS writes that contain `NaN` or `Infinity` now throw `INVALID_ARGUMENT` instead of being stored as `null`.
- Network failures (offline, DNS, refused) now surface as an error with `code: "NETWORK_ERROR"` and `status: 0` in JS and Flutter.
- Realtime does not need `DATA_DATABASE_URL_LISTEN`. Without it each instance polls the outbox about once a second for tenants with connected clients. Set a direct (non-pooled) connection string to also get instant wake-ups; each instance with LISTEN holds one direct connection.
- `DATA_POOL_MAX` is now honoured for the data-plane pool.

### Added

- **Security rules:** `get()` and `exists()` lookups in rules, evaluated by the engine, by realtime, and in the docs. `list` rule semantics are unchanged. Live queries apply the same rules: when a subscriber can no longer read a document, their query gets a removal for it. Roll the ruleset out after the new API version is live, because an older API instance rejects rules that use these functions.
- **Auth:** a per-project SMTP setting for verification and password-reset email.

### Changed

- The Index Advisor warning in the JS SDK is one line.
- Docs: batch limit corrected to 100 and `BATCH_SIZE_EXCEEDED` explained, account-enumeration behavior of sign-up, reset and verify, the realtime snapshot shape, TypeScript run steps in the quickstart.

### Fixed

- **Realtime, multi-instance:** updates are no longer missed when the write and the client connection are served by different instances. The outbox poller always runs, and rows that commit late are delivered.
- **Realtime:** a cold instance no longer replays old history as live events. The watermark returned on subscribe is the newest outbox sequence of the project. Idle tenants cost no database work.
- **Realtime (JS, Flutter):** a delete in a document subscription reports `exists: false` and `data()` of `null`. An update older than the version already held is ignored.
- **JS realtime** follows the browser's online and offline events.
- **Errors:** a non-UUID project id gives `400 INVALID_ARGUMENT`. A `limit` below 1 or not an integer, and an empty `in` list, give `INVALID_ARGUMENT`.
- **Auth:** console sign-out now ends the session on the server. It revokes the access token and every console refresh session of the user, and the 15 second refresh grace window no longer mints a session for a revoked token. The dashboard calls it on logout.
- **Realtime:** a revoked or expired session stops receiving live data. The session is rechecked before each delivered event (at most every 5 seconds, `REALTIME_SESSION_RECHECK_MS`).
- **Realtime (JS, Flutter):** the SSE fallback drops replayed mutations it has already seen for a subscription.
- **Console sign-up:** email addresses are limited to 254 characters.
- Audit fixes: dotted update paths, timers, timestamp ranges, throttle keys, client IP handling, registry reads, nested field operations, group-by types and message text.

## 0.0.7

Fixes found by building a real chat app on 0.0.6: realtime and requests from a browser, batch writes, and missing documents. Upgrade the SDKs together with the API.

### Upgrade notes

- No migrations. API keys that list `allowedOrigins` now also work for same-origin GET requests and for realtime (WebSocket and SSE) from those origins.
- `batchWriteChunked` (JS) and `writeBatchChunked` (Flutter) now default to 100 operations per request, the server limit. Larger `chunkSize` values are capped at 100.
- `doc.get()` on a missing document now returns `exists: false` instead of throwing NOT_FOUND. Code that relied on the exception should check `snapshot.exists`.
- A plain Vercel `rewrites` rule buffers SSE and cannot carry WebSockets. Point the SDK `endpoint` at the API origin for realtime.

### Fixed

- **fix(api):** on Vercel the client IP for rate limits (sign-up, auth) now comes from `x-vercel-forwarded-for`, which the platform sets, instead of the last `x-forwarded-for` hop. Behind a rewrite from another deployment, all users used to share one rate-limit bucket.
- **fix(api):** `Access-Control-Allow-Credentials` is no longer sent when no `Access-Control-Allow-Origin` was granted.
- **fix(sdk-js):** in a browser every request failed with "Illegal invocation" unless the app passed `customFetch`, because the transport called `globalThis.fetch` as a method of itself. The transport and the SSE socket now call fetch as a plain function, and the default is looked up at call time.
- **fix:** an API key with `allowedOrigins` rejected same-origin GET requests, because browsers send no `Origin` header on them. A GET or HEAD with `Sec-Fetch-Site: same-origin` (a header page scripts cannot set) is now checked against the origin of the request's own host. Every other request without an `Origin` header is still refused.
- **fix(realtime):** realtime now works for a developer's own web app. Before, per-project CORS (origins on an API key) only covered `/v1/projects/...`, so the WebSocket handshake answered 403 and the SSE stream failed its preflight. `POST /v1/realtime/stream` now returns `Access-Control-Allow-Origin` when an active key of the project in the auth frame lists the origin, and the WebSocket accepts such an origin provisionally and closes it (1008) unless the auth frame names a project whose active keys list it. Null, wildcard and malformed origins are still refused at the handshake, other origins are refused at the auth frame, and third-party origins never receive `Access-Control-Allow-Credentials` (this also applies to the existing `/v1/projects/...` responses).
- **fix(api):** the API no longer rejects ordinary 100-operation batches with "Total object keys exceed 500". The object-key limit now applies per write (500 keys each) and the body total scales with the number of writes (at most 100). The 5 MiB body cap and depth limits are unchanged. The SDK chunk size defaults to 100 in JS and Flutter.
- **fix(sdk-js, flutter):** `doc.get()` on a document that does not exist (for example right after `delete()`) returns a snapshot with `exists: false` instead of throwing NOT_FOUND. A missing project still throws. In JS, `snapshot.metadata.fromCache` is now `true` when a snapshot comes from the client read cache.
- **fix(realtime):** a write that committed while a new `onSnapshot` was reading its initial snapshot could be delivered before `initial_sync` and then overwritten by it, so the update was lost. Live events are now held until `initial_sync` is sent, then delivered in order, skipping any the snapshot already contains.

- **fix(rules):** `unchanged([...])` treats a field that is missing on both the stored and the new document as unchanged (null on both already was). The `in` operator no longer lets an unauthenticated caller match a null entry in the list. The syntax `auth.uid in resource.memberIds` and `incoming.memberIds` was already supported and is now documented and tested.
- **feat(sdk):** throttled (429) errors expose `retryAfter` in seconds: `err.retryAfter` in JavaScript and `VellumException.retryAfter` in Dart.
- **feat(api):** optional `AUTH_RATE_LIMIT_SCALE` multiplies the auth rate limits for load and end-to-end tests. Off by default; never set it in production.
- **hardening:** the batch key budget only applies to `batchWrite`, `documents:batchWrite` and `transactions:commit` (fields `writes`, `operations`, `mutations`), per write, and the rest of the body is checked against the original cap. The realtime initial-snapshot flush always releases its gate.

### Known limitations

- Realtime handshakes and SSE responses reveal whether an origin is listed on any key of a project (an origin-listing oracle). It exposes only allowed origins, which are public by nature in a browser app.

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

- **Behavior change:** queries that no index can serve (a range filter, `!=`, `not-in`, text filters, `search`, or an order on a field other than `documentId`, `createdAt` and `updatedAt`) are now refused with `FAILED_PRECONDITION` and a `suggestedIndex` when the collection has more than 50,000 live documents (strictly greater; at exactly 50,000 the query is still served). `collectionGroup` queries are unsupported - every query targets one concrete collection path, and template indexes serve concrete paths only. Create the composite index named in the error, or raise or disable the limit with `VELLUM_UNINDEXED_QUERY_MAX_DOCS` (`0` disables). Smaller collections are unaffected. Before, such queries read the whole collection and failed at the 5 second statement timeout on large ones.
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
