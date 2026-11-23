# VELLUM — Comprehensive Verification Report

Generated: 2026-11-18T19:39:38.750795

- Endpoint: `http://127.0.0.1:8080`
- Project: `aa286272-1de6-4102-8ee3-f3ee169c310b`
- API key: `pk_d••••3CcS`
- Wall time: 16.36 s

## Summary

| Metric | Value |
| --- | --- |
| Total | 55 |
| Passed | 55 |
| Failed | 0 |

## Feature matrix

| Area | Pass / Total |
| --- | --- |
| Connection | 2/2 |
| Setup | 1/1 |
| CRUD | 7/7 |
| Query | 11/11 |
| Realtime | 2/2 |
| Batch | 2/2 |
| Transactions | 1/1 |
| Subcollections | 1/1 |
| Errors | 4/4 |
| End-user auth | 8/8 |
| Authorization | 16/16 |

## Failures

None. All checks passed against the live backend.

## Details

### Connection

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | health/live responds 200 | HTTP 200 | 109 |
| PASS | health/ready responds 200 | HTTP 200 | 279 |

### Setup

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | Seed 5 query fixture documents | Seeded 5 documents in auto_1795030762393_q | 1362 |

### CRUD

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | set() creates a document | Created test/auto_1795030762393_crud | 427 |
| PASS | get() reads the created document | Fields match | 159 |
| PASS | set() replaces the whole document | Replace semantics verified | 423 |
| PASS | set(merge: true) preserves other fields | Merge preserved unrelated fields | 848 |
| PASS | update() patches a single field | Atomic patch applied | 424 |
| PASS | get() on a missing document returns null | NOT_FOUND normalised to null | 161 |
| PASS | delete() removes a document | Deleted | 664 |

### Query

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | where == matches the seeded category | 5 matching documents | 193 |
| PASS | where > (item_price > 25) | 3 matching documents | 192 |
| PASS | where >= (item_price >= 30) | 3 matching documents | 191 |
| PASS | where < (item_price < 30) | 2 matching documents | 191 |
| PASS | where <= (item_price <= 20) | 2 matching documents | 192 |
| PASS | where != (item_price != 30) | 4 matching documents | 190 |
| PASS | where in ([10, 30]) | 2 matching documents | 191 |
| PASS | orderBy ascending | ascending: [10.0, 20.0, 30.0, 40.0, 50.0] | 189 |
| PASS | orderBy descending | descending: [50.0, 40.0, 30.0, 20.0, 10.0] | 191 |
| PASS | limit(3) | 3 documents | 186 |
| PASS | startAfter cursor pagination | 2 + 2 non-overlapping documents | 373 |

### Realtime

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | snapshots() emits an initial event | Initial snapshot with 5 doc(s) | 427 |
| PASS | snapshots() detects a real write | Received 1 update event(s) after write | 625 |

### Batch

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | batchWrite() commits two sets | 2 documents written atomically | 637 |
| PASS | batchWrite() commits a delete | Deleted via batch | 398 |

### Transactions

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | runTransaction() increments a counter | counter 0 -> 1 -> 2 | 1514 |

### Subcollections

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | nested path is routed and rules are enforced | Nested write denied by rules (403) | 159 |

### Errors

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | invalid API key is rejected | Rejected: UNAUTHENTICATED (HTTP 401) | 4 |
| PASS | unknown project is rejected | Rejected: NOT_FOUND (HTTP 404) | 5 |
| PASS | empty document id is rejected | Rejected: INVALID_DOCUMENT_PATH | 0 |
| PASS | unreachable endpoint throws | Threw: ClientException with SocketException: Connection refused (OS Error: Connection refused, errno = 111), address = 127.0.0.1, port = 54140, uri=http://127.0.0.1:1/v1/projects/aa286272-1de6-4102-8ee3-f3ee169c310b/query | 3 |

### End-user auth

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | sign-up with email + password | User 6436fe75-6da2-4d97-9b46-c0e53e9e2384 created | 1238 |
| PASS | wrong password is rejected | Rejected: UNAUTHENTICATED | 361 |
| PASS | sign-in with correct password | Session issued for 6436fe75-6da2-4d97-9b46-c0e53e9e2384 | 990 |
| PASS | forced token refresh issues new tokens | Access token rotated | 476 |
| PASS | get profile requires the bearer token | Profile: verify_1795030762393@vellum.dev | 161 |
| PASS | update profile persists | displayName updated | 579 |
| PASS | end-user JWT is accepted on the document plane | Authenticated document read OK | 158 |
| PASS | sign-out clears local session | Signed out | 313 |

### Authorization

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | public JWKS endpoint is reachable without a key | 1 public key(s) | 4 |
| PASS | publishable key can read documents | Read 1 document(s) | 185 |
| PASS | missing API key is rejected | Rejected: HTTP 401 | 2 |
| PASS | invalid API key is rejected at HTTP layer | Rejected: HTTP 401/UNAUTHENTICATED | 2 |
| PASS | cross-project key reuse is rejected | Rejected: HTTP 404/NOT_FOUND | 2 |
| PASS | forged HS256 user token is rejected (EdDSA-only plane) | Rejected: HTTP 401/UNAUTHENTICATED | 3 |
| PASS | console sign-in issues customer_console realm token | realm=customer_console | 100 |
| PASS | admin login issues super_admin realm token | realm=super_admin | 101 |
| PASS | console token is accepted by console API | HTTP 200 | 3 |
| PASS | admin token is accepted by admin API | HTTP 200 | 157 |
| PASS | console token is rejected by admin API | Rejected: HTTP 401/UNAUTHENTICATED | 3 |
| PASS | admin token is rejected by console API | Rejected: HTTP 401/UNAUTHENTICATED | 3 |
| PASS | control tokens are rejected by document plane | Both control-plane realms rejected without an API key | 7 |
| PASS | console session refresh rotates tokens | Console access token rotated | 182 |
| PASS | admin session refresh rotates tokens | Admin access token rotated | 179 |
| PASS | refresh cookies are realm-isolated | vellum_console_rt vs vellum_admin_rt | 200 |
