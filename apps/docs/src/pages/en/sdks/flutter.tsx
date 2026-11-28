import { SdkEndpointNote } from "../../../sdk-endpoint-note";
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
      title="Flutter / Dart SDK (vellum_flutter)"
      description="Complete reference for vellum_flutter—streamPages()/streamDocuments(), writeBatchChunked()/batch().commitChunked(), coalesceInFlightGets, Retry-After retries, sessionEpoch, and dispose()."
    >

      <SdkEndpointNote />
      <Callout tone="info" title="Optional settings">
        Document ids from <code>doc()</code>, auth tokens, cache policy, references with <code>addWithRelated</code> and realtime transport are covered in <PageLink slug="advanced">Advanced configuration</PageLink>.
      </Callout>

      <Section id="beta-install" title="Beta installation">
        <P>Version 0.0.10 is available on npm and pub.dev. Install the published Beta packages below. Repository access is not required.</P>
        <Code lang="bash" title="TypeScript / Node 22+" code={betaJavaScriptInstall} />
        <Code lang="yaml" title="Flutter / Dart 3.4+" code={betaDartInstall} />
      </Section>
      <P>
        <code>vellum_flutter</code> is the official pure-Dart / Flutter SDK for VELLUM. It implements
        the v1 tagged wire format (<code>VellumWire</code>), <code>FieldOp</code> /{" "}
        <code>FieldValue</code> sentinels, <code>withConverter&lt;T&gt;()</code>, resilient HTTP
        retries honoring <code>Retry-After</code>, single-flight GET coalescing, reactive auth with{" "}
        <code>sessionEpoch</code> race protection, and RFC 6455 WebSocket realtime streams.
      </P>

      <Section id="client-configuration" title="Client setup &amp; reliability options">
        <Code
          lang="dart"
          title="Configure VellumClient with timeouts, retries, and secure storage"
          code={`import 'package:vellum_flutter/vellum_flutter.dart';
import 'package:http/http.dart' as http;

final httpClient = http.Client();

final db = VellumClient(
  endpoint: 'https://api.example.com',
  projectId: const String.fromEnvironment('VELLUM_PROJECT_ID'),
  apiKey: const String.fromEnvironment('VELLUM_API_KEY'),
  httpClient: httpClient,
  authStorage: SecureAuthTokenStorage(), // default: encrypted persistent sessions (see Advanced configuration)
  requestTimeout: const Duration(seconds: 30),
  maxRetries: 3,
  retryBaseDelay: const Duration(milliseconds: 250),
  retryMaxDelay: const Duration(seconds: 15),
  coalesceInFlightGets: true,
  warnOnMissingIndexes: true,
);

// Rehydrate persisted session on app startup
await db.auth.restore();`}
        />

        <Table
          head={["Parameter / Property", "Default", "Behavior"]}
          rows={[
            [<code>requestTimeout</code>, <code>Duration(seconds: 30)</code>, "Enforces per-attempt timeout; throws VellumException(code: 'REQUEST_TIMEOUT', statusCode: 408)."],
            [<><code>maxRetries</code> / <code>retryBaseDelay</code> / <code>retryMaxDelay</code></>, <><code>3</code> / <code>250ms</code> / <code>15s</code></>, "Retries GET/HEAD, /query, /documents:aggregate, and requests carrying an Idempotency-Key on 408, 429, 5xx, TimeoutException, or socket errors."],
            [<><code>Retry-After</code> handling</>, "Automatic", "Parses both delta-seconds and RFC 7231 IMF-fixdate Retry-After headers via parseRetryAfterHeader(), clamped to retryMaxDelay."],
            [<code>coalesceInFlightGets</code>, <code>true</code>, "Transparent single-flight deduplication for concurrent identical non-transactional GET requests (keyed by URL + Authorization header)."],
            [<code>auth.sessionEpoch</code>, <><code>0</code> (monotonic)</>, "Incremented on sign-in, restore, sign-out, and dispose so an in-flight token refresh can never resurrect a signed-out or replaced session."],
            [<><code>dispose()</code> / <code>close()</code></>, "—", "Cancels auth refresh timers, closes authStateChanges & WebSocket transport, and clears _memoryCache and _inFlightGets."],
          ]}
        />
      </Section>

      <Section id="typed-streaming" title="Typed models, streamPages() &amp; streamDocuments()">
        <Code
          lang="dart"
          title="withConverter<T>() paired with lazy cursor streaming"
          code={`class Order {
  final String id;
  final int totalCents;
  const Order(this.id, this.totalCents);
  factory Order.fromMap(Map<String, dynamic> data, String id) =>
      Order(id, (data['totalCents'] as num?)?.toInt() ?? 0);
  Map<String, dynamic> toMap() => {'totalCents': totalCents};
}

final orders = db.collection('orders').withConverter<Order>(
  fromVellum: (data, id) => Order.fromMap(data, id),
  toVellum: (order) => order.toMap(),
);

// Stream QuerySnapshot pages lazily
await for (final page in orders
    .where('status', '==', 'paid')
    .orderBy('createdAt', dir: 'desc')
    .streamPages(pageSize: 50, maxPages: 10)) {
  print('Page docs: \${page.docs.length}, nextCursor: \${page.nextCursor}');
}

// Or stream individual DocumentSnapshot<Order> items directly
await for (final snap in orders
    .where('status', '==', 'paid')
    .streamDocuments(pageSize: 50)) {
  final Order? order = snap.data();
  print('\${snap.id}: \${order?.totalCents}');
}`}
        />
      </Section>

      <Section id="chunked-batches" title="Fluent batch().commitChunked() &amp; writeBatchChunked()">
        <Code
          lang="dart"
          title="Bulk writes with automatic chunking and idempotency prefixes"
          code={`// 1. Fluent builder (recommended)
final batch = db.batch();
final items = [{'sku': 'notebook', 'stock': 10}];
for (final item in items) {
  batch.set(
    db.collection('inventory').doc(item['sku'] as String),
    item,
    merge: true,
  );
}
final chunkResults = await batch.commitChunked(
  chunkSize: 100,
  idempotencyKeyPrefix: 'inv-sync-2026-11',
);

// 2. Or submit raw write maps directly
final rawWriteMaps = <Map<String, Object?>>[
  {'type': 'set', 'path': 'inventory/notebook', 'data': {'stock': 10}},
];
final rawResults = await db.writeBatchChunked(
  rawWriteMaps,
  chunkSize: 100,
  idempotencyKeyPrefix: 'raw-import-01',
);`}
        />
      </Section>

      <Section id="offline" title="Persistent cache &amp; offline write queue">
        <P>
          <code>PersistentDocumentCacheStore</code> keeps the document cache across restarts and <code>VellumOutbox</code> queues document writes while offline.
          Both encrypt everything with AES-256-GCM. The key is created on the device, kept in the Keychain or Keystore (never synced to iCloud), and is specific to the project. The cache is also bound to the signed-in user; a different user or project finds nothing.
          If the secure store cannot be read the key stays in memory and nothing is written. Sign-out deletes both blobs and the key.
          On web the key sits next to the data, so encryption adds no protection: nothing is written to disk on web unless you pass <code>allowWeb: true</code>.
        </P>
        <P>
          The queue accepts document writes only (never auth calls, query strings or <code>..</code> paths) and stores no token or API key: they are added when the write is replayed.
          Each entry has an idempotency key, belongs to the user who made it, and is never replayed for another user or project.
          It is limited to 200 writes, 256 KB each, 2 MB in all (1 MB on web); a write that does not fit throws <code>RESOURCE_EXHAUSTED</code>.
          Entries older than 23 hours are dropped (<code>expired</code>), because the server remembers idempotency keys for 24 hours and increments or array transforms must not run twice.
          Replay keeps the entry and stops on network errors, 401, 403 UNAUTHENTICATED, 408, 429 and 5xx; after 8 such failures it is dropped as <code>failed</code>.
          400, 403 PERMISSION_DENIED and 404 are dropped as <code>rejected</code>, and 409 or 412 as <code>conflict</code>. Writes are last-writer-wins unless you pass <code>ifVersion</code>.
          Cached documents stay readable offline for up to 14 days, even if your rules changed since. Call <code>flush()</code> when the app resumes or the connection returns.
        </P>
        <Code lang="dart" title="Offline cache and outbox" code={`import 'package:vellum_flutter/vellum_flutter.dart';

final box = VellumEncryptedBox(keyStore: defaultSecureKeyValue());
final cache = PersistentDocumentCacheStore(box: box);

final db = VellumClient(
  endpoint: 'https://api.example.com',
  projectId: 'prj_1',
  apiKey: 'pk_...',
  cacheStore: cache,
);
cache.attach(db); // binds the cache to this project and clears it on sign-out

final outbox = VellumOutbox(
  client: db,
  box: box,
  onDropped: (entry, reason, error) {
    // reason: rejected, conflict, expired, otherUser or failed. Tell the user.
  },
);

// After the session is restored (the user is known):
await cache.load();
await outbox.load();

// Offline: queue the write instead of failing. Pass the version the user saw
// so a change made meanwhile is reported as a conflict, not overwritten.
await outbox.enqueueSet(db.collection('notes').doc('n1'), {'text': 'hello'}, ifVersion: 3);
// Later (app resumed, connection back):
await outbox.flush();`} />
      </Section>

      <Section id="auth-and-lifecycle" title="Reactive auth, sessionEpoch &amp; dispose()">
        <P>
          <code>db.auth.authStateChanges</code> immediately emits the current{" "}
          <code>VellumUser?</code> to every new subscriber and tracks sign-in, proactive 45-second
          pre-expiry refreshes, reactive 401 single-flight refreshes, profile updates, and sign-out.
          Because <code>sessionEpoch</code> increments on every session boundary, an in-flight{" "}
          <code>POST /auth/token/refresh</code> that resolves after <code>signOut()</code> or{" "}
          <code>dispose()</code> is discarded automatically.
        </P>

        <Code
          lang="dart"
          title="Lifecycle-safe teardown in Flutter"
          code={`final sub = db.auth.authStateChanges.listen((VellumUser? user) {
  print('Auth user: \${user?.id}, epoch: \${db.auth.sessionEpoch}');
});

// On widget / provider disposal:
await sub.cancel();
db.dispose();
// Close the injected httpClient here if this scope created it.`}
        />

        <Callout tone="info" title="Path-traversal &amp; secret-redaction safety">
          <code>vellum_flutter</code> validates every path segment client-side via{" "}
          <code>validateVellumSegment</code> (blocking <code>..</code>, percent-encoded traversals,
          and control characters) and automatically redacts Bearer tokens, API keys, and JWTs in{" "}
          <code>toString()</code> and exception messages. See{" "}
          <PageLink slug="realtime">Realtime Architecture</PageLink> for live{" "}
          <code>snapshots()</code> usage.
        </Callout>
      </Section>

      <Callout tone="warning" title="Account changes and realtime">
        Recreate realtime subscriptions after signing in, signing out, or switching users.
        The SDK ends old subscriptions at that boundary with a SESSION_CHANGED error, so one
        account cannot keep another account's live data; subscribe again afterwards. A token
        refresh for the same user keeps subscriptions alive. Do not share cached clients
        between users. Custom getAuthToken providers must reset subscriptions when their
        identity changes.
      </Callout>
      <Section id="modular-architecture" title="Modular architecture &amp; tamper-proofing">
        <P>
          <code>vellum_flutter</code> is organized as a single pure-Dart, Flutter-Web-safe library (
          <code>library vellum_flutter;</code> with zero <code>dart:io</code> imports) split across{" "}
          <code>lib/src/core/</code>, <code>lib/src/models/</code>, <code>lib/src/auth/</code>,{" "}
          <code>lib/src/realtime/</code>, and <code>lib/src/client/</code>. Internal transport,
          retry, and session state stay library-private (<code>_</code>), public collections are
          wrapped with <code>Map.unmodifiable</code> / <code>List.unmodifiable</code>, session
          storage copies user payloads defensively, and all <code>toString()</code> overrides
          automatically redact tokens and keys.
        </P>
      </Section>
    </Doc>
  );
}
