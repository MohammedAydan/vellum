import { Callout, Doc, H3, P, PageLink, Section, Table } from "../../../ui";

export default function Page() {
  return (
    <Doc
      title="Package APIs"
      description="The framework-agnostic @vellum/* libraries under packages/*, what each one owns, and the exports that matter."
      eyebrow="Reference"
    >
      <Section id="internal-vs-public" title="Internal building blocks, not the public SDK">
        <P>
          The libraries below are the internal building blocks used by <code>apps/api</code>{" "}
          and the two client SDKs. They are not a supported public product surface: their
          exports can change between releases, and a few paths — notably{" "}
          <code>@vellum/core</code> tagged-value constructors and{" "}
          <code>@vellum/query-engine</code> cursors — are wire-format critical. Application
          code should depend on <PageLink slug="sdks/javascript">@vellum/sdk-js</PageLink>,{" "}
          <PageLink slug="sdks/flutter">vellum_flutter</PageLink>, or plain HTTP instead.
        </P>
        <Callout tone="warning" title="Layering rule">
          All domain logic lives in these framework-agnostic packages. The API, dashboard
          and admin are thin delivery adapters: no AST evaluation, wire serialization or
          SQL compilation belongs in a route handler or UI component.
        </Callout>
      </Section>

      <Section id="package-map" title="Every package in the monorepo">
        <P>
          The repository contains thirteen packages under <code>packages/*</code>. Eleven
          form the runtime blueprint; <code>auth</code> and <code>ui</code> provide
          end-user auth primitives and the shared React design system. None of them import
          Hono, Next.js or React as domain dependencies, although <code>ui</code> and{" "}
          <code>sdk-js</code> target the browser by design.
        </P>
        <Table
          head={["Package", "Responsibility", "Layer"]}
          rows={[
            [<code>@vellum/core</code>, "Locked limits, canonical error hierarchy, path parser, tagged wire format and order-preserving sort-key encoder. Lowest-level package.", "Foundation"],
            [<code>@vellum/api-contract</code>, "Runtime Zod schemas, OpenAPI 3.1 generator, canonical WebSocket frames and boundary validators used by API routes.", "Contract"],
            [<code>@vellum/auth</code>, "End-user authentication primitives: password hashing, field encryption, JWT, realm sessions, MFA, session services and mail.", "Security"],
            [<code>@vellum/authorization</code>, "API-key generation/verification, JWT claims, session tokens and revocation, RFC 6238 TOTP helpers and the deterministic rules AST evaluator.", "Security"],
            [<code>@vellum/database-control</code>, "Control Plane SQL, Drizzle schema and migrations: users, organizations, projects, key hashes, rulesets, metering and audit.", "Persistence"],
            [<code>@vellum/database-data</code>, "Data Plane SQL, Drizzle schema and RLS policies: documents, index definitions, index entries, realtime outbox and OCC transactions.", "Persistence"],
            [<code>@vellum/storage</code>, "StorageAdapter contract with in-memory, PostgreSQL and Neon adapters; tenant transaction context that binds RLS settings; TTL caches and the invalidation bus.", "Persistence"],
            [<code>@vellum/query-engine</code>, "Query validation/normalization, composite-index selection, parameterized SQL compilation and HMAC-SHA256 signed cursors.", "Query"],
            [<code>@vellum/document-engine</code>, "Document core: CRUD, atomic field transforms, batchWrite, structured query and PostgreSQL-backed OCC transactions.", "Engine"],
            [<code>@vellum/realtime</code>, "WebSocket hub, subscription matcher, gap-detecting outbox poller and the dedicated LISTEN/NOTIFY bus. No broker.", "Realtime"],
            [<code>@vellum/observability</code>, "Structured JSON logging with secret redaction, sliding-window rate limiting and request-id generation.", "Platform"],
            [<code>@vellum/sdk-js</code>, "Official TypeScript/JavaScript client SDK: createClient, references, queries, auth, batch/transactions and realtime snapshots.", "SDK"],
            [<code>@vellum/ui</code>, "Private shadcn-based React component library, design tokens and RTL-aware English/Arabic i18n shared by the dashboards.", "UI"],
          ]}
        />
      </Section>

      <Section id="foundation-and-contracts" title="Foundation and contracts">
        <H3 id="core">@vellum/core</H3>
        <P>
          Pure, dependency-light and the lowest-level package in the graph. It defines the
          wire and limit vocabulary that every other package imports.
        </P>
        <Table
          head={["Export", "What it does"]}
          rows={[
            [<code>SYSTEM_LIMITS</code>, "All locked v1 quotas. See Quotas &amp; limits."],
            [<code>VellumError</code>, "Canonical throwable with code, status, details and toEnvelope(requestId)."],
            [<code>ERROR_HTTP_STATUS</code>, "Canonical code to HTTP status map."],
            [<><code>parseDocumentPath</code> / <code>parseCollectionPath</code></>, "Validate even 2–10 segment document paths and odd 1–9 segment collection paths."],
            [<><code>validateWireValue</code> / <code>validateFieldName</code></>, "Recursive tagged-value and field-op validation, nesting and field-name bounds."],
            [<code>normalizeAndValidateDocumentData</code>, "Canonicalizes data and enforces the 1 MiB document cap."],
            [<code>WireValue</code>, "Constructors for $t/$v tagged values: int64, timestamp, reference, bytes, geopoint, escapeMap."],
            [<><code>encodeSortableFloat64</code> / <code>encodeSortableInt64</code></>, "Order-preserving big-endian byte encodings for composite index sort keys."],
          ]}
        />
        <H3 id="api-contract">@vellum/api-contract</H3>
        <P>
          The boundary validator. It owns the runtime shapes for document, query,
          transaction, error and WebSocket traffic, plus the served OpenAPI 3.1 document.
        </P>
        <Table
          head={["Export", "What it does"]}
          rows={[
            [<code>generateOpenApiSpec</code>, "Builds the OpenAPI 3.1 document served at /v1/openapi.json."],
            [<code>validateClientWsFrame</code>, "Zod-validates inbound WebSocket frames."],
            [<><code>QuerySpecSchema</code>, <code>BatchWriteSchema</code>, <code>CommitTransactionSchema</code></>, "Runtime validation of public request bodies."],
            [<><code>ClientFrameSchema</code> / <code>ServerFrameSchema</code></>, "Canonical realtime frame unions."],
            [<><code>ApiErrorSchema</code> / <code>ErrorCodeEnum</code></>, "Canonical error envelope and code set."],
            [<><code>TaggedObjectSchema</code> / <code>DocumentPayloadSchema</code></>, "Wire-format representation, including legacy alias normalization."],
          ]}
        />
      </Section>

      <Section id="security-packages" title="Security packages">
        <H3 id="authorization">@vellum/authorization</H3>
        <P>
          The deterministic security core: key verification, claim verification, revocation,
          TOTP MFA and the rules evaluator. Rules are validated against the v1 JSON AST
          (depth ≤ 10, nodes ≤ 100) and evaluated synchronously with no <code>eval()</code>.
        </P>
        <Table
          head={["Export", "What it does"]}
          rows={[
            [<code>generateProjectApiKey</code>, "Creates pk_/sk_ keys; returns the full key, prefix, secret hash and key type."],
            [<><code>hashApiKey</code> / <code>verifyApiKey</code></>, "Peppered SHA-256 digest with constant-time compare and a 30-second in-process cache."],
            [<code>invalidateApiKeyCache</code>, "Clears one or all verified-key cache entries."],
            [<><code>signEndUserJwt</code> / <code>verifyEndUserJwt</code></>, "JWT helpers; verification supports remote JWKS."],
            [<code>validateSecurityRulesetAst</code>, "Enforces the v1 AST depth and node bounds."],
            [<><code>evaluateAstNode</code> / <code>authorizeOperation</code></>, "Synchronous expression evaluation and scope/rules authorization; denies by default."],
            [<code>createSessionService</code>, "Access/refresh token service with a revocation store."],
            [<><code>generateTotpCode</code> / <code>verifyTotp</code></>, "RFC 6238 TOTP and recovery-code lifecycle helpers."],
          ]}
        />
        <H3 id="auth">@vellum/auth</H3>
        <P>
          End-user authentication primitives backed by <code>node:crypto</code> and{" "}
          <code>nodemailer</code>: password handling, field encryption, end-user JWTs, the
          three-realm session model, MFA, session services, a projector and mail delivery.
          See <PageLink slug="end-user-auth">End users &amp; the three realms</PageLink>.
        </P>
      </Section>

      <Section id="data-plane-packages" title="Data plane, query and document engine">
        <H3 id="databases">@vellum/database-control and @vellum/database-data</H3>
        <P>
          The two physically and logically separate PostgreSQL planes. Control stores
          platform identity and configuration; Data stores customer documents and the
          realtime/outbox state. Bootstrap, operator login and key verification never
          depend on the public document API. Each package exposes a Drizzle schema via its{" "}
          <code>./schema</code> subpath and its own <code>migrate</code> script.
        </P>
        <H3 id="storage">@vellum/storage</H3>
        <Table
          head={["Export", "What it does"]}
          rows={[
            [<code>createStorageAdapter</code>, "Selects memory, pg or neon driver from explicit options or URL inference."],
            [<code>StorageAdapter</code>, "The sole data-plane persistence seam: documents, indexes, outbox, workers; every method takes a TenantContext."],
            [<code>TenantContext</code>, <><code>{"{ projectId }"}</code> — mandatory scope for every operation.</>],
            [<code>runInTenantTransactionAsync</code>, "Opens a raw PG client, binds tenant settings and runs the callback."],
            [<><code>SQL_SET_STATEMENT_TIMEOUT</code>, <code>SQL_SET_PROJECT</code></>, "SET LOCAL statement_timeout='5000ms' and app.current_project_id so RLS fails closed."],
            [<><code>createTtlCache</code> / <code>getNamedCache</code></>, "In-process 30–60s TTL caches instead of a second stateful service."],
            [<code>createCacheInvalidationBus</code>, "LISTEN/NOTIFY bus on vellum_cache_invalidate for cross-instance invalidation."],
          ]}
        />
        <H3 id="query-engine">@vellum/query-engine</H3>
        <P>
          Validates and normalizes queries, selects a tenant composite index, compiles
          parameterized SQL (never string-built predicates) and signs opaque cursors. See{" "}
          <PageLink slug="query">Query</PageLink> and{" "}
          <PageLink slug="indexes">Composite indexes</PageLink>.
        </P>
        <Table
          head={["Export", "What it does"]}
          rows={[
            [<code>validateAndNormalizeQuery</code>, "Bounds where/orderBy/limit and resolves collection paths."],
            [<code>compileQueryToParameterizedSql</code>, "Emits tenant-scoped parameterized SQL."],
            [<code>selectCompositeIndexForQuery</code>, "Returns the matched index and whether one is required."],
            [<code>computeIndexDefinitionHash</code>, "SHA-256 of a composite index definition."],
            [<code>computeQueryShapeHash</code>, "SHA-256 of the canonical query shape, bound into the cursor."],
            [<><code>encodeQueryCursor</code> / <code>decodeAndVerifyQueryCursor</code></>, "Base64url JSON plus HMAC-SHA256; verification throws INVALID_CURSOR."],
          ]}
        />
        <H3 id="document-engine">@vellum/document-engine</H3>
        <P>
          The business core that route handlers call. It owns CRUD, field transforms,
          batch writes, query execution and the database-backed OCC transaction lifecycle:{" "}
          <code>getDocument</code>, <code>setDocument</code>, <code>updateDocument</code>,{" "}
          <code>deleteDocument</code>, <code>batchWrite</code>, <code>executeQuery</code>,{" "}
          <code>beginTransaction</code> / <code>commitTransaction</code> /{" "}
          <code>rollbackTransaction</code>, plus <code>applyFieldTransforms</code>.
        </P>
      </Section>

      <Section id="delivery-packages" title="Realtime, observability and frontends">
        <Table
          head={["Package", "Key surface"]}
          rows={[
            [<code>@vellum/realtime</code>, "RealtimeGatewayHub (subscribe/resume, fan-out, slow-consumer guard), OutboxPoller (500-row batches, gap detection), createPgNotifyBus on the vellum_outbox channel, and createPgRealtimeInfrastructure. One dedicated, non-pooled LISTEN client."],
            [<code>@vellum/observability</code>, "createLogger / StructuredLogger, redactSensitiveData, SlidingWindowRateLimiter (default 100 RPS) and generateRequestId."],
            [<code>@vellum/sdk-js</code>, "createClient and the public document, query, auth, batch, transaction and snapshots API. This is the supported JS/TS entry point."],
            [<code>@vellum/ui</code>, "Shared React primitives, composed app-shell components, domain components and RTL-aware i18n. Private to the frontends."],
          ]}
        />
        <P>
          The realtime protocol itself is documented in{" "}
          <PageLink slug="reference/realtime-protocol">Realtime WebSocket protocol</PageLink>;
          the runtime guardrails that keep these packages safe in production are in{" "}
          <PageLink slug="production-checklist">Production checklist</PageLink>.
        </P>
      </Section>
    </Doc>
  );
}
