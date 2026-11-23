import { Callout, Code, CodeTabs, Doc, H3, PageLink, P, Section, Table, UL } from "../../../ui";

export default function Page() {
  return (
    <Doc
      title="Tagged wire format & paths"
      description="Canonical $t/$v tagged types, $op field transforms, path grammar, binary sort keys and the locked v1 limits."
      eyebrow="Reference"
    >
      <Section id="overview" title="Overview">
        <P>
          JSON has no native int64, timestamp, byte string, reference or geopoint type. VELLUM
          reserves the wrapper <code>{"{\"$t\": \"<tag>\", \"$v\": <value>}"}</code> so extended
          types can never collide with a user map. Primitives — <code>null</code>, boolean, string,
          finite number, array and plain map — are stored <strong>untagged</strong>, which lets
          PostgreSQL <code>jsonb</code> GIN indexes address them directly without wrapper overhead.
        </P>
        <P>
          The validators and constructors live in <code>@vellum/core</code> ({" "}
          <code>WireValue</code>, <code>validateWireValue</code>,{" "}
          <code>parseDocumentPath</code> ); the Dart SDK exposes the equivalent{" "}
          <code>VellumWire</code> helpers. Every value arriving over HTTP, WebSocket or from a rules
          expression is validated at the boundary before it reaches storage.
        </P>
        <Callout tone="info" title="Source of truth">
          This page documents the shipped behavior of{" "}
          <code>packages/core/src/{"{wire-format,paths,limits,sort-key}"}.ts</code> and{" "}
          <code>packages/api-contract/src/schemas/documents.ts</code>. See also{" "}
          <PageLink slug="crud">CRUD & document paths</PageLink> for read/write semantics and{" "}
          <PageLink slug="reference/errors">Error codes</PageLink> for the exact statuses.
        </Callout>
      </Section>

      <Section id="tagged-values" title="Canonical tagged values">
        <P>
          An object containing the key <code>$t</code> is always interpreted as a tagged wrapper;
          an unknown tag is rejected. The tag determines the required shape of <code>$v</code>.
        </P>
        <Table
          head={["Logical type", "$t", "$v", "Validation"]}
          rows={[
            [<code>int64</code>, <code>"int"</code>, <>Decimal string, e.g. <code>"-9007199254740993"</code></>, <>Must match <code>/^-?\d+$/</code> and lie in <code>[−2⁶³, 2⁶³−1]</code>.</>],
            [<code>timestamp</code>, <code>"ts"</code>, <>ISO-8601 UTC string, e.g. <code>"2026-11-15T14:30:00.123Z"</code></>, <>Must parse with <code>Date.parse</code>. Optional <code>$ms</code> holds finite epoch milliseconds; on write <code>$v</code> and <code>$ms</code> are normalized to a consistent pair.</>],
            [<code>reference</code>, <code>"ref"</code>, <>Canonical document path, e.g. <code>"users/u_123"</code></>, <>Must pass <code>parseDocumentPath</code> and point inside the same project.</>],
            [<code>bytes</code>, <code>"bytes"</code>, <>Standard Base64 string, e.g. <code>"SGVsbG8="</code></>, <>Must match the RFC&nbsp;4648 Base64 pattern (canonical padding).</>],
            [<code>geopoint</code>, <code>"geo"</code>, <><code>{"{ \"lat\": 30.0444, \"lng\": 31.2357 }"}</code></>, <>Finite <code>lat ∈ [−90, 90]</code> and <code>lng ∈ [−180, 180]</code>.</>],
            [<code>escaped map</code>, <code>"map"</code>, <>Plain object, e.g. <code>{"{ \"$t\": \"user_custom\" }"}</code></>, <>Automatic when a user object literally contains the key <code>$t</code>: it becomes <code>{"{ \"$t\": \"map\", \"$v\": { ... } }"}</code> so the map survives losslessly.</>],
          ]}
        />
        <CodeTabs
          tabs={[
            {
              label: "All tags",
              lang: "json",
              code: `{
  "big":    { "$t": "int", "$v": "9007199254740993" },
  "when":   { "$t": "ts", "$v": "2026-11-15T14:30:00.123Z", "$ms": 1794753000123 },
  "owner":  { "$t": "ref", "$v": "users/u_123" },
  "blob":   { "$t": "bytes", "$v": "SGVsbG8=" },
  "loc":    { "$t": "geo", "$v": { "lat": 30.0444, "lng": 31.2357 } }
}`,
            },
            {
              label: "Escaped user map",
              lang: "json",
              code: `// A user map with a literal "$t" key is auto-wrapped:
{ "$t": "user_custom" }
// becomes
{ "$t": "map", "$v": { "$t": "user_custom" } }`,
            },
            {
              label: "Constructors",
              lang: "ts",
              code: `import { WireValue } from "@vellum/core";

const data = {
  big: WireValue.int64("9007199254740993"),
  when: WireValue.timestamp(new Date()),
  owner: WireValue.reference("users/u_123"),
  blob: WireValue.bytes(new Uint8Array([1, 2, 3])),
  loc: WireValue.geopoint(30.0444, 31.2357),
  custom: WireValue.escapeMap({ $t: "user_custom" }),
};`,
            },
          ]}
        />
        <Callout tone="info" title="Legacy aliases accepted on input">
          <code>@vellum/api-contract</code> normalizes pre-v1 aliases before validation:{" "}
          <code>{"$t: \"time\""}</code> becomes <code>{"$t: \"ts\""}</code>, and geopoint{" "}
          <code>$v.latitude</code> / <code>$v.longitude</code> become <code>$v.lat</code> /{" "}
          <code>$v.lng</code>. Validated and returned documents always use the canonical form.
        </Callout>
        <H3 id="validation-rules">Validation & normalization</H3>
        <UL
          items={[
            <><code>validateWireValue</code> recurses through every value. Non-finite numbers (<code>NaN</code>, <code>Infinity</code>) raise <code>INVALID_ARGUMENT</code>.</>,
            <>Any object with <code>$t</code> is a tagged wrapper; any object with <code>$op</code> is a field transform. Transforms are only allowed where the engine opts in.</>,
            <>Plain map keys go through <code>validateFieldName</code>: non-empty, at most 256 characters and free of control characters, otherwise <code>INVALID_FIELD_NAME</code>.</>,
            <><code>canonicalizeTimestamps</code> rewrites every <code>ts</code> value to a canonical <code>$v</code>/<code>$ms</code> pair.</>,
            <><code>normalizeAndValidateDocumentData</code> requires a plain map at the root (no <code>$t</code> or <code>$op</code>), enforces nesting depth, then compares <code>Buffer.byteLength(JSON.stringify(normalized))</code> with the 1&nbsp;MiB cap.</>,
          ]}
        />
      </Section>

      <Section id="field-transforms" title="Atomic field transforms ($op)">
        <P>
          Transform sentinels let the server compute a value at commit time. They are accepted
          only in <code>PATCH</code>, <code>PUT</code> with <code>merge: true</code>,{" "}
          <code>batchWrite</code> and <code>transactions:commit</code>; a bare <code>POST</code>{" "}
          create rejects them with <code>INVALID_ARGUMENT</code>. The set of transforms, their
          parameters and their failure modes is fixed in v1.
        </P>
        <Table
          head={["$op", "Parameters", "Effect", "On bad input"]}
          rows={[
            [<code>serverTimestamp</code>, "—", <>Replaced with the current server transaction UTC timestamp <code>{"{ \"$t\": \"ts\", \"$v\": \"...\", \"$ms\": ... }"}</code>.</>, "—"],
            [<><code>inc</code> (alias <code>increment</code>)</>, <>Finite number <code>by</code> (or <code>value</code>)</>, <>Adds to an existing finite number; initializes to <code>by</code> when missing.</>, <><code>INVALID_ARGUMENT</code>; <code>FAILED_PRECONDITION</code> (412) if the existing field is non-numeric.</>],
            [<code>arrayUnion</code>, <><code>elements: any[]</code></>, "Appends elements not already present, using deep wire-value equality.", <><code>INVALID_ARGUMENT</code> if <code>elements</code> is missing or not an array.</>],
            [<code>arrayRemove</code>, <><code>elements: any[]</code></>, "Removes all occurrences matching any element.", <><code>INVALID_ARGUMENT</code> if <code>elements</code> is missing or not an array.</>],
            [<code>deleteField</code>, "—", "Removes the target property from its parent map.", "—"],
          ]}
        />
        <CodeTabs
          tabs={[
            {
              label: "PATCH body",
              lang: "json",
              code: `{
  "data": {
    "views": { "$op": "inc", "by": 1 },
    "updatedAt": { "$op": "serverTimestamp" },
    "tags": { "$op": "arrayUnion", "elements": ["featured"] },
    "legacyId": { "$op": "deleteField" }
  }
}`,
            },
            {
              label: "SDK helpers",
              lang: "ts",
              code: `import { fieldOp } from "@vellumdb/sdk-js";

await db.collection("posts").doc("p1").update({
  views: fieldOp.increment(1),
  updatedAt: fieldOp.serverTimestamp(),
  tags: fieldOp.arrayUnion(["featured"]),
});`,
            },
            {
              label: "Dart",
              lang: "dart",
              code: `await client.updateDoc("posts/p1", {
  "views": FieldOp.increment(1),
  "updatedAt": FieldValue.serverTimestamp(),
  "tags": FieldOp.arrayUnion(["featured"]),
});`,
            },
          ]}
        />
        <Callout tone="warning" title="Two accepted payload spellings">
          The core validator used by the engine accepts <code>by</code> / <code>value</code> for{" "}
          <code>inc</code> and <code>elements</code> for the array ops. The Zod{" "}
          <code>TaggedFieldTransformSchema</code> additionally uses <code>$v</code> as the payload
          key (<code>increment</code>, <code>arrayUnion</code>, <code>arrayRemove</code>). The
          examples above follow the core validator; prefer the SDK field-op helpers so the correct
          spelling is chosen for you. See{" "}
          <PageLink slug="field-transforms">Field transforms</PageLink> for ordering and merge
          semantics.
        </Callout>
      </Section>

      <Section id="path-grammar" title="Path grammar">
        <P>
          Every document-plane resource is addressed by a canonical, <code>/</code>-separated UTF-8
          path. Parity is the rule: <strong>odd = collection, even = document</strong>. There are no
          leading or trailing slashes and no empty segments.
        </P>
        <Table
          head={["Rule", "Document path", "Collection path"]}
          rows={[
            ["Segment count", "Even: 2, 4, 6, 8 or 10", "Odd: 1, 3, 5, 7 or 9"],
            ["Depth meaning", "Up to 5 nested collections", "Up to 5 collection levels"],
            ["Start / end", "No leading or trailing /", "No leading or trailing /"],
            ["Empty segments", "Rejected", "Rejected"],
            ["Relative / encoded", <><code>.</code>, <code>..</code>, <code>%2e%2e</code>, <code>%2f</code> rejected</>, "Same"],
            ["System-reserved", <>Any segment matching <code>^__.*__$</code> rejected</>, "Same"],
            ["Control characters", <><code>0x00</code>–<code>0x1F</code> rejected</>, "Same"],
            ["Segment size", "≤ 1,500 UTF-8 bytes", "≤ 1,500 UTF-8 bytes"],
          ]}
        />
        <P>
          Every violation raises <code>INVALID_DOCUMENT_PATH</code> (400). A valid path is
          decomposed deterministically — <code>users/u_123/orders/ord_456</code>:
        </P>
        <Table
          head={["Property", "Value"]}
          rows={[
            [<code>path</code>, <code>users/u_123/orders/ord_456</code>],
            [<code>collectionPath</code>, <code>users/u_123/orders</code>],
            [<code>collectionGroup</code>, <code>orders</code>],
            [<code>documentId</code>, <code>ord_456</code>],
            [<code>pathDepth</code>, <code>4</code>],
          ]}
        />
        <Code
          code={`parseDocumentPath("users/u_123/orders/ord_456");
// { path, collectionPath, collectionGroup, documentId, pathDepth, segments }

parseCollectionPath("users/u_123/orders");
// { collectionPath, collectionGroup: "orders", depth: 3, segments }

parseDocumentPath("users/u_123/orders/"); // INVALID_DOCUMENT_PATH
parseCollectionPath("users//orders");     // INVALID_DOCUMENT_PATH
parseCollectionPath("users/__meta__");    // INVALID_DOCUMENT_PATH`}
          lang="ts"
          title="Path parsing"
        />
      </Section>

      <Section id="locked-limits" title="Locked v1 limits">
        <P>
          These constants are defined once in <code>@vellum/core</code>{" "}
          (<code>SYSTEM_LIMITS</code>) and enforced at the engine boundaries. A breach always maps
          to a canonical error code.
        </P>
        <Table
          head={["Constant", "Value", "Breach code / status"]}
          rows={[
            [<code>MAX_DOCUMENT_BYTES</code>, "1,048,576 (1 MiB)", <><code>DOCUMENT_TOO_LARGE</code> / 413</>],
            [<code>MAX_PATH_DEPTH</code>, "10 segments", <><code>INVALID_DOCUMENT_PATH</code> / 400</>],
            [<code>MAX_PATH_SEGMENT_BYTES</code>, "1,500", <><code>INVALID_DOCUMENT_PATH</code> / 400</>],
            [<code>MAX_OBJECT_NESTING_DEPTH</code>, "20", <><code>MAX_NESTING_EXCEEDED</code> / 400</>],
            [<code>MAX_FIELD_NAME_LENGTH</code>, "256", <><code>INVALID_FIELD_NAME</code> / 400</>],
            [<code>MAX_BATCH_OPERATIONS</code>, "100", <><code>BATCH_SIZE_EXCEEDED</code> / 400</>],
            [<code>MAX_BATCH_PAYLOAD_BYTES</code>, "5,242,880 (5 MiB)", <><code>PAYLOAD_TOO_LARGE</code> / 413</>],
            [<code>MAX_TRANSACTION_DURATION_MS</code>, "5,000", <><code>TRANSACTION_TIMEOUT</code> / 408</>],
            [<code>MAX_WHERE_CLAUSES</code>, "10", <><code>QUERY_TOO_COMPLEX</code> / 400</>],
            [<code>MAX_DISJUNCTIVE_VALUES</code>, "30", <><code>QUERY_TOO_COMPLEX</code> / 400</>],
            [<code>MAX_ORDER_BY_FIELDS</code>, "3", <><code>QUERY_TOO_COMPLEX</code> / 400</>],
            [<><code>DEFAULT_QUERY_LIMIT</code> / <code>MAX_QUERY_LIMIT</code></>, "50 / 500", <><code>LIMIT_EXCEEDED</code> / 400</>],
            [<code>MAX_QUERY_RESPONSE_BYTES</code>, "4,194,304 (4 MiB)", <><code>RESPONSE_TOO_LARGE</code> / 413</>],
            [<code>MAX_QUERY_EXECUTION_MS</code>, "5,000", <><code>QUERY_DEADLINE_EXCEEDED</code> / 504</>],
            [<code>MAX_WS_SUBSCRIPTIONS_PER_CONN</code>, "50", <><code>SUBSCRIPTION_LIMIT_EXCEEDED</code> / 400</>],
            [<code>MAX_WS_OUTBOUND_BUFFER_BYTES</code>, "1,048,576 (1 MiB)", <><code>SLOW_CONSUMER_DISCONNECT</code> / 429</>],
            [<><code>RULES_AST_MAX_DEPTH</code> / <code>RULES_AST_MAX_NODES</code></>, "10 / 100", <><code>INVALID_ARGUMENT</code> / 400</>],
            [<><code>MAX_COMPOSITE_INDEXES_FREE</code> / <code>_PRO</code></>, "50 / 200", "Plan enforcement"],
          ]}
        />
        <P>
          The full status map, including codes without a quota, is in{" "}
          <PageLink slug="reference/errors">Error codes & retry guidance</PageLink>; the same
          limits grouped by subsystem are in{" "}
          <PageLink slug="errors-and-limits">Quotas & limits</PageLink>.
        </P>
      </Section>

      <Section id="sort-keys" title="Binary sort keys (internal)">
        <P>
          Tenant-defined composite indexes never issue <code>CREATE INDEX</code> on the shared{" "}
          <code>documents</code> table. Instead, each field of an index entry is encoded into an
          order-preserving <code>sort_key BYTEA</code> stored as a row in{" "}
          <code>document_index_entries</code>. A leading type tag makes different types sort
          deterministically relative to one another.
        </P>
        <Table
          head={["Type", "Tag", "Type", "Tag"]}
          rows={[
            [<code>MISSING</code>, <code>0x05</code>, <code>NULL</code>, <code>0x0a</code>],
            [<code>BOOLEAN</code>, <code>0x10</code>, <code>NUMBER</code>, <code>0x20</code>],
            [<code>STRING</code>, <code>0x30</code>, <code>TIMESTAMP</code>, <code>0x40</code>],
            [<code>REFERENCE</code>, <code>0x50</code>, <code>BYTES</code>, <code>0x60</code>],
            [<code>GEOPOINT</code>, <code>0x70</code>, "", ""],
          ]}
        />
        <UL
          items={[
            <>Floats use a sign-flipped big-endian encoding and int64s use XOR with the sign bit, so raw byte order matches numeric order.</>,
            <>Strings and references are UTF-8 with null-byte escaping and a <code>0x00 0x00</code> terminator.</>,
            <>A <code>desc</code> field inverts every encoded byte (XOR <code>0xff</code>) so a single ascending comparison serves both directions.</>,
          ]}
        />
        <P>
          This is an internal representation: you define indexes, not sort keys. See{" "}
          <PageLink slug="indexes">Composite indexes</PageLink> for index creation and{" "}
          <PageLink slug="reference/realtime-protocol">Realtime protocol</PageLink> for the
          document payloads that travel over the socket.
        </P>
      </Section>
    </Doc>
  );
}
