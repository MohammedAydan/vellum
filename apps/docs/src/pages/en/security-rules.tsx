import { Api, Callout, Code, CodeTabs, Doc, H3, P, PageLink, Section, Table } from "../../ui";

const RULES_PATH = "/v1/projects/:projectId/rulesets";
const CONSOLE_RULES_PATH = "/v1/console/projects/:projectId/rulesets";

export default function Page() {
  return (
    <Doc
      title="Security rules"
      description="The v1 JSON rules AST: deny-by-default evaluation, wildcard matching, validation bounds, publishing, and simulation."
      eyebrow="Security"
    >
      <Section id="how-it-works" title="How rules work">
        <P>
          Security rules decide whether a <strong>public API key</strong> (<code>pk_</code>) may read or write a
          document. They are stored as a versioned JSON <strong>Abstract Syntax Tree</strong> in the control plane
          and evaluated synchronously in memory — never by generating or executing code. Every public-key
          operation (<code>get</code>, <code>list</code>, <code>create</code>, <code>update</code>,
          <code> delete</code>) is checked against the project's active ruleset.
        </P>
        <P>
          A <strong>server key</strong> (<code>sk_</code>) bypasses the AST only for operations covered by its
          explicit scopes: <code>documents:read</code>, <code>documents:write</code>, or
          <code> indexes:manage</code>. Public keys can never manage composite indexes. With no active ruleset,
          all public-key access is denied.
        </P>
        <Callout tone="info" title="Rules consume identity; they do not create it">
          The <code>auth.*</code> variables are populated from the EdDSA end-user bearer token resolved by the
          document plane. Without a valid token, <code>auth.uid</code> is <code>null</code>. See{" "}
          <PageLink slug="end-user-auth">End users & the three realms</PageLink>.
        </Callout>
      </Section>

      <Section id="ruleset-shape" title="Ruleset shape (v1)">
        <P>
          A ruleset has <code>version: 1</code> and a <code>rules</code> array. Each rule pairs a <code>match</code>
          path pattern with an <code>allow</code> object whose keys are operations and whose values are expressions.
          This example lets each signed-in user manage their own document and orders, while an admin may list and
          delete users:
        </P>
        <Code
          lang="json"
          title="A realistic v1 ruleset"
          code={`{
  "version": 1,
  "rules": [
    {
      "match": "users/{userId}",
      "allow": {
        "get": { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } },
        "list": { "op": "==", "left": { "var": "auth.claims.role" }, "right": { "val": "admin" } },
        "create": {
          "op": "all",
          "conditions": [
            { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } },
            { "op": "isType", "left": { "var": "request.data.ownerId" }, "right": { "val": "string" } }
          ]
        },
        "update": {
          "op": "all",
          "conditions": [
            { "op": "==", "left": { "var": "resource.data.ownerId" }, "right": { "var": "auth.uid" } },
            { "op": "==", "left": { "var": "request.data.ownerId" }, "right": { "var": "resource.data.ownerId" } }
          ]
        },
        "delete": { "op": "==", "left": { "var": "auth.claims.role" }, "right": { "val": "admin" } }
      }
    },
    {
      "match": "users/{userId}/orders/{orderId}",
      "allow": {
        "get": { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } },
        "create": {
          "op": "all",
          "conditions": [
            { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } },
            { "op": ">", "left": { "var": "request.data.total" }, "right": { "val": 0 } }
          ]
        }
      }
    }
  ]
}`}
        />
        <H3 id="allow-operations">Allow operations</H3>
        <Table
          head={["Key", "Applies to", "Fallback behavior"]}
          rows={[
            [<code>get</code>, "Read one document", "Falls back to read"],
            [<code>list</code>, "Query / list documents", "Falls back to read"],
            [<code>create</code>, "Create a document", "Falls back to write"],
            [<code>update</code>, "Patch an existing document", "Falls back to write"],
            [<code>delete</code>, "Delete a document", "Falls back to write"],
            [<code>read</code>, "Shorthand for get + list", "—"],
            [<code>write</code>, "Shorthand for create + update + delete", "—"],
          ]}
        />
        <H3 id="wildcard-matching">Wildcard matching</H3>
        <P>
          Patterns are matched segment by segment against the document path. A single-segment wildcard{" "}
          <code>{"{paramName}"}</code> binds the matching segment to <code>path.paramName</code>. A recursive
          wildcard <code>{"{document=**}"}</code> at the end of a pattern matches one or more remaining segments
          and binds the relative sub-path to <code>path.document</code>. If several rules match a path, access is
          granted when <strong>any</strong> matching rule evaluates to true for the operation — standard OR
          semantics — and denied when no rule matches or none evaluates to true.
        </P>
      </Section>

      <Section id="operators-and-context" title="Operators & context">
        <H3 id="operators">Expression operators</H3>
        <Table
          head={["Category", "Operators", "Shape"]}
          rows={[
            ["Comparison", <code>{"==  !=  <  <=  >  >=  in"}</code>, "left and right operands"],
            ["Object / type", <code>{"hasKey  isType"}</code>, "left and right operands"],
            ["Combinator", <code>all</code>, "non-empty conditions array — every child must be true"],
            ["Combinator", <code>any</code>, "non-empty conditions array — at least one child must be true"],
            ["Combinator", <code>not</code>, "one condition — negates it"],
          ]}
        />
        <P>
          An operand is either a literal <code>{"{ \"val\": ... }"}</code> or a context lookup{" "}
          <code>{"{ \"var\": \"...\" }"}</code>. Comparisons use the same typed wire-value equality and ordering
          as the query engine, so a tagged value is compared by its underlying type rather than by string form.
        </P>
        <H3 id="variables">Available variables</H3>
        <Table
          head={["Variable", "Meaning"]}
          rows={[
            [<code>auth.uid</code>, "End-user id from the bearer JWT; null without a token."],
            [<code>auth.email</code>, "End-user email, when present in the token."],
            [<code>auth.email_verified</code>, "Boolean verification flag from the token."],
            [<code>auth.is_anonymous</code>, "True for anonymous end users."],
            [<code>{"auth.claims.<path>"}</code>, "Nested claim from the end-user JWT, e.g. auth.claims.role."],
            [<code>{"path.<param>"}</code>, "Value bound by a wildcard in the matching rule."],
            [<code>{"resource.data[.<path>]"}</code>, "Existing document data; null on create."],
            [<code>{"request.data[.<path>]"}</code>, "Incoming document data; null on reads and deletes."],
            [<code>request.time</code>, "Request timestamp in epoch milliseconds."],
          ]}
        />
        <P>
          <code>request.auth.*</code> is an alias of <code>auth.*</code> — both resolve to the same context. An
          unknown variable, operator, or expression shape evaluates to false, which means deny.
        </P>
      </Section>

      <Section id="evaluation-and-limits" title="Deterministic evaluation & bounds">
        <P>
          Authorization is a pure, in-memory walk of the AST. There is no <code>eval()</code>, no{" "}
          <code>new Function()</code>, no network call, and no recursive I/O, so a deeply nested ruleset cannot
          turn a request into a denial-of-service vector. Unless a matching rule explicitly allows an operation,
          <code> authorizeOperation</code> throws <code>PERMISSION_DENIED</code> (403).
        </P>
        <Table
          head={["Constraint", "Bound", "When exceeded"]}
          rows={[
            ["AST nesting depth", "<= 10 levels", "QUERY_TOO_COMPLEX at validation and evaluation"],
            ["Nodes per rule expression", "<= 100 nodes", "QUERY_TOO_COMPLEX at validation"],
            ["Circular references", "Forbidden", "INVALID_ARGUMENT at validation"],
            ["Unknown operator or operation", "Forbidden", "INVALID_ARGUMENT at publish; false at evaluation"],
            ["Dynamic code execution / I/O", "Never used", "Not applicable — evaluation is synchronous and in memory"],
          ]}
        />
        <Callout tone="warning" title="Validation happens at publish time">
          A malformed AST — wrong version, missing <code>match</code> or <code>allow</code>, unsupported operation
          or operator — is rejected with <code>INVALID_ARGUMENT</code> before it can become active. The active
          ruleset is always a previously validated version.
        </Callout>
      </Section>

      <Section id="publish-and-simulate" title="Publishing & simulation">
        <H3 id="publish">Publish</H3>
        <P>
          Publish a ruleset through the session-authenticated control-plane API. The request body is{" "}
          <code>{"{ \"rulesAst\": { \"version\": 1, \"rules\": [...] } }"}</code>. A successful publish returns 201
          with the new version, writes an audit entry, and invalidates the ruleset cache locally and across
          instances via <code>NOTIFY vellum_cache_invalidate</code>. The effect is immediate for the project.
        </P>
        <Table
          head={["Method", "Path", "Purpose"]}
          rows={[
            ["POST", <code>{RULES_PATH}</code>, "Validate and publish a new version."],
            ["GET", <code>{RULES_PATH}</code>, "Read the active ruleset (or version 0 with a null AST when none is published)."],
            ["POST", <code>{CONSOLE_RULES_PATH}</code>, "Console variant: validate, publish, and write a console.ruleset.published audit entry."],
            ["GET", <code>{CONSOLE_RULES_PATH}</code>, "Console variant: read the active ruleset."],
          ]}
        />
        <Api method="POST" path={RULES_PATH}>
          <P>
            Requires a console session bearer token. Invalid ASTs return <code>INVALID_ARGUMENT</code> or
            <code> QUERY_TOO_COMPLEX</code>; a valid publish returns the stored ruleset with its new
            <code> version</code>.
          </P>
        </Api>
        <CodeTabs
          tabs={[
            {
              label: "cURL",
              lang: "bash",
              code: `curl -X POST "https://api.vellum.dev${RULES_PATH}" \\
  -H "Authorization: Bearer <SESSION_TOKEN>" \\
  -H "content-type: application/json" \\
  -d '{ "rulesAst": { "version": 1, "rules": [] } }'`,
            },
            {
              label: "TypeScript (fetch)",
              lang: "ts",
              code: `const res = await fetch(
  "https://api.vellum.dev${RULES_PATH}",
  {
    method: "POST",
    headers: {
      authorization: \`Bearer \${sessionToken}\`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ rulesAst }),
  }
);
if (!res.ok) throw new Error(\`Publish failed: \${res.status}\`);
const published = await res.json();`,
            },
          ]}
        />
        <H3 id="simulate">Simulate before publishing</H3>
        <P>
          The dashboard's <strong>Rule Simulator</strong> dry-runs a candidate AST against a simulated request. It
          validates the AST and evaluates the same authorization path used reporting whether the
          operation would be allowed and which rule matched (or the error code if it would be denied). Nothing is
          published and no document-plane request is made.
        </P>
        <Code
          lang="json"
          title="Simulation context"
          code={`{
  "rulesAst": {
    "version": 1,
    "rules": [
      {
        "match": "users/{userId}",
        "allow": {
          "get": { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } }
        }
      }
    ]
  },
  "operation": "get",
  "path": "users/u_123",
  "authUid": "u_123",
  "authClaims": { "role": "member" },
  "resourceData": { "ownerId": "u_123" },
  "requestData": null
}`}
        />
        <P>
          For an end-to-end check, publish the candidate and issue a
          normal request with a public key and an end-user bearer; a denied request returns
          <code> PERMISSION_DENIED</code>. See{" "}
          <PageLink slug="reference/errors">Error codes & retry guidance</PageLink>.
        </P>
      </Section>

      <Section id="pitfalls-and-next" title="Least privilege & common pitfalls">
        <Table
          head={["Pitfall", "Fix"]}
          rows={[
            ["Trusting a client-supplied ownerId", "Bind ownership to a path wildcard and compare it with auth.uid."],
            ["Allowing updates without checking resource.data", "Check the stored owner as well as the incoming write so a patch cannot transfer ownership."],
            ["Forgetting deny-by-default", "Confirm version: 1 and publish the ruleset; no match means deny."],
            ["Overly deep or large expressions", "Stay within depth 10 and 100 nodes per expression."],
            ["Granting broad read access", "Use list only where necessary, scoped by a claim such as auth.claims.role."],
          ]}
        />
        <P>
          Keep rules narrow: grant only the operations a role actually needs, scope them to the narrowest path
          pattern, and prefer comparing against path wildcards and token claims over fields the client controls.
        </P>
        <P>
          Continue with <PageLink slug="end-user-auth">End users & the three realms</PageLink>,{" "}
          <PageLink slug="crud">CRUD & document paths</PageLink> for the paths rules match against, or{" "}
          <PageLink slug="errors-and-limits">Quotas & limits</PageLink>.
        </P>
      </Section>
    </Doc>
  );
}
