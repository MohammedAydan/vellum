# Flutter Live Testbed (`vellum_flutter`)

A real Dart/Flutter application that exercises `vellum_flutter` against a
**running** VELLUM HTTP API. It provisions its own isolated
organization, project, publishable/secret API keys, security ruleset and auth
configuration over HTTP, then runs 20 live scenarios. There are no mocks, no
simulations and no skips.

This is the standard Dart/Flutter live testbed. The optional interactive console in
`apps/vellum-e2e-app` imports this runner through a compatibility entry point, rather
than maintaining a second scenario implementation.

The CLI uses development/test-only email action tokens. Do not point it at a
production tenant. When starting the local API, set an explicit ephemeral
`API_KEY_PEPPER` consistently for key issuance and validation; keep it out of logs.

## Requirements

- Dart SDK `>=3.4.0 <4.0.0` (verified with Dart 3.14.1)
- A running API reachable at `VELLUM_API_BASE_URL` (default
  `http://127.0.0.1:8080`) backed by the real PostgreSQL planes.

## Run

```sh
cd examples/flutter_testbed_app
dart pub get

# formatted table of all 20 results; exit 0 only when every scenario passes
VELLUM_API_BASE_URL=http://127.0.0.1:8080 \
  dart run bin/run_live_testbed.dart

# test runner (fails loudly when the server is missing; never skips)
dart test
```

An alternate base URL may be passed as the first CLI argument:

```sh
dart run bin/run_live_testbed.dart http://127.0.0.1:9090
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `VELLUM_API_BASE_URL` | `http://127.0.0.1:8080` | Origin of the live API. The SDK derives `/v1/projects/{id}`. |

No secrets are read from environment variables: API keys are provisioned per run via
the control plane and held only in memory. Raw tokens, keys and DB URLs are
never printed.

## The 20 scenarios

1. JWKS discovery — fetch `/.well-known/jwks.json` and assert an `OKP` /
   `Ed25519` verification key.
2. Alice signup and automatic projection read at `users/{uid}`.
3. Custom field merge preservation plus `updateProfile(displayName: "Alice
   Updated")`.
4. Email verification using the returned `devToken`.
5. TOTP enrollment, local RFC 6238 code (HMAC-SHA1 + base32), confirmation,
   sign-out, MFA-required sign-in and challenge verification.
6. Security rules: Bob receives HTTP 403 on Alice's task (and vice versa before
   elevation).
7. Custom claims elevation through the customer-admin HTTP endpoint with an
   `sk_` key, forced token refresh, then moderator write/read.
8. Five prioritized tasks, sorted filtered query and cursor pagination order
   with no overlap.
9. Realtime WebSocket watch on `tasks` with an event within 2 seconds (a
   timeout is a FAIL, never a skip).
10. Expired access token injected into `AuthTokenStorage`; a document get must
    succeed and a refresh must have happened.
11. Parallel refresh mutex: five concurrent `getIdToken(forceRefresh: true)`
    calls all return the same valid token with exactly one refresh request.
12. Password reset via `devToken`, sign-in with the new password,
    `signOut(allSessions: true)` and rejection of the old refresh token.
13. V2 Rules DSL: compile via REST, publish a merged AST, decompile and run
    ALLOW/DENY simulations with a trace.
14. V2 relations: `doc().get(include: …)` resolves eager relations and redacts
    a target denied by a public-key ruleset (`included` / `redactedRefs`).
15. V2 aggregations: count/sum/avg/min/max, `groupBy`, multi-field `or` groups
    and `contains_ci` filtering.
16. V2 index advisor: an unindexed composite query fires the SDK's
    `onIndexSuggestion` callback, then the recommendation is applied through
    `POST /indexes` and verified in `/indexes/recommendations`.

17. Collections: creating an empty collection persists it.
18. Collections: SDK document writes register their collection.
19. Collections: clearing documents preserves the empty collection.
20. Collections: deleting removes the collection and its documents.

## Files

- `lib/testbed_runner.dart` — `VellumLiveTestbedRunner.runAll()` and
  `ScenarioResult`.
- `bin/run_live_testbed.dart` — formatted table CLI.
- `test/live_testbed_e2e_test.dart` — `dart test` wrapper.
- `lib/flutter_ui_showcase.dart` — conditional facade for the showcase UI.
  Under Flutter it exports the real Material 3 widget tree from
  `lib/src/showcase_flutter.dart`; under the pure Dart SDK it exports the typed
  descriptor from `lib/src/showcase_stub.dart`. Both share
  `lib/src/showcase_model.dart` (the 20 scenarios). The Flutter-only file is
  excluded from pure-Dart analysis in `analysis_options.yaml` and is analysed by
  `flutter analyze` in a Flutter project.

## Gates

```sh
dart pub get
dart analyze --fatal-infos --fatal-warnings
```

## Product issues found while building — all fixed at the root cause

Three defects were discovered while building this testbed. Each was fixed in
source and re-verified; none remains as a workaround:

1. **WS `authToken` was verified with HMAC** in `packages/realtime/src/hub.ts`,
   while end-user tokens are EdDSA/Ed25519 — signed-in handshakes failed. The
   hub now calls `verifyEndUserAccessToken()` against the project's Ed25519
   public key with the same issuer/audience/claims as HTTP, with no HS256
   fallback. Scenario 9 now runs as an authenticated watch; the event is a real
   durable outbox delivery (Flutter PASS at ~520 ms).
2. **`watchCollection()` sent a flattened query spec.** The wire contract
   requires a nested `{ query: { ... } }` frame with `direction` (not `dir`)
   and no opaque cursors. `Query.toRealtimeQuerySpec()` now produces the
   canonical WS spec and `snapshots()` subscribes with `{'query': …}`. A unit
   test asserts the frame shape; scenario 9 uses `watchDocument()` for the live
   watch and the nested query frame is covered by `dart test`.
3. **`PATCH /auth/user` did not re-project `users/{uid}`.** The route now calls
   the projector after profile updates and after email-verification confirmation,
   so `updateProfile(displayName: "Alice Updated")` is reflected in the
   projected document (scenario 3 now asserts it). The same re-projection was
   added after customer-admin `PATCH /users/:uid` and claims grants.

Details, root causes and gate results are in
the Flutter SDK test suite.

## Recorded live result

`dart run bin/run_live_testbed.dart` → all 20 live scenarios PASS, exit 0.
SDK gates: `dart analyze --fatal-infos --fatal-warnings` ("No issues found!")
and `dart test` (50 tests) PASS. The Flutter UI showcase is a real
`lib/flutter_ui_showcase.dart` conditional facade; its widget tree was **not**
compiled with the `flutter` toolchain (unavailable here), but the pure-Dart
surface is analysed and tested with 0 issues.
