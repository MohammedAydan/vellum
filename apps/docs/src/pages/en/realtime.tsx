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
      title="Realtime Architecture"
      description="Broker-free PostgreSQL LISTEN/NOTIFY with a dedicated keepAlive listener, monotonic outbox poller, O(tenant) fan-out, continuous auth & ruleset enforcement, and resumeSeqId replay."
    >
      <P>
        VELLUM delivers sub-50 ms live document and query updates over RFC 6455 WebSockets, with an automatic HTTP streaming fallback (
        <code>wss://&lt;host&gt;/v1/realtime</code>) with zero Redis or external message brokers.
        Every committed mutation appends an immutable row to the Data Plane&apos;s{" "}
        <code>realtime_outbox</code> table (indexed on <code>(project_id, seq_id ASC)</code>, 24 h
        retention) inside the same PostgreSQL transaction as the document write.
      </P>

      <Section id="pg-notify-bus" title="Pooled publisher + dedicated keepAlive listener">
        <P>
          <code>@vellum/realtime</code> separates PostgreSQL notification publishing from listening so
          neither path blocks the other:
        </P>
        <UL
          items={[
            <>
              <strong>Dedicated LISTEN client:</strong> A single persistent <code>pg.Client</code>{" "}
              with TCP <code>keepAlive: true</code> (<code>keepAliveInitialDelayMillis: 10_000</code>,{" "}
              <code>connectionTimeoutMillis: 10_000</code>) that is never returned to a request
              pool.
            </>,
            <>
              <strong>Lazy pooled publisher:</strong> A tiny dedicated <code>pg.Pool</code> (
              <code>max: 2</code>, <code>idleTimeoutMillis: 15_000</code>,{" "}
              <code>connectionTimeoutMillis: 5_000</code>) executes{" "}
              <code>SELECT pg_notify($1, $2)</code> without per-publish TCP/TLS handshakes.
            </>,
            <>
              <strong>Strict payload validation:</strong> Rejects NUL bytes, non-Postgres URIs,
              oversized notifications, negative sequence IDs, and non-UUID project IDs before
              dispatching wake-ups.
            </>,
          ]}
        />
      </Section>

      <Section id="monotonic-outbox" title="Monotonic outbox poller &amp; zero-skip burst handling">
        <P>
          PostgreSQL <code>NOTIFY</code> is treated strictly as a low-latency wake-up signal—never
          as the source of truth. When a burst of writes emits multiple notifications (e.g.{" "}
          <code>seqId = 2</code> through <code>seqId = 5</code> arriving out of order or coalesced),
          the <code>OutboxPoller</code> advances its per-project <code>BigInt</code> watermark
          strictly monotonically by reading every row where{" "}
          <code>seq_id &gt; currentWatermark ORDER BY seq_id ASC</code>. Intermediate rows are never
          skipped even under heavy write bursts or dropped notifications.
        </P>
      </Section>

      <Section id="fanout-and-security" title="O(tenant) fan-out &amp; continuous session enforcement">
        <Table
          head={["Invariant", "Implementation in RealtimeGatewayHub"]}
          rows={[
            [
              <strong>O(tenant) fan-out index</strong>,
              "Connections are indexed by projectId so a write in Project A only evaluates subscriptions belonging to Project A—never scanning connections from other tenants.",
            ],
            [
              <strong>Continuous JWT &amp; API-key expiry checks</strong>,
              "On every dispatched mutation—not just during the initial handshake—the hub verifies that the session's end-user JWT exp claim has not elapsed and the API key has not been revoked or expired. Expired sessions are disconnected immediately.",
            ],
            [
              <strong>Live active-ruleset re-evaluation</strong>,
              "Every outgoing mutation is evaluated against the project's currently active published security ruleset, so revoking access takes effect on live streams immediately.",
            ],
            [
              <strong>Cross-tenant re-auth protection</strong>,
              "Re-authenticating an existing WebSocket clears all previous subscriptions before binding the new tenant context, preventing cross-tenant hijack.",
            ],
            [
              <strong>Fault isolation &amp; backpressure</strong>,
              <>
                Broken sockets are torn down and removed without impacting healthy subscribers;
                outbound buffers are capped at <code>MAX_WS_OUTBOUND_BUFFER_BYTES = 1 MiB</code> and
                subscriptions at <code>MAX_WS_SUBSCRIPTIONS_PER_CONN = 25</code>.
              </>,
            ],
          ]}
        />
      </Section>

      <Section id="resume-and-connection-state" title="Resuming streams (resumeSeqId) &amp; connectionState">
        <P>
          Both SDK transports automatically track the highest observed <code>seqId</code> /{" "}
          <code>watermarkSeqId</code> per subscription. On reconnect (using decorrelated/full-jitter
          backoff from 500 ms up to 30,000 ms), the client automatically re-subscribes with{" "}
          <code>resumeSeqId</code> so missed mutations are replayed cleanly from{" "}
          <code>realtime_outbox</code>. If the client was offline longer than the 24-hour outbox
          retention window, the server triggers a clean <code>initial_sync</code>.
        </P>

        <CodeTabs
          tabs={[
            {
              label: "TypeScript (connectionState & snapshots)",
              lang: "ts",
              code: `// Observe WebSocket lifecycle: "disconnected" | "connecting" | "connected" | "reconnecting"
const unsubState = db.onConnectionStateChange((state, prev) => {
  console.log(\`Realtime state: \${prev} -> \${state}\`);
});

const unsubQuery = db
  .collection("messages")
  .where("roomId", "==", "room_general")
  .orderBy("createdAt", "asc")
  .onSnapshot(
    (snap) => {
      console.log("Watermark:", snap.watermarkSeqId, "Docs:", snap.docs.length);
    },
    (err) => console.error("Realtime error:", err)
  );

// Clean up when unmounting
unsubQuery();
unsubState();`,
            },
            {
              label: "Flutter / Dart (snapshots() & resumeSeqId)",
              lang: "dart",
              code: `final sub = db
    .collection('messages')
    .where('roomId', '==', 'room_general')
    .orderBy('createdAt', dir: 'asc')
    .snapshots()
    .listen(
      (QuerySnapshot<Map<String, dynamic>> snap) {
        print('Watermark: \${snap.watermarkSeqId}, docs: \${snap.docs.length}');
      },
      onError: (Object err) => print('Realtime error: $err'),
    );

// Transport tracks lastSeqId per subId and sends resumeSeqId on reconnect.
// Cancel when the widget disposes:
await sub.cancel();`,
            },
          ]}
        />

        <Callout tone="info" title="Protocol specification">
          For exact JSON frame schemas (<code>auth</code>, <code>auth_ack</code>,{" "}
          <code>subscribe</code>, <code>initial_sync</code>, <code>mutation</code>,{" "}
          <code>ping</code>/<code>pong</code>), see the{" "}
          <PageLink slug="reference/realtime-protocol">Realtime WebSocket Protocol reference</PageLink>.
        </Callout>
      </Section>

      <Section id="transports" title="Transports: WebSocket first, SSE fallback">
        <P>
          The SDKs connect with a WebSocket by default. Some hosts, such as Vercel serverless functions,
          cannot upgrade connections. In that case the SDKs fall back automatically to HTTP streaming
          (Server-Sent Events) at <code>POST /v1/realtime/stream</code>, which carries the same frames, the
          same authentication and the same resume position. Your listeners do not change, and you do not need
          to configure anything. To force a transport, set <code>realtimeTransport</code> (JavaScript) or{" "}
          <code>realtimeMode</code> (Flutter). Details are in{" "}
          <PageLink slug="advanced">Advanced configuration</PageLink>.
        </P>
      </Section>

      <Section id="opt-in-includes" title="Opt-in relation includes">
        <P>
          Subscriptions can ask the server to resolve relations <strong>point-in-time</strong> on every
          emitted document: send <code>resolveIncludes: true</code> plus an{" "}
          <code>include</code> list (top level, or under <code>query.include</code> for query
          subscriptions). Resolved payloads land on <code>snapshot.doc.included</code>; targets hidden
          by Security Rules appear in <code>redactedRefs</code>. These are snapshots at event time, not
          a live join — a later write to the referenced document does not re-emit the parent.
        </P>
        <UL
          items={[
            <>At most <strong>10 specs</strong> per subscription, <strong>depth 1</strong> only — nested includes are rejected with <code>INVALID_ARGUMENT</code>.</>,
            <>At most <strong>1000 unique target paths</strong> and <strong>1 MiB</strong> of fetched target data per event (<code>RESPONSE_TOO_LARGE</code>).</>,
            <>One tenant-scoped batch fetch collects the union of references for all subscribers of an event — never one query per subscriber.</>,
            <>Every resolved target is re-authorized per subscriber; denied targets are redacted, never leaked.</>,
          ]}
        />
        <CodeTabs
          tabs={[
            {
              label: "TypeScript",
              lang: "ts",
              code: `const off = db.doc("orders/ord_1").onSnapshot(
  (snap) => {
    for (const change of snap.changes) {
      console.log(change.doc.included, change.doc.redactedRefs);
    }
  },
  (err) => console.error(err),
  { resolveIncludes: true, include: ["customer", { field: "items", select: ["sku"] }] }
);`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `final sub = db.collection('orders').doc('ord_1').snapshots(
  resolveIncludes: true,
  include: ['customer', const VellumInclude(field: 'items', select: ['sku'])],
).listen((snap) {
  print(snap.included);      // resolved payloads
  print(snap.redactedRefs);  // targets hidden by security rules
});`,
            },
          ]}
        />
      </Section>
    </Doc>
  );
}
