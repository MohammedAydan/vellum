import {
  Api,
  Badge,
  Callout,
  Code,
  CodeTabs,
  Doc,
  H3,
  PageLink,
  P,
  Section,
  Table,
  UL,
} from "../../ui";

export default function Page() {
  return (
    <Doc
      title="CRUD & document paths"
      description="Canonical paths, document and collection references, create/set/update/delete, version preconditions and the tagged wire format."
      eyebrow="Core concepts"
    >
      <Section id="overview" title="Overview">
        <P>
          Every resource in the VELLUM data plane is addressed by a canonical,
          <code>/</code>-separated UTF-8 path. Paths alternate between collection
          segments (odd depth) and document-id segments (even depth). A document
          reference always points to an even-depth path; a collection reference
          points to an odd-depth path.
        </P>
        <P>
          All writes and reads are scoped to a project by the
          client, and every request carries an API key. The SDK builds the
          correct REST URL for you, but the same rules apply if you call the HTTP
          API directly.
        </P>
        <Callout tone="info" title="What you will build">
          A user document at <code>users/u_123</code> with a subcollection of
          orders at <code>users/u_123/orders/ord_456</code>. You will create the
          user, patch a field, guard a write with a version precondition, and read
          the stored document with its metadata.
        </Callout>
      </Section>

      <Section id="paths" title="Canonical path rules">
        <P>
          Paths are validated by <code>@vellum/core</code> before any SQL runs.
          A document path must have an even number of segments between 2 and 10;
          a collection path must have an odd number between 1 and 9. Depth 10 is
          therefore five levels of nested collections.
        </P>

        <Table
          head={["Rule", "Document path", "Collection path", "Locked v1 limit / error"]}
          rows={[
            [
              "Segment count",
              "Even, 2–10",
              "Odd, 1–9",
              "MAX_PATH_DEPTH = 10 → INVALID_DOCUMENT_PATH (400)",
            ],
            [
              "Leading / trailing slash",
              "Rejected",
              "Rejected",
              "INVALID_DOCUMENT_PATH (400)",
            ],
            [
              "Empty segment",
              "Rejected",
              "Rejected",
              "INVALID_DOCUMENT_PATH (400)",
            ],
            [
              "Segment byte length (UTF-8)",
              "≤ 1,500 bytes",
              "≤ 1,500 bytes",
              "MAX_PATH_SEGMENT_BYTES = 1,500 → INVALID_DOCUMENT_PATH (400)",
            ],
            [
              "Forward slash inside a segment",
              "Rejected",
              "Rejected",
              "INVALID_DOCUMENT_PATH (400)",
            ],
            [
              "NUL byte / ASCII control chars 0x00–0x1F",
              "Rejected",
              "Rejected",
              "INVALID_DOCUMENT_PATH (400)",
            ],
            [
              "Relative segments . and .. (and encoded %2e%2e / %2f)",
              "Rejected",
              "Rejected",
              "INVALID_DOCUMENT_PATH (400)",
            ],
            [
              "Reserved system segments matching ^__.*__$",
              "Rejected (e.g. __name__)",
              "Rejected",
              "INVALID_DOCUMENT_PATH (400)",
            ],
          ]}
        />

        <H3 id="path-decomposition">Path decomposition</H3>
        <P>
          A document path deterministically decomposes into the following parts.
          These are the values returned as document metadata.
        </P>
        <Table
          head={["Component", "Value for users/u_123/orders/ord_456"]}
          rows={[
            ["path", "users/u_123/orders/ord_456"],
            ["collectionPath", "users/u_123/orders"],
            ["collectionGroup", "orders"],
            ["documentId", "ord_456"],
            ["pathDepth", "4"],
          ]}
        />
        <P>
          The maximum depth path is <code>c1/d1/c2/d2/c3/d3/c4/d4/c5/d5</code>:
          five collections and five document ids. Exceeding any of the rules
          above raises <code>INVALID_DOCUMENT_PATH</code> with HTTP 400.
        </P>
      </Section>

      <Section id="references" title="Document and collection references">
        <P>
          References are immutable builders. Calling a method on a reference
          returns a new value with the updated state, so a reference can be
          safely reused and shared.
        </P>
        <CodeTabs
          tabs={[
            {
              label: "TypeScript",
              lang: "ts",
              code: `import { createClient } from "@vellum/sdk-js";

const db = createClient({
  projectId: "<YOUR_PROJECT_ID>",
  apiKey: "<YOUR_API_KEY>",
});

// Document reference (even number of segments).
const user = db.collection("users").doc("u_123");

// Collection reference (odd number of segments), then a document inside it.
const orders = db.collection("users/u_123/orders");
const order = orders.doc("ord_456");

// Nested subcollection from an existing document reference.
const events = user.collection("events"); // users/u_123/events`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `import 'package:vellum_flutter/vellum_flutter.dart';

final client = VellumClient(
  endpoint: 'http://localhost:8080',
  projectId: '<YOUR_PROJECT_ID>',
  apiKey: '<YOUR_API_KEY>',
);

// Reads and writes take a full canonical path.
final user = await client.getDoc('users/u_123');`,
            },
          ]}
        />
        <P>
          On the wire, every call is sent to a path-scoped REST endpoint. The
          document path is the wildcard segment after <code>/documents/</code>.
        </P>
      </Section>

      <Section id="writes" title="Create, set, update and delete">
        <Table
          head={["Operation", "SDK call", "HTTP", "Semantics"]}
          rows={[
            [
              "create",
              <code>db.collection(path).doc(id).create(data)</code>,
              "POST",
              "Fails with ALREADY_EXISTS (409) if the path is occupied.",
            ],
            [
              "set (replace)",
              <code>db.collection(path).doc(id).set(data)</code>,
              "PUT",
              "Replaces the entire document data map.",
            ],
            [
              "set (merge)",
              <code>{"set(data, { merge: true })"}</code>,
              "PUT",
              "Deep-merges the supplied keys; other keys are preserved.",
            ],
            [
              "update",
              <code>db.collection(path).doc(id).update(data)</code>,
              "PATCH",
              "Patches only the supplied keys; supports field transforms.",
            ],
            [
              "get",
              <code>db.collection(path).doc(id).get()</code>,
              "GET",
              "Returns the document plus server-managed metadata.",
            ],
            [
              "delete",
              <code>db.collection(path).doc(id).delete()</code>,
              "DELETE",
              "Soft delete: tombstone plus a durable outbox event.",
            ],
          ]}
        />

        <CodeTabs
          tabs={[
            {
              label: "TypeScript",
              lang: "ts",
              code: `import { createClient, fieldOp } from "@vellum/sdk-js";

const db = createClient({ projectId: "<YOUR_PROJECT_ID>", apiKey: "<YOUR_API_KEY>" });
const user = db.collection("users").doc("u_123");

// create — fails with ALREADY_EXISTS if the path is occupied.
await user.create({ name: "Ada", role: "admin" });

// set — replace by default, or deep-merge with { merge: true }.
await user.set({ name: "Ada Lovelace" }, { merge: true });

// update — patch only the given fields; supports field transforms.
await user.update({ lastSeenAt: fieldOp.serverTimestamp() });

// delete — soft delete (tombstone + outbox event).
await user.delete();

// A read returns the document and its metadata.
const snap = await user.get();
console.log(snap.path, snap.version, snap.exists, snap.data());`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `// create is a set on a new path; set/merge overwrites or patches.
await client.setDoc('users/u_123', {'name': 'Ada', 'role': 'admin'});
await client.setDoc('users/u_123', {'name': 'Ada Lovelace'}, merge: true);
await client.updateDoc('users/u_123', {'status': 'approved'});

final snap = await client.getDoc('users/u_123');
await client.deleteDoc('users/u_123');`,
            },
          ]}
        />

        <H3 id="version-preconditions">Optimistic concurrency with ifVersion</H3>
        <P>
          Every document carries a monotonically increasing <code>version</code>.
          Pass the expected version as a precondition so a write is rejected if
          another writer changed the document first. <code>set</code>,
          <code>update</code> and <code>delete</code> all accept it.
        </P>
        <Code
          lang="ts"
          code={`const snap = await db.collection("users").doc("u_123").get();
await db.collection("users").doc("u_123").update(
  { status: "approved" },
  { ifVersion: snap.version }
);
// If another writer bumped the version, this throws
// FAILED_PRECONDITION (412) with expectedVersion and actualVersion in details.`}
        />
        <P>
          For atomicity across several documents with preconditions, use a
          transaction — see{" "}
          <PageLink slug="batch-and-transactions">
            Batch writes &amp; transactions
          </PageLink>
          .
        </P>

        <H3 id="rest-endpoints">REST endpoints</H3>
        <Api method="GET" path="/v1/projects/:projectId/documents/*">
          <P>
            Read a document (even segments). An odd-segment path performs a
            collection listing with <code>limit</code> (default 50) and an
            optional <code>startAfter</code> cursor.
          </P>
        </Api>
        <Api method="POST" path="/v1/projects/:projectId/documents/*">
          <P>Create a document. Returns 201, or ALREADY_EXISTS (409).</P>
        </Api>
        <Api method="PUT" path="/v1/projects/:projectId/documents/*">
          <P>
            Replace or merge. Body carries <code>data</code>, <code>merge</code>{" "}
            and optional <code>ifVersion</code>.
          </P>
        </Api>
        <Api method="PATCH" path="/v1/projects/:projectId/documents/*">
          <P>
            Patch fields and apply <code>$op</code> transforms. Body carries{" "}
            <code>data</code> and optional <code>ifVersion</code>.
          </P>
        </Api>
        <Api method="DELETE" path="/v1/projects/:projectId/documents/*">
          <P>
            Soft-delete a document, optionally with an <code>ifVersion</code>{" "}
            query parameter.
          </P>
        </Api>
        <Callout tone="info" title="Authentication">
          Every document-plane call requires the <code>x-vellum-api-key</code>{" "}
          header (<code>pk_</code> for browser/mobile, <code>sk_</code> for
          servers). An optional EdDSA end-user bearer may be supplied via{" "}
          <code>authorization</code> or <code>x-vellum-user-token</code>. Missing
          or mismatched keys yield UNAUTHENTICATED (401) or PERMISSION_DENIED
          (403). See <PageLink slug="authentication">Authentication</PageLink>.
        </Callout>
      </Section>

      <Section id="wire-format" title="Tagged wire format basics">
        <P>
          Native JSON primitives (<code>null</code>, <code>boolean</code>,{" "}
          <code>string</code>, finite <code>number</code>, <code>array</code>)
          are stored directly so PostgreSQL <code>jsonb_path_ops</code> indexes
          can use them without wrapper overhead. Extended types use the reserved
          keys <code>$t</code> (tag) and <code>$v</code> (value).
        </P>
        <Table
          head={["Logical type", "Wire representation"]}
          rows={[
            ["int64", <code>{`{ "$t": "int", "$v": "-9007199254740993" }`}</code>],
            [
              "timestamp",
              <code>{`{ "$t": "ts", "$v": "2026-11-15T14:30:00.123Z", "$ms": 1794753000123 }`}</code>,
            ],
            ["reference", <code>{`{ "$t": "ref", "$v": "users/u_123" }`}</code>],
            ["bytes", <code>{`{ "$t": "bytes", "$v": "SGVsbG8=" }`}</code>],
            [
              "geopoint",
              <code>{`{ "$t": "geo", "$v": { "lat": 30.0444, "lng": 31.2357 } }`}</code>,
            ],
            [
              "user map containing $t",
              <code>{`{ "$t": "map", "$v": { ... } }`}</code>,
            ],
          ]}
        />
        <UL
          items={[
            <>
              Numbers must be finite; <code>NaN</code> and <code>Infinity</code>{" "}
              are rejected with INVALID_ARGUMENT (400).
            </>,
            <>
              A reference (<code>$t: "ref"</code>) is a plain canonical path
              string in the same project; VELLUM does not fetch
              the target document.
            </>,
            <>
              A user object that literally contains the key <code>$t</code> is
              wrapped automatically as <code>$t: "map"</code> for lossless
              round-tripping.
            </>,
          ]}
        />
        <P>
          The full grammar, including validation rules for every tag, is in{" "}
          <PageLink slug="reference/wire-format">Wire format &amp; paths</PageLink>.
        </P>
      </Section>

      <Section id="limits-and-errors" title="Locked v1 limits and error codes">
        <P>
          These quotas are enforced by <code>@vellum/core</code> and cannot be
          relaxed in v1. Document writes and paths are governed by the following
          limits.
        </P>
        <Table
          head={["Limit", "Value", "Error on breach"]}
          rows={[
            [
              "Maximum document size",
              "1,048,576 bytes (1 MiB)",
              <Badge tone="danger">DOCUMENT_TOO_LARGE (413)</Badge>,
            ],
            [
              "Maximum path depth",
              "10 segments (5 nested collections)",
              <Badge tone="danger">INVALID_DOCUMENT_PATH (400)</Badge>,
            ],
            [
              "Maximum path segment",
              "1,500 UTF-8 bytes",
              <Badge tone="danger">INVALID_DOCUMENT_PATH (400)</Badge>,
            ],
            [
              "Maximum nesting depth",
              "20 levels",
              <Badge tone="danger">MAX_NESTING_EXCEEDED (400)</Badge>,
            ],
            [
              "Maximum field name length",
              "256 characters",
              <Badge tone="danger">INVALID_FIELD_NAME (400)</Badge>,
            ],
          ]}
        />
        <P>
          Other codes you will encounter on CRUD paths:{" "}
          <code>ALREADY_EXISTS</code> (409) from <code>create</code>,{" "}
          <code>FAILED_PRECONDITION</code> (412) from a failed{" "}
          <code>ifVersion</code>, and <code>NOT_FOUND</code> (404). The canonical
          status mapping for every code is in{" "}
          <PageLink slug="reference/errors">Error codes &amp; retry guidance</PageLink>{" "}
          and <PageLink slug="errors-and-limits">Quotas &amp; limits</PageLink>.
        </P>
      </Section>
    </Doc>
  );
}
