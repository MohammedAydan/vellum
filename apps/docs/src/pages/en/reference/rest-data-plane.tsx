import { Api, Callout, Code, CodeTabs, Doc, P, PageLink, Section, Table } from "../../../ui";

export default function Page() {
  return (
    <Doc
      title="Data plane REST API"
      description="Endpoint-by-endpoint reference for document CRUD, structured queries, batch writes, OCC transactions and composite indexes. Every call is authenticated with an API key and scoped to a project."
      eyebrow="Reference"
    >
      <Section id="authentication" title="Authentication and scoping">
        <P>
          All data plane routes live under <code>/v1/projects/:projectId</code>. The API key must
          belong to the addressed project;
          a mismatch returns <code>403 PERMISSION_DENIED</code>.
        </P>
        <Table
          head={["Header", "Required", "Notes"]}
          rows={[
            [<code>x-vellum-api-key</code>, "Yes", "Use a pk_ public key in browser/mobile apps or an sk_ secret key on a trusted server. The legacy x-project-key header is also accepted."],
            [<code>content-type: application/json</code>, "On bodies", "Required for POST, PUT and PATCH requests with a JSON body."],
            [<><code>authorization</code> / <code>x-vellum-user-token</code></>, "Optional", "Bearer EdDSA vellum+enduser+jwt carrying the end-user identity for rules evaluation. No HS256 fallback."],
            [<code>x-transaction-token</code>, "Optional", "Read within an OCC transaction; also accepted as ?transactionToken= or ?txToken=."],
          ]}
        />
        <Callout tone="danger" title="Isolation is enforced in PostgreSQL">
          <P>
            Every transaction binds <code>SET LOCAL app.current_project_id</code>,{" "}
            <code>statement_timeout = '5000ms'</code>. Row-Level Security fails closed if tenant
            context is ever omitted. Index management requires a server key with the{" "}
            <code>indexes:manage</code> scope — public keys cannot manage indexes.
          </P>
        </Callout>
        <P>
          Every response carries <code>X-Request-Id</code>. For the shared error envelope and the
          canonical codes, see{" "}
          <PageLink slug="reference/errors">Error codes &amp; retry guidance</PageLink>.
        </P>
      </Section>

      <Section id="documents" title="Documents">
        <P>
          A path with an <strong>even</strong> number of segments addresses one document; an{" "}
          <strong>odd</strong> number addresses a collection. Paths are relative to the{" "}
          <code>/documents/</code> prefix and URL-encoded, for example{" "}
          <code>users/u_123/orders/o_9</code>.
        </P>
        <Api method="GET" path="/v1/projects/:projectId/documents/*">
          <P>
            Required header: <code>x-vellum-api-key</code>. Read a document (even segments) or list a
            collection (odd segments). Collection listing accepts <code>?limit=</code> (default 50)
            and <code>?startAfter=&lt;cursor&gt;</code>.
          </P>
          <Code
            title="Response · 200 (single document)"
            code={JSON.stringify(
              {
                path: "users/u_123",
                collectionPath: "users",
                collectionGroup: "users",
                documentId: "u_123",
                data: { name: "Ada", role: "admin" },
                sizeBytes: 96,
                version: 3,
                createdAt: "2026-11-15T14:30:00.123Z",
                updatedAt: "2026-11-17T09:00:00.000Z",
              },
              null,
              2
            )}
          />
          <P>A collection listing returns the same query envelope documented below.</P>
        </Api>

        <Api method="POST" path="/v1/projects/:projectId/documents/*">
          <P>
            Required headers: <code>x-vellum-api-key</code>, <code>content-type: application/json</code>.
            Creates a document and returns <code>409 ALREADY_EXISTS</code> if it is already present.
          </P>
          <Code
            title="Request · 201"
            code={JSON.stringify({ data: { name: "Ada", role: "admin", credits: 0 } }, null, 2)}
          />
          <Code
            title="Response · 201"
            code={JSON.stringify(
              {
                path: "users/u_123",
                collectionPath: "users",
                collectionGroup: "users",
                documentId: "u_123",
                data: { name: "Ada", role: "admin", credits: 0 },
                sizeBytes: 104,
                version: 1,
                createdAt: "2026-11-17T09:00:00.000Z",
                updatedAt: "2026-11-17T09:00:00.000Z",
              },
              null,
              2
            )}
          />
        </Api>

        <Api method="PUT" path="/v1/projects/:projectId/documents/*">
          <P>
            Required headers: <code>x-vellum-api-key</code>, <code>content-type: application/json</code>.
            Overwrites the document when <code>merge</code> is false (the default) or deep-merges it
            when true. <code>merge</code> may also be passed as <code>?merge=true</code>. Supply{" "}
            <code>ifVersion</code> for an optimistic precondition.
          </P>
          <Code
            title="Request"
            code={JSON.stringify(
              { data: { role: "admin", lastSeen: { $op: "serverTimestamp" } }, merge: true, ifVersion: 3 },
              null,
              2
            )}
          />
        </Api>

        <Api method="PATCH" path="/v1/projects/:projectId/documents/*">
          <P>
            Required headers: <code>x-vellum-api-key</code>, <code>content-type: application/json</code>.
            Updates fields and applies atomic <code>$op</code> transforms; an optional{" "}
            <code>ifVersion</code> guards the write.
          </P>
          <Code
            title="Request"
            code={JSON.stringify(
              {
                data: {
                  loginCount: { $op: "inc", by: 1 },
                  tags: { $op: "arrayUnion", elements: ["vip"] },
                  retiredField: { $op: "deleteField" },
                },
                ifVersion: 3,
              },
              null,
              2
            )}
          />
          <P>
            Transforms are also valid in <code>POST /batchWrite</code> and{" "}
            <code>POST …/transactions:commit</code>. See{" "}
            <PageLink slug="field-transforms">Field transforms</PageLink>.
          </P>
        </Api>

        <Api method="DELETE" path="/v1/projects/:projectId/documents/*">
          <P>
            Required header: <code>x-vellum-api-key</code>. Soft-deletes the document by writing a
            tombstone and an outbox event. An optional <code>?ifVersion=</code> precondition applies.
          </P>
          <Code
            title="Response · 200"
            code={JSON.stringify({ path: "users/u_123", documentId: "u_123", deleted: true, version: 4 }, null, 2)}
          />
        </Api>
      </Section>

      <Section id="query" title="Structured query">
        <Api method="POST" path="/v1/projects/:projectId/query">
          <P>
            Required headers: <code>x-vellum-api-key</code>, <code>content-type: application/json</code>.
            The body is a query spec: up to 10 <code>where</code> clauses, 3 <code>orderBy</code> fields,
            a limit of 1–500, and an optional HMAC-signed <code>startAfter</code> cursor. Queries are
            cursor-only — there is no SQL <code>OFFSET</code>.
          </P>
          <CodeTabs
            tabs={[
              {
                label: "Request",
                lang: "json",
                code: JSON.stringify(
                  {
                    collectionPath: "users",
                    where: [
                      { field: "status", op: "==", value: "active" },
                      { field: "age", op: ">=", value: 18 },
                    ],
                    orderBy: [{ field: "age", dir: "desc" }],
                    select: ["name", "age", "status"],
                    limit: 25,
                    startAfter: "eyJ2IjoxLCJpZCI6InVfMTIzIn0",
                  },
                  null,
                  2
                ),
              },
              {
                label: "Response · 200",
                lang: "json",
                code: JSON.stringify(
                  {
                    documents: [
                      {
                        path: "users/u_123",
                        collectionPath: "users",
                        collectionGroup: "users",
                        documentId: "u_123",
                        data: { name: "Ada", age: 36, status: "active" },
                        sizeBytes: 104,
                        version: 3,
                        createdAt: "2026-11-15T14:30:00.123Z",
                        updatedAt: "2026-11-17T09:00:00.000Z",
                      },
                    ],
                    nextCursor: "eyJ2IjoxLCJpZCI6InVfMTIzIn0",
                    meta: {
                      count: 1,
                      indexUsed: "primary_btree",
                      executionTimeMs: 1.234,
                      compiledSql: "SELECT ...",
                    },
                  },
                  null,
                  2
                ),
              },
            ]}
          />
          <P>
            <code>document_id ASC</code> is appended as the final tie-breaker. If the filter and sort
            combination needs a composite index that does not exist, the call returns{" "}
            <code>412 FAILED_PRECONDITION</code> with a <code>suggestedIndex</code> in the error
            details. See <PageLink slug="query">Query</PageLink>,{" "}
            <PageLink slug="pagination">Pagination</PageLink> and{" "}
            <PageLink slug="indexes">Composite indexes</PageLink>.
          </P>
        </Api>

        <Api method="POST" path="/v1/projects/:projectId/documents:referencedBy">
          <P>
            Required headers: <code>x-vellum-api-key</code>, <code>content-type: application/json</code>.
            The reverse of <code>include</code>: given a target document path, return the documents whose
            reference field points at it, optionally narrowed to one collection and one field. Pagination
            is cursor-only with a page limit of 1&ndash;100. The target must be readable (<code>get</code>)
            and every returned document is re-authorized (<code>list</code>); documents the API key may
            not read are silently filtered out.
          </P>
          <CodeTabs
            tabs={[
              {
                label: "Request",
                lang: "json",
                code: JSON.stringify(
                  {
                    targetPath: "users/u_123",
                    collection: "posts",
                    field: "authorId",
                    limit: 25,
                    cursor: "eyJ2IjoxLCJpZCI6InBfOTk5In0",
                  },
                  null,
                  2
                ),
              },
              {
                label: "Response · 200",
                lang: "json",
                code: JSON.stringify(
                  {
                    documents: [
                      { path: "posts/p_001", data: { title: "Hello", authorId: "u_123" }, version: 2 },
                    ],
                    nextCursor: "eyJ2IjoxLCJpZCI6InBfMDAxIn0",
                  },
                  null,
                  2
                ),
              },
            ]}
          />
          <P>
            A <code>restrict</code> relation rule makes deleting a still-referenced target fail with{" "}
            <code>412 RELATION_RESTRICT_VIOLATION</code>, and this endpoint powers the{" "}
            <PageLink slug="relationships">Relationships</PageLink> reverse lookups. Declare the rule
            first so the GIN index on <code>referenced_by</code> is prebuilt; see{" "}
            <PageLink slug="relationships">Relationships</PageLink>.
          </P>
        </Api>
      </Section>

      <Section id="batch-and-transactions" title="Batch writes and OCC transactions">
        <Api method="POST" path="/v1/projects/:projectId/batchWrite">
          <P>
            Required headers: <code>x-vellum-api-key</code>, <code>content-type: application/json</code>.
            Up to 100 mutations execute in one PostgreSQL transaction; any failure aborts the whole
            batch. <code>documents:batchWrite</code> is an equivalent path.
          </P>
          <Code
            title="Request"
            code={JSON.stringify(
              {
                writes: [
                  { type: "create", path: "users/u_123", data: { name: "Ada", credits: 0 } },
                  { type: "set", path: "users/u_123/stats", data: { logins: 0 }, merge: false },
                  { type: "update", path: "counters/users", data: { total: { $op: "inc", by: 1 } } },
                  { type: "delete", path: "sessions/old_session" },
                ],
              },
              null,
              2
            )}
          />
          <Code
            title="Response · 200"
            code={JSON.stringify(
              {
                results: [
                  { path: "users/u_123", version: 1 },
                  { path: "users/u_123/stats", version: 1 },
                  { path: "counters/users", version: 7 },
                  { path: "sessions/old_session", deleted: true },
                ],
                committedAt: "2026-11-17T09:00:00.000Z",
              },
              null,
              2
            )}
          />
        </Api>

        <Api method="POST" path="/v1/projects/:projectId/transactions:begin">
          <P>
            Required header: <code>x-vellum-api-key</code>. Starts a data-plane transaction row and
            returns a signed token that must be passed to reads and to the commit call.
          </P>
          <Code
            title="Response · 200"
            code={JSON.stringify(
              {
                transactionId: "tx_9f2c1a7b4e8d4f0a9b3c6d5e8f1a2b4c",
                transactionToken: "eyJ0eElkIjoidHhfOWYyYzFhN2I0ZThkRjBhOWIzYzZkNWU4ZjFhMmI0YyJ9.sig",
                expiresAt: "2026-11-17T09:00:05.000Z",
              },
              null,
              2
            )}
          />
        </Api>

        <Api method="POST" path="/v1/projects/:projectId/transactions:commit">
          <P>
            Required headers: <code>x-vellum-api-key</code>, <code>content-type: application/json</code>.
            The commit verifies and locks every read-set document in deterministic <code>path ASC</code>{" "}
            order with <code>SELECT … FOR UPDATE</code>, compares versions, and applies all writes in
            one native transaction. A changed read set returns{" "}
            <code>409 ABORTED_CONFLICT</code>; the SDK retries automatically.
          </P>
          <Code
            title="Request"
            code={JSON.stringify(
              {
                transactionToken: "eyJ0eElkIjoidHhfOWYyYzFhN2I0ZThkRjBhOWIzYzZkNWU4ZjFhMmI0YyJ9.sig",
                writes: [
                  { type: "update", path: "accounts/a", data: { balance: 450 }, ifVersion: 3 },
                  { type: "update", path: "accounts/b", data: { balance: 550 }, ifVersion: 8 },
                ],
              },
              null,
              2
            )}
          />
          <P>
            Transactions must complete within 5 seconds or they return{" "}
            <code>408 TRANSACTION_TIMEOUT</code>. See{" "}
            <PageLink slug="batch-and-transactions">Batch writes &amp; transactions</PageLink>.
          </P>
        </Api>
      </Section>

      <Section id="indexes" title="Composite index management">
        <P>
          Composite indexes are stored as rows in <code>document_indexes</code> and maintained in{" "}
          <code>document_index_entries</code> with an order-preserving <code>sort_key BYTEA</code>.
          The API never issues <code>CREATE INDEX</code> on the shared documents table. All three
          routes require a server key with <code>indexes:manage</code>.
        </P>
        <Api method="GET" path="/v1/projects/:projectId/indexes">
          <P>Required header: an <code>sk_</code> key with <code>indexes:manage</code>.</P>
          <Code
            title="Response · 200"
            code={JSON.stringify(
              {
                indexes: [
                  {
                    id: "idx_01J9F5K2M8",
                    collectionPath: "users",
                    fields: [
                      { path: "status", dir: "asc" },
                      { path: "priority", dir: "desc" },
                    ],
                    status: "ready",
                    createdAt: "2026-11-15T14:30:00.123Z",
                  },
                ],
              },
              null,
              2
            )}
          />
        </Api>
        <Api method="POST" path="/v1/projects/:projectId/indexes">
          <P>
            Required headers: an <code>sk_</code> key with <code>indexes:manage</code>,{" "}
            <code>content-type: application/json</code>. Registration returns immediately with status{" "}
            <code>building</code>; poll the list until it is <code>ready</code>.
          </P>
          <Code
            title="Request"
            code={JSON.stringify(
              {
                collectionPath: "users",
                fields: [
                  { path: "status", dir: "asc" },
                  { path: "priority", dir: "desc" },
                ],
              },
              null,
              2
            )}
          />
          <Code
            title="Response · 201"
            code={JSON.stringify(
              {
                id: "idx_01J9F5K2M8",
                collectionPath: "users",
                fields: [
                  { path: "status", dir: "asc" },
                  { path: "priority", dir: "desc" },
                ],
                status: "building",
                createdAt: "2026-11-17T09:00:00.000Z",
              },
              null,
              2
            )}
          />
        </Api>
        <Api method="DELETE" path="/v1/projects/:projectId/indexes/:indexId">
          <P>Required header: an <code>sk_</code> key with <code>indexes:manage</code>.</P>
          <Code
            title="Response · 200"
            code={JSON.stringify({ deleted: true, indexId: "idx_01J9F5K2M8" }, null, 2)}
          />
        </Api>
      </Section>

      <Section id="collections" title="Collections lifecycle">
        <P>
          A collection is a durable registry row in <code>data_db.project_collections</code> with{" "}
          <code>ENABLE FORCE ROW LEVEL SECURITY</code>, not an emergent view over documents. It exists
          even when empty and keeps its settings across deletes, F5 and restarts. The <strong>same
          eight endpoints</strong> are exposed on two surfaces: the public data plane shown here and
          the session-authenticated console at{" "}
          <code>/v1/console/projects/:projectId/collections…</code>, which the Dashboard uses.
        </P>
        <Callout tone="danger" title="Key types: pk_ reads, sk_ writes">
          <P>
            On the public surface, <code>GET</code> (list, single, export) accepts a publishable{" "}
            <code>pk_</code> key. Every mutation — create, patch, clear, delete, import — requires a{" "}
            <code>sk_</code> server key or the request returns <code>403 PERMISSION_DENIED</code>.
            Console calls use the realm-bound <code>CUSTOMER_CONSOLE</code> session token instead and
            are written to the hash-chained audit log.
          </P>
        </Callout>
        <Table
          head={["Method", "Path suffix", "Auth (public / console)", "Response"]}
          rows={[
            [<code>GET</code>, <code>/collections</code>, <><code>pk_</code>/<code>sk_</code> / session</>, <><code>{'{ collections: CollectionWithStats[], nextCursor }'}</code></>],
            [<code>POST</code>, <code>/collections</code>, <><code>sk_</code> / session</>, <>201 <code>CollectionRecord</code></>],
            [<code>GET</code>, <code>/collections/:name</code>, <><code>pk_</code>/<code>sk_</code> / session</>, <><code>CollectionWithStats | null</code></>],
            [<code>PATCH</code>, <code>/collections/:name</code>, <><code>sk_</code> / session</>, <code>CollectionWithStats</code>],
            [<code>POST</code>, <code>/collections/:name/clear</code>, <><code>sk_</code> / session</>, <><code>{'{ deletedCount, freedBytes }'}</code></>],
            [<code>DELETE</code>, <code>/collections/:name</code>, <><code>sk_</code> / session</>, <><code>{'{ deletedCollection, deletedDocuments, freedBytes }'}</code></>],
            [<code>POST</code>, <code>/collections/:name/import</code>, <><code>sk_</code> / session</>, <><code>{'{ importedCount, skippedCount, errors }'}</code></>],
            [<code>GET</code>, <code>/collections/:name/export</code>, <><code>pk_</code>/<code>sk_</code> / session</>, <><code>{'{ documents, nextCursor }'}</code></>],
          ]}
        />
        <Api method="GET" path="/v1/projects/:projectId/collections">
          <P>
            Required header: <code>x-vellum-api-key</code>. Query parameters: <code>search</code>{" "}
            (substring, ≤256 characters), <code>limit</code> (1–500, <strong>default 50</strong>),{" "}
            <code>cursor</code> (opaque continuation from <code>nextCursor</code>). Use{" "}
            <code>?limit=500</code> to see all collections when more than 50 exist — the Dashboard
            Data Explorer always does.
          </P>
          <Code
            title="Response · 200"
            code={JSON.stringify(
              {
                collections: [
                  {
                    id: "col_01J9F5K2M8",
                    name: "users",
                    description: "Customer accounts",
                    defaultTtlSeconds: 86400,
                    schemaValidation: { requiredFields: ["email"], strict: false },
                    isSystem: false,
                    metadata: {},
                    createdAt: "2026-11-19T10:00:00.000Z",
                    updatedAt: "2026-11-19T10:05:00.000Z",
                    documentCount: 12,
                    storageBytes: 4096,
                    lastDocumentAt: "2026-11-19T10:04:00.000Z",
                  },
                ],
                nextCursor: null,
              },
              null,
              2
            )}
          />
        </Api>
        <Api method="POST" path="/v1/projects/:projectId/collections">
          <P>
            Requires an <code>sk_</code> key. <code>name</code> is 1–128 characters matching{" "}
            <code>{'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'}</code>; <code>ifNotExists: true</code> makes
            registration idempotent. Settings: <code>description</code> (≤2048 chars),{" "}
            <code>defaultTtlSeconds</code> (positive integer),{" "}
            <code>schemaValidation.requiredFields</code> (string[]) with optional <code>strict</code>,
            and <code>metadata</code>. Unknown keys are rejected with <code>400 INVALID_ARGUMENT</code>.
          </P>
          <Code
            title="Request"
            code={JSON.stringify(
              {
                name: "users",
                description: "Customer accounts",
                defaultTtlSeconds: 86400,
                schemaValidation: { requiredFields: ["email"], strict: false },
                ifNotExists: true,
              },
              null,
              2
            )}
          />
          <P>
            <code>PATCH …/:name</code> accepts the same settings with <code>null</code> to clear{" "}
            <code>description</code>, <code>defaultTtlSeconds</code> or <code>schemaValidation</code>.
          </P>
        </Api>
        <Api method="POST" path="/v1/projects/:projectId/collections/:name/clear">
          <P>
            <strong>Clear</strong> soft-deletes every document (tombstones + outbox events) but keeps
            the collection registration and all settings. <strong>Delete</strong>{" "}
            (<code>DELETE …/:name</code>) removes the registration and every document. Both are
            metered and audited (<code>collection.clear</code> / <code>collection.delete</code>).
          </P>
          <Code
            title="Response · 200 (clear)"
            code={JSON.stringify({ deletedCount: 12, freedBytes: 4096 }, null, 2)}
          />
          <Code
            title="Response · 200 (delete)"
            code={JSON.stringify({ deletedCollection: true, deletedDocuments: 12, freedBytes: 4096 }, null, 2)}
          />
        </Api>
        <Api method="POST" path="/v1/projects/:projectId/collections/:name/import">
          <P>
            The body is a JSON array of at most 500 <code>{'{ id?, data }'}</code> objects, or the
            SDK envelope <code>{'{ documents, mode }'}</code>. Invalid
            entries are skipped and reported by zero-based <code>index</code> with a safe message.
            <code> GET …/:name/export</code> pages in <code>path ASC</code> order and returns{" "}
            <code>documents</code> with <code>id/path/data/version/createdAt/updatedAt</code> plus an
            opaque <code>nextCursor</code> — no SQL <code>OFFSET</code>.
          </P>
          <CodeTabs
            tabs={[
              {
                label: "Import request",
                lang: "json",
                code: JSON.stringify(
                  [
                    { id: "u_1", data: { name: "Ada", email: "ada@example.com" } },
                    { data: { name: "Grace" } },
                  ],
                  null,
                  2
                ),
              },
              {
                label: "Import response · 200",
                lang: "json",
                code: JSON.stringify({ importedCount: 2, skippedCount: 0, errors: [] }, null, 2),
              },
              {
                label: "Export response · 200",
                lang: "json",
                code: JSON.stringify(
                  {
                    documents: [
                      {
                        id: "u_1",
                        path: "users/u_1",
                        data: { name: "Ada" },
                        version: 3,
                        createdAt: "2026-11-19T10:00:00.000Z",
                        updatedAt: "2026-11-19T10:05:00.000Z",
                      },
                    ],
                    nextCursor: null,
                  },
                  null,
                  2
                ),
              },
            ]}
          />
          <P>
            SDK wrappers: <code>importDocuments(collection, docs, {'{ mode }'})</code> and{" "}
            <code>exportDocuments(collection, {'{ limit, cursor }'})</code> — see{" "}
            <PageLink slug="sdks/javascript">JavaScript SDK</PageLink> and{" "}
            <PageLink slug="sdks/flutter">Flutter SDK</PageLink>. Full lifecycle contract:{" "}
            <code>docs/COLLECTIONS-CONTRACT.md</code>.
          </P>
        </Api>
      </Section>

      <Section id="limits-and-errors" title="Limits and errors">
        <Table
          head={["Constraint", "Limit", "Error when exceeded"]}
          rows={[
            ["Document size", "1 MiB", "DOCUMENT_TOO_LARGE (413)"],
            ["Batch operations / payload", "100 ops / 5 MiB", "BATCH_SIZE_EXCEEDED (400) / PAYLOAD_TOO_LARGE (413)"],
            ["Transaction duration", "5,000 ms", "TRANSACTION_TIMEOUT (408)"],
            ["Where clauses / orderBy fields", "10 / 3", "QUERY_TOO_COMPLEX (400)"],
            ["Query limit / response", "500 (default 50) / 4 MiB", "LIMIT_EXCEEDED (400) / RESPONSE_TOO_LARGE (413)"],
          ]}
        />
        <P>
          The complete locked-v1 quota table lives in{" "}
          <PageLink slug="errors-and-limits">Quotas &amp; limits</PageLink>. For session-authenticated
          management endpoints, continue to the{" "}
          <PageLink slug="reference/rest-control-plane">control plane REST API</PageLink>.
        </P>
      </Section>
    </Doc>
  );
}
