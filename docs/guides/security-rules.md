---
title: Security rules
order: 11
group: Security
description: Write and test least-privilege document rules, with precise query and realtime behavior.
---

# Security rules

Rules authorize project document operations made with a public API key. A public key identifies the project; it does not prove who the end user is. A verified end-user token supplies identity. No active ruleset, no matching rule, or no successful expression means PERMISSION_DENIED. Server keys use their explicit scopes instead of end-user rules. Never put a server key in a client application.

## Start with a private user namespace

Put private records under users/{userId}/notes/{noteId}. Check the user wildcard, not a client-provided owner field. This also gives collection queries an owner boundary they can check without reading document data.

```json
{
  "version": 1,
  "rules": [
    {
      "match": "users/{userId}/notes/{noteId}",
      "allow": {
        "get": { "op": "all", "conditions": [
          { "op": "!=", "left": { "var": "auth.uid" }, "right": { "val": null } },
          { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } }
        ] },
        "list": { "op": "all", "conditions": [
          { "op": "!=", "left": { "var": "auth.uid" }, "right": { "val": null } },
          { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } }
        ] },
        "create": { "op": "all", "conditions": [
          { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } },
          { "op": "isType", "left": { "var": "request.data.title" }, "right": { "val": "string" } }
        ] },
        "update": { "op": "all", "conditions": [
          { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } },
          { "op": "isType", "left": { "var": "request.data.title" }, "right": { "val": "string" } }
        ] },
        "delete": { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } }
      }
    }
  ]
}
```

The equivalent readable language and more patterns are in [Rules DSL](./security-rules-dsl.md). Wildcards are strings. For writes above, an unauthenticated null uid cannot equal the userId path segment.

## Matching and operation selection

A ruleset is version 1 with a rules array. Each rule contains match and allow. Use canonical relative paths in JSON, such as users/{userId}, without project prefixes. A single wildcard binds one segment to path.userId. Put a recursive wildcard such as {rest=**} last; it captures one or more remaining segments. A rule on a parent document does not automatically apply to its subcollections. Nested DSL matches are separate rules after compilation, not inherited permissions.

| Operation | Context |
| --- | --- |
| get | A single document read. Existing data is available if the document exists. |
| list | Collection query, aggregate, subscription or batch-read gate. See the operation differences below. |
| create | Creation, including set when the document does not exist. |
| update | Patch, merge, or replacement of an existing document. |
| delete | Deletion of an existing document. |
| read | JSON fallback for get and list. |
| write | JSON fallback for create, update and delete. |

In JSON an explicit operation takes precedence over its fallback, even when false: get:false plus read:true denies get in that rule. Across separate matching rules, any successful grant allows access. There is no overriding deny rule. In DSL, read and write expand into individual operations; repeated declarations of the same operation in one match block replace the earlier expression. Combine conditions in one declaration instead.

## Context reference

| JSON variable | Meaning |
| --- | --- |
| auth.uid | Verified end-user id, or null without identity. Use uid != null, not auth != null, to require sign-in. |
| auth.email | Email from the verified identity, or null when absent. |
| auth.email_verified | Verified-email flag, or null when absent. |
| auth.is_anonymous | Anonymous-account flag, or null when absent. Anonymous accounts can still have a uid. |
| auth.claims.<field> | Nested verified claim. hasRole uses the singular claims.role, not a roles array. |
| request.auth.* | Alias of auth.* in both JSON and DSL. |
| path.<wildcard> | String captured by match. Use explicit path.userId for clarity; the corrected DSL compiler also binds bare wildcard names. |
| resource.data | Stored document, null on create or when no resource was loaded. |
| request.data | Full validated document after merge and field transforms, not the raw patch. Null on read/delete. |
| request.time | Evaluation time in epoch milliseconds, not a timestamp object. |

DSL resource.title maps to resource.data.title; incoming.title and request.resource.data.title map to request.data.title. Those are compiler aliases, not extra JSON variable roots. auth.token is not an exposed rules variable. Neither query filters nor query limits are exposed as request.query.

Missing data fields resolve to undefined, not null. Equality and inequality with undefined return false. Negating such a comparison can therefore return true: ! (incoming.missing == resource.missing) is not a safe existence check. Use hasKey and isType for required fields. Missing wildcard bindings resolve to null, so use isSignedIn/isOwner when comparing optional values.

## Complete JSON expression reference

An expression is true, false, or an operator node. Operands are {val: literal} or {var: contextPath}. Logical operators contain expressions; comparison operators contain operands. They do not execute nested arithmetic or function calls at runtime.

