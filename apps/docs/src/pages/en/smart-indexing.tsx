import {
  Callout,
  CodeTabs,
  Doc,
  P,
  PageLink,
  Section,
  Table,
  UL,
} from "../../ui";

export default function Page() {
  return (
    <Doc
      eyebrow="Core concepts"
      title="Smart Indexing &amp; Performance"
      description="The automatic E/S/R (Equality → Sort → Range) index advisor, response headers, one-click console deep links, SDK deduplication, and bounded in-process caches."
    >
      <P>
        Designing composite indexes by hand is error-prone when queries combine multiple equality
        filters, range bounds, and sort orders. VELLUM ships an automatic{" "}
        <strong>E/S/R Index Advisor</strong> built into <code>@vellum/core</code> and wired into
        both the API response headers and the TypeScript/Flutter SDKs.
      </P>

      <Section id="esr-rule" title="The E/S/R ordering rule">
        <P>
          Whenever a query runs without an optimal composite index—or triggers{" "}
          <code>INDEX_REQUIRED</code>—the advisor synthesizes the minimal composite index definition
          following the canonical B-Tree E/S/R rule:
        </P>
        <Table
          head={["Position", "Clause Class", "Why It Goes Here"]}
          rows={[
            [
              <strong>1. E — Equality</strong>,
              <><code>==</code> filters (canonicalized alphabetically)</>,
              "Narrows the B-Tree scan to a single contiguous prefix. Matching is commutative at runtime.",
            ],
            [
              <strong>2. S — Sort</strong>,
              <><code>orderBy</code> fields (excluding the implicit documentId tie-breaker)</>,
              "Allows PostgreSQL to stream results in final order with zero in-memory sort step.",
            ],
            [
              <strong>3. R — Range</strong>,
              <><code>&lt;</code>, <code>&lt;=</code>, <code>&gt;</code>, <code>&gt;=</code>,{" "}<code>!=</code></>,
              "Bounds the tail of the B-Tree slice without invalidating the preceding equality prefix.",
            ],
          ]}
        />
      </Section>

      <Section id="advisor-headers" title="Response headers &amp; one-click deep links">
        <P>
          When the server detects a missing or suboptimal index, it attaches two non-blocking
          headers to the HTTP response without failing the request:
        </P>
        <UL
          items={[
            <>
              <code>x-vellum-index-suggestion</code>: JSON payload containing the deterministic{" "}
              <code>fingerprint</code>, <code>collectionPath</code>, recommended{" "}
              <code>fields</code> array, and human-readable <code>reason</code>.
            </>,
            <>
              <code>x-vellum-index-url</code>: A deep link straight into the VELLUM Console&apos;s
              Index Builder with the collection and E/S/R fields pre-populated for one-click
              creation.
            </>,
          ]}
        />
      </Section>

      <Section id="sdk-integration" title="SDK advisor hooks &amp; deduplication">
        <P>
          Both <code>@vellumdb/sdk-js</code> and <code>vellum_flutter</code> inspect{" "}
          <code>x-vellum-index-*</code> headers automatically, deduplicate suggestions by{" "}
          <code>fingerprint</code> so each missing index is logged only once per process, and redact
          any accidental secrets before printing.
        </P>

        <CodeTabs
          tabs={[
            {
              label: "TypeScript (@vellumdb/sdk-js)",
              lang: "ts",
              code: `import { createClient } from "@vellumdb/sdk-js";

const db = createClient({
  endpoint: "https://api.example.com",
  projectId: process.env.VELLUM_PROJECT_ID!,
  apiKey: process.env.VELLUM_API_KEY!,
  warnOnMissingIndexes: process.env.NODE_ENV !== "production",
  onIndexSuggestion(suggestion) {
    telemetry.record("vellum.missing_index", {
      fingerprint: suggestion.fingerprint,
      collectionPath: suggestion.collectionPath,
      url: suggestion.url,
    });
  },
});`,
            },
            {
              label: "Flutter / Dart (vellum_flutter)",
              lang: "dart",
              code: `final db = VellumClient(
  endpoint: 'https://api.example.com',
  projectId: projectId,
  apiKey: apiKey,
  warnOnMissingIndexes: kDebugMode,
  onIndexSuggestion: (VellumIndexSuggestion suggestion) {
    logger.warning(
      'Missing index \${suggestion.fingerprint}: \${suggestion.url}',
    );
  },
);`,
            },
          ]}
        />
      </Section>

      <Section id="bounded-caches" title="Bounded caches &amp; Zero-Redis invalidation">
        <P>
          To keep p99 latency low without introducing Redis, VELLUM pairs bounded in-process LRU
          caches on the server (<code>indexDefHashCache</code>, <code>splitPathCache</code>, API key
          cache, ruleset cache) with PostgreSQL <code>pg_notify</code> invalidation across API
          replicas. On the client side, <code>@vellumdb/sdk-js</code> offers{" "}
          <code>BoundedReadCache</code> (default <code>ttlMs: 30_000</code>,{" "}
          <code>maxEntries: 1_000</code>) with O(1) per-path invalidation on writes and realtime
          mutations, plus single-flight read coalescing (<code>dedupeReads</code> in JS,{" "}
          <code>coalesceInFlightGets</code> in Flutter).
        </P>
        <Callout tone="success" title="Zero silent drift on invalidation">
          If a remote <code>pg_notify</code> publish fails during key revocation or ruleset
          publishing, the server still invalidates its local cache immediately and surfaces the
          error—never leaving stale credentials cached.
        </Callout>
        <P>
          Next: learn how <PageLink slug="indexes">Composite Indexes</PageLink> execute these plans,
          or inspect <PageLink slug="sdks/javascript">TypeScript SDK caching options</PageLink>.
        </P>
      </Section>
    </Doc>
  );
}
