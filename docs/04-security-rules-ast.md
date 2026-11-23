# 04 — Authentication, API Keys & Declarative Security Rules AST

## 1. Two-Tier Credential Model

Every API and WebSocket request must authenticate with an `X-Project-Key` header (or `apiKey` in the WebSocket `auth` frame):

### 1.1 Public Keys (`pk_<random_base62>`)
- Safe to embed in browser, mobile (Flutter), and desktop applications.
- Identifies `(projectId)`.
- Grants **zero implicit data access**: every operation (`get`, `list`, `create`, `update`, `delete`) is unconditionally evaluated against the project's active `security_rulesets.rules_ast`.
- Optionally paired with `Authorization: Bearer <end_user_jwt>` to populate `auth.uid` and `auth.claims`.

### 1.2 Server Keys (`sk_<random_base62>`)
- Confidential backend credentials stored only on trusted servers.
- Stored in `control_db.api_keys` as a unique `key_prefix` (first 16 chars) plus a `SHA-256(fullKey + ":" + serverPepper)` hex digest (`secret_hash`). Plaintext keys are never stored after creation.
- Bypasses end-user Security Rules AST **only** for the explicit scopes granted in `api_keys.scopes`:
  - `documents:read` (`get`, `list`, `query`)
  - `documents:write` (`create`, `set`, `update`, `delete`, `batchWrite`, `transactions`)
  - `indexes:manage` (`listIndexes`, `createIndex`, `deleteIndex`)

---

## 2. Declarative Security Rules AST (v1)

Security rules are stored and evaluated as a deterministic JSON Abstract Syntax Tree (`RulesetAst`).

### 2.1 Example Ruleset AST

```json
{
  "version": 1,
  "rules": [
    {
      "match": "users/{userId}",
      "allow": {
        "get": {
          "op": "==",
          "left": { "var": "auth.uid" },
          "right": { "var": "path.userId" }
        },
        "list": {
          "op": "==",
          "left": { "var": "auth.claims.role" },
          "right": { "val": "admin" }
        },
        "create": {
          "op": "all",
          "conditions": [
            { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } },
            { "op": "==", "left": { "var": "request.data.ownerId" }, "right": { "var": "auth.uid" } }
          ]
        },
        "update": {
          "op": "all",
          "conditions": [
            { "op": "==", "left": { "var": "resource.data.ownerId" }, "right": { "var": "auth.uid" } },
            { "op": "==", "left": { "var": "request.data.ownerId" }, "right": { "var": "resource.data.ownerId" } }
          ]
        },
        "delete": {
          "op": "==",
          "left": { "var": "auth.claims.role" },
          "right": { "val": "admin" }
        }
      }
    }
  ]
}
```

### 2.2 Wildcard Path Matching
- Single-segment wildcard `{paramName}` binds the matching segment to `path.<paramName>`.
- Recursive multi-segment wildcard `{document=**}` at the end of a pattern matches 1 or more remaining segments and binds the relative sub-path to `path.document`.
- If multiple `match` blocks match a target path, access is granted if **any** matching rule evaluates to `true` for the requested operation (standard Firestore semantics), and denied by default (`false`) if no rule matches or evaluates to `true`.

### 2.3 Complexity Bounds & Deterministic Evaluation
- Maximum AST Depth: `10` levels.
- Maximum AST Node Count per Rule: `100` nodes.
- Evaluation is 100% synchronous and in-memory, preventing recursive I/O amplification or denial-of-service attacks.
