import {
  Callout,
  Code,
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
      title="Composite Indexes"
      description="Multi-tenant composite indexes stored as order-preserving BYTEA sort keys—with commutative equality-prefix matching and cost-ranked narrowest index selection."
    >
      <P>
        Creating dynamic DDL indexes per tenant in PostgreSQL causes catalog bloat and lock
        contention at scale. VELLUM instead stores tenant composite indexes as rows inside two
        RLS-protected tables: <code>document_indexes</code> (definitions &amp; lifecycle status) and{" "}
        <code>document_index_entries</code> (order-preserving <code>BYTEA</code> sort keys with
        primary key <code>(index_id, sort_key, document_id)</code>).
      </P>

      <Section id="sort-keys" title="Order-preserving BYTEA sort keys">
        <P>
          Every indexed field value is encoded by <code>@vellum/core</code> into a canonical{" "}
          <code>BYTEA</code> sequence whose unsigned byte order matches VELLUM&apos;s cross-type
          sort order (null &lt; boolean &lt; number/int64 &lt; timestamp &lt; string &lt; bytes &lt;
          reference &lt; geopoint). For <code>desc</code> fields, the encoded bytes are bitwise
          inverted so PostgreSQL can always execute a forward B-Tree Index Scan:{" "}
          <code>ORDER BY ie.sort_key ASC, ie.document_id ASC</code>.
        </P>
      </Section>

      <Section id="matching-algorithm" title="Commutative equality-prefix &amp; cost-ranked matching">
        <P>
          When compiling a query, <code>@vellum/query-engine</code> inspects all{" "}
          <code>status = &apos;ready&apos;</code> composite indexes for the target collection and
          applies a two-phase matcher:
        </P>

        <UL
          items={[
            <>
              <strong>1. Commutative equality-prefix matching:</strong> Leading equality predicates
              (<code>==</code>) can appear in <em>any</em> permutation at the front of the index. An
              index on <code>(tenantRegion ASC, status ASC, createdAt DESC)</code> satisfies both{" "}
              <code>where(status == &quot;open&quot;).where(tenantRegion == &quot;eu&quot;)</code>{" "}
              and{" "}
              <code>where(tenantRegion == &quot;eu&quot;).where(status == &quot;open&quot;)</code>—so
              you never need duplicate indexes for different filter orderings.
            </>,
            <>
              <strong>2. Ordered suffix matching:</strong> Immediately after the equality prefix,
              the index fields must match the query&apos;s range/sort suffix fields and directions
              (<code>asc</code> / <code>desc</code>) in exact order.
            </>,
            <>
              <strong>3. Cost-ranked narrowest index selection:</strong> If multiple ready indexes
              satisfy the query, the compiler computes <code>extraFields = idx.fields.length - requiredCount</code>{" "}
              and selects the narrowest index (fewest unused trailing fields), short-circuiting
              immediately when <code>extraFields === 0</code> (exact-width match).
            </>,
          ]}
        />

        <Callout tone="info" title="Why narrowest-index selection wins">
          Narrower composite indexes have smaller <code>BYTEA</code> sort keys, higher B-Tree fan-out
          per 8 KiB PostgreSQL page, and better buffer-pool residency. Cost-ranking prevents a wide
          5-field index from shadowing an exact 2-field index.
        </Callout>
      </Section>

      <Section id="lifecycle" title="Index lifecycle &amp; quotas">
        <Table
          head={["Status", "Used by Query Planner?", "Maintained on Writes?"]}
          rows={[
            [<code>building</code>, "No (backfilling existing documents)", "Yes (dual-written during backfill)"],
            [<code>ready</code>, "Yes (eligible for commutative & cost-ranked matching)", "Yes (atomically inside write transaction)"],
            [<code>failed</code>, "No (see error_message)", "No"],
            [<code>deleting</code>, "No", "No (entries cascaded via ON DELETE CASCADE)"],
          ]}
        />

        <Code
          lang="bash"
          title="Create a composite index via REST"
          code={`curl -X POST "https://api.example.com/v1/projects/$PROJECT_ID/indexes" \\
  -H "x-vellum-api-key: $VELLUM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "collectionPath": "orders",
    "fields": [
      { "path": "status", "direction": "asc" },
      { "path": "customerTier", "direction": "asc" },
      { "path": "totalCents", "direction": "desc" }
    ]
  }'`}
        />

        <P>
          Composite index quotas are <strong>50</strong> per project on Free plans and{" "}
          <strong>200</strong> per project on Pro plans (<code>MAX_COMPOSITE_INDEXES_FREE</code> /{" "}
          <code>MAX_COMPOSITE_INDEXES_PRO</code>). See{" "}
          <PageLink slug="smart-indexing">Smart Indexing &amp; the E/S/R Advisor</PageLink> to let
          VELLUM design optimal indexes automatically from live traffic.
        </P>
      </Section>
    </Doc>
  );
}
