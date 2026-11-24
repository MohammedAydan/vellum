import {
  autoIdTs, autoIdDart, authTs, authDart, secureStorageDart, cacheTs, cacheDart,
  relationsTs, relationsDart, realtimeTs,
} from "../../advanced-examples";
import { AlphaNotice, Callout, Code, CodeTabs, Doc, P, PageLink, Section, Table } from "../../ui";

export default function Page() {
  return (
    <Doc
      eyebrow="Get started"
      title="Advanced configuration"
      description="Everything here is optional. The Quickstart works with the defaults; come back when you need to tune IDs, auth, caching, references or realtime."
    >
      <AlphaNotice />
      <Callout tone="info" title="Defaults first">
        You do not need any of these settings to get started. Each one has a safe default and works the
        same on every supported platform: Flutter on Android, iOS, web and desktop, and JavaScript in
        browsers, Node, edge and serverless runtimes, and React Native.
      </Callout>

      <Section id="auto-id" title="Document IDs: doc() and add()">
        <P>
          Call <code>doc()</code> without an id to get a new reference with a 20-character, time-sortable id.
          The id is created on the device, so no request is sent until you write.
        </P>
        <CodeTabs tabs={[
          { label: "TypeScript", lang: "ts", code: autoIdTs },
          { label: "Flutter / Dart", lang: "dart", code: autoIdDart },
        ]} />
      </Section>

      <Section id="auth" title="Auth: automatic refresh and custom tokens">
        <P>
          Sessions are refreshed about 60 seconds before expiry, and once more if a request returns 401.
          Concurrent calls share one refresh. Use <code>setCustomToken</code> to send a token from your own
          identity provider, or <code>autoRefresh: false</code> to take over refresh yourself.
        </P>
        <CodeTabs tabs={[
          { label: "TypeScript", lang: "ts", code: authTs },
          { label: "Flutter / Dart", lang: "dart", code: authDart },
        ]} />
      </Section>

      <Section id="secure-storage" title="Flutter: secure token storage (optional)">
        <P>
          Out of the box the Flutter client keeps the session in memory, so there is nothing to install. If
          you want the session to survive app restarts in the keychain or keystore, add{" "}
          <code>flutter_secure_storage</code> to your own app and paste this class. It uses the existing{" "}
          <code>AuthTokenStorage</code> interface.
        </P>
        <Code lang="dart" title="SecureAuthTokenStorage" code={secureStorageDart} />
      </Section>

      <Section id="cache" title="Cache policy">
        <P>Choose how reads use the local store. The default is <code>networkFirst</code>.</P>
        <Table
          head={["Policy", "Behavior"]}
          rows={[
            [<code>networkFirst</code>, "Fetch from the network. If the device is offline, return the stored copy (flagged fromCache)."],
            [<code>cacheFirst</code>, "Return a fresh stored copy (default 5 minutes), otherwise fetch."],
            [<code>networkOnly</code>, "Never read the store."],
            [<code>cacheOnly</code>, "Only the store. A miss returns a document that does not exist."],
          ]}
        />
        <CodeTabs tabs={[
          { label: "TypeScript", lang: "ts", code: cacheTs },
          { label: "Flutter / Dart", lang: "dart", code: cacheDart },
        ]} />
        <Callout tone="info" title="Where data is stored">
          JavaScript uses IndexedDB in browsers and a bounded in-memory store elsewhere (Node, edge,
          React Native). Flutter uses a bounded in-memory store on every platform. Persisting to disk in
          Flutter is opt-in by implementing <code>DocumentCacheStore</code>.
        </Callout>
      </Section>

      <Section id="references" title="References and related writes">
        <P>
          Put a document reference directly in your data. To create a parent and its children together, use{" "}
          <code>addWithRelated</code>: one atomic request, all or nothing, up to 500 documents. See{" "}
          <PageLink slug="relationships">Relationships</PageLink> for reading related documents.
        </P>
        <CodeTabs tabs={[
          { label: "TypeScript", lang: "ts", code: relationsTs },
          { label: "Flutter / Dart", lang: "dart", code: relationsDart },
        ]} />
      </Section>

      <Section id="realtime-transport" title="Realtime transport">
        <P>
          By default the SDKs open a WebSocket. If a WebSocket cannot be used, for example on hosts that do
          not support upgrades, they switch to HTTP streaming (SSE) automatically and keep your listeners and
          resume position. You can pin one transport if you need to. See <PageLink slug="realtime">Realtime</PageLink>.
        </P>
        <Code lang="ts" title="TypeScript" code={realtimeTs} />
        <Code lang="dart" title="Flutter / Dart" code={`final db = VellumClient(
  endpoint: endpoint, projectId: projectId, apiKey: apiKey,
  realtimeMode: VellumRealtimeMode.auto, // or .websocket / .sse
);`} />
      </Section>
    </Doc>
  );
}
