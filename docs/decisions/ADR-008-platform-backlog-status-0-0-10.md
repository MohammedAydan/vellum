# ADR-008: Platform backlog status for 0.0.10 (cross-doc rules, onDelete surface, anonymous upgrade)

## Status
Accepted. Verified against the source on the 0.0.10 branch.

## Cross-document rules lookup
`get()` and `exists()` already work in `get`, `create`, `update` and `delete` rules
(`packages/authorization/src/rules-dsl.ts`, lookups collected by `collectRuleLookups` in
`rules-ast.ts`). They are refused in `list` and `read` rules on purpose: a query is checked once, not
per document, so a per-document lookup would either leak or cost one read per row. The 0.0.10
change for list queries is different and separate: `get` rules that depend on the document are now
applied per returned row, and scoped aggregates over those rules are bounded by
`VELLUM_AGGREGATE_ROW_FILTER_MAX` and fail with `SCOPED_AGGREGATE_ROW_LIMIT` past the cap.
Decision: keep the restriction. Document it (done in `docs/guides/security-rules.md`).

## onDelete public API
Relation rules (`onDelete: cascade | set_null | restrict`) are enforced by the server on every delete.
The management surface (read and write the rules) stays console-only until ADR-007's `sk_` and SDK
surface is built; it is tracked there. Enforcement is not affected by the SDK surface.

## Anonymous upgrade parity
`upgradeAnonymousWithEmailAndPassword` exists in `@vellumdb/sdk-js` (`auth-client.ts`) and
`vellum_flutter` (`auth_client.dart`) and calls `POST /auth/upgrade-anonymous`. The uid, claims and
documents are kept. Errors: FAILED_PRECONDITION when the account is not anonymous, ALREADY_EXISTS
when the email is taken.
