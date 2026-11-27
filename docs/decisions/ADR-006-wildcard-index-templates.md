# ADR-006: Wildcard Collection Templates in the Index Advisor (Deferred to 0.0.10)

## Status
Accepted (deferral with implementation plan)

## Context
The 0.0.9 remediation (P1-3) observed that `x-vellum-index-suggestion` emits the
**concrete subcollection instance path** (e.g. `collectionPath: "chats/chat_123/messages"`),
so a one-click Console suggestion only indexes a single parent document's subcollection.
Collections crossing 50,000 documents fail unindexed `orderBy` / `text_search` with
`FAILED_PRECONDITION`, which requires reusable wildcard composite and full-text index
templates (`chats/*/messages`) to scale.

The 0.0.9 plan scoped P1-3 as: implement wildcard index templates **if provably safe,
otherwise record an ADR plus an implementation plan**. This ADR records that decision.

## Decision
**Defer wildcard index templates to 0.0.10.** The sign-up rate-limit and CORS portions
of P1-3 shipped in 0.0.9; the index-template portion is not provably safe to ship in the
same pass, for these reasons:

1. **Coverage correctness is load-bearing.** An index suggestion that the Console turns
   into an index record must actually cover the queries that triggered it. Today the
   whole pipeline keys on the exact collection path string:
   - the advisor's coverage check (`index.collectionPath !== collectionPath`),
   - the index builder's backfill scan (`WHERE collection_path = $2`),
   - the per-collection in-memory index cache (`indexesByCollection`),
   - the query compiler's index selection and `maxScanRows` enforcement.
   Emitting `chats/*/messages` without changing all four together would create an index
   whose backfill scan matches zero rows and whose coverage check never fires: queries
   would keep failing while the Console shows a "ready" index. That is a silent
   availability regression, worse than the current explicit `FAILED_PRECONDITION`.
2. **The change is cross-layer.** Advisor canonicalization, coverage matching, the
   backfill builder (segment-pattern matching instead of string equality), the query
   compiler's index selection, cache invalidation keys, the Console accept flow, SDK
   suggestion types, and migration semantics for already-created concrete indexes all
   move together. Partial shipment is exactly the unsafe case above.
3. **Acceptance requires >50k-document end-to-end benchmarks**, which per project policy
   run only against throwaway databases on the new Neon project. Those were not
   available inside the 0.0.9 remediation window.

## Implementation plan (0.0.10)
1. **Canonicalization (advisor):** derive the template from a collection path by
   replacing every dynamic document-id segment with `*`. Path segments alternate
   collection/document starting with a collection, so every odd-indexed segment of a
   nested path becomes `*` (`chats/chat_123/messages` → `chats/*/messages`). The
   suggestion payload, fingerprint and dashboard deep link use the template; the
   concrete instance path is kept as metadata for display.
2. **Template-aware coverage:** an index record whose `collectionPath` is a template
   covers a query when the query's concrete path matches segment-wise (`*` matches one
   segment). Concrete-path index records keep exact-match semantics. Matching is pure
   and deterministic; no SQL wildcards reach the compiler.
3. **Builder and compiler:** the backfill scan matches documents whose collection path
   matches the template segment-wise (segments are stored split, so this stays indexed
   and sargable); the query compiler selects template indexes with the same match; the
   in-memory cache keys on the template and invalidates on template-aware create/delete.
4. **Migration:** existing concrete indexes are untouched and keep working; the Console
   gains an optional "generalize to template" action that creates the template index and
   only then offers to drop redundant concrete ones.
5. **Text search:** full-text index templates follow the same canonicalization, added
   behind the same template-matching machinery.
6. **Benchmarks:** >50k-document subcollection benchmark (unindexed `FAILED_PRECONDITION`
   before, indexed p50/p95 after) on a throwaway Neon database, per the benchmarking
   policy, before the feature ships.

## Consequences

### Positive
- No risk of a "ready" index that covers nothing; failures stay loud and explicit.
- The 0.0.9 sign-up-limit and CORS fixes were not held back by the index work.
- The plan above is reviewable and sized before implementation starts.

### Negative
- Multi-tenant subcollections still need one index per parent document until 0.0.10;
  the `FAILED_PRECONDITION` error message and suggestion deep link remain the
  mitigation.
