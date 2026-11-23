import {
  Callout,
  Code,
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
      title="Pagination &amp; Opaque Cursors"
      description="Zero-OFFSET keyset pagination backed by HMAC-SHA256 signed opaque cursors, key rotation, PostgreSQL row-value tuple B-Tree seeks, and streaming SDK iterators."
    >
      <P>
        VELLUM never uses SQL <code>OFFSET</code>. Every paginated query compiles to a B-Tree keyset
        seek using an opaque, HMAC-SHA256 signed cursor bound to the exact query shape. Page 1,000
        reads the same number of index pages as page 1.
      </P>

      <Section id="cursor-format" title="HMAC-SHA256 cursor codec &amp; security">
        <P>
          When a query returns more rows than <code>limit</code> (VELLUM internally fetches{" "}
          <code>limit + 1</code>), the server encodes the boundary document into a base64url cursor
          token containing <code>{`{ qHash, vals, docId, sortKey?, sig }`}</code>.
        </P>

        <Table
          head={["Control", "Implementation in @vellum/query-engine", "Protection"]}
          rows={[
            [
              <strong>Token size cap</strong>,
              <><code>MAX_CURSOR_TOKEN_BYTES = 16_384</code> (enforced before base64url decode)</>,
              "Prevents base64 decode and JSON parse memory DoS.",
            ],
            [
              <strong>Query shape binding</strong>,
              <>
                <code>qHash</code> = SHA-256 of canonicalized <code>projectId</code>,{" "}
                <code>collectionPath</code>, <code>where</code>, <code>orderBy</code>, and{" "}
                <code>or</code> groups (compared via <code>crypto.timingSafeEqual</code>).
              </>,
              "Prevents cursor replay across different filters, sort orders, OR groups, or projects.",
            ],
            [
              <strong>Constant-time HMAC</strong>,
              <>
                64-char hex HMAC-SHA256 signature verified via <code>crypto.timingSafeEqual</code>.
              </>,
              "Eliminates timing side channels and cursor tampering.",
            ],
            [
              <strong>Whitelisted reconstruction</strong>,
              <>
                Only <code>qHash</code>, <code>vals</code>, <code>docId</code>,{" "}
                <code>sortKey</code> (even-length hex), and <code>sig</code> are accepted.
              </>,
              "Rejects unknown properties and blocks prototype pollution.",
            ],
            [
              <strong>Zero-downtime key rotation</strong>,
              <>
                <code>decodeAndVerifyQueryCursor</code> accepts{" "}
                <code>string | readonly string[]</code> secrets (signs with primary secret, verifies
                against all active secrets).
              </>,
              "Allows rolling CURSOR_SECRET / CURSOR_HMAC_SECRET without invalidating live pagination sessions.",
            ],
          ]}
        />
      </Section>

      <Section id="tuple-seeks" title="Row-value tuple B-Tree seeks &amp; tie-breaking">
        <P>
          Every query automatically appends <code>documentId ASC</code> as a deterministic
          tie-breaker unless you explicitly order by <code>documentId</code> (including{" "}
          <code>documentId DESC</code>). The compiler emits PostgreSQL row-value tuple comparisons
          whenever the primary sort and tie-breaker align, unlocking direct B-Tree Index Scans:
        </P>

        <Code
          lang="sql"
          title="Compiled keyset seek predicates"
          code={`-- Composite index path (startAfter -> '>', startAt -> '>=')
WHERE ie.index_id = $idx::uuid
  AND ie.project_id = $1::uuid
  AND (ie.sort_key, ie.document_id) > ($key::bytea, $docId)
ORDER BY ie.sort_key ASC, ie.document_id ASC
LIMIT $limitPlusOne;

-- Single-field / native column path with aligned direction (including documentId DESC)
WHERE (d.document_id COLLATE "C") < $docId
ORDER BY d.document_id DESC
LIMIT $limitPlusOne;`}
        />

        <Callout tone="success" title="Exact startAt vs startAfter &amp; documentId DESC semantics">
          Row-value tuple comparisons <code>(ie.sort_key, ie.document_id) &gt;= ($key, $id)</code>{" "}
          for <code>startAt</code> and <code>&gt;</code> for <code>startAfter</code> eliminate
          off-by-one tie-breaker bugs when multiple documents share the same sort value, and handle{" "}
          <code>documentId DESC</code> without direction inversion.
        </Callout>
      </Section>

      <Section id="sdk-streaming" title="Streaming pages &amp; documents in the SDKs">
        <P>
          You can pass <code>nextCursor</code> manually to <code>.startAfter(cursor)</code>, or use
          the built-in lazy async iterators in <code>@vellumdb/sdk-js</code> and{" "}
          <code>vellum_flutter</code> that follow cursors automatically and guard against duplicate
          or empty cursor loops.
        </P>

        <CodeTabs
          tabs={[
            {
              label: "TypeScript (pages() & stream())",
              lang: "ts",
              code: `const query = db
  .collection("invoices")
  .where("status", "==", "open")
  .orderBy("createdAt", "desc");

// 1. Iterate page-by-page with AbortSignal support
const controller = new AbortController();
for await (const page of query.pages({ pageSize: 100, maxPages: 10, signal: controller.signal })) {
  console.log(\`Fetched \${page.docs.length} invoices\`);
}

// 2. Or stream individual DocumentSnapshots directly
for await (const doc of query.stream({ pageSize: 100 })) {
  await processInvoice(doc.id, doc.data());
}`,
            },
            {
              label: "Flutter / Dart (streamPages() & streamDocuments())",
              lang: "dart",
              code: `final query = db
    .collection('invoices')
    .where('status', '==', 'open')
    .orderBy('createdAt', dir: 'desc');

// 1. Lazily stream QuerySnapshot pages
await for (final page in query.streamPages(pageSize: 100, maxPages: 10)) {
  print('Fetched \${page.docs.length} invoices');
}

// 2. Or stream individual DocumentSnapshots across all pages
await for (final doc in query.streamDocuments(pageSize: 100)) {
  await processInvoice(doc.id, doc.data());
}`,
            },
          ]}
        />
      </Section>

      <Section id="best-practices" title="Pagination best practices">
        <UL
          items={[
            <>
              Treat <code>nextCursor</code> as an opaque string—never parse or construct it on the
              client.
            </>,
            <>
              If a user changes a filter or sort order in your UI, discard the previous{" "}
              <code>nextCursor</code>; replaying it against a different query shape intentionally
              returns <code>INVALID_CURSOR</code>.
            </>,
            <>
              Always cap user-facing page sizes (default <code>50</code>, max <code>500</code>) and
              pair deep sorting with a <PageLink slug="indexes">composite index</PageLink>.
            </>,
          ]}
        />
      </Section>
    </Doc>
  );
}
