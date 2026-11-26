
# Rules DSL

The DSL is a rules authoring language, not JavaScript, Dart or the Firebase rules language. It compiles into version 1 JSON expressions. Read [Security rules](./guides/security-rules.md) first for operation contexts, list access and realtime differences.

## Syntax and first complete policy

```text
rules_version = '2';

function ownsNamespace() {
  return isOwner(path.userId);
}

match /users/{userId}/notes/{noteId} {
  allow get, list: if ownsNamespace();
  allow create, update: if ownsNamespace()
    && isType(incoming.title, 'string');
  allow delete: if ownsNamespace();
}
```

The optional version declaration accepts '1' and '2'; both emit JSON version 1. Other versions produce a diagnostic, not a new evaluator. Match paths can begin with /. JSON examples use canonical relative paths. Prefer explicit path.userId; the corrected compiler also resolves a bare name that matches a wildcard.

A file contains top-level function and match declarations and must produce at least one rule. Nested match blocks join their path to their parent and produce separate rules; parent permissions are not inherited. Use a recursive wildcard only as the final segment. Comments support // and /* ... */. Statements use semicolons; always include them even where the parser accepts omission.

allow get, list shares an expression. read expands to get and list; write expands to create, update and delete. Repeating an operation in one match block replaces its earlier expression, not OR. Separate matching rules use OR: a permissive rule elsewhere can defeat a restrictive one.

## Operators, values and precedence

| Form | Meaning |
| --- | --- |
| a == b, a != b | Typed equality or inequality; missing operands do not pass either comparison. |
| a < b, a <= b, a > b, a >= b | Wire ordering. Guard the type before checking numeric bounds. |
| a in ['one', 'two'] | Array membership using typed equality. |
| hasKey(value, 'field') | Direct own-key check, not a dotted-path lookup or allowlist. |
| isType(value, 'string') | Type predicate; see the complete type table in Security rules. |
| a && b | Both expressions pass. |
| a OR b (double vertical bar) | At least one passes. |
| !a | Negation. Use parentheses around compound expressions. |

Comparisons bind more tightly than !, then &&, then || in this parser. Use parentheses instead of relying on unfamiliar precedence. Values include single/double-quoted strings, signed numbers, booleans, null and literal arrays. Dynamic array entries are not supported. Do not use JavaScript object literals, bracket property access, methods, arithmetic, loops, assignment, ternaries, regex, string concatenation or database calls.

A bare field in a boolean position is compared with true; there is no JavaScript truthiness. Prefer explicit predicates. Functions are boolean-expression helpers, not value-returning arithmetic helpers. Use a function as a complete predicate, not as an operand in another comparison or inside an array.

## Every built-in

| Built-in | Arguments | Exact behavior |
| --- | --- | --- |
| isSignedIn() | None | auth.uid != null. Anonymous users with a uid count as signed in. |
| isAuth() | None | Alias of isSignedIn(). |
| isOwner(id) | One value | Signed in AND uid equals id. |
| hasRole(role) | One value | auth.claims.role equals role. It does not inspect claims.roles. |
| hasAnyRole(['writer', 'reviewer']) | One literal string array | Singular auth.claims.role is in that array. |
| isEmailVerified() | None | auth.email_verified equals true. Does not itself require a uid. |
| unchanged(['ownerId', 'createdAt']) | One literal string array | Each listed field in the full new data equals stored data. Dotted field paths work. Empty array returns true. A field missing on both the stored and the new data, or null on both, counts as unchanged. A field present on only one side counts as changed. |
| onlyChanged(['title']) | One literal string array | Negated equality for each listed field, with a diagnostic. Does NOT forbid other changes. Empty array returns true. Do not use as a write allowlist. |
| hasKey(value, 'field') | Two values | Own direct key on a non-array object; reserved prototype-related keys are blocked. |
| isType(value, 'type') | Two values | null, bool/boolean, string, number, array, map, or matching wire tag such as ref, int, ts, bytes, geo. |

There are no other built-ins. Incorrect argument counts fail compilation. unchanged, onlyChanged and hasAnyRole require string arrays, not a runtime variable containing an array. Never let a client assign its own trusted role claim. Never replace missing identity checks with auth != null: the unauthenticated auth context is an object with uid:null.

## Context aliases

| DSL | Canonical JSON variable |
| --- | --- |
| auth.uid, request.auth.uid | auth.uid |
| auth.email, auth.email_verified, auth.is_anonymous | Same path |
| auth.claims.team, request.auth.claims.team | auth.claims.team |
| path.userId | path.userId |
| resource, resource.title, resource.data.title | resource.data, resource.data.title, resource.data.title |
| incoming, incoming.title | request.data, request.data.title |
| request.resource.data.title | request.data.title |
| request.data.title, request.time | Same path |

incoming is the full post-write document after merges and transforms. It is null on read/delete. resource is null on create and at collection-level list gates. Missing fields are undefined, distinct from explicit null.

## Public reads, trusted roles and field validation

