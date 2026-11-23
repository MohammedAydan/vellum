import {
  Api,
  Callout,
  Code,
  Doc,
  P,
  PageLink,
  Section,
  Table,
  UL,
} from "../../ui";

const exampleDsl = `rules_version = '2';

function isMember() {
  return isSignedIn() && hasAnyRole(['member', 'admin']);
}

match /users/{userId} {
  allow get: if isOwner(userId) || hasRole('admin');
  allow create: if isOwner(userId) && isEmailVerified()
                   && isType(incoming.displayName, 'string');
  allow update: if isOwner(userId) && unchanged(['ownerId', 'createdAt']);
  allow delete: if hasRole('admin');

  match /orders/{orderId} {
    allow read: if isOwner(userId);
  }
}`;

const exampleAst = `{
  "version": 1,
  "rules": [
    {
      "match": "/users/{userId}",
      "allow": {
        "get": {
          "op": "any",
          "conditions": [
            { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } },
            { "op": "==", "left": { "var": "auth.claims.role" }, "right": { "val": "admin" } }
          ]
        }
      }
    }
  ]
}`;

const endpoints = `BASE="https://api.example.com/v1/projects/$PROJECT_ID/rules"

# Compile DSL → v1 AST + diagnostics.
curl -s -X POST "$BASE/compile" \\
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \\
  -d '${JSON.stringify({ source: "rules_version = '2';\nmatch /users/{uid} {\n  allow get: if isOwner(uid);\n}" }).replaceAll("'", "'\\''")}'

# Decompile v1 AST → DSL.
curl -s -X POST "$BASE/decompile" \\
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \\
  -d '{ "rulesAst": { "version": 1, "rules": [] } }'

# Simulate with an explicit deny-by-default AST. Omit rulesAst only when an active ruleset exists.
curl -s -X POST "$BASE/simulate" \\
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \\
  -d '{ "operation": "get", "path": "users/u_123",
        "auth": { "uid": "u_123", "claims": { "role": "member" } },
        "resourceData": { "ownerId": "u_123" }, "incomingData": null,
        "rulesAst": { "version": 1, "rules": [] } }'`;

const diagnostic = `{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "Expected '}' but found 'end of input' (line 5, column 3)",
    "line": 5,
    "column": 3,
    "snippet": "  allow get: if auth.uid == userId;\n  ^"
  }
}`;

