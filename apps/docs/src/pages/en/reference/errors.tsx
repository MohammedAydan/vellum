import { Callout, Code, CodeTabs, Doc, H3, PageLink, P, Section, Table } from "../../../ui";

export default function Page() {
  return (
    <Doc
      title="Error codes & retry guidance"
      description="Every canonical VELLUM error code, its HTTP status, when it occurs and whether it is safe to retry."
      eyebrow="Reference"
    >
      <Section id="envelope" title="The error envelope">
        <P>
          Every failure returns a single JSON envelope. It is produced by{" "}
          <code>VellumError.toEnvelope(requestId)</code> and the HTTP error middleware; every
          response also carries an <code>X-Request-Id</code> header whose value is echoed as{" "}
          <code>error.requestId</code>. The SDKs copy <code>code</code>, <code>status</code>,{" "}
          <code>details</code> and <code>requestId</code> onto the thrown error.
        </P>
        <Code
          code={`{
  "error": {
    "code": "FAILED_PRECONDITION",
    "message": "Version precondition failed on 'users/u_123' (expected 4, actual 5)",
    "requestId": "req_01JCK9X2P8...",
    "details": {
      "path": "users/u_123",
      "expectedVersion": 4,
      "actualVersion": 5
    }
  }
}`}
          lang="json"
          title="400–599 response body"
        />
        <P>
          Branch on <code>code</code>, never on HTTP status alone — several distinct codes share a
          status, and WebSocket <code>error</code> frames carry no status at all. Treat{" "}
          <code>details</code> as an opaque record: its keys vary by code. Source of truth is{" "}
          <code>packages/core/src/errors.ts</code> (<code>ERROR_HTTP_STATUS</code>),{" "}
          <code>packages/api-contract/src/schemas/errors.ts</code> and the locked quotas in{" "}
          <PageLink slug="errors-and-limits">Quotas & limits</PageLink>.
        </P>
      </Section>

      <Section id="canonical-codes" title="Canonical codes & statuses">
        <P>
          The table below is the complete runtime set constructible as a <code>VellumError</code>.
          &ldquo;Retry&rdquo; assumes fixed or full-jitter backoff; it never means an immediate
          tight loop.
        </P>
        <Table
          head={["Code", "HTTP", "Typical trigger", "Retry"]}
          rows={[
            [<code>INVALID_ARGUMENT</code>, "400", "Schema/body validation failure, bad $op, empty index fields.", <><strong>No</strong> — fix the request.</>],
            [<code>INVALID_DOCUMENT_PATH</code>, "400", "Bad path grammar: parity, empty/relative/reserved segments, segment over 1,500 bytes.", <><strong>No</strong>.</>],
            [<code>INVALID_FIELD_NAME</code>, "400", "Empty, over 256-character or control-character field key.", <><strong>No</strong>.</>],
            [<code>MAX_NESTING_EXCEEDED</code>, "400", "Document data nested deeper than 20 levels.", <><strong>No</strong>.</>],
            [<code>BATCH_SIZE_EXCEEDED</code>, "400", "Batch or transaction has more than 100 operations.", <><strong>No</strong> — split the batch.</>],
            [<code>INVALID_CURSOR</code>, "400", "Malformed, tampered or modified HMAC cursor, or a cursor reused with a different query shape.", <><strong>No</strong> — restart pagination.</>],
            [<code>QUERY_TOO_COMPLEX</code>, "400", "More than 10 where clauses, 3 orderBy fields or 30 disjunctive values.", <><strong>No</strong> — simplify or add an index.</>],
            [<code>LIMIT_EXCEEDED</code>, "400", "Query limit above 500 (or below 1).", <><strong>No</strong>.</>],
            [<code>SUBSCRIPTION_LIMIT_EXCEEDED</code>, "400", "More than 50 subscriptions on one WebSocket connection.", <><strong>No</strong> — unsubscribe or open another connection.</>],
            [<code>UNAUTHENTICATED</code>, "401", "Missing/invalid API key, missing/invalid JWT, wrong MFA code, WS auth timeout.", <><strong>No</strong> — refresh credentials, then retry once.</>],
            [<code>TOKEN_EXPIRED</code>, "401", "An end-user access token passed its exp; includes EdDSA tokens on the document and WS planes.", <><strong>No</strong> — refresh the token, then replay the request.</>],
            [<code>PERMISSION_DENIED</code>, "403", "Key/project mismatch, rules denial, cross-tenant access, suspended project or account.", <><strong>No</strong> — authorization will not change on retry.</>],
            [<code>NOT_FOUND</code>, "404", "Document, API key, tenant, feature flag or route missing.", <><strong>No</strong>.</>],
            [<code>TRANSACTION_TIMEOUT</code>, "408", "OCC window (5,000 ms) elapsed before commit.", <><strong>Yes</strong> — restart with a fresh token.</>],
            [<code>ALREADY_EXISTS</code>, "409", "Document create on an occupied path, duplicate sign-up or duplicate composite index.", <><strong>No</strong> — use set/put instead.</>],
            [<code>ABORTED_CONFLICT</code>, "409", "OCC read-set version changed before commit, or a relation-rules replacement used a stale If-Match version.", <><strong>Yes</strong> — retry the whole transaction with backoff.</>],
            [<code>FAILED_PRECONDITION</code>, "412", "ifVersion/exists mismatch, non-numeric inc target, missing required index, MFA state error.", <><strong>No</strong> unless you re-read state first.</>],
            [<code>DOCUMENT_TOO_LARGE</code>, "413", "Serialized document above 1 MiB.", <><strong>No</strong>.</>],
            [<code>PAYLOAD_TOO_LARGE</code>, "413", "Batch payload above 5 MiB or an oversized WS frame.", <><strong>No</strong> — split the payload.</>],
            [<code>RESPONSE_TOO_LARGE</code>, "413", "Query response above 4 MiB.", <><strong>No</strong> — reduce limit or select.</>],
            [<code>RATE_LIMITED</code>, "429", "Per-key RPS limit, throttled project or MFA attempt throttle; Retry-After may be set.", <><strong>Yes</strong> — after Retry-After/backoff.</>],
            [<code>TOO_MANY_REQUESTS</code>, "429", "Too many attempts on an auth-rate-limited endpoint (e.g. repeated sign-in attempts).", <><strong>Yes</strong> — after backoff.</>],
            [<code>QUOTA_EXCEEDED</code>, "429", "Plan or tenant quota exhausted.", <><strong>No</strong> until quota rises or usage resets.</>],
            [<code>SLOW_CONSUMER_DISCONNECT</code>, "429", "WebSocket outbound buffer above 1 MiB; connection is closed.", <><strong>No</strong> — drain faster.</>],
            [<code>INTERNAL_ERROR</code>, "500", "Unexpected server-side invariant or integrity failure.", <><strong>Retry once</strong> with backoff, then report with requestId.</>],
            [<code>SERVICE_UNAVAILABLE</code>, "503", "Dependency or readiness-probe failure.", <><strong>Yes</strong> — after backoff, with a deadline.</>],
            [<code>QUERY_DEADLINE_EXCEEDED</code>, "504", "Query exceeded its 5,000 ms execution budget.", <><strong>Yes</strong> — narrow the query or add an index.</>],
          ]}
        />
        <H3 id="wire-enum-aliases">Codes in the wire enum without a core status</H3>
        <P>
          The Zod <code>ErrorCodeEnum</code> additionally declares <code>ABORTED</code>,{" "}
          <code>RESOURCE_EXHAUSTED</code>, <code>DEADLINE_EXCEEDED</code>, <code>UNAVAILABLE</code>{" "}
          and <code>INTERNAL</code>. They are not keys of <code>ERROR_HTTP_STATUS</code> and are not
          constructible as <code>VellumError</code> codes; if they reach the middleware they fall
          through to status 500. Prefer the mapped equivalents in the table above:{" "}
          <code>ABORTED_CONFLICT</code>, <code>RATE_LIMITED</code>/<code>QUOTA_EXCEEDED</code>,{" "}
          <code>QUERY_DEADLINE_EXCEEDED</code>, <code>SERVICE_UNAVAILABLE</code> and{" "}
          <code>INTERNAL_ERROR</code>. <code>INTERNAL</code> is the fallback envelope code for
          unexpected exceptions; treat it like <code>INTERNAL_ERROR</code> — server fault, retry
          sparingly, always include the <code>requestId</code>.
        </P>
        <Callout tone="danger" title="Never log credentials with the error">
          Error details and messages are redacted through{" "}
          <code>@vellum/observability</code>. Do not add raw API keys (<code>pk_</code>/{" "}
          <code>sk_</code>), bearer tokens or database URLs to your own error reports. The{" "}
          <code>requestId</code> is the safe correlation handle.
        </Callout>
      </Section>

      <Section id="quota-mapping" title="Quota → error mapping">
        <P>
          The v1 quotas are locked in <code>@vellum/core</code>; exceeding one always produces a
          specific code. This is the condensed form — the full constant list, including rules AST
          and index-count limits, is on{" "}
          <PageLink slug="errors-and-limits">Quotas & limits</PageLink> and in{" "}
          <PageLink slug="reference/wire-format">Wire format & paths</PageLink>.
        </P>
        <Table
          head={["Limit", "Value", "Error / status"]}
          rows={[
            ["Document bytes", "1 MiB", <><code>DOCUMENT_TOO_LARGE</code> / 413</>],
            ["Path depth", "10 segments", <><code>INVALID_DOCUMENT_PATH</code> / 400</>],
            ["Path segment bytes", "1,500", <><code>INVALID_DOCUMENT_PATH</code> / 400</>],
            ["Object nesting", "20", <><code>MAX_NESTING_EXCEEDED</code> / 400</>],
            ["Field name length", "256", <><code>INVALID_FIELD_NAME</code> / 400</>],
            ["Batch operations", "100", <><code>BATCH_SIZE_EXCEEDED</code> / 400</>],
            ["Batch payload", "5 MiB", <><code>PAYLOAD_TOO_LARGE</code> / 413</>],
            ["Transaction duration", "5,000 ms", <><code>TRANSACTION_TIMEOUT</code> / 408</>],
            ["Where clauses / orderBy / disjunctive values", "10 / 3 / 30", <><code>QUERY_TOO_COMPLEX</code> / 400</>],
            ["Query limit", "500 (default 50)", <><code>LIMIT_EXCEEDED</code> / 400</>],
            ["Query response", "4 MiB", <><code>RESPONSE_TOO_LARGE</code> / 413</>],
            ["WS subscriptions / connection", "50", <><code>SUBSCRIPTION_LIMIT_EXCEEDED</code> / 400</>],
            ["WS outbound buffer", "1 MiB", <><code>SLOW_CONSUMER_DISCONNECT</code> / 429</>],
          ]}
        />
      </Section>

      <Section id="retry-policy" title="Retry policy">
        <P>
          Split codes into three buckets. Retry transient faults with backoff; retry stateful
          faults only after changing something; never blindly retry validation or authorization
          failures.
        </P>
        <Table
          head={["Safe to retry (with backoff)", "Retry after changing something", "Never retry blindly"]}
          rows={[
            [
              <><code>TRANSACTION_TIMEOUT</code>, <code>ABORTED_CONFLICT</code>, <code>RATE_LIMITED</code>, <code>TOO_MANY_REQUESTS</code>, <code>SERVICE_UNAVAILABLE</code>, <code>QUERY_DEADLINE_EXCEEDED</code>, <code>INTERNAL_ERROR</code> (once)</>,
              <><code>UNAUTHENTICATED</code> (refresh token), <code>TOKEN_EXPIRED</code> (refresh token), <code>FAILED_PRECONDITION</code> (re-read state), <code>QUOTA_EXCEEDED</code> (wait for reset)</>,
              <>4xx validation/authz errors: <code>INVALID_ARGUMENT</code>, <code>INVALID_DOCUMENT_PATH</code>, <code>INVALID_FIELD_NAME</code>, <code>MAX_NESTING_EXCEEDED</code>, <code>BATCH_SIZE_EXCEEDED</code>, <code>INVALID_CURSOR</code>, <code>QUERY_TOO_COMPLEX</code>, <code>LIMIT_EXCEEDED</code>, <code>PERMISSION_DENIED</code>, <code>NOT_FOUND</code>, <code>ALREADY_EXISTS</code>, <code>DOCUMENT_TOO_LARGE</code>, <code>PAYLOAD_TOO_LARGE</code>, <code>RESPONSE_TOO_LARGE</code>, <code>SLOW_CONSUMER_DISCONNECT</code></>,
            ],
          ]}
        />
        <P>
          Both SDKs use full-jitter backoff:{" "}
          <code>sleep = random(0, min(tMax, t0 · 2^attempt))</code> with{" "}
          <code>t0 = 500&nbsp;ms</code> and <code>tMax = 30,000&nbsp;ms</code> for reconnects
          (OCC commits use <code>t0 = 25&nbsp;ms</code>, <code>tMax = 500&nbsp;ms</code> in the JS
          SDK).
        </P>
        <CodeTabs
          tabs={[
            {
              label: "Branch on code",
              lang: "ts",
              code: `try {
  await db.collection("users").doc("u_123").update({ name: "Ada" });
} catch (err) {
  const e = err as { code?: string; details?: Record<string, unknown> };
  switch (e.code) {
    case "FAILED_PRECONDITION":
    case "ABORTED_CONFLICT": // re-read, then retry the operation
      return retryWithBackoff();
    case "PERMISSION_DENIED": // check scopes or rules
      return showAccessError();
    default:
      throw err;
  }
}`,
            },
            {
              label: "Respect Retry-After",
              lang: "ts",
              code: `if (e.code === "RATE_LIMITED") {
  const ms = Number(e.details?.retryAfterMs ?? 1000);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return retry();
}`,
            },
            {
              label: "Full jitter",
              lang: "ts",
              code: `function fullJitter(attempt: number): number {
  const t0 = 500, tMax = 30_000;
  return Math.random() * Math.min(tMax, t0 * 2 ** attempt);
}`,
            },
          ]}
        />
      </Section>

      <Section id="websocket-errors" title="Errors on the WebSocket plane">
        <P>
          Realtime failures arrive as an <code>error</code> frame rather than an HTTP status; the
          frame carries the same canonical <code>code</code>. Transport-level timeouts use{" "}
          <code>subId: "connection"</code>; subscription failures echo the offending{" "}
          <code>subId</code>. When a rules check denies a subscription, the subscription is not
          registered.
        </P>
        <Code
          code={`{ "type": "error", "subId": "sub_3", "code": "PERMISSION_DENIED", "message": "list denied" }
{ "type": "error", "subId": "connection", "code": "UNAUTHENTICATED", "message": "Authentication timeout" }
{ "type": "error", "subId": "sub_4", "code": "SUBSCRIPTION_LIMIT_EXCEEDED", "message": "Maximum of 50 active subscriptions exceeded" }`}
          lang="json"
          title="Error frames"
        />
        <P>
          See the{" "}
          <PageLink slug="reference/realtime-protocol">Realtime WebSocket protocol</PageLink> for
          every frame shape, the auth handshake and resume behavior, or the{" "}
          <PageLink slug="reference/rest-data-plane">Data plane REST API</PageLink> for the
          endpoints that produce these statuses over HTTP.
        </P>
      </Section>
    </Doc>
  );
}
