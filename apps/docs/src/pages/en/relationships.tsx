import {
  Api,
  Callout,
  Code,
  CodeTabs,
  Doc,
  H3,
  P,
  PageLink,
  Section,
  Table,
  UL,
} from "../../ui";

const includeJs = `const posts = await db
  .collection("posts")
  .where("published", "==", true)
  .include([
    "author",                          // shorthand → { field: "author" }
    {
      field: "editorId",
      collection: "users",
      as: "editor",
      select: ["name", "email"],
      include: [{ field: "avatarRef", as: "avatar" }],
    },
  ])
  .select("title", "authorRef", "createdAt")
  .limit(25)
  .get();

for (const post of posts.docs) {
  console.log(post.included?.["author"]); // resolved doc (or null)
  console.log(post.redactedRefs);         // keys hidden by rules
}`;

const includeDart = `final page = await client.collection('posts')
  .where('published', '==', true)
  .include([
    'author',
    VellumInclude(
      field: 'editorId',
      collection: 'users',
      as: 'editor',
      select: ['name', 'email'],
      include: [VellumInclude(field: 'avatarRef', as: 'avatar')],
    ),
  ])
  .select(['title', 'createdAt'])
  .limit(25)
  .get();`;

const includeRest = `curl -s -X POST \\
  "https://api.example.com/v1/projects/$PROJECT_ID/query" \\
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \\
  -d '{
    "collectionPath": "posts",
    "select": ["title", "authorRef"],
    "include": [
      { "field": "author" },
      { "field": "editorId", "collection": "users", "as": "editor",
        "select": ["name", "email"] }
    ],
    "limit": 25
  }'`;

const referencedByJs = `let cursor;
do {
  const page = await db.doc("users/u1").referencedBy({
    collection: "orders",
    field: "customerId",
    limit: 25,
    cursor,
  });
  for (const doc of page.documents) console.log(doc.path, doc.data());
  cursor = page.nextCursor ?? undefined;
} while (cursor !== undefined);`;

const referencedByDart = `var page = await client.collection('users').doc('u1').referencedBy(
  collection: 'orders',
  field: 'customerId',
  limit: 25,
);
while (page.nextCursor != null) {
  page = await client.collection('users').doc('u1').referencedBy(
    collection: 'orders',
    field: 'customerId',
    limit: 25,
    cursor: page.nextCursor,
  );
}`;

const aggregateJs = `const orders = db.collection("orders").where("status", "==", "paid");

const total  = await orders.count();
const revenue = await orders.sum("total");
const average = await orders.avg("total");
const largest = await orders.max("total");

const byStatus = await orders.aggregate({
  groupBy: ["status", "currency"],
  metrics: {
    orders:  { op: "count" },
    revenue: { op: "sum", field: "total" },
    average: { op: "avg", field: "total" },
  },
}); // → Array<{ status, currency, orders, revenue, average }>`;

const aggregateDart = `final orders = client.collection('orders').where('status', '==', 'paid');

final int total = await orders.count();
final num? revenue = await orders.sum('total');
final num? average = await orders.avg('total');

final grouped = await orders.aggregate(
  groupBy: ['status', 'currency'],
  metrics: {
    'orders': const AggregateMetric.count(),
    'revenue': AggregateMetric.sum('total'),
    'smallest': AggregateMetric.min('total'),
    'largest': AggregateMetric.max('total'),
  },
);
final rows = grouped['rows'] as List;`;

const aggregateRest = `curl -s -X POST \\
  "https://api.example.com/v1/projects/$PROJECT_ID/documents:aggregate" \\
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \\
  -d '{
    "collectionPath": "orders",
    "where": [{ "field": "status", "op": "==", "value": "paid" }],
    "groupBy": ["status", "currency"],
    "metrics": {
      "orders":  { "op": "count" },
      "revenue": { "op": "sum", "field": "total" }
    }
  }'`;

const orJs = `const page = await db
  .collection("users")
  .where("active", "==", true)                 // ANDed with the OR groups
  .or([
    [{ field: "role", op: "==", value: "admin" }],
    [
      { field: "role", op: "==", value: "editor" },
      { field: "verified", op: "==", value: true },
    ],
  ])
  .get();`;

const orDart = `final page = await client.collection('users')
  .where('active', '==', true)
  .or([
    [
      {'field': 'role', 'op': '==', 'value': 'admin'},
    ],
    [
      {'field': 'role', 'op': '==', 'value': 'editor'},
      {'field': 'verified', 'op': '==', 'value': true},
    ],
  ])
  .get();`;

