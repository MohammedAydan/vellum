import {
  Callout,
  Cards,
  Code,
  CodeTabs,
  Doc,
  P,
  Section,
  Table,
  UL,
} from "../../ui";

export default function Page() {
  return (
    <Doc
      eyebrow="Get started"
      title="VELLUM Documentation"
      description="A multi-tenant, real-time document database built exclusively on PostgreSQL—combining Firebase-style ergonomics with strict Row-Level Security, ACID transactions, and zero external cache brokers."
    >
      <P>
        VELLUM gives application teams a schemaless JSONB document model, deterministic security rules,
        cursor-paginated queries, optimistic concurrency transactions, and multiplexed WebSocket
        realtime streams—all backed by two isolated PostgreSQL databases and nothing else.
      </P>

      <Callout tone="info" title="The Zero-Redis Doctrine">
        PostgreSQL is the sole stateful dependency in production. There is no Redis, Memcached,
        Kafka, or RabbitMQ cluster to provision, secure, or keep consistent. Realtime fan-out uses
        PostgreSQL <code>LISTEN/NOTIFY</code> backed by a durable <code>realtime_outbox</code> table;
        hot-path lookups use bounded in-process LRU caches invalidated via <code>pg_notify</code>;
        and interactive transactions persist their read sets directly in the Data Plane.
      </Callout>

      <Section id="architecture" title="Dual PostgreSQL architecture">
        <P>
          Every deployment separates tenant control metadata from customer document workloads into
          two physically isolated PostgreSQL planes. Both planes are accessed through least-privilege
          database roles and fail-closed transaction wrappers.
        </P>

        <Table
          head={["Plane", "PostgreSQL URL", "Responsibilities", "Isolation Model"]}
          rows={[
            [
              <strong>Control Plane</strong>,
              <code>CONTROL_DATABASE_URL</code>,
              "Organizations, projects, API key hashes, rulesets, audit hash-chain, metering ledger, invoices, and Stripe billing state.",
              "Three isolated auth realms (Super Admin, Customer Admin, End User) with separate signing secrets and cookie scopes.",
            ],
            [
              <strong>Data Plane</strong>,
              <code>DATA_DATABASE_URL</code>,
              "Documents (JSONB), composite indexes & bytea sort keys, realtime outbox, OCC transactions, collections, and end-user auth tables.",
              <>
                Fail-closed <code>FORCE ROW LEVEL SECURITY</code> across all 12 tenant tables via
                transaction-local <code>set_config(&apos;app.current_project_id&apos;, $1, true)</code>.
              </>,
            ],
          ]}
        />

        <Code
          lang="text"
          title="End-to-end request & realtime topology"
          code={`Client Apps (TypeScript / Flutter / REST / WebSocket)
        │
        ▼
Caddy / Edge TLS (HSTS, CSP, X-Frame-Options: DENY)
        │
        ▼
Vellum API Gateway (Node 22 + Hono + RFC 6455 WS)
  ├── Fortress & Security Middleware (chunked body cap, spoof-resistant IP, SSRF guard, AST 256-step budget)
  ├── Bounded In-Process LRU Caches (API keys, rulesets, project routing — invalidated via pg_notify)
  ├── Control Plane PG  ──▶ orgs, projects, keys, rulesets, billing, hash-chained audit log
  └── Data Plane PG     ──▶ 12 RLS-enforced tables (documents, document_index_entries, realtime_outbox, transactions)
                            └── LISTEN/NOTIFY (keepAlive listener + pooled publisher) ──▶ Realtime Hub`}
        />
      </Section>

      <Section id="enterprise-guarantees" title="Hardened enterprise guarantees">
        <UL
          items={[
            <>
              <strong>Single-round-trip fail-closed RLS:</strong> Every Data Plane transaction binds{" "}
              <code>app.current_project_id</code>, <code>statement_timeout</code> (5,000 ms),{" "}
              <code>lock_timeout</code> (2,000 ms), and{" "}
              <code>idle_in_transaction_session_timeout</code> (15,000 ms) in a single parameterized{" "}
              <code>SELECT set_config(..., true)</code> call. If <code>ROLLBACK</code> ever fails,
              the tainted pooled socket is destroyed immediately via <code>client.release(err)</code>.
            </>,
            <>
              <strong>Constant-time cryptography everywhere:</strong> API key verification runs{" "}
              <code>crypto.timingSafeEqual</code> against SHA-256 digests on every request—including
              cache hits. HMAC-SHA256 cursors, HS256/EdDSA JWTs, TOTP recovery codes, and webhook
              signatures all use constant-time verification.
            </>,
            <>
              <strong>B-Tree keyset pagination &amp; smart indexing:</strong> Zero{" "}
              <code>OFFSET</code> queries. Composite indexes compile to order-preserving{" "}
              <code>BYTEA</code> sort keys with row-value tuple seeks{" "}
              <code>(ie.sort_key, ie.document_id) &gt; ($1, $2)</code>, commutative equality-prefix
              matching, and an automatic E/S/R index advisor.
            </>,
            <>
              <strong>True ACID transactions &amp; atomic batches:</strong> Interactive OCC
              transactions lock rows in deterministic <code>path ASC</code> order with{" "}
              <code>FOR UPDATE</code>, support nested same-tenant <code>SAVEPOINT</code>s, and
              automatically retry transient PostgreSQL <code>40001</code> / <code>40P01</code>{" "}
              failures.
            </>,
            <>
              <strong>First-class TypeScript &amp; Flutter SDKs:</strong> Idiomatic clients with{" "}
              <code>withConverter&lt;T&gt;()</code> type safety, async pagination iterators,
              auto-chunked bulk writes, single-flight read deduplication, proactive token refresh,
              and clean <code>dispose()</code> lifecycle hooks.
            </>,
          ]}
        />
      </Section>

      <Section id="hello-vellum" title="A 15-second taste">
        <CodeTabs
          tabs={[
            {
              label: "TypeScript (@vellumdb/sdk-js)",
              lang: "ts",
              code: `import { createClient, fieldOp } from "@vellumdb/sdk-js";

const db = createClient({
  endpoint: "https://api.example.com",
  projectId: "proj_0196a1b2-c3d4-7000-8000-000000000001",
  apiKey: process.env.VELLUM_API_KEY!,
  dedupeReads: true,
});

await db.doc("orders/ord_1001").set({
  status: "paid",
  totalCents: 4900,
  tags: ["priority", "eu"],
  updatedAt: fieldOp.serverTimestamp(),
});

for await (const doc of db
  .collection("orders")
  .where("status", "==", "paid")
  .orderBy("totalCents", "desc")
  .stream({ pageSize: 50 })) {
  console.log(doc.id, doc.data());
}

db.dispose();`,
            },
            {
              label: "Flutter / Dart (vellum_flutter)",
              lang: "dart",
              code: `import 'package:vellum_flutter/vellum_flutter.dart';

final db = VellumClient(
  endpoint: 'https://api.example.com',
  projectId: 'proj_0196a1b2-c3d4-7000-8000-000000000001',
  apiKey: const String.fromEnvironment('VELLUM_API_KEY'),
);

await db.doc('orders/ord_1001').set({
  'status': 'paid',
  'totalCents': 4900,
  'tags': ['priority', 'eu'],
  'updatedAt': FieldOp.serverTimestamp(),
});

await for (final doc in db
    .collection('orders')
    .where('status', '==', 'paid')
    .orderBy('totalCents', dir: 'desc')
    .streamDocuments(pageSize: 50)) {
  print('\${doc.id}: \${doc.data()}');
}

db.dispose();`,
            },
          ]}
        />
      </Section>

      <Section id="explore" title="Where to go next">
        <Cards
          items={[
            {
              title: "Quickstart",
              body: "Verify health probes, install the TypeScript or Flutter SDK, and execute your first CRUD + query cycle.",
              href: "/docs/quickstart/",
            },
            {
              title: "Query Engine",
              body: "All 13 filter operators, disjunctive OR groups, projections, and native PostgreSQL JSONB/timestamptz compilation.",
              href: "/docs/query/",
            },
            {
              title: "Pagination & Cursors",
              body: "HMAC-SHA256 opaque cursors, key rotation, B-Tree tuple seeks, and streaming SDK helpers.",
              href: "/docs/pagination/",
            },
            {
              title: "Security & Defense in Depth",
              body: "12-table RLS, constant-time auth, AST 256-step budgets, SSRF guards, and hardened headers.",
              href: "/docs/security-and-defense/",
            },
            {
              title: "Realtime Architecture",
              body: "Broker-free LISTEN/NOTIFY, durable outbox watermarks, O(tenant) fan-out, and continuous auth checks.",
              href: "/docs/realtime/",
            },
            {
              title: "Production Deployment",
              body: "Hardened Docker containers (tini, cap_drop: ALL, read_only), Caddy/Vercel TLS+CSP, and graceful draining.",
              href: "/docs/deployment/",
            },
          ]}
        />
      </Section>
    </Doc>
  );
}