| Operator | Shape and behavior |
| --- | --- |
| ==, != | left/right; typed wire equality, with no JavaScript coercion. Both operands must resolve. |
| <, <=, >, >= | left/right; query-engine wire ordering. Undefined and null do not pass. Guard numeric validation with isType before range comparisons. |
| in | left must equal an element of right, which must be an array. Not a substring or object-key test. |
| hasKey | left is a non-array object; right is one direct own-key string. For a nested field, pass its parent object. |
| isType | left is the value; right is a type string from the table below. |
| all | Non-empty conditions array; every child must pass. |
| any | Non-empty conditions array; at least one child must pass. |
| not | One condition expression, negated. |

| isType name | Accepted value |
| --- | --- |
| null | Literal null, not a missing field. |
| bool, boolean | JavaScript boolean. |
| string | String. |
| number | Untagged JSON number. Tagged integers are not number. |
| array | Array. |
| map | Non-null, non-array object without an own $t key. |
| int, ts, ref, bytes, geo | Matching tagged wire value. Check ref before reading a reference's $v. |

Do not rely on cross-type ordering to validate a numeric range. hasKey is not a key allowlist and there is no general size, regex, diff, length, cross-document get, exists, or database lookup function in this language.

## Queries are not per-document get checks

An ordinary query checks list once against a synthetic document path under its collection, with resource.data and request.data both null. It does not re-run get for each result and does not inject owner filters. Aggregates also use the collection-level list gate. Granting list on a mixed-owner collection can expose rows whose individual get would fail. Adding a where(ownerId == uid) in an untrusted client is not an access-control boundary because the client can omit it.

Use private user subcollections and compare path.userId for both get and list, as in the example. A rule requiring resource.data.ownerId for list denies the collection-level check, even if the query includes an owner filter. Do not compare the final document wildcard to uid for list; that segment is a synthetic marker, not a real record id.

Batch get first checks list for each collection, then get with each loaded document's data; denied documents are omitted. Bulk delete checks list for the collection and delete for each selected document. Reverse-reference reads check get on the target and both get and list on referring rows. Do not assume one API operation's checks apply identically to every read API.

## Realtime and relations

Query subscriptions require list on a synthetic path at subscription time. Individual realtime rows/events require get with their document data, including the corrected initial-snapshot behavior. Direct document subscriptions also perform a get gate before loading data, so a resource-only get condition can fail subscription setup. Path-based ownership works at both stages. Test initial snapshots, later changes and replay separately. Realtime's per-row get check does not make ordinary HTTP queries equally restrictive.

A reference is data, not a permission grant or a cross-document rules lookup. Included targets are separately checked with get and the target's stored data. Denied references are redacted rather than granting access through the source. Rules cannot verify that a referenced target exists or inspect its owner. Use a fixed trusted path convention and test unauthorized includes. Relationship integrity rules and security rules are distinct features.

The storage package is a document persistence adapter, not a separate client file-bucket rules language. Do not use Firebase-style storage match paths or assume these rules protect an unrelated upload service.

## Limits, errors and safe testing

| Limit | Bound |
| --- | --- |
| Rules per ruleset | 200 |
| Expression depth | 10 |
| Expression nodes | 100 per operation expression, including inlined functions |
| Match pattern length | 2048 characters |
| Variable path length | 512 characters |
| in right-hand array | At most 256 elements, also subject to the evaluation step budget |
| Runtime expression work | 256 steps per expression; large membership checks can exhaust the budget |

Unknown operators and invalid shapes are rejected by validation. Unknown variables may pass structural validation but resolve to undefined; negation and OR mean that an invalid subexpression is not proof that the whole rule denies. Reserved prototype-related field segments are blocked. Complexity failures use QUERY_TOO_COMPLEX; malformed ASTs use INVALID_ARGUMENT. A rule denial uses PERMISSION_DENIED. Invalid, expired or revoked API keys are separate authentication failures.

Keep every test's identity, operation, full path, old data and full new data explicit. Test unauthenticated access, a different user, missing fields, wrong types, ownership changes, omitted client filters, nested paths, batch operations, included private targets and realtime setup/initial/live/replay. Test with a public key, because a server key can bypass the very rules you are checking.

Compile and simulate endpoints are authoring tools, not activation or document-write APIs. A simulated allow is not proof of real API behavior, because a simulation supplies context directly. This guide does not claim that either SDK can activate rules. Verify actual document requests against the project's active ruleset before relying on a change.
