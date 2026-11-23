# `tests/dart-verify` — real-backend verification harness

A framework-agnostic Dart harness that exercises the **live** VELLUM
backend (`apps/api` + PostgreSQL/Neon). Every check performs a real HTTP or
WebSocket call. There are no mocks, no simulated responses, no skips and no
hardcoded secrets. A Markdown report is generated and saved to disk.

## Coverage (55 checks)

| Area | Checks |
| --- | --- |
| Connection | `health/live`, `health/ready` |
| Setup | seeds five query fixtures |
| CRUD | create, read, replace, merge, patch, missing-document, delete |
| Query | `==`, `>`, `>=`, `<`, `<=`, `!=`, `in`, `orderBy` asc/desc, `limit`, HMAC cursor pagination |
| Realtime | initial `snapshots()` event, event after a real write |
| Batch | atomic multi-set, atomic delete |
| Transactions | OCC counter `0 → 1 → 2` |
| Subcollections | nested path routing and Security-Rules enforcement |
| Errors | invalid key, unknown project, empty id, unreachable endpoint |
| **End-user auth** | sign-up, wrong password, sign-in, forced refresh, profile read/update, authenticated document read, sign-out |
| **Authorization** | public JWKS, publishable-key read, missing/invalid key, cross-project key reuse, forged-HS256 rejection (EdDSA-only plane), three-realm tokens, realm cross-rejection, control tokens on document plane, console/admin refresh, refresh-cookie isolation |

## Run

From the repository root (use the portable toolchain if the host Dart is older
 than 3.4):

```bash
export PATH="$PWD/.tools/dart-sdk/bin:$PATH"
cd tests/dart-verify && dart pub get && cd ../..

dart run tests/dart-verify \
  --VELLUM_ENDPOINT=http://127.0.0.1:8080 \
  --VELLUM_PROJECT_ID=<project-uuid> \
  --VELLUM_API_KEY=pk_... \
  --VELLUM_REPORT=tests/dart-verify/VERIFICATION-REPORT.md
```

The same settings can be supplied as `VELLUM_*` environment variables instead
of CLI flags. `VELLUM_CONSOLE_EMAIL`, `VELLUM_CONSOLE_PASSWORD`,
`VELLUM_ADMIN_EMAIL` and `VELLUM_ADMIN_PASSWORD` override the test operators.

Exit code is `0` only when **every** check passes. The generated `.md` report
contains the summary, a per-area feature matrix, the failure list and a full
per-check detail table. Reports in this directory are the committed evidence:

- `VERIFICATION-REPORT.md` — against local `127.0.0.1:8080`
- `VERIFICATION-REPORT-PUBLIC.md` — against the public API tunnel
- `VERIFICATION-REPORT-GATEWAY.md` — against the unified single-origin gateway
