# ADR-002: Dual-Mode OCC Interactive Transaction State

## Status
Accepted

## Context
Specification Section 8.2 requires an interactive transaction protocol (`beginTransaction` → reads → `commit`). Holding open PostgreSQL database transactions across untrusted client network round trips would cause connection pool exhaustion, transaction timeout errors, and denial-of-service risks under multi-tenant workloads.

The specification specifies Optimistic Concurrency Control (OCC) where client reads accumulate an observed `(path, version)` read-set, which is verified under row lock (`SELECT ... FOR UPDATE`) during atomic commit. The open question was how to store and verify the intermediate transaction state across ephemeral serverless or multi-instance deployments.

## Decision
We implement a **Dual-Mode OCC Transaction State Model**:
1. `beginTransaction` generates an opaque, HMAC-SHA256 signed `transactionToken` encoding:
   ```json
   {
     "txId": "tx_01J...",
     "projectId": "<uuid>",
     "projectId": "<uuid>",
     "startedAtMs": 1794753000000,
     "expiresAtMs": 1794753005000
   }
   ```
2. The active read-set is tracked in a fast, short-lived ephemeral cache (in-memory `Map` with 5-second TTL on single instance, or Redis `SETEX` key `occ:tx:{txId}` when Redis is configured).
3. On `commit`:
   - The token signature and expiration (`MAX_TRANSACTION_DURATION_MS = 5000ms`) are verified.
   - Target documents in the read-set are locked via PostgreSQL `SELECT path, version FROM documents WHERE ... FOR UPDATE`.
   - If any locked row's `version` has mutated since read time, the engine immediately aborts with `ABORTED_CONFLICT (409)`.
   - Otherwise, all writes are applied, `document_index_entries` updated, `realtime_outbox` inserted, and the transaction commits atomically.
4. Client SDKs (`@vellumdb/sdk-js` and `vellum_flutter`) must implement automatic exponential backoff retry on receiving `ABORTED_CONFLICT`.

## Consequences

### Positive
- PostgreSQL connections are held for only single-digit milliseconds during the final atomic `commit` phase, preventing connection pool starvation.
- Immune to dropped WebSocket or HTTP connections while clients execute intermediate application logic.
- Redis clustering allows horizontal scalability of API instances without sticky sessions.

### Negative / Trade-offs
- High-contention write workloads on identical document keys will trigger retries. However, document database best practices avoid hotspot single-document bottlenecks.
- Read-sets expire strictly after 5,000 ms; long client computations within a transaction will be rejected with `TRANSACTION_TIMEOUT`.
