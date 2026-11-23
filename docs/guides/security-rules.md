---
title: Security Rules
order: 11
group: Security
description: The v1 JSON rules AST, deterministic deny-by-default evaluation, validation bounds, publishing, and simulation.
---

# Security Rules

Security rules decide whether a public API key (`pk_`) may read or write a document. They are stored as a versioned JSON **Abstract Syntax Tree** in the control plane and evaluated synchronously in memory — never by generating or executing code.

:::note
Server keys (`sk_`) bypass the rules AST for operations covered by their scopes. Public keys always evaluate rules; with no active ruleset, access is denied.
:::

## Scenario

You run a multi-user app where each user may read and write only their own `users/{userId}` document, while a small admin group may read all users. You publish a ruleset that binds ownership to the path wildcard, check it in the Rule Simulator, and verify that an unauthorized `pk_` request gets `PERMISSION_DENIED`.

## Ruleset shape (v1)

```json
{
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
            { "op": "==", "left": { "var": "request.data.ownerId" }, "right": { "var": "auth.uid" } }
          ]
        },
        "update": { "op": "==", "left": { "var": "resource.data.ownerId" }, "right": { "var": "auth.uid" } },
        "delete": { "op": "==", "left": { "var": "auth.claims.role" }, "right": { "val": "admin" } }
      }
    }
  ]
}
```

`version` must be `1` and `rules` must be an array. Each rule has a `match` path pattern and an `allow` object whose keys are operations: `get`, `list`, `create`, `update`, `delete`, plus the shorthands `read` (covers `get`/`list`) and `write` (covers `create`/`update`/`delete`).

### Wildcard matching

- `{paramName}` binds one segment to `path.<paramName>`.
- `{document=**}` at the end of a pattern matches one or more remaining segments and binds the relative sub-path to `path.document`.
- If several rules match a path, access is granted when **any** matching rule evaluates to true for the operation (standard OR semantics). No match, or no true expression, means deny.

## Expression operators

| Category | Operators |
| :--- | :--- |
| Comparisons | `==`, `!=`, `<`, `<=`, `>`, `>=`, `in` |
| Object / type | `hasKey`, `isType` |
| Combinators | `all` (every `conditions`), `any` (some `conditions`), `not` (one `condition`) |

Operands are either `{ "val": ... }` for a literal or `{ "var": "..." }` for a context value:

| Variable | Meaning |
| :--- | :--- |
| `auth.uid` | End-user id from the bearer JWT (null without a token). |
| `auth.claims.<path>` | Claim from the end-user JWT. |
| `path.<param>` | Value bound by a wildcard in `match`. |
| `resource.data[.<path>]` | Existing document data (null on create). |
| `request.data[.<path>]` | Incoming document data (null on reads/deletes). |
| `request.time` | Request timestamp in epoch milliseconds. |

All comparisons use the same typed wire-value equality and ordering as the query engine.

## Deterministic evaluation and bounds

- Evaluation is 100% synchronous and in memory: no dynamic code execution, no network calls, and no recursive I/O. Complex expressions cannot turn a request into a denial-of-service vector.
- Validation enforces **max AST depth 10** and **max 100 nodes per rule expression**. Exceeding either raises `QUERY_TOO_COMPLEX`.
- Circular references are rejected at validation time, and unknown operators or operands evaluate to false (deny).
- **Deny by default:** `authorizeOperation` throws `PERMISSION_DENIED` (403) unless a matching rule explicitly allows the operation.

:::warning
Rules are validated against the v1 schema at publish time. A malformed AST (bad version, missing `match`/`allow`, unsupported operation or operator) is rejected with `INVALID_ARGUMENT` before it can become active.
:::

## Publishing and simulation

Publish through the session-authenticated console API:

| Method | Endpoint | Purpose |
| :--- | :--- | :--- |
| `POST` | `/v1/projects/:projectId/rulesets` | Validate and publish a new version; writes an audit log and invalidates caches. |
| `GET` | `/v1/projects/:projectId/rulesets` | Read the active ruleset (or the built-in default when none is published). |

```bash
curl -X POST "https://api.example.com/v1/projects/<PROJECT_ID>/rulesets" \
  -H "Authorization: Bearer <SESSION_TOKEN>" \
  -H "content-type: application/json" \
  -d '{ "rulesAst": { "version": 1, "rules": [ /* ... */ ] } }'
```

Publishing immediately affects the project: the ruleset cache is invalidated locally and across instances via `NOTIFY vellum_cache_invalidate`. For a dry run before publishing, the dashboard's **Rule Simulator** evaluates a candidate AST against a simulated auth and path context and reports whether the request would be allowed and which rule matched. You can also validate a candidate against the project using a public key.

## Least privilege patterns

```json
{
  "match": "users/{userId}/orders/{orderId}",
  "allow": {
    "get": { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } },
    "create": {
      "op": "all",
      "conditions": [
        { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } },
        { "op": "isType", "left": { "var": "request.data.total" }, "right": { "val": "number" } }
      ]
    }
  }
}
```

Bind the owner id to a path wildcard rather than trusting a client-supplied field, and check `resource.data` on updates so ownership cannot be transferred by a malicious patch.

## Common pitfalls

- **Trusting a client-supplied owner field.** Bind ownership to a path wildcard and verify it against `auth.uid`.
- **Allowing updates without checking `resource.data`.** A malicious patch could transfer ownership if you only validate the incoming data.
- **Forgetting deny-by-default.** If no rule matches, access is denied — publish the ruleset and confirm the shape (`version: 1`).
- **Overly deep or large rulesets.** Exceeding depth 10 or 100 nodes per expression raises `QUERY_TOO_COMPLEX` at publish time.

## Verified example

:::example-tabs rules

## What to read next

- [Authentication](./authentication.md) — public keys, end-user tokens, and server-key scopes.
- [CRUD](./crud.md) — path patterns that rules match against.
- [Errors & limits](./errors-and-limits.md) — `PERMISSION_DENIED` and rules complexity errors.
