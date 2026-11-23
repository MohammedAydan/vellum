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
      title="Query Engine"
      description="Parameterized SQL compilation over PostgreSQL JSONB and composite B-Tree indexes—covering all 13 operators, disjunctive OR groups, projections, and DoS guardrails."
    >
      <P>
        Every query sent to <code>POST /v1/projects/:projectId/query</code> is validated by{" "}
        <code>@vellum/query-engine</code> and compiled into a single parameterized PostgreSQL query
        executed inside the tenant&apos;s RLS transaction. No operator is ever silently degraded to{" "}
        <code>TRUE</code>, and no PostgreSQL query path loads an entire collection into Node.js
        memory to filter client-side.
      </P>

      <Section id="operators" title="All 13 filter operators">
        <Table
          head={["Operator", "Operand Type", "PostgreSQL Compilation &amp; Index Behavior"]}
          rows={[
            [
              <code>==</code>,
              "Any valid wire value",
              <>
                Native B-Tree on <code>document_id</code> / <code>created_at</code> /{" "}
                <code>updated_at</code>; GIN <code>d.data @&gt; $p::jsonb</code> for primitives;{" "}
                <code>d.data @&gt; $p::jsonb AND exact JSONB equality</code> for objects &amp;
                arrays.
              </>,
            ],
            [
              <code>!=</code>,
              "Any valid wire value",
              <>
                Non-null inequality on native system columns (<code>&lt;&gt;</code>) or JSONB field
                extraction; excludes missing fields.
              </>,
            ],
            [
              <code>&lt;</code>,
              "Finite number, string, tagged int64, or tagged timestamp",
              <>
                Native <code>timestamptz</code> or <code>COLLATE &quot;C&quot;</code> comparison on
                system columns; typed <code>::numeric</code> / <code>COLLATE &quot;C&quot;</code> on
                JSONB fields. <code>null</code> bounds are rejected with{" "}
                <code>INVALID_ARGUMENT</code>.
              </>,
            ],
            [<code>&lt;=</code>, "Finite number, string, int64, or timestamp", "Same typed range compilation as <."],
            [<code>&gt;</code>, "Finite number, string, int64, or timestamp", "Same typed range compilation as <."],
            [<code>&gt;=</code>, "Finite number, string, int64, or timestamp", "Same typed range compilation as <."],
            [
              <code>in</code>,
              "Non-empty array (max 30 values)",
              "Matches when the field equals any element in the array.",
            ],
            [
              <code>not-in</code>,
              "Non-empty array (max 30 values)",
              "Matches when the field exists and does not equal any element in the array.",
            ],
            [
              <code>array-contains</code>,
              "Single wire value",
              <>
                Compiles to GIN-accelerated containment{" "}
                <code>d.data @&gt; {`{"field": [value]}`}::jsonb</code>.
              </>,
            ],
            [
              <code>array-contains-any</code>,
              "Non-empty array (max 30 values)",
              <>
                Expands to ORed GIN <code>@&gt;</code> predicates, bounded by{" "}
                <code>MAX_TOTAL_DISJUNCTIVE_EXPANSIONS = 120</code> across the entire query.
              </>,
            ],
            [
              <code>contains_ci</code>,
              "String (max 1,024 chars)",
              <>
                Case-insensitive substring match via escaped SQL <code>ILIKE &apos;%…%&apos;</code>{" "}
                (<code>%</code>, <code>_</code>, and <code>\</code> in user input are escaped).
              </>,
            ],
            [
              <code>starts_with_ci</code>,
              "String (max 1,024 chars)",
              <>
                Case-insensitive prefix match via escaped SQL <code>ILIKE &apos;…%&apos;</code>.
              </>,
            ],
            [
              <code>text_search</code>,
              "String (max 1,024 chars)",
              "Tokenized full-text match compiled safely with bound parameters; rejects non-string operands.",
            ],
          ]}
        />
      </Section>

      <Section id="or-groups" title="Disjunctive OR groups">
        <P>
          In addition to top-level <code>where</code> clauses (which are ANDed together), queries
          accept an <code>or</code> array of clause groups. Each inner group is ANDed internally,
          and groups are ORed together: <code>(where) AND ((or[0]) OR (or[1]) OR ...)</code>.
        </P>

        <CodeTabs
          tabs={[
            {
              label: "TypeScript",
              lang: "ts",
              code: `const snap = await db
  .collection("tickets")
  .where("workspaceId", "==", "ws_42")
  .or([
    [
      { field: "status", op: "==", value: "urgent" },
      { field: "assignee", op: "==", value: "usr_alice" },
    ],
    [
      { field: "escalated", op: "==", value: true },
    ],
  ])
  .orderBy("updatedAt", "desc")
  .limit(25)
  .get();`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `final snap = await db
    .collection('tickets')
    .where('workspaceId', '==', 'ws_42')
    .or([
      [
        {'field': 'status', 'op': '==', 'value': 'urgent'},
        {'field': 'assignee', 'op': '==', 'value': 'usr_alice'},
      ],
      [
        {'field': 'escalated', 'op': '==', 'value': true},
      ],
    ])
    .orderBy('updatedAt', dir: 'desc')
    .limit(25)
    .get();`,
            },
          ]}
        />

        <P>
          Both <code>where</code> and each <code>or</code> group share the exact same validator:
          at most <code>10</code> clauses per group, at most <code>10</code> <code>or</code> groups,
          and at most <code>120</code> total <code>array-contains-any</code> expansions across the
          entire query. The <code>or</code> clauses are also hashed into the HMAC cursor shape so
          cursors cannot be replayed across different disjunctive predicates.
        </P>
      </Section>

      <Section id="projection" title="Field projection (select)">
        <P>
          Use <code>select</code> to return only specific top-level or nested dot-path fields. The
          compiler builds a server-side <code>jsonb_build_object(...)</code> projection so unused
          document blobs never cross the network.
        </P>
        <UL
          items={[
            <>
              <strong>Maximum fields:</strong> <code>MAX_SELECT_FIELDS = 50</code> (50 key-value
              pairs = 100 arguments, matching PostgreSQL&apos;s{" "}
              <code>jsonb_build_object</code> function argument cap). Duplicate paths are
              automatically deduplicated.
            </>,
            <>
              <strong>Maximum nesting depth:</strong> <code>MAX_FIELD_DEPTH = 16</code> dot-path
              segments on any <code>where</code>, <code>or</code>, <code>orderBy</code>, or{" "}
              <code>select</code> field.
            </>,
            <>
              <strong>Prototype-pollution guard:</strong> Any path segment equal to{" "}
              <code>__proto__</code>, <code>constructor</code>, or <code>prototype</code> is
              rejected immediately with <code>INVALID_ARGUMENT</code>.
            </>,
          ]}
        />
      </Section>

      <Section id="compilation-internals" title="Native timestamptz &amp; GIN+exact JSONB compilation">
        <P>
          The query compiler applies two critical PostgreSQL optimizations to preserve both
          correctness and index utilization:
        </P>

        <Table
          head={["Pattern", "Compiled SQL", "Why It Matters"]}
          rows={[
            [
              <>
                System timestamp filters (<code>createdAt</code>, <code>updatedAt</code>)
              </>,
              <code>d.updated_at &gt;= $p::timestamptz</code>,
              "Compares directly against native TIMESTAMPTZ columns so PostgreSQL uses the partial B-Tree indexes (idx_docs_collection_updated_active / idx_docs_collection_created_active).",
            ],
            [
              <>
                Primitive equality (<code>status == &quot;paid&quot;</code>)
              </>,
              <code>{`d.data @> '{"status":"paid"}'::jsonb`}</code>,
              "Directly hits the partial GIN index (idx_docs_data_gin_active USING GIN (data jsonb_path_ops)) with exact semantics for primitives.",
            ],
            [
              <>
                Object / array equality (<code>{`meta == { a: 1 }`}</code>)
              </>,
              <code>{`(d.data @> $lit::jsonb AND (d.data #> $path) = $exact::jsonb)`}</code>,
              <>
                Pairs the fast GIN <code>@&gt;</code> pre-filter with exact structural JSONB
                equality so <code>{`{ a: 1 }`}</code> never falsely matches{" "}
                <code>{`{ a: 1, b: 2 }`}</code> and <code>[1]</code> never matches{" "}
                <code>[1, 2]</code>.
              </>,
            ],
          ]}
        />

        <Callout tone="warning" title="Query complexity &amp; unindexed scan limits">
          Queries without a matching composite index are protected by{" "}
          <code>UNINDEXED_SCAN_CAP = 1000</code>, a <code>5,000 ms</code>{" "}
          <code>statement_timeout</code>, and a <code>4 MiB</code> response byte ceiling. For
          production sorting or multi-field filtering, create a{" "}
          <PageLink slug="indexes">composite index</PageLink> or follow the{" "}
          <PageLink slug="smart-indexing">Smart Indexing E/S/R advisor</PageLink>.
        </Callout>
      </Section>

      <Section id="limits-summary" title="Hardened query compiler constants">
        <Table
          head={["Constant", "Value", "Error on Breach"]}
          rows={[
            [<code>MAX_WHERE_CLAUSES</code>, "10 clauses (per where / or group)", <code>QUERY_TOO_COMPLEX</code>],
            [<code>MAX_DISJUNCTIVE_VALUES</code>, "30 values (in / not-in / array-contains-any)", <code>QUERY_TOO_COMPLEX</code>],
            [<code>MAX_TOTAL_DISJUNCTIVE_EXPANSIONS</code>, "120 total expansions per query", <code>QUERY_TOO_COMPLEX</code>],
            [<code>MAX_ORDER_BY_FIELDS</code>, "3 orderBy clauses (+ automatic documentId tie-breaker)", <code>QUERY_TOO_COMPLEX</code>],
            [<code>MAX_SELECT_FIELDS</code>, "50 projected fields", <code>QUERY_TOO_COMPLEX</code>],
            [<code>MAX_FIELD_DEPTH</code>, "16 dot-path segments", <code>INVALID_ARGUMENT</code>],
            [<code>MAX_TEXT_FILTER_LENGTH</code>, "1,024 characters for contains_ci / starts_with_ci / text_search", <code>QUERY_TOO_COMPLEX</code>],
            [<><code>DEFAULT_QUERY_LIMIT</code> / <code>MAX_QUERY_LIMIT</code></>, "50 default / 500 maximum docs per page", <code>LIMIT_EXCEEDED</code>],
          ]}
        />
      </Section>
    </Doc>
  );
}
