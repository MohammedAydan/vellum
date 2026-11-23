import { betaJavaScriptInstall, betaDartInstall } from "../../../beta-install";
import {
  Callout,
  Code,
  Doc,
  P,
  PageLink,
  Section,
  Table,
} from "../../../ui";

export default function Page() {
  return (
    <Doc
      eyebrow="SDKs"
      title="JavaScript / TypeScript SDK (@vellum/sdk-js)"
      description="Complete reference for @vellum/sdk-js—typed converters, streaming pagination, auto-chunked bulk writes, BoundedReadCache, single-flight read deduplication, AbortSignal, realtime connectionState, and dispose()."
    >

      <Section id="beta-install" title="Beta installation">
        <P>Public npm and pub.dev packages are pending release approval. Use this pinned Beta checkout or Git dependency. Repository access is required; no package publication is needed.</P>
        <Code lang="bash" title="TypeScript / Node 22+" code={betaJavaScriptInstall} />
        <Code lang="yaml" title="Flutter / Dart 3.4+" code={betaDartInstall} />
      </Section>
      <P>
        <code>@vellum/sdk-js</code> is a zero-dependency TypeScript client for Node.js 22+, edge
        runtimes, and modern browsers. It speaks the canonical v1 tagged wire format, handles
        proactive JWT refresh, and multiplexes WebSocket realtime subscriptions over a single
        transport.
      </P>

      <Section id="client-setup" title="Client configuration (createClient)">
        <Code
          lang="ts"
          title="Initialize a hardened @vellum/sdk-js client"
          code={`import { createClient, BoundedReadCache } from "@vellum/sdk-js";

const db = createClient({
  endpoint: "https://api.example.com",
  projectId: process.env.VELLUM_PROJECT_ID!,
  apiKey: process.env.VELLUM_API_KEY!,
  // Single-flight coalescing for concurrent identical GETs (default: false)
  dedupeReads: true,
  // Optional bounded LRU + TTL cache (defaults: ttlMs = 30_000, maxEntries = 1_000)
  readCache: { ttlMs: 30_000, maxEntries: 1_000 },
  // Index advisor warnings & telemetry hook
  warnOnMissingIndexes: process.env.NODE_ENV !== "production",
  onIndexSuggestion(event) {
    console.warn("Suggested index:", event.fingerprint, event.url);
  },
});`}
        />

        <Table
          head={["Option / Export", "Default", "Purpose"]}
          rows={[
            [<code>dedupeReads</code>, <code>false</code>, "Coalesces concurrent identical document GET calls into one in-flight HTTP request (bypassed when a per-call AbortSignal is provided)."],
            [<code>BoundedReadCache&lt;V&gt;</code>, <code>ttlMs: 30_000, maxEntries: 1_000</code>, "Zero-dependency O(1) LRU + TTL read cache with secondary per-path index for O(1) invalidation on local writes and incoming realtime mutations."],
            [<><code>AbortSignal</code> (via <code>options.signal</code>)</>, "—", "Supported on document reads/writes, queries, pages()/stream(), and batchWriteChunked(); rejects with AbortError (code: \"REQUEST_ABORTED\")."],
            [<><code>connectionState</code> / <code>onConnectionStateChange</code></>, <code>&quot;disconnected&quot;</code>, "Tracks realtime transport state: \"disconnected\" | \"connecting\" | \"connected\" | \"reconnecting\"."],
            [<code>dispose()</code>, "—", "Disposes auth refresh timers, closes the WebSocket transport, clears caches, and removes connectionState listeners."],
          ]}
        />
      </Section>

      <Section id="with-converter" title="Type-safe models with withConverter&lt;T&gt;()">
        <P>
          Attach a <code>DocDataConverter&lt;T&gt;</code> to any <code>CollectionReference</code>,{" "}
          <code>Query</code>, or <code>DocumentReference</code> so reads return strongly typed
          domain objects and writes serialize cleanly. Pass <code>withConverter(null)</code> to
          drop back to raw <code>Record&lt;string, unknown&gt;</code>.
        </P>

        <Code
          lang="ts"
          title="Typed converter on collection, query, and document references"
          code={`import type { DocDataConverter } from "@vellum/sdk-js";

interface User {
  id: string;
  email: string;
  role: "member" | "admin";
}

const userConverter: DocDataConverter<User> = {
  toVellum(user) {
    return { email: user.email, role: user.role };
  },
  fromVellum(data, id) {
    return {
      id,
      email: String(data.email ?? ""),
      role: data.role === "admin" ? "admin" : "member",
    };
  },
};

const users = db.collection("users").withConverter(userConverter);
const snap = await users.doc("usr_1").get();
const user: User | null = snap.data();

// Revert to untyped access on a specific reference
const rawSnap = await users.doc("usr_1").withConverter(null).get();`}
        />
      </Section>

      <Section id="pagination-and-bulk" title="Streaming pagination &amp; chunked bulk writes">
        <Code
          lang="ts"
          title="pages(), stream(), and batchWriteChunked() with AbortSignal"
          code={`const ac = new AbortController();

// Stream page-by-page
for await (const page of db
  .collection("events")
  .where("severity", "==", "error")
  .orderBy("createdAt", "desc")
  .pages({ pageSize: 100, maxPages: 20, signal: ac.signal })) {
  console.log("Page size:", page.docs.length);
}

// Stream individual DocumentSnapshots
for await (const doc of db.collection("events").stream({ pageSize: 100, signal: ac.signal })) {
  console.log(doc.id, doc.data());
}

// Auto-chunked bulk writes (default chunkSize: 500, concurrency: 4; pass 100 for server batch cap)
const result = await db.batchWriteChunked(writes, {
  chunkSize: 100,
  concurrency: 4,
  signal: ac.signal,
  onChunkComplete(progress) {
    console.log(\`\${progress.completedOperations}/\${progress.totalOperations} ops\`);
  },
});`}
        />
      </Section>

      <Section id="realtime-and-auth" title="Realtime connectionState, auth &amp; lifecycle">
        <Code
          lang="ts"
          title="Observing connectionState and cleaning up with dispose()"
          code={`console.log("Initial:", db.connectionState); // "disconnected"

const off = db.onConnectionStateChange((next, prev) => {
  console.log(\`WS transition: \${prev} -> \${next}\`);
});

const unsub = db.collection("orders").onSnapshot((snap) => {
  console.log("Live orders:", snap.docs.length);
});

// Auth client (MemoryAuthStorage or BrowserLocalStorage)
await db.auth.signInWithEmailAndPassword({ email: "ada@example.com", password: "secret" });

// Clean teardown
unsub();
off();
db.dispose();`}
        />

        <Callout tone="warning" title="Always dispose() in tests &amp; workers">
          Calling <code>db.dispose()</code> cancels proactive JWT refresh timers, tears down the
          WebSocket connection, clears <code>BoundedReadCache</code>, and clears{" "}
          <code>connectionStateListeners</code>. See{" "}
          <PageLink slug="realtime">Realtime Architecture</PageLink> and{" "}
          <PageLink slug="batch-and-transactions">Batch Writes &amp; Transactions</PageLink> for
          deeper patterns.
        </Callout>
      </Section>

      <Section id="modular-architecture" title="Modular architecture &amp; tamper-proofing">
        <P>
          <code>@vellum/sdk-js</code> is structured into focused domain modules under{" "}
          <code>src/</code> (<code>core/</code>, <code>cache/</code>, <code>auth/</code>,{" "}
          <code>realtime/</code>, <code>references/</code>, <code>batch/</code>, and{" "}
          <code>client/</code>) re-exported cleanly from <code>@vellum/sdk-js</code>. All public
          facades, <code>fieldOp</code> sentinels, and snapshots are frozen via{" "}
          <code>Object.freeze</code>, internal caches and credentials remain encapsulated behind{" "}
          <code>private readonly</code> fields with redacted <code>toJSON()</code>/<code>toString()</code>,
          and every <code>snapshot.data()</code> or cache read returns a fresh prototype-safe clone.
        </P>
      </Section>
    </Doc>
  );
}
