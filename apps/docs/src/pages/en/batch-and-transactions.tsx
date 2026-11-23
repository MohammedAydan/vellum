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
      title="Batch Writes &amp; Transactions"
      description="Atomic batchWrite, auto-chunked bulk writes, native PostgreSQL OCC transactions with FOR UPDATE pre-locking, SAVEPOINT nested transactions, and 40001/40P01 retries."
    >
      <P>
        VELLUM provides two multi-document write primitives backed directly by PostgreSQL ACID
        transactions: <strong>atomic batch writes</strong> for blind multi-document mutations, and{" "}
        <strong>interactive OCC transactions</strong> for read-modify-write workflows that require
        serializable version verification across horizontally scaled API instances.
      </P>

      <Section id="occ-transactions" title="Interactive OCC transactions &amp; FOR UPDATE lock order">
        <P>
          Unlike in-memory transaction managers that break across multiple API replicas, every
          interactive transaction is stored as a durable row in the Data Plane&apos;s RLS-protected{" "}
          <code>transactions</code> table (along with its observed <code>read_set</code> JSONB).
          When <code>POST /transactions:commit</code> runs, the engine enforces a strict,
          deadlock-free locking invariant:
        </P>

        <UL
          items={[
            <>
              <strong>Step 1 — Lock the transaction row first:</strong>{" "}
              <code>SELECT status, expires_at, read_set FROM transactions WHERE token_hash = $1 AND project_id = $2::uuid FOR UPDATE</code>.
              This serializes concurrent commits on the same token and races against rollback or
              expiration (5,000 ms interactive window).
            </>,
            <>
              <strong>Step 2 — Pre-lock every read-set document in deterministic order:</strong>{" "}
              <code>SELECT path, version FROM documents WHERE project_id = $1::uuid AND path = ANY($2::text[]) AND deleted_at IS NULL ORDER BY path ASC FOR UPDATE</code>.
              Locking in strict <code>path ASC</code> order guarantees two concurrent OCC commits
              touching overlapping hot documents never acquire locks in opposite orders.
            </>,
            <>
              <strong>Step 3 — Verify versions &amp; apply staged writes:</strong> Every observed
              document version is compared against the locked current version. Any mismatch aborts
              with <code>409 ABORTED_CONFLICT</code>, which the SDKs automatically retry with
              full-jitter exponential backoff (default up to 5 attempts).
            </>,
          ]}
        />

        <CodeTabs
          tabs={[
            {
              label: "TypeScript (@vellum/sdk-js)",
              lang: "ts",
              code: `await db.runTransaction(async (tx) => {
  const fromRef = db.doc("accounts/acct_a");
  const toRef = db.doc("accounts/acct_b");

  const [fromSnap, toSnap] = await Promise.all([tx.get(fromRef), tx.get(toRef)]);
  const balance = Number(fromSnap.data()?.balanceCents ?? 0);
  if (balance < 5000) throw new Error("Insufficient funds");

  tx.update(fromRef, { balanceCents: balance - 5000 });
  tx.update(toRef, { balanceCents: Number(toSnap.data()?.balanceCents ?? 0) + 5000 });
});`,
            },
            {
              label: "Flutter / Dart (vellum_flutter)",
              lang: "dart",
              code: `await db.runTransaction((tx) async {
  final fromRef = db.doc('accounts/acct_a');
  final toRef = db.doc('accounts/acct_b');

  final fromSnap = await tx.get(fromRef);
  final toSnap = await tx.get(toRef);
  final balance = (fromSnap.data()?['balanceCents'] as num?)?.toInt() ?? 0;
  if (balance < 5000) throw StateError('Insufficient funds');

  tx.update(fromRef, {'balanceCents': balance - 5000});
  tx.update(toRef, {
    'balanceCents': ((toSnap.data()?['balanceCents'] as num?)?.toInt() ?? 0) + 5000,
  });
}, maxAttempts: 5);`,
            },
          ]}
        />
      </Section>

      <Section id="savepoints-and-retries" title="SAVEPOINT nested transactions &amp; 40001/40P01 retries">
        <P>
          Inside the server&apos;s <code>@vellum/storage</code> transaction runner (
          <code>runInTenantTransactionAsync</code>), two additional PostgreSQL hardening mechanisms
          protect multi-step operations:
        </P>
        <Table
          head={["Mechanism", "Behavior", "Security / Reliability Guarantee"]}
          rows={[
            [
              <>
                <strong>Nested <code>SAVEPOINT</code>s</strong>
              </>,
              <>
                Re-entrant calls on the same pool &amp; tenant via <code>AsyncLocalStorage</code>{" "}
                execute <code>SAVEPOINT vellum_sp_N</code> / <code>RELEASE SAVEPOINT</code> instead
                of opening a second connection.
              </>,
              <>
                Prevents pool starvation deadlocks. Cross-tenant nested calls fail closed
                immediately with <code>PERMISSION_DENIED</code>.
              </>,
            ],
            [
              <>
                <strong>Automatic <code>40001</code> / <code>40P01</code> retries</strong>
              </>,
              "Top-level transactions automatically retry PostgreSQL serialization failures (40001) and deadlocks (40P01) with bounded jitter.",
              "Absorbs transient MVCC contention cleanly without leaking raw SQLSTATE errors to callers.",
            ],
            [
              <>
                <strong>Rollback socket destruction</strong>
              </>,
              <>
                If <code>ROLLBACK</code> throws on a pooled client, the client is destroyed via{" "}
                <code>client.release(err)</code>.
              </>,
              "Guarantees a tainted or half-open transaction socket is never recycled to another tenant.",
            ],
          ]}
        />
      </Section>

      <Section id="batch-writes" title="Atomic batchWrite &amp; auto-chunked bulk writes">
        <P>
          A single atomic <code>POST /batchWrite</code> executes up to{" "}
          <code>MAX_BATCH_OPERATIONS = 100</code> writes (up to <code>5 MiB</code> payload) inside
          one all-or-nothing PostgreSQL transaction, optionally guarded by an{" "}
          <code>Idempotency-Key</code> header. For larger migrations or imports, use the built-in
          chunking helpers in both SDKs:
        </P>

        <CodeTabs
          tabs={[
            {
              label: "TypeScript (batchWriteChunked)",
              lang: "ts",
              code: `const controller = new AbortController();

const ops = items.map((item) => ({
  type: "set" as const,
  path: \`catalog/\${item.id}\`,
  data: item,
  merge: true,
}));

const result = await db.batchWriteChunked(ops, {
  chunkSize: 100,       // match MAX_BATCH_OPERATIONS for server atomicity per chunk
  concurrency: 4,       // bounded parallel chunks (default: 4)
  signal: controller.signal,
  onChunkComplete(progress) {
    console.log(\`Chunk \${progress.chunkIndex + 1}/\${progress.totalChunks} done\`);
  },
});`,
            },
            {
              label: "Flutter / Dart (batch().commitChunked())",
              lang: "dart",
              code: `final batch = db.batch();
for (final item in items) {
  batch.set(
    db.collection('catalog').doc(item.id),
    item.toJson(),
    merge: true,
  );
}

// Auto-splits into bounded chunks with deterministic per-chunk idempotency keys
final results = await batch.commitChunked(
  chunkSize: 100,
  idempotencyKeyPrefix: 'catalog-sync-2026-11',
);`,
            },
          ]}
        />

        <Callout tone="warning" title="Atomicity scope of chunked writes">
          Each chunk submitted by <code>batchWriteChunked()</code> or{" "}
          <code>batch().commitChunked()</code> is atomic on its own, but chunks are independent
          transactions. Pass <code>chunkSize: 100</code> to align with{" "}
          <code>SYSTEM_LIMITS.MAX_BATCH_OPERATIONS</code>, and supply an{" "}
          <code>idempotencyKeyPrefix</code> when retrying bulk imports. See{" "}
          <PageLink slug="errors-and-limits">Quotas &amp; Limits</PageLink> for exact bounds.
        </Callout>
      </Section>
    </Doc>
  );
}
