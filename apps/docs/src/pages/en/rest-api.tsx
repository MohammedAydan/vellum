import { Api, Callout, Code, CodeTabs, Doc, P, PageLink, Section, Table } from "../../ui";

export default function Page() {
  return (
    <Doc
      title="REST API"
      description="Every VELLUM capability is reachable over HTTP under /v1. This page maps the endpoint families, the two authentication models, and the response conventions shared by the whole API."
      eyebrow="Reference"
    >
      <Section id="overview" title="Overview">
        <P>
          The HTTP API is mounted at <code>/v1</code>. Every response is JSON and carries an{" "}
          <code>X-Request-Id</code> header — capture it on errors so support can correlate an incident
          without handling your credentials. A machine-readable OpenAPI 3.1 document is served at{" "}
          <code>GET /v1/openapi.json</code>; it is the authoritative request and response schema for
          every route.
        </P>
        <P>
          The <strong>document plane</strong> authenticates each call with an API key sent in a header,
          plus an optional EdDSA end-user bearer. An API key never authorizes anything outside the
          document plane, and no other credential is accepted on it.
        </P>
        <Callout tone="info" title="Prefer an SDK for application code">
          <P>
            Use raw HTTP when calling from a language without an official SDK, or when debugging.
            The endpoint-by-endpoint reference covers{" "}
            <PageLink slug="reference/rest-data-plane">data plane operations</PageLink>.
          </P>
        </Callout>
      </Section>

      <Section id="authentication" title="Authentication">
        <P>
          Data plane calls are scoped by <code>projectId</code> in the URL, and the
          API key you send must belong to that exact project.
        </P>
        <Table
          head={["Header", "Value", "Used for"]}
          rows={[
            [<code>x-vellum-api-key</code>, <code>pk_…</code>, "Public key — browser and mobile clients; scopes documents:read and documents:write."],
            [<code>x-vellum-api-key</code>, <code>sk_…</code>, "Secret key — trusted servers; additionally carries indexes:manage."],
            [<><code>x-vellum-user-token</code> / <code>authorization</code></>, <code>Bearer &lt;EdDSA JWT&gt;</code>, "Optional end-user identity used when evaluating security rules."],
            [<code>x-project-key</code>, "API key", "Legacy alias for x-vellum-api-key. Accepted for compatibility; do not use in new code."],
          ]}
        />
        <P>
          An end-user token must be an EdDSA <code>vellum+enduser+jwt</code> verified against the
          project's Ed25519 configuration. There is no HS256 fallback: an invalid token returns{" "}
          <code>401 UNAUTHENTICATED</code> rather than silently degrading to an anonymous context. See{" "}
          <PageLink slug="end-user-auth">End-user authentication</PageLink>.
        </P>
        <P>
          End-user tokens rotate as single-use refresh hashes, and refresh cookies are{" "}
          <code>HttpOnly</code> with project-specific names and paths. See{" "}
          <PageLink slug="authentication">Authentication</PageLink>.
        </P>
      </Section>

      <Section id="endpoint-families" title="Endpoint families">
        <Table
          head={["Family", "Base path", "Auth", "What it does"]}
          rows={[
            ["Health", <code>/v1/health/live</code>, "Public", "Process liveness; never touches PostgreSQL."],
            ["Readiness", <code>/v1/health/ready</code>, "Public", "Real control/data DB, migration and LISTEN probes; 503 when unready."],
            ["Metadata", <code>/v1/openapi.json</code>, "Public", "OpenAPI 3.1 specification."],
            [<PageLink slug="reference/rest-data-plane">Documents</PageLink>, <code>/v1/projects/:projectId/documents/*</code>, "API key", "GET doc/collection, POST create, PUT set, PATCH update, DELETE soft-delete."],
            ["Query", <code>/v1/projects/:projectId/query</code>, "API key + rules", "Structured where / orderBy / select / cursor query."],
            ["Batch", <code>/v1/projects/:projectId/batchWrite</code>, "API key + rules", "Up to 100 atomic mutations in one transaction."],
            [<PageLink slug="relationships">Relations</PageLink>, <>…/documents:referencedBy · …/documents:aggregate · …/documents:bulk-delete</>, "API key + rules", "Reverse lookups to referencing documents, grouped aggregates and reference-aware bulk delete."],
            [<PageLink slug="realtime">Realtime</PageLink>, <code>/v1/realtime</code>, "API key over WebSocket", "Durable subscribe/resume with watermarks and gap detection; opt-in relation includes."],
            ["Transactions", <><code>…/transactions:begin</code> / <code>…/transactions:commit</code></>, "API key + rules", "Issue an OCC token and commit a read-verify-write cycle."],
            ["Indexes", <><code>…/indexes</code> / <code>…/indexes/:indexId</code></>, "sk_ with indexes:manage", "List, register and delete composite indexes."],
            ["Collections", <><code>…/collections</code> / <code>…/collections/:name</code></>, "pk_ reads, sk_ writes", "Eight lifecycle endpoints: list, create, info, patch, clear, delete, import, export."],
            ["Auth", <code>/v1/projects/:projectId/auth/**</code>, "API key", "End-user email sign-up and sign-in, token refresh, sign-out, MFA."],
          ]}
        />
      </Section>

      <Section id="collections-lifecycle" title="Collections lifecycle">
        <P>
          Collections are persisted registry rows, not an inferred <code>DISTINCT</code> list. Eight
          REST endpoints manage them under{" "}
          <code>/v1/projects/:projectId/collections…</code> (API-key auth). Reads (list, single, export) accept a <code>pk_</code> key; writes
          (create, patch, clear, delete, import) require an <code>sk_</code> key. Listing defaults to{" "}
          <code>limit=50</code> — pass <code>?limit=500</code> to see all collections when more than
          50 exist. <strong>Clear</strong> removes every document but keeps the registration and
          settings; <strong>delete</strong> removes both. Import takes a JSON array of at most 500{" "}
          <code>{'{ id?, data }'}</code> objects; export returns <code>documents</code> plus an opaque{" "}
          <code>nextCursor</code> in <code>path ASC</code> order. Import also accepts the SDK
          envelope <code>{'{ documents, mode }'}</code>.
        </P>
        <P>
          Full request/response shapes, settings fields and SDK wrappers are in{" "}
          <PageLink slug="reference/rest-data-plane">Data plane REST API § Collections lifecycle</PageLink>.
        </P>
      </Section>

      <Section id="conventions" title="Request and response conventions">
        <P>
          Request bodies are JSON — send <code>content-type: application/json</code>. The{" "}
          Any other value is rejected with{" "}
          <code>400 INVALID_ARGUMENT</code>. Every query response is cursor-paginated: pass the{" "}
          <code>nextCursor</code> you receive back as <code>startAfter</code>. There is no SQL{" "}
          <code>OFFSET</code> in the public API.
        </P>
        <P>Errors use one canonical envelope with the exact code and HTTP status:</P>
        <Code
          title="Error envelope · 412"
          code={JSON.stringify(
            {
              error: {
                code: "FAILED_PRECONDITION",
                message: "Query on 'users' requires a composite index for the requested filters and sort order.",
                requestId: "req_01J9F5K2M8",
                details: {
                  collectionPath: "users",
                  suggestedIndex: { collectionPath: "users", fields: [{ path: "status", dir: "asc" }] },
                },
              },
            },
            null,
            2
          )}
        />
        <P>
          Codes are fixed and documented in{" "}
          <PageLink slug="reference/errors">Error codes &amp; retry guidance</PageLink>; the numeric
          quotas behind them are in{" "}
          <PageLink slug="errors-and-limits">Quotas &amp; limits</PageLink>.
        </P>
      </Section>

      <Section id="raw-examples" title="Two raw requests">
        <P>
          Discover the live contract first, then make a key-authenticated read and a structured query.
          Credentials belong in headers, never in a URL or source control.
        </P>
        <Code
          title="Discover the contract"
          code={'curl -fsS "https://api.example.com/v1/openapi.json" | jq \'.paths | keys[]\''}
        />
        <Api method="GET" path="/v1/projects/:projectId/documents/*">
          <P>Required headers: <code>x-vellum-api-key</code>. No body.</P>
          <Code
            title="Request"
            code={'curl "https://api.example.com/v1/projects/PROJECT_ID/documents/users/u_123" \\\n  -H "x-vellum-api-key: pk_…"'}
          />
          <Code
            title="Response · 200"
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
        </Api>
        <Api method="POST" path="/v1/projects/:projectId/query">
          <P>Required headers: <code>x-vellum-api-key</code>, <code>content-type: application/json</code>.</P>
          <CodeTabs
            tabs={[
              {
                label: "cURL",
                lang: "bash",
                code: 'curl -X POST "https://api.example.com/v1/projects/PROJECT_ID/query" \\\n  -H "x-vellum-api-key: pk_…" \\\n  -H "content-type: application/json" \\\n  -d \'{"collectionPath":"users","where":[{"field":"status","op":"==","value":"active"}],"limit":25}\'',
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
                        data: { name: "Ada", status: "active" },
                        sizeBytes: 104,
                        version: 3,
                        createdAt: "2026-11-15T14:30:00.123Z",
                        updatedAt: "2026-11-17T09:00:00.000Z",
                      },
                    ],
                    nextCursor: "eyJ2IjoxLCJpZCI6InVfMTIzIn0",
                    meta: { count: 1, indexUsed: "primary_btree", executionTimeMs: 1.234 },
                  },
                  null,
                  2
                ),
              },
            ]}
          />
        </Api>
      </Section>

      <Section id="next-steps" title="Next steps">
        <Table
          head={["Read", "Why"]}
          rows={[
            [<PageLink slug="reference/rest-data-plane">Data plane REST API</PageLink>, "Exact request and response JSON for documents, query, batch, transactions and indexes."],
            [<PageLink slug="reference/wire-format">Wire format &amp; paths</PageLink>, "Tagged values, $op transforms and path grammar."],
            [<PageLink slug="reference/realtime-protocol">Realtime WebSocket protocol</PageLink>, "Live change streams over /v1/realtime."],
          ]}
        />
      </Section>
    </Doc>
  );
}