This policy intentionally makes every post publicly readable. Only signed-in users can create their own post, the original author can edit without transferring ownership, and a verified reviewer role may delete.

```text
match /posts/{postId} {
  allow read: if true;
  allow create: if isSignedIn()
    && incoming.authorId == auth.uid
    && isType(incoming.title, 'string')
    && isType(incoming.score, 'number')
    && incoming.score >= 0 && incoming.score <= 100;
  allow update: if isOwner(resource.authorId)
    && unchanged(['authorId'])
    && isType(incoming.title, 'string')
    && isType(incoming.score, 'number')
    && incoming.score >= 0 && incoming.score <= 100;
  allow delete: if hasRole('reviewer');
}
```

These predicates constrain named fields but do not reject additional fields. isType(title,'string') allows an empty string; no length predicate is available. To make posts private, do not merely change get while leaving list:true. Use the private namespace pattern instead, or deny list on a mixed-owner collection.

## Relations and immutable fields

```text
match /users/{userId}/notes/{noteId} {
  allow get, list: if isOwner(path.userId);
  allow create: if isOwner(path.userId)
    && isType(incoming.author, 'ref')
    && incoming.author.$v == auth.claims.profilePath;
  allow update: if isOwner(path.userId)
    && unchanged(['author']);
}
```

This assumes the verified token contains a trusted profilePath claim, such as profiles/alice. The type check confirms a tagged reference and $v compares its target path. It does not check target existence, read the target, grant target access or create an inverse relation. The application must not let an end user self-assign profilePath. Included targets still require their own get permission.

unchanged checks the full post-write value, so a patch that omits author can pass while replacing the document without author fails. Use explicit required-field/type checks on create; unchanged alone is not a create validator.

## Reusable functions

```text
function mayRead(userId) {
  return isOwner(userId) || hasAnyRole(['reviewer', 'support']);
}
match /users/{userId}/tickets/{ticketId} {
  allow get, list: if mayRead(path.userId);
}
```

Functions contain exactly one return expression. Parameters substitute complete values/expressions; forward references work. Definitions are top-level and names must be unique. User functions shadow built-ins, so do not name your helper isOwner or isSignedIn. Calls are inlined; recursion is rejected, inlining depth is capped at 16 and the final expression still must fit depth 10 and 100 nodes. Helpers do not add new runtime capabilities.

## Compile, decompile and simulate

| Method and path | Request | Response |
| --- | --- | --- |
| POST /v1/projects/:projectId/rules/compile | source: DSL text | ast and diagnostics |
| POST /v1/projects/:projectId/rules/decompile | rulesAst: version 1 AST | dsl text |
| POST /v1/projects/:projectId/rules/simulate | operation, path, optional rulesAst, auth, resourceData, incomingData | allowed, matchedRule, evaluationTrace |

Use the project's API key in X-Project-Key. These tools do not write documents or activate rules. Supplying auth in a simulation only chooses test input; it cannot authenticate a real data request. Omitting rulesAst in simulation uses the active ruleset, if any. Decompilation preserves supported expression behavior, not original comments, helper names or formatting.

```json
{
  "operation": "get",
  "path": "users/alice/notes/one",
  "auth": { "uid": "alice", "claims": {} },
  "resourceData": { "title": "Private note" },
  "incomingData": null,
  "rulesAst": {
    "version": 1,
    "rules": [{
      "match": "users/{userId}/notes/{noteId}",
      "allow": { "get": {
        "op": "all",
        "conditions": [
          { "op": "!=", "left": { "var": "auth.uid" }, "right": { "val": null } },
          { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } }
        ]
      } }
    }]
  }
}
```

Repeat with uid:bob and uid:null and expect denial. Then issue real document requests with public-key/end-user credentials against the active ruleset. The simulation does not prove collection gates, query filtering, key scopes, tenant authentication or realtime behavior.

## Diagnostics and pitfalls

Syntax errors include one-based line/column and a caret snippet. Non-fatal diagnostics can accompany a successful AST: unknown functions, unknown variable roots, unsupported version declarations, non-literal arrays and onlyChanged. Require zero diagnostics for production policies, then still run negative tests. A typo under a known root may not produce a diagnostic at all.

An unknown function becomes false, but !unknownFunction() can therefore become true. Undefined-field comparisons also behave differently under negation. Do not treat an unknown identifier or a warning as a safe deny for an entire policy. Prefer positive existence, type and identity checks.

Source length is capped at 131072 JavaScript string code units; the error calls this bytes, but the implementation measures string length. The token cap is 16384; parser nesting is capped at 64. Keep policies short enough that runtime membership checks also stay within the 256-step budget. There is no general field allowlist: onlyChanged is not one, hasKey is not one, and validation in an untrusted client is not one.

The complete examples in these two guides are extracted by tests/integration/rules-guide-examples.test.ts and evaluated with real authorization and the local document engine. Run corepack pnpm exec vitest run tests/integration/rules-guide-examples.test.ts when changing them.
