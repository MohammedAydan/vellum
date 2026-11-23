# VELLUM Examples

Every verified example is provided in **three variants**, so the same scenario can
be read in the language the reader actually uses:

| Variant | Directory | Status | How to run |
| --- | --- | --- | --- |
| **JS/TS SDK** | `examples/ts/` | Runnable | `corepack pnpm exec tsx examples/ts/<id>.ts` |
| **Raw REST** | `examples/rest/` | Runnable | `node examples/rest/<id>.mjs` |
| **Flutter / Dart** | `examples/flutter/` | Runnable | `cd examples/flutter && dart run <id>.dart` |

In addition to these single-scenario examples, there are **two full live testbed apps** that exercise the SDKs end-to-end against the running API (each provisions its own isolated tenant and runs its real scenario suite):

| Testbed | README | Run |
| :--- | :--- | :--- |
| `@vellum/js-testbed-app` (CLI + dashboard) | [`examples/js-testbed-app/README.md`](./js-testbed-app/README.md) | `corepack pnpm --filter @vellum/js-testbed-app verify:live` |
| Flutter/Dart CLI testbed | [`examples/flutter_testbed_app/README.md`](./flutter_testbed_app/README.md) | `cd examples/flutter_testbed_app && dart run bin/run_live_testbed.dart` |

The Flutter testbed is pure Dart — no `flutter` UI toolchain was used. See the [full SDK guides](../docs/08-sdk-js-guide.md) and [Flutter guide](../docs/09-sdk-flutter-guide.md).

The docs' three-tab code blocks are driven by `examples/ts/manifest.json`. Each
entry keeps its original fields (`id`, `file`, `title`, `group`, `description`)
and adds two optional path fields, both relative to `examples/`:

- `"rest": "rest/<id>.mjs"`
- `"dart": "flutter/<id>.dart"`

The standard live testbeds are the JS/TS app and the Dart/Flutter app above.
`apps/vellum-e2e-app` is an optional interactive Flutter UI adapter over the same
Dart runner, not another independent test suite. The single-scenario examples and
`tests/dart-verify` contract harness are not replacement testbeds.

## What the examples show

All 13 scenarios are practical, real-world flows rather than API smoke tests:

| id | Scenario |
| --- | --- |
| `quickstart` | Status-page hit counter: health probes, then one full document lifecycle |
| `crud` | Versioned user profile with a rejected stale-tab write |
| `field-transforms` | Atomic likes/tags/timestamp updates on a social post |
| `query` | Analytics filter: top events by region and a disjunctive `in` filter |
| `pagination` | User directory walked two rows at a time via opaque cursors |
| `indexes` | Tenant leaderboard index over `(team, score)` |
| `realtime-snapshot` | Live sensor dashboard watching a document and a query |
| `batch-write` | Atomic user onboarding plus an all-or-nothing rollback |
| `transactions` | Balance transfer with a forced conflict and a stale precondition |
| `rules` | Publish a deny-by-default v1 ruleset, reject a bad AST, restore |
| `errors` | Canonical error codes for quota, complexity, size and conflict |
| `rest-api` | Plain `fetch` CRUD, collection listing and `/query` |
| `auth` | API-key lifecycle with immediate revocation |

## Prerequisites

- A running API at `http://127.0.0.1:8080` (override with `VELLUM_API_BASE`).
- **TS:** pnpm via Corepack (`corepack pnpm exec tsx`).
- **REST:** Node 20+ (`fetch` is built in; no dependencies).
- Set `VELLUM_EMAIL`, `VELLUM_PASSWORD` and `VELLUM_PROJECT_ID` for a disposable local test project. Both harnesses read `.env.phase5.local` from the repo root for optional
  `VELLUM_API_BASE` and `VELLUM_PROJECT_ID` overrides.

## Running the TypeScript examples

```bash
corepack pnpm exec tsx examples/ts/quickstart.ts
# or all of them:
for id in quickstart crud field-transforms query pagination indexes \
          realtime-snapshot batch-write transactions rules errors rest-api auth; do
  corepack pnpm exec tsx "examples/ts/$id.ts"
done
```

Each example imports `examples/ts/_harness.ts`, which signs in with the configured test
account, mints a short-lived server API key, uses a unique per-run path prefix,
and calls `cleanup()` in a `finally` block. Output is deterministic and fully
redacted — `=== Title ===` followed by JSON lines. Secrets (keys, tokens,
email, password, run prefix) are scrubbed before printing, and every example
exits `0` on success.

## Running the REST examples

```bash
node examples/rest/quickstart.mjs
# or all of them:
for id in quickstart crud field-transforms query pagination indexes \
          realtime-snapshot batch-write transactions rules errors rest-api auth; do
  node "examples/rest/$id.mjs"
done
```

`examples/rest/_harness.mjs` is deliberately standalone: it is ESM, uses only
`fetch`, and does **not** import the TypeScript harness or any SDK. It mirrors
the TS harness's auth/bootstrap/cleanup/redaction behavior. Captured, redacted
stdout for every REST example lives in `examples/rest/output/<id>.txt`.

> Note: `realtime-snapshot.mjs` is fetch-only, so it has no WebSocket transport.
> It observes mutations through the REST/outbox polling path and labels that
> fallback explicitly in its output.

## Flutter / Dart examples

The 13 `examples/flutter/<id>.dart` programs run with the pure Dart SDK (no Flutter engine required). Run `dart pub get` in `examples/flutter`, then set `VELLUM_API_BASE`, `VELLUM_PROJECT_ID` and `VELLUM_API_KEY` in the environment. The examples also accept compile-time defines. `scripts/run-dart-examples.mjs` runs them against disposable PostgreSQL-backed fixtures in CI and revokes temporary API keys.

## Safety notes

- No example logs raw API keys, bearer tokens, emails, passwords, or database URLs.
- Each run uses a unique prefix so repeated runs never collide, and all created
  documents, indexes and minted keys are deleted in `cleanup()`.
- The `rules` example restores the previously active ruleset even on failure.