const writeJs = `// Idempotent upsert (INSERT … ON CONFLICT DO UPDATE).
await db.doc("counters/visits").upsert({ count: 1 });

// TTL: expire 1 hour after creation.
await db.collection("sessions").doc("s_1")
  .create({ userId: "u_1" }, { ttlSeconds: 3600 });

// Bulk delete matching documents.
const removed = await db.collection("sessions")
  .where("lastSeenAt", "<", "2026-01-01T00:00:00.000Z")
  .deleteWhere({ limit: 2000 });
console.log(removed.deletedCount);`;

const writeDart = `await client.collection('counters').doc('visits').upsert({'count': 1});

await client.collection('sessions').doc('s_1')
  .create({'userId': 'u_1'}, ttlSeconds: 3600);

final removed = await client.collection('sessions')
  .where('lastSeenAt', '<', '2026-01-01T00:00:00.000Z')
  .deleteWhere(limit: 2000);`;

const writeRest = `# Upsert with TTL via PUT.
curl -s -X PUT \\
  "https://api.example.com/v1/projects/$PROJECT_ID/documents/sessions/s_1" \\
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \\
  -d '{ "data": { "userId": "u_1" }, "ttlSeconds": 3600, "upsert": true }'

# Bulk delete.
curl -s -X POST \\
  "https://api.example.com/v1/projects/$PROJECT_ID/documents:bulk-delete" \\
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \\
  -d '{ "collectionPath": "sessions",
        "where": [{ "field": "lastSeenAt", "op": "<",
                    "value": "2026-01-01T00:00:00.000Z" }], "limit": 2000 }'`;

