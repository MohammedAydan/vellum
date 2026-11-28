# ADR-006: Wildcard Collection Templates for Composite Indexes (Shipped in 0.0.9)

## Status
Accepted and shipped in 0.0.9 (supersedes the earlier deferral recorded in this file)

## Context
The 0.0.9 remediation (P1-3) observed that `x-vellum-index-suggestion` emitted the
**concrete subcollection instance path** (e.g. `collectionPath: "chats/chat_123/messages"`),
so a one-click Console suggestion only indexed a single parent document's subcollection.
Collections crossing 50,000 documents fail unindexed scan-risk queries with
`FAILED_PRECONDITION`, which requires reusable wildcard composite index templates
(`chats/*/messages`) to scale across tenants.

An earlier revision of this ADR deferred the work to 0.0.10 on safety grounds: coverage
correctness is load-bearing, the change is cross-layer, and acceptance required
>50k-document end-to-end benchmarks on a throwaway database. The project owner then
ruled that there is no 0.0.10 and every fix ships in 0.0.9. This revision records the
design as implemented, benchmarked and shipped.

## Decision
Ship wildcard collection templates across all four layers at once, exactly the
"unsafe if partial" surface the deferral called out:

1. **Canonicalization (`packages/core/src/index-templates.ts`).**
   `canonicalizeCollectionPathToTemplate` replaces every dynamic document-id segment
   with `*`. Path segments alternate collection/document starting with a collection,
   so every even-indexed (1-based: odd) segment of a nested path becomes `*`
   (`chats/chat_123/messages` -> `chats/*/messages`). `isTemplateCollectionPath`,
   `parseIndexCollectionPath` and `indexCollectionPathCovers` (segment-wise match,
   `*` matches exactly one segment, pure and deterministic, no SQL wildcards) are
   shared by every layer.

2. **Advisor.** Coverage checks use `indexCollectionPathCovers`, so a ready template
   index suppresses suggestions for every concrete path it covers. Emitted suggestions
   carry the canonical template as `collectionPath` and keep the concrete instance
   path as `exampleCollectionPath` metadata for display; the suggestion fingerprint
   is computed over the template so repeat hits across different parents dedupe.
   `decodeSuggestPayload` round-trips the new field.

3. **Builder (backfill).** The PG and Neon index-builder workers match documents
   segment-wise via the shared `buildCollectionPathMatchSql` helper (split_part
   equality per segment with bind parameters, no LIKE), and paginate the backfill on
   the **(collection_path, document_id) tuple**: document ids repeat across concrete
   paths under a template, so document_id alone is an ambiguous resume key. Each
   entry stores its document's concrete collection path.

4. **Compiler.** `selectCompositeIndexForQuery` matches template indexes with the same
   segment-wise coverage and prefers an exact-path index at equal width (narrower
   blast radius if a template is ever dropped). The compiled SQL pushes
   `ie.collection_path = $2` into the entry scan, so template-backed queries take a
   direct primary-key range scan instead of scanning every entry in the index.

5. **Entry storage key (found by the acceptance benchmark).**
   `document_index_entries` originally primary-keyed on
   `(index_id, sort_key, document_id)`. Under a template, different concrete paths
   legitimately repeat the same `(sort_key, document_id)` pair, and
   `ON CONFLICT DO NOTHING` silently dropped entries: the 84k-document benchmark
   backfilled only 60,000 entries and still reported `ready`. Data migration 0017
   re-keys the table on `(index_id, collection_path, sort_key, document_id)` and the
   insert target and memory-adapter entry keys follow. Read-side cursors needed no
   change: every query is scoped to one concrete collection path, so
   `(sort_key, document_id)` remains unique within any result set.

6. **Cache invalidation.** Index create/delete clears the whole per-transaction
   index cache; template entries would otherwise leave stale per-collection entries
   behind.

7. **Console and API.** The Console index-create route parses paths with
   `parseIndexCollectionPath` and accepts templates. The dashboard indexes page shows
   a template badge, the concrete `exampleCollectionPath` on suggestions, and a
   per-index "generalize to template" action that creates the template index from a
   nested concrete one and only then offers to drop the redundant concrete index.
   The v2 recommendation recorder records the template path.

## Migration of existing indexes
Existing concrete indexes are untouched and keep working (concrete-path records keep
exact-match semantics, and the compiler prefers them at equal width). Generalization
to a template is an explicit, optional Console action that creates the template index
first and never drops the concrete index automatically.

## Acceptance benchmark (throwaway Postgres 18.7, 84,000 documents)
`tests/load/track5-template-index-bench.ts` seeds one 60,000-message chat plus 60
chats of 400 messages and asserts end to end:
- unindexed `orderBy` on the 60k subcollection fails `FAILED_PRECONDITION` and the
  suggestion carries the canonical template `chats/*/messages`;
- an under-cap subcollection is still served unindexed (behavior unchanged);
- template backfill of all 84,000 entries reaches `ready` in ~13.5s
  (pre-0017 it reached `ready` with 60,000 entries; the benchmark caught it);
- indexed `orderBy` on the 60k chat: p50 2.1ms, p95 5.3ms; on another chat under
  the same template: p50 2.8ms, p95 10.0ms, both served by the template index;
- a document written after the backfill into a chat the backfill never saw is
  indexed by the write path and served from the template index.

## Consequences

### Positive
- One template index covers every tenant subcollection of a shape; multi-tenant apps
  no longer need one index per parent document.
- Failures stay loud: anything a template does not cover still fails
  `FAILED_PRECONDITION` with a template suggestion.
- Backfill and write-path maintenance are lossless under repeated document ids.

### Negative / follow-ups
- Full-text (search) index templates are not part of this change; composite templates
  only. Search suggestions still emit concrete paths.
- A dropped template can strand many tenants at once; mitigated by the compiler's
  exact-path preference and by keeping generalization an explicit action.
