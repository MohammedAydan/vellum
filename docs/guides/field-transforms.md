---
title: Field Transforms
order: 5
group: Core concepts
description: All atomic fieldOp sentinels, how they are applied, their ordering, and restrictions.
---

# Field Transforms

Field transforms let the server compute a field value atomically, avoiding a read-modify-write race. The SDK exposes five helpers under `fieldOp`; on the wire each becomes a sentinel object with a `$op` key.

```ts
import { fieldOp } from "@vellumdb/sdk-js";
```

## Scenario

Several users can "like" a post at the same time, and you want an accurate `likeCount` without coordinating clients. You use `increment(1)` to bump the counter atomically and `arrayUnion` to record unique reactor ids — the server applies both in one transaction, so no update is lost.

## The five operations

| SDK helper | Wire sentinel | Behavior |
| :--- | :--- | :--- |
| `fieldOp.serverTimestamp()` | `{ "$op": "serverTimestamp" }` | Replaced with the transaction's UTC timestamp as `{ "$t": "ts", "$v": "...", "$ms": ... }`. |
| `fieldOp.increment(n = 1)` | `{ "$op": "inc", "by": n }` | Adds `n` to the current value. Missing field initializes to `n`. |
| `fieldOp.arrayUnion(...items)` | `{ "$op": "arrayUnion", "elements": [...] }` | Appends items not already present (typed deep equality). |
| `fieldOp.arrayRemove(...items)` | `{ "$op": "arrayRemove", "elements": [...] }` | Removes every occurrence matching any item. |
| `fieldOp.deleteField()` | `{ "$op": "deleteField" }` | Removes the field from its parent map. |

```ts
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
```

`arrayUnion` and `arrayRemove` accept either variadic arguments or a single array argument (`fieldOp.arrayUnion(["a", "b"])` and `fieldOp.arrayUnion("a", "b")` are equivalent).

On the wire the increment operation also accepts the alias `$op: "increment"` with `$v` / `value`; the canonical SDK helper emits `inc` with `by`.

```ts
// Two independent counters updated in a single write.
await db.collection("stats").doc("global").update({
  posts: fieldOp.increment(1),
  lastPostAt: fieldOp.serverTimestamp(),
});
```

## Where transforms are allowed

Transforms are accepted in write paths where the engine validates data with field operations enabled:

- `DocumentReference.set` with `{ merge: true }`
- `DocumentReference.update` (HTTP `PATCH`)
- `batchWrite` mutations
- transaction commits (`tx.set` / `tx.update`)

They are **not** valid in `create` payloads or in query values. A sentinel appearing where transforms are not allowed raises `INVALID_ARGUMENT`.

A transform must be a field value, not an array element. `{ events: [fieldOp.serverTimestamp()] }` is rejected with `INVALID_ARGUMENT` ("Field operation ($op) is not permitted in this context"). To record a time inside a list, set a separate field with `serverTimestamp()`, or use `arrayUnion` with a client-side `Date`.

## Atomicity and ordering

- All transforms in a single write are applied inside the same database transaction, using one shared transaction timestamp for `serverTimestamp`.
- The patch is walked in object-key insertion order. Nested plain objects are merged recursively, so a transform can sit at any depth.
- `arrayUnion` and `arrayRemove` use wire-value equality, so tagged values (timestamps, references, int64) compare correctly rather than by JavaScript identity.
- For `increment`, if the current value is a tagged `int64` (`$t: "int"`), the server computes in `BigInt` and stores a tagged int64 result; otherwise it uses IEEE-754 addition.

:::note
Because transforms are evaluated server-side at commit time, two clients incrementing the same counter concurrently do not lose updates. If you also need preconditions across several documents, use a transaction.
:::

## Restrictions and failure modes

- Incrementing a field whose current value is not numeric (and not a tagged int64) throws `FAILED_PRECONDITION` (412).
- A field named `__proto__`, `constructor`, or `prototype` is rejected at every merge level with `INVALID_FIELD_NAME` to prevent prototype-pollution gadgets.
- `inc` requires a finite numeric `by` value; `arrayUnion` / `arrayRemove` require an `elements` array.
- An unknown `$op` value throws `INVALID_ARGUMENT`.
- Transformed values still go through the normal wire-format validation: 20-level nesting cap, 256-character field names, and 1 MiB document size.

:::warning
Do not mix a transform with a precondition that depends on the same field's post-transform value. `ifVersion` compares the document version *before* the write; it does not validate the transformed result.
:::

## Common pitfalls

- **Using a transform in `create` or a query value.** Those paths reject `$op` sentinels with `INVALID_ARGUMENT`.
- **Incrementing a non-numeric field.** The first write must initialize the field to a number (or a tagged int64).
- **Assuming read-your-writes inside a transform.** Transforms are computed at commit time against the current stored value.
- **Using `ifVersion` to protect a transformed field.** The precondition checks the pre-write version, not the computed result.

## Verified example

:::example-tabs field-transforms

## What to read next

- [CRUD](./crud.md) — document paths and wire-format details.
- [Batch & transactions](./batch-and-transactions.md) — atomic multi-document writes.
- [Errors & limits](./errors-and-limits.md) — canonical error codes and statuses.
