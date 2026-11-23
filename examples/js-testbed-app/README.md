# `@vellum/js-testbed-app`

A standalone, no-build TypeScript application that exercises **20 real live
scenarios** through `@vellumdb/sdk-js` against a running Document Database API.
There are no mocks, no simulations and no skips: every assertion talks to the
real HTTP API and real WebSocket gateway. The same scenario functions are used
by the CLI and the dashboard.

## Prerequisites

- A running API with real control/data database planes.
- Node 22+ and pnpm via Corepack (installed at the repo root).
- `@vellumdb/sdk-js` built once (`corepack pnpm --filter @vellumdb/sdk-js build`) so
  its `dist/` type declarations are available.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `VELLUM_API_BASE_URL` | `http://127.0.0.1:8080` | Base URL of the live API. |
| `PORT` | `8081` | Port for the dashboard (`dev` script only). |

No credential is ever read from environment variables or written to a log. Each run
provisions a fresh organization, project, `pk_`/`sk_` key pair and security
ruleset via the real control-plane HTTP routes, with a fresh UUID suffix in
every slug and email address. Repeated runs never collide, and no data outside
the freshly created project is ever modified.

## Run the CLI verifier

```bash
cd <repository-root>
corepack pnpm --filter @vellum/js-testbed-app verify:live
```

It prints a PASS/FAIL table with latency in milliseconds and exits non-zero if
any scenario fails. Only status and latency are printed; error details are
redacted so no API key, JWT, refresh token, email or database URL can appear in
the console.

## Run the dashboard

```bash
corepack pnpm --filter @vellum/js-testbed-app dev
# open http://127.0.0.1:8081
```

Click **Bootstrap tenant**, then run any individual scenario or **Run all 16**.
Results appear live with status and latency. The dashboard calls the exact same
functions in `src/scenarios.ts` as the CLI; there is no duplicated test logic.

## The 16 scenarios

| # | Scenario | SDK / HTTP surface used |
| --- | --- | --- |
| 1 | JWKS discovery → one OKP/Ed25519 key | `GET /auth/.well-known/jwks.json` |
| 2 | Alice signup + projected `users/{uid}` | `signUpWithEmailAndPassword`, `doc().get()` |
| 3 | Merge preservation + profile update | `doc().set(..., {merge:true})`, `updateProfile`, `doc().get()` |
| 4 | Email verification via `devToken` | `sendEmailVerification`, `confirmEmailVerification`, `getUser` |
| 5 | TOTP MFA challenge | `enrollTotpMfa`, `confirmTotpMfa`, `signOut`, `signInWithEmailAndPassword`, `verifyMfaChallenge` |
| 6 | Rules: owner vs stranger (403) | `doc().create()`, Bob `set()`/`delete()` → `PERMISSION_DENIED` |
| 7 | Custom claims elevation | `PUT .../auth/admin/users/:uid/claims` with `sk_`, `getIdToken(true)`, read/write report |
| 8 | Filtered + sorted query + cursor | `collection().where().orderBy().limit()`, `startAfter()` |
| 9 | Realtime WebSocket watch | `collection().onSnapshot()`, second client inserts |
| 10 | Silent refresh of expired access token | custom `AuthStorage` with expired JWT, `collection().get()`, refresh call counted |
| 11 | Parallel refresh | `Promise.all([...5 getIdToken(true)])`, single-flight asserted |
| 12 | Password reset + signOut(allSessions) | `sendPasswordResetEmail`, `confirmPasswordReset`, `signOut({allSessions:true})`, refresh rejection |
| 13 | V2 Rules DSL compile → publish → simulate | `POST .../rules/compile`, `/rules/decompile`, `/rules/simulate`, `/rulesets` |
| 14 | V2 relations include + redaction | `doc().get({include})`, `_included` / `redactedRefs`, public-key ruleset |
| 15 | V2 aggregations + OR + CI operators | `count/sum/avg/min/max`, `aggregate({groupBy})`, `or()`, `contains_ci` |
| 16 | V2 index advisor callback + apply | `createClient({onIndexSuggestion})`, `POST .../indexes`, `/indexes/recommendations` |

Scenarios 13–16 compile the locked v2 rules DSL through the REST endpoint,
publish a merged AST for the testbed's isolated tenant, and then exercise the
real V2 engine paths. Each scenario is standalone-safe: the rules publication
is memoized and re-applied on demand when a single scenario is re-run from the
dashboard. Applying the index recommendation in scenario 16 calls the exact
`POST /indexes` route the dashboard deep link uses.

TOTP codes are computed locally with Node's `crypto` (RFC 6238, HMAC-SHA1, six
digits, 30-second step) — no extra dependency.

## Recorded live result

`corepack pnpm --filter @vellum/js-testbed-app run verify:live` printed **12/12
scenarios passed, exit 0** after the source fixes, twice in the same API
process (the second run is the cross-run rate-limit regression proof). Per-scenario
latency numbers are reproducible with the scripts in this directory
§2 and §4.1–4.2. The full developer guide is [`docs/08-sdk-js-guide.md`](../../docs/08-sdk-js-guide.md).

### Notes on scenario 7

The ruleset gates `admin_reports/{id}` on both `auth.claims.role === "moderator"`
and `auth.claims.clearance >= 3`. The grant is performed by the real customer
admin route using the `sk_` key, and the refreshed JWT is what unlocks the
collection. The scenario asserts the moderator role on the projected
`users/{uid}` document exactly as specified, so any staleness in the auth
projection is reported as a real failure rather than hidden.

### Notes on scenario 12

A dedicated, per-run user is created for the reset flow so that it does not
depend on the TOTP enrollment performed on Alice in scenario 5. Since end-user
access tokens are stateless EdDSA JWTs, the revocation assertion verifies that
the **refresh token** is rejected on `/auth/token/refresh` after the reset and
after `signOut({allSessions:true})`.

## Type checking

```bash
corepack pnpm --filter @vellum/js-testbed-app typecheck
corepack pnpm --filter @vellum/js-testbed-app exec tsc --noEmit
```
