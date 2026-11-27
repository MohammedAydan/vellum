import {
  Callout,
  Doc,
  P,
  PageLink,
  Section,
  Table,
} from "../../ui";

export default function Page() {
  return (
    <Doc
      eyebrow="Reference"
      title="Quotas &amp; Limits"
      description="Exact system limits enforced by @vellum/core, @vellum/query-engine, @vellum/authorization, and @vellum/database-data—plus the canonical error code returned on each breach."
    >
      <P>
        Every limit below is enforced server-side in code before expensive database work begins.
        All API errors follow the canonical envelope{" "}
        <code>{`{ "error": { "code", "message", "details" } }`}</code> with an{" "}
        <code>x-request-id</code> header.
      </P>

      <Section id="document-and-batch-limits" title="Documents, paths &amp; batch writes">
        <Table
          head={["Constant", "Limit", "Error Code"]}
          rows={[
            [<code>MAX_DOCUMENT_BYTES</code>, "1,048,576 bytes (1 MiB)", <code>DOCUMENT_TOO_LARGE</code>],
            [<code>MAX_PATH_DEPTH</code>, "10 segments (5 nested collections: c1/d1..c5/d5)", <code>INVALID_DOCUMENT_PATH</code>],
            [<code>MAX_PATH_SEGMENT_BYTES</code>, "1,500 UTF-8 bytes per segment", <code>INVALID_DOCUMENT_PATH</code>],
            [<code>MAX_OBJECT_NESTING_DEPTH</code>, "20 levels inside document JSONB data", <code>INVALID_ARGUMENT</code>],
            [<code>MAX_FIELD_NAME_LENGTH</code>, "256 characters per field key", <code>INVALID_ARGUMENT</code>],
            [<code>MAX_BATCH_OPERATIONS</code>, "100 operations per atomic batchWrite / transaction", <code>BATCH_SIZE_EXCEEDED</code>],
            [<code>MAX_BATCH_PAYLOAD_BYTES</code>, "5,242,880 bytes (5 MiB) — enforced on chunked streams too", <code>PAYLOAD_TOO_LARGE</code>],
            [<code>MAX_TRANSACTION_DURATION_MS</code>, "15,000 ms interactive OCC window", <code>TRANSACTION_EXPIRED</code>],
          ]}
        />
      </Section>

      <Section id="query-and-cursor-limits" title="Queries, projections, relations &amp; cursors">
        <Table
          head={["Constant", "Limit", "Error Code"]}
          rows={[
            [<code>MAX_WHERE_CLAUSES</code>, "10 clauses per where or or group (max 10 or groups)", <code>QUERY_TOO_COMPLEX</code>],
            [<code>MAX_DISJUNCTIVE_VALUES</code>, "30 values per in / not-in / array-contains-any", <code>QUERY_TOO_COMPLEX</code>],
            [<code>MAX_TOTAL_DISJUNCTIVE_EXPANSIONS</code>, "120 total array-contains-any expansions per query", <code>QUERY_TOO_COMPLEX</code>],
            [<code>MAX_ORDER_BY_FIELDS</code>, "3 explicit orderBy fields (+ documentId tie-breaker)", <code>QUERY_TOO_COMPLEX</code>],
            [<code>MAX_SELECT_FIELDS</code>, "50 projected fields (100 jsonb_build_object args)", <code>QUERY_TOO_COMPLEX</code>],
            [<code>MAX_FIELD_DEPTH</code>, "16 dot-path nesting levels", <code>INVALID_ARGUMENT</code>],
            [<code>MAX_TEXT_FILTER_LENGTH</code>, "1,024 characters for contains_ci / starts_with_ci / text_search", <code>QUERY_TOO_COMPLEX</code>],
            [<><code>DEFAULT_QUERY_LIMIT</code> / <code>MAX_QUERY_LIMIT</code></>, "50 default / 500 maximum docs per page", <code>LIMIT_EXCEEDED</code>],
            [<code>MAX_QUERY_RESPONSE_BYTES</code>, "4,194,304 bytes (4 MiB)", <code>LIMIT_EXCEEDED</code>],
            [<code>MAX_QUERY_EXECUTION_MS</code>, "5,000 ms PostgreSQL statement_timeout", <code>DEADLINE_EXCEEDED</code>],
            [<code>MAX_CURSOR_TOKEN_BYTES</code>, "16,384 bytes (checked before base64url decode)", <code>INVALID_CURSOR</code>],
            [<><code>MAX_RELATION_DEPTH</code> / <code>MAX_INCLUDES</code> / <code>MAX_INCLUDED_TARGETS_PER_PAGE</code></>, "Depth 3 / 10 includes / 1,000 targets per page", <code>QUERY_TOO_COMPLEX</code>],
          ]}
        />
      </Section>

      <Section id="indexes-realtime-security" title="Indexes, realtime, rules &amp; RLS timeouts">
        <Table
          head={["Constant", "Limit", "Scope"]}
          rows={[
            [<><code>MAX_COMPOSITE_INDEXES_FREE</code> / <code>PRO</code></>, "50 (Free) / 200 (Pro) per project", "Composite indexes"],
            [<code>MAX_WS_SUBSCRIPTIONS_PER_CONN</code>, "25 active subscriptions per WebSocket", "Realtime gateway"],
            [<code>MAX_WS_OUTBOUND_BUFFER_BYTES</code>, "1,048,576 bytes (1 MiB) per WebSocket", "Realtime backpressure"],
            [<code>OUTBOX_RETENTION_HOURS</code>, "24 hours", "realtime_outbox replay window"],
            [<code>TOMBSTONE_RETENTION_DAYS_DEFAULT</code>, "7 days", "Soft-deleted document retention"],
            [<><code>RULES_AST_MAX_DEPTH</code> / <code>MAX_NODES</code> / <code>MAX_EVAL_STEPS</code></>, "Depth 10 / 100 nodes / 256 eval steps", "Security rules AST"],
            [<code>DOCUMENT_MAX_OBJECT_KEYS</code>, "10,000 object keys per document (each write in a batch, transaction or import gets its own budget)", "Document writes"],
            [<code>RULESET_MAX_OBJECT_KEYS</code>, "25,000 object keys per published ruleset (400, guardCode RULESET_TOO_LARGE)", "Ruleset publish"],
            [<><code>DEFAULT_LOCK_TIMEOUT_MS</code> / <code>IDLE_IN_TRANSACTION</code></>, "2,000 ms lock_timeout / 15,000 ms idle_in_transaction", "Data Plane RLS transactions"],
          ]}
        />

      </Section>

      <Section id="sign-in-throttles-and-passwords" title="Sign-in throttles &amp; passwords">
        <Table
          head={["Limit", "Value", "Scope"]}
          rows={[
            ["Failed sign-ins", "10 per 15 minutes", "Per (IP address, email); wrong passwords get 429 TOO_MANY_REQUESTS with Retry-After"],
            ["Failed sign-ins", "50 per 15 minutes", "Per account across all IP addresses (bounds IP-rotated guessing)"],
            ["Sign-ups", "30 per 15 minutes per (project, IP); hourly per-project budget", "Every attempt counts"],
            ["Password reset / email verify requests", "5 per 15 minutes", "Per (IP, email); non-enumerating"],
            ["Password minimum", "8 characters; common passwords always rejected", "Sign-up, password change and reset confirm"],
          ]}
        />
        <P>
          The per-account ceiling can never lock the real owner out: while the bucket is full, wrong passwords
          get <code>TOO_MANY_REQUESTS</code> but the correct password still signs in. This is deliberate —
          otherwise anyone who knows a user&apos;s email could keep that user locked out of their own account.
          Single-source guessing stays capped by the per-(IP, email) limit, which has no such bypass.
        </P>
      </Section>

      <Section id="retry-guidance-section" title="Errors &amp; retry">
        <Callout tone="info" title="Retry guidance">
          For the full table of HTTP status codes and which error codes are safe to retry with
          exponential backoff, see{" "}
          <PageLink slug="reference/errors">Error Codes &amp; Retry Guidance</PageLink>.
        </Callout>
      </Section>
    </Doc>
  );
}
