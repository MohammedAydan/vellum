# ADR-007: Relation-Rules Management Surface (sk_ / SDK)

## Status
Accepted (0.0.9 scope: console-only; this ADR records the planned sk_/SDK surface)

## Context
Relation rules (`onDelete: cascade | set_null | restrict`) are project integrity
configuration. Today the only management surface is the console: the
`GET/PUT /v1/projects/:projectId/relation-rules` routes sit behind
`requireRealmSession`, which rejects project API keys. Customers asked for a
programmatic surface (infrastructure-as-code, per-environment sync, SDK parity).

Opening the existing routes to `sk_` keys as-is was rejected for 0.0.9:

1. **Blast radius.** A rule change rewrites or tombstones *other people's*
   documents on the next delete. A leaked `sk_` key with relation-rules write
   access can wipe subtrees via `cascade` without touching a single document
   endpoint directly. That deserves its own scope, not a silent ride on the
   general server-key surface.
2. **Optimistic concurrency for machines.** The console uses `expectedVersion`
   interactively. A programmatic surface needs idempotent apply semantics
   (dry-run, drift detection) rather than last-writer-wins replacement.
3. **Auditability.** Console edits are audit-logged per user. An `sk_` surface
   must record the key id and caller-supplied reason, and belongs in the same
   audit stream customers already export.

## Decision
For 0.0.9 the management surface stays **console-only**. The engine behavior is
unchanged: configured actions are enforced on every delete no matter how rules
were edited, and the wire `IncludeSpec.onDelete` field remains accepted for
forward compatibility but never configures rules by itself.

The planned surface for a later minor release:

- **Scope-gated key access.** A new API-key scope `relation-rules:write`
  (read implied by `relation-rules:read`). Server keys (`sk_`) created without
  the scope get `PERMISSION_DENIED` on both routes; publishable keys (`pk_`)
  are never eligible, matching the existing key-type split.
- **Routes.** `GET /v1/projects/:projectId/relation-rules` (read scope) and
  `PUT /v1/projects/:projectId/relation-rules` (write scope), same wire shape
  and `expectedVersion` semantics as the console routes, shared validation
  (50-rule cap, `onDelete` enum, duplicate `(collection, field)` rejection).
- **SDK methods.** `client.admin.getRelationRules()` /
  `client.admin.putRelationRules(rules, { expectedVersion })` in sdk-js and
  `client.admin` equivalents in the Flutter SDK, documented as server-key-only
  and excluded from browser bundles by convention with the other admin methods.
- **Audit and dry-run.** Every `PUT` writes an audit entry with the key id,
  an optional caller `reason` string, and the rule diff. A `?dryRun=true`
  query flag validates and returns the would-be diff without persisting.

## Consequences
- 0.0.9 ships no new public endpoint and no SDK additions for relation rules;
  docs/12 states the console-only status explicitly.
- When the scoped surface lands, no route or wire-shape migration is needed:
  the same routes accept the new scope, and existing console sessions keep
  working unchanged.