export default function Page() {
  return (
    <Doc
      title="Security Rules DSL"
      description="A readable rules language that compiles to the deterministic v1 AST, with macros, functions and a full compile/decompile/simulate toolchain."
      eyebrow="Security"
    >
      <Section id="overview" title="Overview">
        <P>
          The Rules DSL is a small, human-friendly language for authoring security rules. The compiler
          tokenizes and parses your source, expands macros and user functions, and emits a v1 JSON AST —
          the exact same structure described in{" "}
          <PageLink slug="security-rules">Security rules</PageLink>. There is no <code>eval()</code> and no{" "}
          <code>new Function()</code>: the runtime evaluator only ever walks the deterministic AST, in
          memory, with deny-by-default semantics.
        </P>
        <Callout tone="info" title="Authoring format, not a new security model">
          The DSL changes how rules are written, not how they are enforced. Publishing still stores a
          validated <code>version: 1</code> ruleset in the control plane.
        </Callout>
      </Section>

      <Section id="version" title="rules_version = '2' is sugar">
        <P>
          A ruleset typically starts with <code>rules_version = '2';</code>. That declaration is{" "}
          <strong>sugar only</strong>: <code>compileRulesDsl()</code> always emits{" "}
          <code>{"{ \"version\": 1, \"rules\": [...] }"}</code>, because the validator requires version 1.
          Declaring <code>'1'</code> is accepted; any other value produces a diagnostic but does not change
          the emitted version. The declaration may be omitted.
        </P>
        <Code lang="ts" title="DSL → AST" code={exampleDsl} />
        <P>The compiler turns that into the v1 AST used everywhere else:</P>
        <Code lang="json" title="Emitted v1 AST" code={exampleAst} />
      </Section>

      <Section id="syntax" title="Syntax">
        <P>
          A ruleset is a sequence of <code>function</code> and <code>match</code> declarations and must
          contain at least one match block. Both <code>//</code> and <code>/* … */</code> comments are
          supported, as are single/double-quoted strings, numbers, booleans, <code>null</code> and array
          literals. A single wildcard <code>{"{param}"}</code> binds one path segment; a trailing{" "}
          <code>{"{document=**}"}</code> matches one or more segments. Nested matches are flattened.
        </P>
        <Code lang="ts" title="Allow statement forms" code={`allow get: if <expression>;
allow list, get: if <expression>;     // multiple operations share one expression
allow read: if <expression>;          // expands to get + list
allow write: if <expression>;         // expands to create + update + delete`} />
        <Table
          head={["Construct", "DSL", "AST op"]}
          rows={[
            ["Logical AND", <code>a &amp;&amp; b</code>, <code>all</code>],
            ["Logical OR", <code>a || b</code>, <code>any</code>],
            ["Negation", <code>!a</code>, <code>not</code>],
            ["Comparison", <code>== != &lt; &lt;= &gt; &gt;=</code>, "same operator"],
            ["Membership", <code>a in ['x','y']</code>, <code>in</code>],
            ["Key / type", <code>hasKey(a,'f') · isType(a,'string')</code>, "hasKey · isType"],
          ]}
        />
        <Callout tone="warning" title="Complexity bounds">
          Expressions are limited to depth 10 and 100 nodes. Exceeding either is a syntax error — the
          compiler checks complexity after inlining functions.
        </Callout>
      </Section>

      <Section id="aliases" title="Aliases & context variables">
        <P>
          Short names map onto the exact variable paths the evaluator understands:
        </P>
        <Table
          head={["DSL alias", "AST variable", "Meaning"]}
          rows={[
            [<code>auth</code>, <code>auth</code>, "End-user identity (uid, email, email_verified, claims.*)"],
            [<code>resource</code>, <code>resource.data</code>, "Existing document data (null on create)"],
            [<code>incoming</code>, <code>request.data</code>, "Incoming data (null on reads/deletes)"],
            [<code>request.auth.*</code>, <code>auth.*</code>, "Alternate spelling of identity claims"],
            [<code>request.resource.data.*</code>, <code>request.data.*</code>, "Alternate spelling of incoming data"],
            [<code>path.&lt;param&gt;</code>, <code>path.&lt;param&gt;</code>, "Value bound by a wildcard"],
            [<code>request.time</code>, <code>request.time</code>, "Request time in epoch milliseconds"],
          ]}
        />
      </Section>

      <Section id="macros" title="Built-in macros">
        <Table
          head={["Macro", "Args", "Meaning"]}
          rows={[
            [<code>isSignedIn() / isAuth()</code>, "0", <code>auth.uid != null</code>],
            [<code>isOwner(id)</code>, "1", "signed in and uid equals id"],
            [<code>hasRole(role)</code>, "1", <code>auth.claims.role == role</code>],
            [<code>hasAnyRole(['a','b'])</code>, "1", <code>auth.claims.role in [...]</code>],
            [<code>isEmailVerified()</code>, "0", <code>auth.email_verified == true</code>],
            [<code>unchanged(['a','b'])</code>, "1", "each listed field is unchanged"],
            [<code>onlyChanged(['a','b'])</code>, "1", "each listed field differs — see limitation"],
            [<code>hasKey(obj,'f') / isType(v,'string')</code>, "2", "key / type test"],
          ]}
        />
        <Callout tone="danger" title="The onlyChanged limitation">
          The v1 AST has no dynamic key-set comparison, so <code>onlyChanged([...])</code>{" "}
          <strong>cannot fully enforce</strong> that no other keys changed. The compiler emits a check
          that each listed field differs and attaches a diagnostic advising you to enforce "all other keys
          unchanged" in application logic. An unknown function compiles to <code>false</code> — never a
          silent grant.
        </Callout>
      </Section>

      <Section id="functions" title="User functions & inlining">
        <P>
          Declare functions as <code>function name(p) {"{ return <expr>; }"}</code>. Calls are{" "}
          <strong>inlined</strong> at the call site — parameters are substituted and the resulting AST is
          emitted with no function-call nodes at runtime. User definitions shadow built-ins, forward
          references work, recursion is rejected and inlining is capped at depth 16.
        </P>
        <Code lang="ts" title="Inlined function" code={`function canReadPost() {
  return isSignedIn() && (hasRole('admin') || isOwner(path.userId));
}
match /posts/{postId} {
  allow get: if canReadPost();
}`} />
      </Section>

      <Section id="diagnostics" title="Diagnostics — exact line & column">
        <P>
          Positions are 1-based. <code>RulesDslSyntaxError</code> is thrown for lexer, parser, grammar and
          complexity failures and exposes <code>line</code>, <code>column</code> and a caret{" "}
          <code>snippet</code>. A separate diagnostics array (returned with the AST) covers semantic
          concerns that do not block compilation: unknown functions/variables, the{" "}
          <code>onlyChanged</code> limitation, non-literal array elements and unsupported versions.
        </P>
        <Code lang="json" title="Compile error (HTTP 400)" code={diagnostic} />
        <Callout tone="info" title="Successful compile">
          A successful compile returns <code>{"{ \"ast\": {...}, \"diagnostics\": [...] }"}</code>. The
          diagnostics may be non-empty even though compilation succeeded.
        </Callout>
      </Section>

      <Section id="endpoints" title="Compile / decompile / simulate API">
        <P>
          All three endpoints live under <code>/v1/projects/:projectId/rules/*</code> and accept
          an API key or a realm-verified Customer Console session. They are pure tooling — none publishes
          a ruleset or touches document data.
        </P>
        <Table
          head={["Method", "Path", "Purpose"]}
          rows={[
            [<code>POST</code>, <code>…/rules/compile</code>, "DSL source → v1 AST + diagnostics"],
            [<code>POST</code>, <code>…/rules/decompile</code>, "v1 AST → DSL text"],
            [<code>POST</code>, <code>…/rules/simulate</code>, "Dry-run an operation with an evaluation trace"],
          ]}
        />
        <Api method="POST" path="/v1/projects/:projectId/rules/simulate">
          <P>
            Body: <code>operation</code>, <code>path</code>, optional <code>rulesAst</code>,{" "}
            <code>auth</code>, <code>resourceData</code> and <code>incomingData</code>. Returns{" "}
            <code>allowed</code>, <code>matchedRule</code> and <code>evaluationTrace</code>. With no{" "}
            <code>rulesAst</code> the active ruleset is used.
          </P>
        </Api>
        <Code lang="bash" title="cURL" code={endpoints} />
        <P>
          Publishing is separate: send the compiled <code>rulesAst</code> to the rulesets endpoint as{" "}
          <code>{"{ \"rulesAst\": { \"version\": 1, \"rules\": [...] } }"}</code>. Only a validated v1 AST
          can become active.
        </P>
      </Section>

      <Section id="studio" title="Dashboard Rules Studio">
        <P>
          The customer dashboard offers two synchronized editing modes: <strong>DSL mode</strong> (the
          default, with quick-insert templates and live compile-on-edit) and <strong>JSON mode</strong>{" "}
          (direct v1 AST editing for advanced users). Syntax errors show message, line, column and snippet
          in the editor; non-fatal diagnostics are listed separately. The <strong>Rule Simulator</strong>{" "}
          panel dry-runs an operation against the draft or active ruleset, showing the decision, matched
          rule and full evaluation trace. Nothing is published until you explicitly publish.
        </P>
      </Section>

      <Section id="pitfalls" title="Common pitfalls">
        <UL
          items={[
            <>Assuming <code>'2'</code> produces a v2 AST — it is sugar; the output is always version 1.</>,
            <>Relying on <code>onlyChanged</code> to lock an entire write — enforce the rest in application logic.</>,
            <>Trusting a client-supplied owner field — compare <code>auth.uid</code> with a path wildcard.</>,
            <>Allowing updates without checking stored data — add <code>unchanged(['ownerId'])</code>.</>,
            <>Forgetting deny-by-default — no matching rule means deny.</>,
          ]}
        />
        <P>
          Continue with <PageLink slug="security-rules">Security rules</PageLink> for the runtime
          evaluator and variable semantics.
        </P>
      </Section>
    </Doc>
  );
}
