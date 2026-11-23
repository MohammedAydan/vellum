import {
  Api,
  Badge,
  Callout,
  CodeTabs,
  Doc,
  H3,
  P,
  PageLink,
  Section,
  Table,
  UL,
} from "../../ui";

export default function Page() {
  return (
    <Doc
      title="Field transforms"
      description="Every atomic fieldOp sentinel, how the server applies it, where it is allowed and the restrictions that keep writes deterministic."
      eyebrow="Core concepts"
    >
      <Section id="overview" title="Overview">
        <P>
          A field transform tells the server to compute a field value at commit
          time instead of sending a precomputed value. This avoids a
          read-modify-write race: clients never have to read a counter, add one,
          and write it back while another client does the same.
        </P>
        <P>
          The SDK exposes five helpers under <code>fieldOp</code> (and
          <code> FieldOp</code> in Flutter). On the wire, each becomes a sentinel
          object with a reserved <code>$op</code> key. The engine replaces the
          sentinel with the computed value inside the same transaction as the
          write.
        </P>
        <CodeTabs
          tabs={[
            { label: "TypeScript", lang: "ts", code: `import { fieldOp } from "@vellumdb/sdk-js";` },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `import 'package:vellum_flutter/vellum_flutter.dart';
// FieldOp and FieldValue both expose the five operations.`,
            },
          ]}
        />
        <Callout tone="info" title="Scenario">
          Several users can “like” a post at the same time. Use{" "}
          <code>increment(1)</code> for an accurate <code>likeCount</code> and{" "}
          <code>arrayUnion</code> to record unique reactor ids. The server applies
          both atomically, so no update is lost and no id is duplicated.
        </Callout>
      </Section>

      <Section id="operations" title="The five operations">
        <P>
          These are all of the field operations in v1. Each SDK helper emits the
          exact wire sentinel shown below.
        </P>
        <Table
          head={["SDK helper", "Wire sentinel", "Behavior"]}
          rows={[
            [
              <code>fieldOp.serverTimestamp()</code>,
              <code>{`{ "$op": "serverTimestamp" }`}</code>,
              <>
                Replaced with the transaction&apos;s single UTC timestamp as a
                tagged value: <code>{`{ "$t": "ts", "$v": "…", "$ms": … }`}</code>.
              </>,
            ],
            [
              <code>fieldOp.increment(n = 1)</code>,
              <code>{`{ "$op": "inc", "by": n }`}</code>,
              <>
                Adds <code>n</code> to the current value. A missing field is
                initialized to <code>n</code>.
              </>,
            ],
            [
              <code>fieldOp.arrayUnion(...items)</code>,
              <code>{`{ "$op": "arrayUnion", "elements": [...] }`}</code>,
              <>
                Appends items not already present, using wire-value equality
                (tagged values compare correctly, not by object identity).
              </>,
            ],
            [
              <code>fieldOp.arrayRemove(...items)</code>,
              <code>{`{ "$op": "arrayRemove", "elements": [...] }`}</code>,
              <>Removes every occurrence matching any supplied item.</>,
            ],
            [
              <code>fieldOp.deleteField()</code>,
              <code>{`{ "$op": "deleteField" }`}</code>,
              <>Removes the field from its parent map.</>,
            ],
          ]}
        />

        <CodeTabs
          tabs={[
            {
              label: "TypeScript",
              lang: "ts",
              code: `import { createClient, fieldOp } from "@vellumdb/sdk-js";

const db = createClient({ projectId: "<YOUR_PROJECT_ID>", apiKey: "<YOUR_API_KEY>" });

await db.collection("users").doc("u_123").set(
  {
    loginCount: fieldOp.increment(1),
    roles: fieldOp.arrayUnion(["developer", "architect"]),
    tags: fieldOp.arrayRemove(["trial"]),
    lastLoginAt: fieldOp.serverTimestamp(),
    legacyFlag: fieldOp.deleteField(),
  },
  { merge: true }
);

// Two independent counters updated in a single write.
await db.collection("stats").doc("global").update({
  posts: fieldOp.increment(1),
  lastPostAt: fieldOp.serverTimestamp(),
});`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `await client.setDoc('users/u_123', {
  'loginCount': FieldOp.increment(1),
  'roles': FieldOp.arrayUnion(['developer', 'architect']),
  'tags': FieldOp.arrayRemove(['trial']),
  'lastLoginAt': FieldOp.serverTimestamp(),
  'legacyFlag': FieldOp.deleteField(),
}, merge: true);

await client.updateDoc('stats/global', {
  'posts': FieldOp.increment(1),
  'lastPostAt': FieldOp.serverTimestamp(),
});`,
            },
          ]}
        />

        <H3 id="variadic-and-aliases">Variadic arguments and wire aliases</H3>
        <UL
          items={[
            <>
              <code>arrayUnion</code> and <code>arrayRemove</code> accept either
              variadic arguments or a single array:{" "}
              <code>fieldOp.arrayUnion("a", "b")</code> and{" "}
              <code>fieldOp.arrayUnion(["a", "b"])</code> are equivalent.
            </>,
            <>
              On the wire, increment also accepts the alias{" "}
              <code>{`{ "$op": "increment", "value": n }`}</code>. The canonical
              SDK helper emits <code>inc</code> with <code>by</code>.
            </>,
            <>
              Any other <code>$op</code> value is rejected with INVALID_ARGUMENT
              (400).
            </>,
          ]}
        />
      </Section>

      <Section id="where-allowed" title="Where transforms are allowed">
        <P>
          Write mutations validate their data with field operations enabled and
          then apply every sentinel through the transform engine. This applies
          to all of the following paths.
        </P>
        <Table
          head={["Write path", "SDK call", "Allowed"]}
          rows={[
            [
              "Set (replace)",
              <code>db.collection(path).doc(id).set(data)</code>,
              <Badge tone="success">Yes</Badge>,
            ],
            [
              "Set (merge)",
              <code>{"set(data, { merge: true })"}</code>,
              <Badge tone="success">Yes</Badge>,
            ],
            [
              "Update",
              <code>db.collection(path).doc(id).update(data)</code>,
              <Badge tone="success">Yes</Badge>,
            ],
            [
              "Create",
              <code>db.collection(path).doc(id).create(data)</code>,
              <Badge tone="success">Yes</Badge>,
            ],
            ["Batch mutations", <code>db.batchWrite([...])</code>, <Badge tone="success">Yes</Badge>],
            [
              "Transaction commits",
              <>
                <code>db.runTransaction(fn)</code> with <code>tx.set</code> /{" "}
                <code>tx.update</code>
              </>,
              <Badge tone="success">Yes</Badge>,
            ],
            [
              "Query filter values",
              <code>db.collection(path).where(field, op, value)</code>,
              <Badge tone="danger">No — INVALID_ARGUMENT (400)</Badge>,
            ],
          ]}
        />
        <Api method="PATCH" path="/v1/projects/:projectId/documents/*">
          <P>
            The update endpoint accepts <code>$op</code> sentinels in the
            <code> data</code> map. Query values are validated as plain wire
            values, so a sentinel there raises INVALID_ARGUMENT (400).
          </P>
        </Api>
        <Callout tone="warning" title="Do not query on sentinels">
          A <code>$op</code> object is an instruction, not a stored value. Filter
          on the computed field value instead — for example, query the{" "}
          <code>likeCount</code> number after the increment has committed. See{" "}
          <PageLink slug="query">Query</PageLink> for filter rules.
        </Callout>
      </Section>

      <Section id="atomicity-and-ordering" title="Atomicity and ordering">
        <UL
          items={[
            <>
              All transforms in one write are applied inside a single database
              transaction and share one transaction timestamp, so every{" "}
              <code>serverTimestamp</code> in the patch is identical.
            </>,
            <>
              The patch is walked in object-key insertion order. Nested plain
              objects are merged recursively, so a transform may sit at any
              depth of the document.
            </>,
            <>
              <code>arrayUnion</code> and <code>arrayRemove</code> use wire-value
              equality: timestamps, references and int64 values compare by their
              logical value, not JavaScript object identity.
            </>,
            <>
              For <code>increment</code>, a tagged int64 current value
              (<code>{`{ "$t": "int", … }`}</code>) is computed with{" "}
              <code>BigInt</code> and stored back as an int64; otherwise the
              engine uses IEEE-754 addition.
            </>,
          ]}
        />
        <P>
          Because transforms are evaluated at commit time against the currently
          stored value, two clients incrementing the same counter concurrently
          do not lose updates. If you also need preconditions across several
          documents, wrap the writes in{" "}
          <PageLink slug="batch-and-transactions">
            a transaction
          </PageLink>
          .
        </P>
      </Section>

      <Section id="restrictions-and-errors" title="Restrictions and failure modes">
        <Table
          head={["Condition", "Result"]}
          rows={[
            [
              "Increment a field whose current value is not numeric (and not a tagged int64)",
              <Badge tone="danger">FAILED_PRECONDITION (412)</Badge>,
            ],
            [
              "Unknown $op value",
              <Badge tone="danger">INVALID_ARGUMENT (400)</Badge>,
            ],
            [
              "inc without a finite numeric by / value",
              <Badge tone="danger">INVALID_ARGUMENT (400)</Badge>,
            ],
            [
              "arrayUnion / arrayRemove without an elements array",
              <Badge tone="danger">INVALID_ARGUMENT (400)</Badge>,
            ],
            [
              "Field named __proto__, constructor or prototype at any merge level",
              <Badge tone="danger">INVALID_FIELD_NAME (400)</Badge>,
            ],
            [
              "Nesting over 20 levels, field name over 256 characters, or a document over 1 MiB after transforms",
              <Badge tone="danger">
                MAX_NESTING_EXCEEDED / INVALID_FIELD_NAME / DOCUMENT_TOO_LARGE
              </Badge>,
            ],
          ]}
        />

        <H3 id="preconditions">Transforms and preconditions</H3>
        <P>
          <code>ifVersion</code> compares the document version <em>before</em> the
          write. It does not validate the transformed result, so do not combine a
          transform with a precondition that depends on that same field&apos;s
          post-transform value. A failed version check returns{" "}
          <code>FAILED_PRECONDITION</code> (412) with{" "}
          <code>expectedVersion</code> and <code>actualVersion</code> in the error
          details.
        </P>

        <H3 id="common-pitfalls">Common pitfalls</H3>
        <UL
          items={[
            <>
              <strong>Assuming read-your-writes inside a transform.</strong>{" "}
              Transforms run at commit time against the current stored value.
            </>,
            <>
              <strong>Incrementing a non-numeric field.</strong> The first write
              must initialize the field to a number (or a tagged int64).
            </>,
            <>
              <strong>Putting a sentinel in a query value.</strong> Query values
              are plain wire values and reject <code>$op</code> with
              INVALID_ARGUMENT.
            </>,
            <>
              <strong>
                Using <code>ifVersion</code> to protect a transformed field.
              </strong>{" "}
              It guards the pre-write version, not the computed result.
            </>,
          ]}
        />
        <P>
          For the complete status mapping and safe retry guidance, see{" "}
          <PageLink slug="reference/errors">Error codes &amp; retry guidance</PageLink>
          . For the wire-level definition of the <code>$op</code> sentinels, see{" "}
          <PageLink slug="reference/wire-format">Wire format &amp; paths</PageLink>.
          To read the document that results from a transform, see{" "}
          <PageLink slug="crud">CRUD &amp; document paths</PageLink>.
        </P>
      </Section>
    </Doc>
  );
}
