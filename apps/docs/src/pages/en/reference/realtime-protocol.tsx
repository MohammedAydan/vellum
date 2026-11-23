import { Callout, Code, CodeTabs, Doc, H3, PageLink, P, Section, Steps, Table, UL } from "../../../ui";

export default function Page() {
  return (
    <Doc
      title="Realtime WebSocket protocol"
      description="Canonical client and server frames, the auth handshake, subscribe and resume, watermarks, gap detection and connection limits on /v1/realtime."
      eyebrow="Reference"
    >
      <Section id="overview" title="Overview">
        <P>
          The realtime gateway is a native RFC&nbsp;6455 WebSocket endpoint at{" "}
          <code>wss://&lt;host&gt;/v1/realtime</code>. It multiplexes every document and query
          subscription for a connection over a single socket. PostgreSQL is the only stateful
          service: each committed mutation writes a row to the durable{" "}
          <code>realtime_outbox</code>, a dedicated <code>LISTEN</code> connection wakes a poller,
          and the poller fetches the full rows and fans them out in sequence order. There is no
          broker and no second cache.
        </P>
        <UL
          items={[
            <>
              <strong>Outbox first.</strong> The document change and its outbox row commit in the
              same transaction, so a frame is never emitted for a change that is not durable.
            </>,
            <>
              <strong>Wake-up, not transport.</strong> <code>NOTIFY</code> carries only{" "}
              <code>seqId</code> and <code>projectId</code> — never
              document data. The poller reads the row from the tenant-scoped data plane.
            </>,
            <>
              <strong>Poll fallback.</strong> A plain polling loop also runs, so realtime keeps
              working when <code>LISTEN</code> is unavailable (for example, on a Neon pooler
              endpoint).
            </>,
          ]}
        />
        <H3 id="frame-vocabulary">Frame vocabulary</H3>
        <P>
          The canonical frame names are those in the <code>@vellum/api-contract</code> Zod schemas
          and the live gateway hub: <code>auth_ack</code>, <code>initial_sync</code>,{" "}
          <code>mutation</code>, <code>resume_complete</code>, <code>error</code> and{" "}
          <code>pong</code>. Older narrative material used <code>auth_ok</code>,{" "}
          <code>sub_ack</code>, <code>change</code> and <code>sync_complete</code>; those names are
          not on the wire. Likewise, the old Redis Pub/Sub description is revoked under the
          Zero-Redis doctrine.
        </P>
      </Section>

      <Section id="connection-lifecycle" title="Connection & lifecycle">
        <P>
          Every WebSocket resource is addressed by the same path, with tenant and credential
          context supplied by the first application frame rather than by the URL.
        </P>
        <Code code={"GET wss://api.example.com/v1/realtime\nUpgrade: websocket\nConnection: Upgrade\nSec-WebSocket-Key: <base64-16-bytes>\nSec-WebSocket-Version: 13"} lang="http" title="Upgrade request" />
        <Table
          head={["Stage", "Behavior"]}
          rows={[
            ["Upgrade", "Standard WS handshake on /v1/realtime. Requires Sec-WebSocket-Key and version 13. A wrong path returns 404; a malformed handshake returns 400."],
            ["Origin check", "A missing Origin is accepted (native clients). A present Origin must match CORS_ALLOWED_ORIGINS, otherwise 403 Forbidden. An empty allowlist fails closed for browser clients."],
            ["Per-IP cap", <>50 concurrent connections per client IP; beyond that the upgrade returns <code>429 Too Many Requests</code>.</>],
            ["Auth deadline", <>Send a valid <code>auth</code> frame within <strong>5,000&nbsp;ms</strong> (<code>DEFAULT_AUTH_TIMEOUT_MS</code>). On timeout the server sends an <code>error</code> frame with <code>code: "UNAUTHENTICATED"</code>, <code>subId: "connection"</code>, then closes with 1008.</>],
            ["Frame size", <>1&nbsp;MiB hard cap per inbound frame, enforced before any buffer allocation. Oversized frames produce <code>PAYLOAD_TOO_LARGE</code> and close 1009.</>],
            ["Heartbeat / idle", "The server sends a WS-level ping every 30,000 ms. One outstanding ping must be answered within the 30,000 ms idle window, otherwise the socket closes with 1000. Application-level ping/pong JSON frames are also supported."],
            ["Outbound backpressure", <>1&nbsp;MiB cap per connection. Exceeding it emits <code>SLOW_CONSUMER_DISCONNECT</code> and closes 1008 — the server never grows memory without bound.</>],
          ]}
        />
        <Callout tone="warning" title="Code value wins">
          Some older prose says the auth window is 10,000&nbsp;ms and that the server advertises a
          25,000&nbsp;ms heartbeat in an <code>auth_ok</code> frame. The shipped transport uses a
          5,000&nbsp;ms auth deadline and a 30,000&nbsp;ms server ping; the JS SDK separately uses
          a 25,000&nbsp;ms application heartbeat, a 60,000&nbsp;ms pong timeout and a
          10,000&nbsp;ms connect timeout. Those are client-side defaults, not server frame fields.
        </Callout>
        <P>
          A connection must authenticate before any other operation. Sending{" "}
          <code>subscribe</code> or <code>unsubscribe</code> first yields{" "}
          <code>UNAUTHENTICATED</code>.
        </P>
      </Section>

      <Section id="client-frames" title="Client → server frames">
        <P>
          <code>ClientFrameSchema</code> is a discriminated union on <code>type</code> with exactly
          four variants. Unknown types and missing required fields are rejected as{" "}
          <code>INVALID_ARGUMENT</code>.
        </P>
        <Table
          head={["type", "Fields", "Purpose"]}
          rows={[
            [<code>auth</code>, <><code>projectId</code> (min 1), <code>apiKey</code> (min 1), <code>authToken?</code></>, "Must be the first frame. The optional end-user token supplies the rules authContext."],
            [<code>subscribe</code>, <><code>subId</code> (min 1), <code>path?</code> <em>or</em> <code>query?</code>, <code>resumeSeqId?</code> (non-negative integer), <code>resolveIncludes?</code> (bool), <code>include?</code> (IncludeSpec[], max 10)</>, "Subscribe to one document or one collection query. Exactly one of path/query is required. resolveIncludes opts into relation hydration: specs come from include, falling back to query.include; depth 1 only."],
            [<code>unsubscribe</code>, <><code>subId</code> (min 1)</>, "Stop a subscription and drop its state."],
            [<code>ping</code>, <><code>ts</code> (number)</>, "Application heartbeat; answered by a pong frame."],
          ]}
        />
        <CodeTabs
          tabs={[
            {
              label: "auth (server key)",
              lang: "json",
              code: `{
  "type": "auth",
  "projectId": "11111111-1111-1111-1111-111111111111",
  "apiKey": "sk_..."
}`,
            },
            {
              label: "auth + end user",
              lang: "json",
              code: `{
  "type": "auth",
  "projectId": "11111111-1111-1111-1111-111111111111",
  "apiKey": "pk_...",
  "authToken": "eyJ... (EdDSA access token; optional Bearer prefix)"
}`,
            },
            {
              label: "subscribe (path)",
              lang: "json",
              code: `{
  "type": "subscribe",
  "subId": "sub_1",
  "path": "users/u_123"
}`,
            },
            {
              label: "subscribe (query + resume)",
              lang: "json",
              code: `{
  "type": "subscribe",
  "subId": "sub_2",
  "query": { "collectionPath": "orders", "limit": 50 },
  "resumeSeqId": 1042
}`,
            },
            {
              label: "ping / unsubscribe",
              lang: "json",
              code: `{ "type": "ping", "ts": 1794753000123 }\n{ "type": "unsubscribe", "subId": "sub_1" }`,
            },
          ]}
        />
        <P>
          Auth validation verifies the API key and requires it to belong to the addressed project
          (<code>PERMISSION_DENIED</code> otherwise). A supplied{" "}
          <code>authToken</code> is verified as an <strong>EdDSA (Ed25519)</strong> end-user access
          token against the project public key, with a matching issuer and project
          audience. There is no HS256 fallback and no anonymous bypass for a supplied token; an
          expired token yields <code>TOKEN_EXPIRED</code>, any other invalid token yields{" "}
          <code>UNAUTHENTICATED</code>. The <code>Bearer&nbsp;</code> prefix, if present, is
          stripped before verification.
        </P>
        <H3 id="subscription-authorization">Subscription targets & rules checks</H3>
        <Table
          head={["Subscription kind", "Validation", "Rules operation"]}
          rows={[
            [<code>path</code>, <><code>parseDocumentPath</code> — even segment count, 2–10 segments</>, <><code>get</code> on the exact document path</>],
            [<code>query</code>, <><code>validateAndNormalizeQuery</code> — <code>collectionPath</code> or <code>collectionGroup</code>, filters and limit</>, <><code>list</code> on <code>&lt;collectionPath&gt;/__ws_sub__</code></>],
          ]}
        />
        <P>
          Both checks use the active ruleset for the authenticated project together with the
          API key scopes. A failed check emits an <code>error</code> frame and the subscription is
          not registered. See{" "} <PageLink slug="security-rules">Security rules</PageLink> for the
          rules AST itself.
        </P>
      </Section>

      <Section id="server-frames" title="Server → client frames">
        <P>
          <code>ServerFrameSchema</code> is also a discriminated union on <code>type</code>. Each
          frame below is a single JSON text message on the socket.
        </P>
        <Table
          head={["type", "Fields", "Meaning"]}
          rows={[
            [<code>auth_ack</code>, <><code>status: "authenticated"</code>, <code>connectionId</code></>, "Handshake succeeded; the socket is now authorized."],
            [<code>initial_sync</code>, <><code>subId</code>, <code>seqId</code> (number), <code>documents: DocumentPayload[]</code></>, "Fresh subscribe result set. seqId is the current outbox watermark."],
            [<code>mutation</code>, <><code>subId</code>, <code>seqId</code> (number), <code>operation: "create" | "update" | "delete"</code>, <code>document: DocumentPayload</code></>, "One committed change matching the subscription, or a query membership transition."],
            [<code>resume_complete</code>, <><code>subId</code>, <code>seqId</code> (string), <code>count</code> (int), <code>truncated</code> (bool)</>, "Replay after resumeSeqId finished. seqId is the last delivered sequence."],
            [<code>error</code>, <><code>subId?</code>, <code>code</code> (canonical error code), <code>message</code></>, "Protocol or subscription error. Transport-level auth timeouts use subId: \"connection\"."],
            [<code>pong</code>, <><code>ts</code>, <code>serverTs</code></>, "Reply to an application-level ping."],
          ]}
        />
        <CodeTabs
          tabs={[
            {
              label: "Handshake",
              lang: "json",
              code: `{ "type": "auth_ack", "status": "authenticated", "connectionId": "conn_9f2c41ab7d0e4c31" }\n{ "type": "pong", "ts": 1794753000123, "serverTs": 1794753000148 }`,
            },
            {
              label: "Initial sync",
              lang: "json",
              code: `{
  "type": "initial_sync",
  "subId": "sub_1",
  "seqId": 1042,
  "documents": [ /* DocumentPayload[] */ ]
}`,
            },
            {
              label: "Live mutation",
              lang: "json",
              code: `{
  "type": "mutation",
  "subId": "sub_1",
  "seqId": 1043,
  "operation": "update",
  "document": { /* DocumentPayload */ }
}`,
            },
            {
              label: "Resume complete",
              lang: "json",
              code: `{ "type": "resume_complete", "subId": "sub_2", "seqId": "1042", "count": 7, "truncated": false }`,
            },
            {
              label: "Error",
              lang: "json",
              code: `{ "type": "error", "subId": "sub_3", "code": "PERMISSION_DENIED", "message": "list denied on users/u_123/orders" }\n{ "type": "error", "subId": "connection", "code": "UNAUTHENTICATED", "message": "Authentication timeout" }`,
            },
          ]}
        />
        <P>
          A <code>DocumentPayload</code> is{" "}
          <code>{"{ path, collectionPath, collectionGroup, documentId, data, version, createdAt, updatedAt, sizeBytes? }"}</code>{" "}
          and matches <code>DocumentPayloadSchema</code>. Data uses the{" "}
          <PageLink slug="reference/wire-format">tagged wire format</PageLink>. The SDKs map{" "}
          <code>create → added</code>, <code>update → modified</code> and{" "}
          <code>delete → removed</code> in snapshot change lists. Note the deliberate wire
          asymmetry: <code>initial_sync</code> and <code>mutation</code> carry{" "}
          <code>seqId</code> as a <strong>number</strong>, while <code>resume_complete</code>{" "}
          carries it as a <strong>string</strong> for wire compatibility.
        </P>
        <P>
          When <code>resolveIncludes</code> is set, each delivered payload also carries{" "}
          <code>_included</code> (a map of reference path to the hydrated target payload) and{" "}
          <code>_redactedRefs</code> (reference paths withheld because the key may not read the{" "}
          target). Hydration is point-in-time at event processing: target-only edits do not{" "}
          retrigger the parent, and deleted or removed parents are not hydrated. More than 10{" "}
          specs or nesting fails <code>INVALID_ARGUMENT</code>; over 1,000 unique reference{" "}
          paths in one event fails <code>RESPONSE_TOO_LARGE</code>. See{" "}
          <PageLink slug="realtime">Realtime</PageLink> for the full contract.
        </P>
      </Section>

      <Section id="resume-watermarks" title="Watermarks, resume & gap detection">
        <P>
          Delivery is durable and ordered. A <code>seq_id</code> is a monotonic watermark per{" "}
          <code>projectId</code>; <code>seq ≤ watermark</code> is never delivered
          again. The sequence of guarantees is:
        </P>
        <Steps
          items={[
            {
              title: "Outbox write",
              body: "Each committed document mutation inserts a realtime_outbox row in the same transaction, carrying opType, beforeData/afterData, version and committedAt.",
            },
            {
              title: "NOTIFY wake-up",
              body: "An AFTER INSERT trigger publishes a compact {seqId, projectId} payload on the vellum_outbox channel over one dedicated, non-pooled LISTEN client.",
            },
            {
              title: "Poll fallback and catch-up",
              body: "The OutboxPoller also polls every 1,000 ms and reads full rows through the tenant-scoped adapter in batches of 500. A missing NOTIFY therefore never loses an event.",
            },
            {
              title: "Gap detection",
              body: "Each tenant keeps one watermark. If an observed seq is greater than watermark + 1, a gap is recorded and catch-up starts at the watermark; the hub re-fans the missed rows in order. Per-subscription seenSeqIds makes NOTIFY and polling deduplication exactly-once at the subscription boundary.",
            },
            {
              title: "Fresh subscribe",
              body: "Without resumeSeqId, the server sends initial_sync with the current watermark as seqId and the documents that currently match.",
            },
            {
              title: "Resume",
              body: "With resumeSeqId, the server replays at most 5,000 outbox events after that value in 500-row batches, then emits resume_complete. Live events arriving mid-replay are buffered and flushed afterwards in ascending seq order — the client sees replay first, then live, with no interleaving. truncated: true means the 5,000-event cap was reached.",
            },
          ]}
        />
        <Code
          code={`// Persist the watermark; reconnect with it to replay only what was missed.
const stop = db.collection("orders").onSnapshot((snapshot) => {
  if (snapshot.watermarkSeqId != null) {
    localStorage.setItem("orders:watermark", snapshot.watermarkSeqId);
  }
  render(snapshot.docs);
});

// On a new session the SDK transport re-subscribes with resumeSeqId automatically.
// Raw WebSocket clients send: { "type": "subscribe", "subId": "sub_2",
//   "query": { "collectionPath": "orders", "limit": 50 }, "resumeSeqId": 1042 }`}
          lang="ts"
          title="Resume from a watermark"
        />
        <Callout tone="info" title="Retention window">
          The outbox retains events for <strong>24&nbsp;hours</strong>. A resume position older than
          that cannot be replayed — start a fresh subscription and accept a new{" "}
          <code>initial_sync</code> instead. Both SDKs track the highest observed{" "}
          <code>seqId</code> per subscription and send it as <code>resumeSeqId</code> after
          reconnecting with full-jitter backoff.
        </Callout>
      </Section>

      <Section id="limits-errors" title="Limits & error frames">
        <Table
          head={["Condition", "Code", "HTTP equivalent"]}
          rows={[
            ["Auth frame missing, malformed, expired or timed out", <code>UNAUTHENTICATED</code>, "401"],
            ["Expired end-user access token", <code>TOKEN_EXPIRED</code>, "401"],
            ["Key / project mismatch, rules denial", <code>PERMISSION_DENIED</code>, "403"],
            ["More than 50 subscriptions on one connection", <code>SUBSCRIPTION_LIMIT_EXCEEDED</code>, "400"],
            ["Outbound buffer above 1 MiB", <code>SLOW_CONSUMER_DISCONNECT</code>, "429"],
            ["Inbound frame above 1 MiB", <code>PAYLOAD_TOO_LARGE</code>, "413"],
            ["Bad frame, invalid target or unknown field", <code>INVALID_ARGUMENT</code>, "400"],
          ]}
        />
        <P>
          Error frames carry the same canonical codes as HTTP responses, so branch on{" "}
          <code>code</code>, not on a status that is not present on the wire. For the complete
          catalogue with retry guidance see{" "}
          <PageLink slug="reference/errors">Error codes & retry guidance</PageLink>; for the
          quotas behind these limits see{" "}
          <PageLink slug="errors-and-limits">Quotas & limits</PageLink>. To use these frames
          through an SDK rather than directly, see{" "}
          <PageLink slug="sdks/javascript">JavaScript / TypeScript</PageLink> or{" "}
          <PageLink slug="sdks/flutter">Flutter / Dart</PageLink>, and the higher-level{" "}
          <PageLink slug="realtime">Realtime</PageLink> guide.
        </P>
      </Section>
    </Doc>
  );
}
