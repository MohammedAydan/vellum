# Flutter SDK full-platform stress project

This is a separate Dart test project using `vellum_flutter` by local path. It runs against the real Node API, real RFC 6455 WebSockets, and fresh PostgreSQL control/data databases. No in-memory platform or HTTP mock is used by this project.

## Run

Requirements: Node 22+, pnpm, Dart 3.4+, Python 3, PostgreSQL server binaries (`initdb`, `pg_ctl`) and `psql`. Run as an unprivileged user, not root.

```sh
pnpm install --frozen-lockfile
bash tests/flutter-stress/run-local.sh
```

`PG_BIN` can name a PostgreSQL server bin directory. `DART_BIN` can name a Dart executable. A previously built checkout can use `VELLUM_STRESS_SKIP_BUILD=1`; default is to build dependencies first.

The script creates a fresh temporary cluster, binds it to loopback, applies all migrations, starts the API on an ephemeral local port, runs the tests, stops PostgreSQL and removes the temporary directory on exit. Test auth tokens, keys and passwords are disposable local fixtures, never production credentials. Test passwords are intentionally not secret.

The TypeScript runner refuses non-loopback database hosts and databases without `flutter` in the name. It overrides direct/runtime/listener database routes so inherited app URLs cannot target another database. The Dart suite refuses any origin other than `http://127.0.0.1`. Do not point this at production or a shared database.

Allow roughly 70 seconds for tests after build/migrations. One realtime case intentionally waits past the original JWT's 60-second expiry. First dependency build adds time.

## Coverage, 44 real-platform cases

- CRUD, merge, upsert, duplicate/missing documents, version preconditions and deletes.
- Unicode/URL-sensitive IDs, subcollections, tagged int64/reference/bytes/geopoint values and atomic field operations.
- TTL expiration in point reads and queries.
- Sequential and eight-way concurrent idempotent create; replay across auth token rotation.
- Chunked batches, atomic rollback, callback abort, eight contending OCC transactions and typed converters.
- Numeric and negative sorting, multi-page cursor traversal without gaps/duplicates, secondary sort with a composite index, projection, filters, OR, aggregates and invalid cursors.
- Signup with endpoint + projectId + displayName, profile metadata, login/logout, password errors, duplicate signup, anonymous auth and session restoration.
- TOTP enrollment/confirmation/challenge, recovery code, invalid code, twelve-way refresh single flight, invalid reset/verification/OAuth paths.
- Owner-only security rules, cross-user denial, include redaction, references, include, reverse lookup pagination, restrict/set_null/cascade rules.
- Collection registry create/update/list/import/export/clear/delete and filtered bulk deletion.
- Live document/query streams, stream multiplexing/cancellation/disposal, token rotation continuity past old JWT expiry, composite index backfill parity and invalid API keys.

OCC workers use separate locally issued keys so normal per-key rate limits do not confound the conflict test. Rate-limit/retry behavior is covered by the SDK's existing unit tests; this project does not bypass the platform's limiter.

## Verified on this branch

- All 44 real-platform cases passed against a fresh disposable PostgreSQL 17 cluster, with all 27 migrations.
- Flutter SDK: 162 unit/regression tests passed and analyzer reported no issues.
- Backend API/storage/query focused suite: 156 tests passed across 18 files; API TypeScript typecheck passed.

## Limits

This is not proof that every possible feature and failure mode is correct. It does not verify email delivery through an external provider, successful third-party OAuth, Flutter widget/device rendering, network partitions/load at production scale, billing, or every PostgreSQL version. The SDK is pure Dart, so these tests run on Dart VM without a Flutter device. Invalid reset/verification/OAuth paths are exercised, but successful externally delivered email-token flows are not.

## Bugs exposed and fixed

1. Unindexed numeric ORDER BY used text comparison, producing `0,1,10,...,2`. Query ordering and keyset cursor seeks now use matching typed JSONB keys, including tagged int64.
2. HTTP mutations ignored Idempotency-Key. Mutation routes now pass scoped replay keys to the engine. PostgreSQL serializes first-use replay keys with a transaction advisory lock so simultaneous retries do not race.
3. Replay identity originally changed with the bearer token. It now uses the verified API key ID and end-user UID so normal token rotation does not reapply writes.
4. Collection export discarded limit/cursor. The route now forwards both.
5. Flutter auth token rotation left active WebSockets using old credentials. It now reauthenticates and restores active subscriptions without discarding stream listeners.