export default function Page() {
  return (
    <Doc
      title="Relationships & advanced queries"
      description="Eager-loaded $ref relations, aggregations, OR groups, V2 text operators, upsert, bulk delete and document TTL."
      eyebrow="Core concepts"
    >
      <Section id="overview" title="Overview">
        <P>
          V2 extends the query engine with relationships and advanced operations. You can eagerly load
          documents referenced by a <code>$ref</code>, aggregate on the server, combine disjunctive
          filters, run case-insensitive and full-text searches, write idempotently with <code>upsert</code>,
          delete in bulk and give documents a time-to-live. Every feature below is enforced by the same
          Security Rules and tenant-scoped transaction as ordinary queries.
        </P>
        <Callout tone="info" title="Built on the v1 engine">
          These are additive capabilities — the cursor pagination, sort keys and composite indexes from{" "}
          <PageLink slug="query">Query</PageLink> and <PageLink slug="indexes">Composite indexes</PageLink>{" "}
          still apply unchanged.
        </Callout>
      </Section>

      <Section id="include" title="Eager-loaded relationships (.include)">
        <P>
          A relation is a field holding a reference. <code>include()</code> resolves those references and
          attaches the target documents under <code>_included</code>. A bare string is shorthand for{" "}
          <code>{"{ field }"}</code>; the detailed form controls the target collection, attachment alias,
          projection and nested includes.
        </P>
        <Table
          head={["Property", "Purpose"]}
          rows={[
            [<code>field</code>, "Field on the parent holding the reference (dot paths allowed)"],
            [<code>collection</code>, "Target collection; inferred from the $ref or field name if absent"],
            [<code>as</code>, "Attachment key (also written into the document data)"],
            [<code>select</code>, "Dot-path projection on the resolved target"],
            [<code>include</code>, "Nested relations — maximum depth 3"],
          ]}
        />
        <CodeTabs
          tabs={[
            { label: "JavaScript / TypeScript", lang: "typescript", code: includeJs },
            { label: "Flutter / Dart", lang: "dart", code: includeDart },
            { label: "REST", lang: "bash", code: includeRest },
          ]}
        />
        <H3 id="ref-formats">Reference formats</H3>
        <UL
          items={[
            <><code>{"{ \"$ref\": \"users/u_123\" }"}</code> — shorthand object</>,
            <><code>{"{ \"$t\": \"ref\", \"$v\": \"users/u_123\" }"}</code> — tagged wire reference</>,
            <><code>"users/u_123"</code> — plain canonical path</>,
            <><code>"u_123"</code> — bare id, resolved with the given or inferred collection</>,
          ]}
        />
        <H3 id="batching">Batching &amp; cycles</H3>
        <P>
          Resolution issues <strong>one logical batch fetch per depth</strong>: every referenced path
          across all parent documents is collected, deduplicated and fetched in a single{" "}
          <code>batchGetDocuments</code> round trip — no N+1. A <code>visitedPaths</code> set refuses to
          re-expand a path already visited at a shallower depth, so reference cycles terminate.
        </P>
        <Callout tone="warning" title="Security redaction (_redactedRefs)">
          Every resolved target is checked with a Security Rules <code>get</code> authorization. A denied
          target is attached as <code>null</code> and its key is recorded in <code>_redactedRefs</code> —
          it never leaks data and never fails the request. The SDK exposes these as{" "}
          <code>snapshot.included</code> and <code>snapshot.redactedRefs</code>.
        </Callout>
      </Section>

      <Section id="on-delete" title="Referential actions (onDelete)">
        <P>
          <code>onDelete</code> declares what happens to dependent documents when a referenced document is
          deleted. It is evaluated inside <code>batchWrite</code>, in the same tenant transaction and in{" "}
          <code>path ASC</code> order — never as an asynchronous cascade.
        </P>
        <Table
          head={["Action", "Behavior"]}
          rows={[
            [<code>restrict</code>, "Abort the write with RELATION_RESTRICT_VIOLATION (412) while any live dependent still references the path"],
            [<code>set_null</code>, "Write null into the dependent's field, bump its version and emit an updated outbox event"],
            [<code>cascade</code>, "Tombstone the dependent and enqueue further cascades, depth-limited to 3"],
          ]}
        />
        <P>
          Rules are managed per project and hydrated into the document engine as{" "}
          <code>EngineContext.relationRules</code>, with a cross-instance invalidation broadcast on every
          change.
        </P>
      </Section>

      <Section id="reverse-lookup" title="Reverse lookup (referencedBy)">
        <P>
          <code>POST /v1/projects/{'{projectId}'}/documents:referencedBy</code> answers “which documents
          reference this one?” — permission-filtered (a dependent the caller cannot read is never
          leaked), with opaque HMAC-signed cursor pagination. Keep paging while{" "}
          <code>nextCursor</code> is non-null, even after an empty page.
        </P>
        <Table
          head={["Field", "Purpose"]}
          rows={[
            [<code>targetPath</code>, "The referenced document path (required)"],
            [<code>collection</code>, "Optional: narrow the search to one collection"],
            [<code>field</code>, "Optional: narrow to one reference field (dot path)"],
            [<code>limit</code>, "1–100 dependents per page"],
            [<code>cursor</code>, "Opaque continuation token from the previous page"],
            [<code>select / include</code>, "Projection and relation expansion on the dependents"],
          ]}
        />
        <CodeTabs
          tabs={[
            { label: "JavaScript / TypeScript", lang: "typescript", code: referencedByJs },
            { label: "Flutter / Dart", lang: "dart", code: referencedByDart },
          ]}
        />
        <P>
          Reverse lookup uses a recursive JSONPath equality scan backed by the{" "}
          <code>idx_docs_reverse_reference_gin_active</code> partial GIN index (data migration{" "}
          <code>0012_referenced_by_gin.sql</code>). Responses above 4 MiB fail with{" "}
          <code>RESPONSE_TOO_LARGE</code>; reduce <code>limit</code> or use <code>select</code>.
        </P>
      </Section>

      <Section id="aggregates" title="Aggregations (count / sum / avg / min / max / groupBy)">
        <P>
          Aggregation runs in SQL inside the tenant transaction — documents are never loaded into the
          application. Each metric is named; <code>count</code> needs no field, while sum/avg/min/max
          require a dot-path field. With <code>groupBy</code> (max 3 fields) you get the full rows array.
        </P>
        <CodeTabs
          tabs={[
            { label: "JavaScript / TypeScript", lang: "typescript", code: aggregateJs },
            { label: "Flutter / Dart", lang: "dart", code: aggregateDart },
            { label: "REST", lang: "bash", code: aggregateRest },
          ]}
        />
        <Callout tone="info" title="Rules apply">
          Aggregations require the same <code>list</code>/<code>read</code> permission as a normal query.
          Dart exposes <code>count/sum/avg</code> helpers plus <code>aggregate()</code> for min/max and
          grouping; JavaScript adds <code>min()</code> and <code>max()</code> helpers.
        </Callout>
        <Api method="POST" path="/v1/projects/:projectId/documents:aggregate">
          <P>Body: <code>collectionPath</code>, optional <code>where</code>/<code>or</code>/<code>groupBy</code>, and a named <code>metrics</code> map.</P>
        </Api>
      </Section>

      <Section id="select-or" title="Dot-path select & OR groups">
        <H3 id="select">Dot-path select</H3>
        <P>
          <code>select</code> projects fields and rebuilds nested objects from dot paths. In JavaScript it
          is variadic (<code>select("a.b", "c")</code>); in Dart it takes a list. It also works inside an{" "}
          <code>include</code>, where it applies to the resolved target.
        </P>
        <H3 id="or">Disjunctive OR groups</H3>
        <P>
          Within a group clauses are ANDed; groups are ORed; the result is ANDed with the base{" "}
          <code>where</code> predicates. At most 10 groups are accepted. The same <code>or</code> field is
          valid on queries, aggregations and bulk deletes.
        </P>
        <CodeTabs
          tabs={[
            { label: "JavaScript / TypeScript", lang: "typescript", code: orJs },
            { label: "Flutter / Dart", lang: "dart", code: orDart },
          ]}
        />
      </Section>

      <Section id="operators" title="Case-insensitive & text operators">
        <P>
          Three V2 operators pass straight through both SDK <code>where()</code> builders — validation
          happens at the API boundary:
        </P>
        <Table
          head={["Operator", "SQL compilation", "Use"]}
          rows={[
            [<code>contains_ci</code>, <code>ILIKE '%value%'</code>, "Case-insensitive substring"],
            [<code>starts_with_ci</code>, <code>ILIKE 'value%'</code>, "Case-insensitive prefix"],
            [<code>text_search</code>, <code>to_tsvector @@ plainto_tsquery</code>, "Full-text over the payload"],
          ]}
        />
        <Code lang="ts" title="JavaScript" code={`await db.collection("users").where("email", "contains_ci", "@example.com").get();
await db.collection("posts").where("data", "text_search", "postgres index").get(); // field is ignored`} />
        <Callout tone="warning" title="Indexing note">
          These operators are not classified into the advisor's E/S/R model, so they do not trigger a
          composite-index suggestion. See <PageLink slug="smart-indexing">Smart indexing</PageLink>.
        </Callout>
      </Section>

      <Section id="writes" title="Upsert, bulk delete & TTL">
        <H3 id="upsert">Upsert</H3>
        <P>
          <code>upsert(data)</code> (or <code>set(data, {"{ upsert: true }"})</code>) issues an{" "}
          <code>INSERT … ON CONFLICT DO UPDATE</code> write — safe to retry and never fails just because
          the document exists. It composes with <code>merge</code>, <code>ifVersion</code> and TTL.
        </P>
        <H3 id="delete-where">Bulk delete</H3>
        <P>
          <code>deleteWhere()</code> removes every matching document in one server-side operation. It
          enforces list/read rules, emits an outbox event per row and counts toward{" "}
          <code>documentDeletes</code> metering. The <code>limit</code> defaults to 1000 and is capped at
          5000.
        </P>
        <H3 id="ttl">Document TTL</H3>
        <P>
          A document may carry <code>ttlSeconds</code> (relative) or <code>expiresAt</code> (explicit ISO
          timestamp; wins when both are set). Live reads filter out expired rows immediately, and a
          bounded sweeper physically removes them using the partial <code>idx_docs_expires_at</code>{" "}
          index.
        </P>
        <CodeTabs
          tabs={[
            { label: "JavaScript / TypeScript", lang: "typescript", code: writeJs },
            { label: "Flutter / Dart", lang: "dart", code: writeDart },
            { label: "REST", lang: "bash", code: writeRest },
          ]}
        />
        <Api method="POST" path="/v1/projects/:projectId/documents:bulk-delete">
          <P>Body: <code>collectionPath</code>, optional <code>where</code>/<code>or</code>, and <code>limit</code> (1–5000).</P>
        </Api>
      </Section>

      <Section id="next" title="Continue with">
        <UL
          items={[
            <><PageLink slug="security-rules-dsl">Security Rules DSL</PageLink> — author the rules that authorize these operations.</>,
            <><PageLink slug="smart-indexing">Smart indexing &amp; performance</PageLink> — how the advisor keeps these queries fast.</>,
            <><PageLink slug="errors-and-limits">Quotas &amp; limits</PageLink> — the exact bounds and error codes.</>,
          ]}
        />
      </Section>
    </Doc>
  );
}
