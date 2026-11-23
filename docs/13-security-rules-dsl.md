# 13 — Security Rules DSL (V2)

> **Status:** current as of the V2 engine (Phases 1–4). The DSL compiles to the same
> deterministic v1 JSON AST described in [04 — Authentication & Security Rules AST](./04-security-rules-ast.md).
> It never generates or executes JavaScript: there is no `eval()` and no `new Function()`.

The Rules DSL is a small, human-friendly language for writing security rules. The
compiler tokenizes and parses the source, expands macros and user functions, and emits a
`SecurityRulesetAst` with `version: 1`. The runtime evaluator only ever sees that AST —
the same deny-by-default, synchronous, in-memory evaluator that has always enforced the
document plane. This gives you a readable authoring format without changing the security
model.

---

## 1. `rules_version = '2'` is sugar

A ruleset normally begins with a version declaration:

```text
rules_version = '2';

match /users/{userId} {
  allow get: if auth.uid == userId;
}
```

**The declaration is sugar only.** `compileRulesDsl()` always emits
`{ "version": 1, "rules": [...] }`, because `validateSecurityRulesetAst` requires
`version === 1`. The `'2'` string simply signals the V2 authoring format. Declaring
`'1'` is accepted; any other value produces a diagnostic ("not supported; expected
'2'. Compiling as version 1 AST.") but does not change the emitted version. The
declaration may be omitted entirely.

The emitted AST is exactly what you can publish through the rulesets endpoint or edit
in the dashboard's JSON mode:

```json
{
  "version": 1,
  "rules": [
    {
      "match": "/users/{userId}",
      "allow": {
        "get": { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } }
      }
    }
  ]
}
```

---

## 2. Syntax

### 2.1 Top level

A ruleset is a sequence of declarations. It must contain at least one `match` block or
compilation fails with *"Ruleset must contain at least one 'match' block"*.

```text
rules_version = '2';      // optional version declaration

function isAdmin() {      // zero or more user functions
  return hasRole('admin');
}

match /users/{userId} {   // one or more match blocks
  allow get: if ...;
  allow list, create: if ...;
  match /orders/{orderId} {   // nested matches are flattened
    allow read: if ...;
  }
}
```

Both `//` line comments and `/* … */` block comments are supported (an unterminated
block comment is a syntax error). String literals accept single or double quotes with
`\n`, `\t`, `\r`, `\\`, `\'`, `\"` and `\uXXXX` escapes. Numbers may be integer or
decimal and may carry a leading sign. Booleans are `true` / `false`; `null` is `null`.

### 2.2 Match paths

`match /users/{userId}` declares a path pattern. A single-segment wildcard
`{paramName}` binds the matching segment to `path.<paramName>`. A recursive wildcard
`{document=**}` at the end matches one or more remaining segments. Nested `match`
blocks are flattened into full paths (e.g. `/users/{userId}/orders/{orderId}`). Leading
and trailing slashes are normalized.

If several rules match a path, access is granted when **any** matching rule allows the
operation — standard OR semantics — and denied by default when none does.

### 2.3 Allow statements

```text
allow get: if <expression>;
allow list, get: if <expression>;        // multiple operations share one expression
allow read: if <expression>;             // expands to get + list
allow write: if <expression>;            // expands to create + update + delete
```

Supported operations are `get`, `list`, `create`, `update`, `delete`, `read`, `write`.
Anything else is rejected as *"Unsupported rule operation"*. The trailing semicolon is
optional.

### 2.4 Expressions

| Construct | DSL | Emitted AST op |
| :-------- | :-- | :------------- |
| Logical AND | `a && b` | `all` with a conditions array |
| Logical OR | `a \|\| b` | `any` with a conditions array |
| Negation | `!a` | `not` with one condition |
| Comparison | `a == b`, `!=`, `<`, `<=`, `>`, `>=` | same operator |
| Membership | `a in ['x', 'y']` | `in` |
| Key / type test | `hasKey(a, 'field')`, `isType(a, 'string')` | `hasKey`, `isType` |
| Grouping | `(a && b) \|\| c` | nested combinators |
| Literals | `true`, `false`, `null`, `123`, `'text'`, `[...]` | literal operands |

Comparisons use the same typed wire-value equality/ordering as the query engine. Array
literals must contain only literals; a non-literal element is replaced with `null` and
reported as a diagnostic. The AST stays within the locked complexity bounds: **depth
<= 10** and **<= 100 nodes per expression** (`SYSTEM_LIMITS`). Exceeding either is a
syntax error.

---

## 3. Aliases and context variables

The DSL's short names map onto the exact variable paths understood by the evaluator:

| DSL alias | Canonical AST variable | Meaning |
| :-------- | :--------------------- | :------ |
| `auth` | `auth` | End-user identity (`auth.uid`, `auth.email`, `auth.email_verified`, `auth.claims.*`) |
| `resource` | `resource.data` | Existing document data (`null` on create) |
| `incoming` | `request.data` | Incoming document data (`null` on reads/deletes) |
| `request.auth.*` | `auth.*` | Alternate spelling of the identity claims |
| `request.resource.data.*` | `request.data.*` | Alternate spelling of incoming data |
| `path.<param>` | `path.<param>` | Value bound by a wildcard in the matching rule |
| `request.time` | `request.time` | Request time (epoch milliseconds) |

`resource.ownerId` and `resource.data.ownerId` are equivalent, as are `incoming.total`
and `request.resource.data.total`. Unknown variable roots produce a diagnostic
(*"Unknown variable …; compiled as a variable path and may resolve to undefined"*) and
evaluate to `undefined` — which never grants access.

---

## 4. Built-in macros

Macros expand deterministically into v1 AST nodes. Arity is checked: a wrong argument
count is a syntax error.

| Macro | Args | Expansion / meaning |
| :---- | :--- | :------------------ |
| `isSignedIn()` / `isAuth()` | 0 | `auth.uid != null` |
| `isOwner(ownerId)` | 1 | `auth.uid != null && auth.uid == ownerId` |
| `hasRole(role)` | 1 | `auth.claims.role == role` |
| `hasAnyRole(['a','b'])` | 1 (string array) | `auth.claims.role in ['a','b']` |
| `isEmailVerified()` | 0 | `auth.email_verified == true` |
| `unchanged(['a','b'])` | 1 (string array) | every listed field has `request.data.f == resource.data.f` |
| `onlyChanged(['a','b'])` | 1 (string array) | every listed field has `!(request.data.f == resource.data.f)` — see the limitation below |
| `hasKey(obj, 'field')` | 2 | `hasKey` AST node |
| `isType(value, 'string')` | 2 | `isType` AST node |

```text
rules_version = '2';

function isMember() {
  return isSignedIn() && hasAnyRole(['member', 'admin']);
}

match /users/{userId} {
  allow get: if isOwner(userId) || hasRole('admin');
  allow create: if isOwner(userId) && isEmailVerified()
                   && isType(incoming.displayName, 'string');
  allow update: if isOwner(userId) && unchanged(['ownerId', 'createdAt']);
  allow delete: if hasRole('admin');
}
```

### 4.1 The `onlyChanged` limitation

> **Important:** the v1 rules AST has no dynamic key-set comparison, so
> `onlyChanged([...])` **cannot fully enforce** that no other keys changed. The compiler
> emits a deterministic check that each listed field *differs* from its stored value and
> attaches this diagnostic:
>
> *"onlyChanged(...) cannot fully enforce that no other keys changed: the v1 rules AST
> has no dynamic key-set comparison. Compiled a deterministic check that each listed
> field differs; enforce 'all other keys unchanged' in application logic."*
>
> If the entire write must be restricted to a known key set, enforce that in application
> logic (or use `unchanged([...])` on the fields that must stay fixed).

An unknown function name is compiled as the safe literal `false` and reported as a
diagnostic — it never silently grants access.

---

## 5. User-defined functions and inlining

```text
function canReadPost(postId) {
  return isSignedIn() && (hasRole('admin') || isOwner(path.userId));
}

match /posts/{postId} {
  allow get: if canReadPost(postId);
}
```

Functions are declared as `function name(p1, p2) { return <expression>; }`. Call sites
are **inlined** into the calling expression: parameters are substituted with the
supplied arguments, and the resulting AST is emitted inline. There are no function-call
AST nodes at runtime.

- User definitions **shadow** built-in macros of the same name.
- Forward references between functions are supported.
- Recursion is rejected (*"Recursive function call … cannot be inlined"*), and inlining
  is capped at depth 16 (*"Function inlining exceeded maximum depth of 16"*).
- A wrong argument count is an error (*"Function 'x' expects N argument(s) but got M"*).

Because inlining happens before the complexity guard, a function that expands to a huge
tree still trips the depth-10 / 100-node limits.

---

## 6. Diagnostics — exact line and column

Compiler diagnostics are 1-based. There are two channels:

- **`RulesDslSyntaxError`** — thrown for lexer, parser, grammar and complexity failures.
  It exposes `line`, `column` and `snippet` (the offending source line plus a `^` caret),
  and its message reads `"<message> (line L, column C)"`. Examples:
  *"Unterminated string literal"*, *"Expected '}' but found 'end of input'"*,
  *"Security rule expression exceeds maximum depth of 10"*.
- **Diagnostics array** — returned alongside the AST from `compileRulesDsl()` for
  semantic concerns that do not prevent compilation: unknown functions/variables,
  `onlyChanged` limitation, non-literal array elements, and unsupported version strings.
  Each has `{ message, line, column, snippet? }`.

The REST `POST /rules/compile` endpoint maps a syntax error to HTTP 400 with the exact
position:

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "Expected '}' but found 'end of input' (line 5, column 3)",
    "line": 5,
    "column": 3,
    "snippet": "  allow get: if auth.uid == userId;\n  ^"
  }
}
```

A successful compile returns `{ "ast": {...}, "diagnostics": [...] }`.

---

## 7. Compile / decompile / simulate endpoints

All three endpoints live under `/v1/projects/:projectId/rules/*` and accept
either an API key or a realm-verified Customer Console session (the dashboard uses the
latter). They are pure tooling — none of them publish a ruleset or touch document data.

| Method | Path | Request | Response |
| :----- | :--- | :------ | :------- |
| `POST` | `…/rules/compile` | `{ "source": "<DSL>" }` (aliases `dsl`, `rulesDsl`, `rules` accepted) | `{ "ast": <v1 AST>, "diagnostics": [...] }` |
| `POST` | `…/rules/decompile` | `{ "rulesAst": <v1 AST> }` or a bare AST | `{ "dsl": "<rules_version = '2'; …>" }` |
| `POST` | `…/rules/simulate` | `{ "rulesAst"?, "operation", "path", "auth"?, "resourceData"?, "incomingData"? }` | `{ "allowed", "matchedRule", "evaluationTrace" }` |

`decompile` renders a v1 AST back into idiomatic DSL (`&&`/`||`/`!`, aliases
`resource`/`incoming`, and a leading `rules_version = '2';`). `simulate` uses the active
ruleset when `rulesAst` is omitted, then walks every matching rule with the same
evaluator used in production, returning a human-readable `evaluationTrace`.

```bash
BASE="https://api.example.com/v1/projects/$PROJECT_ID/rules"

# Compile DSL → v1 AST + diagnostics.
curl -s -X POST "$BASE/compile" \
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{ "source": "rules_version = '\''2'\'';\nmatch /users/{uid} {\n  allow get: if isOwner(uid);\n}" }'

# Decompile AST → DSL.
curl -s -X POST "$BASE/decompile" \
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{ "rulesAst": { "version": 1, "rules": [] } }'

# Simulate an operation.
curl -s -X POST "$BASE/simulate" \
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{
    "operation": "get",
    "path": "users/u_123",
    "auth": { "uid": "u_123", "claims": { "role": "member" } },
    "resourceData": { "ownerId": "u_123" },
    "incomingData": null
  }'
# → { "allowed": true, "matchedRule": "/users/{uid}",
#     "evaluationTrace": [ "simulate: operation 'get' on path 'users/u_123'", ... ] }
```

Publishing still goes through the rulesets endpoint described in
[04 — Security Rules AST](./04-security-rules-ast.md): send the compiled `rulesAst` as
`{ "rulesAst": { "version": 1, "rules": [...] } }`. Only a validated v1 AST can become
active.

---

## 8. Dashboard: dual-mode studio + simulator

The customer dashboard's **Rules Studio** offers two synchronized editing modes:

- **DSL mode** — the default, with quick-insert templates of valid V2 DSL and live
  compile-on-edit. Syntax errors show the message, line, column and snippet in the
  editor gutter and a toast; non-fatal diagnostics are listed alongside the editor.
- **JSON mode** — direct editing of the v1 AST, for advanced users and for round-tripping
  an existing published ruleset (it is decompiled to DSL when switching back).

The **Rule Simulator** panel runs `POST …/rules/simulate` against either the draft AST or
the active ruleset with mock auth/resource/incoming payloads, showing `allowed`, the
matched rule and the full evaluation trace. Nothing is published until you explicitly
publish the ruleset, and the simulated request never reaches the document plane.

---

## 9. Checklist and common pitfalls

| Pitfall | Fix |
| :------ | :--- |
| Assuming `'2'` produces a v2 AST | It is sugar; the emitted AST is always `version: 1`. |
| Relying on `onlyChanged` to lock the whole write | It only checks listed fields differ; enforce the rest in application logic. |
| Trusting a client-supplied owner field | Compare `auth.uid` with a path wildcard (`isOwner(userId)`), not a writable field. |
| Allowing updates without checking stored data | Add `unchanged(['ownerId'])` so a patch cannot transfer ownership. |
| Calling an unknown function | It compiles to `false` with a diagnostic — grant nothing by accident. |
| Exceeding 10 levels / 100 nodes | Split rules or simplify expressions; the compiler rejects them. |
| Forgetting deny-by-default | No matching rule or no expression for the operation means deny. |

Continue with the [Security Rules AST reference](./04-security-rules-ast.md) for the
runtime evaluator and variable semantics, and [12 — Relationships & Advanced Queries](./12-relationships-and-advanced-queries.md)
for the paths and writes that rules authorize.
