# VELLUM — Comprehensive Verification Report

Generated: 2026-11-18T19:38:56.061870

- Endpoint: `https://feof-highland-having-moscow.trycloudflare.com`
- Project: `aa286272-1de6-4102-8ee3-f3ee169c310b`
- API key: `pk_d••••3CcS`
- Wall time: 20.85 s

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
| PASS | health/live responds 200 | HTTP 200 | 386 |
| PASS | health/ready responds 200 | HTTP 200 | 424 |

### Setup

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | Seed 5 query fixture documents | Seeded 5 documents in auto_1795030715214_q | 1723 |

### CRUD

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | set() creates a document | Created test/auto_1795030715214_crud | 547 |
| PASS | get() reads the created document | Fields match | 230 |
| PASS | set() replaces the whole document | Replace semantics verified | 501 |
| PASS | set(merge: true) preserves other fields | Merge preserved unrelated fields | 1037 |
| PASS | update() patches a single field | Atomic patch applied | 497 |
| PASS | get() on a missing document returns null | NOT_FOUND normalised to null | 236 |
| PASS | delete() removes a document | Deleted | 831 |

### Query

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | where == matches the seeded category | 5 matching documents | 245 |
| PASS | where > (item_price > 25) | 3 matching documents | 229 |
| PASS | where >= (item_price >= 30) | 3 matching documents | 227 |
| PASS | where < (item_price < 30) | 2 matching documents | 226 |
| PASS | where <= (item_price <= 20) | 2 matching documents | 214 |
| PASS | where != (item_price != 30) | 4 matching documents | 215 |
| PASS | where in ([10, 30]) | 2 matching documents | 221 |
| PASS | orderBy ascending | ascending: [10.0, 20.0, 30.0, 40.0, 50.0] | 221 |
| PASS | orderBy descending | descending: [50.0, 40.0, 30.0, 20.0, 10.0] | 217 |
| PASS | limit(3) | 3 documents | 218 |
| PASS | startAfter cursor pagination | 2 + 2 non-overlapping documents | 448 |

### Realtime

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | snapshots() emits an initial event | Initial snapshot with 5 doc(s) | 526 |
| PASS | snapshots() detects a real write | Received 1 update event(s) after write | 719 |

### Batch

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | batchWrite() commits two sets | 2 documents written atomically | 836 |
| PASS | batchWrite() commits a delete | Deleted via batch | 461 |

### Transactions

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | runTransaction() increments a counter | counter 0 -> 1 -> 2 | 1889 |

### Subcollections

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | nested path is routed and rules are enforced | Nested write denied by rules (403) | 197 |

### Errors

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | invalid API key is rejected | Rejected: UNAUTHENTICATED (HTTP 401) | 45 |
| PASS | unknown project is rejected | Rejected: NOT_FOUND (HTTP 404) | 44 |
| PASS | empty document id is rejected | Rejected: INVALID_DOCUMENT_PATH | 0 |
| PASS | unreachable endpoint throws | Threw: ClientException with SocketException: Connection refused (OS Error: Connection refused, errno = 111), address = 127.0.0.1, port = 49236, uri=http://127.0.0.1:1/v1/projects/aa286272-1de6-4102-8ee3-f3ee169c310b/query | 7 |

### End-user auth

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | sign-up with email + password | User 294e27da-854b-4dd5-bd82-ad04af18812d created | 1314 |
| PASS | wrong password is rejected | Rejected: UNAUTHENTICATED | 408 |
| PASS | sign-in with correct password | Session issued for 294e27da-854b-4dd5-bd82-ad04af18812d | 977 |
| PASS | forced token refresh issues new tokens | Access token rotated | 490 |
| PASS | get profile requires the bearer token | Profile: verify_1795030715214@vellum.dev | 240 |
| PASS | update profile persists | displayName updated | 582 |
| PASS | end-user JWT is accepted on the document plane | Authenticated document read OK | 205 |
| PASS | sign-out clears local session | Signed out | 349 |

### Authorization

| Result | Check | Detail | ms |
| --- | --- | --- | --- |
| PASS | public JWKS endpoint is reachable without a key | 1 public key(s) | 110 |
| PASS | publishable key can read documents | Read 1 document(s) | 213 |
| PASS | missing API key is rejected | Rejected: HTTP 401 | 32 |
| PASS | invalid API key is rejected at HTTP layer | Rejected: HTTP 401/UNAUTHENTICATED | 31 |
| PASS | cross-project key reuse is rejected | Rejected: HTTP 404/NOT_FOUND | 23 |
| PASS | forged HS256 user token is rejected (EdDSA-only plane) | Rejected: HTTP 401/UNAUTHENTICATED | 65 |
| PASS | console sign-in issues customer_console realm token | realm=customer_console | 140 |
| PASS | admin login issues super_admin realm token | realm=super_admin | 153 |
| PASS | console token is accepted by console API | HTTP 200 | 78 |
| PASS | admin token is accepted by admin API | HTTP 200 | 646 |
| PASS | console token is rejected by admin API | Rejected: HTTP 401/UNAUTHENTICATED | 27 |
| PASS | admin token is rejected by console API | Rejected: HTTP 401/UNAUTHENTICATED | 36 |
| PASS | control tokens are rejected by document plane | Both control-plane realms rejected without an API key | 85 |
| PASS | console session refresh rotates tokens | Console access token rotated | 265 |
| PASS | admin session refresh rotates tokens | Admin access token rotated | 242 |
| PASS | refresh cookies are realm-isolated | vellum_console_rt vs vellum_admin_rt | 276 |
