---
title: CRUD & Document Paths
order: 4
group: Core concepts
description: Canonical paths, document and collection references, create/set/update/delete, ifVersion, and the tagged wire format.
---

# CRUD & Document Paths

Every resource in the data plane is addressed by a canonical, `/`-separated UTF-8 path. Paths alternate between collection segments and document-id segments.

## Scenario

You are modeling a customer with their orders: one document at `users/u_123`, plus a subcollection of orders at `users/u_123/orders/ord_456`. You create the user, patch a field with a server timestamp, guard the update with a version precondition, and then read the document with its metadata.

## Path rules

| Kind | Segments | Examples |
| :--- | :--- | :--- |
| Document | Even, 2–10 | `users/u_123`, `users/u_123/orders/ord_456` |
| Collection | Odd, 1–9 | `users`, `users/u_123/orders` |

A path of depth 10 allows five nested collections. For `users/u_123/orders/ord_456`:

| Component | Value |
| :--- | :--- |
| `path` | `users/u_123/orders/ord_456` |
| `collectionPath` | `users/u_123/orders` |
| `collectionGroup` | `orders` |
| `documentId` | `ord_456` |
| `pathDepth` | `4` |

### Segment constraints

- At most **1,500 bytes** per segment (UTF-8).
- No `/`, NUL byte, or ASCII control characters (`0x00`–`0x1F`).
- `.` and `..` are rejected.
- Segments matching `^__.*__$` (for example `__name__`) are reserved for engine metadata and rejected on user paths.

:::warning
Exceeding the depth limit raises `INVALID_DOCUMENT_PATH` (400). Over-long segments and reserved segments produce the same code.
:::

## Document and collection references

```ts
import { createClient } from "@vellumdb/sdk-js";

const db = createClient({ projectId: "<YOUR_PROJECT_ID>", apiKey: "<YOUR_API_KEY>" });

// Document reference (even number of segments).
const user = db.doc("users/u_123");

// Collection reference (odd number of segments), then a document inside it.
const orders = db.collection("users/u_123/orders");
const order = orders.doc("ord_456");

// Nested subcollection from an existing document reference.
const events = user.collection("events"); // users/u_123/events
```

References are immutable builders; calling a method on a reference returns a new value with the updated state where appropriate.

## create, set, update, delete

```ts
// create — fails with ALREADY_EXISTS if the path is occupied.
await user.create({ name: "Ada", role: "admin" });

// set — replace by default, or deep-merge with { merge: true }.
await user.set({ name: "Ada Lovelace" }, { merge: true });

// update — patch only the supplied fields; supports field transforms.
await user.update({ lastSeenAt: fieldOp.serverTimestamp() });

// delete — soft delete (tombstone + outbox event).
await user.delete();
```

`create` and `set` return the stored document (path, collection path, document id, data, `version`, `createdAt`, `updatedAt`). `update` applies only the given keys; missing keys are left untouched.

```ts
// A read returns the document plus its server-managed metadata.
const snap = await user.get();
console.log(snap.path, snap.version, snap.exists, snap.data());
```

### Optimistic concurrency with `ifVersion`

Every document has a monotonically increasing `version`. Pass the expected version as a precondition to reject a write if someone else changed the document first:

```ts
const snap = await user.get();
await user.update({ status: "approved" }, { ifVersion: snap.version });
// If another writer bumped the version, this throws FAILED_PRECONDITION (412).
```

`set` and `delete` accept the same `ifVersion` option. A failed precondition returns `FAILED_PRECONDITION` with `expectedVersion` and `actualVersion` in the error details. For multi-document atomicity with preconditions, use [transactions](./batch-and-transactions.md).

## Tagged wire format basics

Native JSON primitives (`null`, `boolean`, `string`, finite `number`, `array`) are stored directly so PostgreSQL `jsonb_path_ops` indexes can use them without wrapper overhead. Extended types use the reserved keys `$t` (tag) and `$v` (value):

| Logical type | Representation |
| :--- | :--- |
| `int64` | `{ "$t": "int", "$v": "-9007199254740993" }` |
| `timestamp` | `{ "$t": "ts", "$v": "2026-11-15T14:30:00.123Z", "$ms": 1794753000123 }` |
| `reference` | `{ "$t": "ref", "$v": "users/u_123" }` |
| `bytes` | `{ "$t": "bytes", "$v": "SGVsbG8=" }` (Base64) |
| `geopoint` | `{ "$t": "geo", "$v": { "lat": 30.0444, "lng": 31.2357 } }` |
| user map containing `$t` | `{ "$t": "map", "$v": { ... } }` (automatic lossless escape) |

- Numbers must be finite; `NaN` and `Infinity` are rejected.
- Object/array nesting is capped at 20 levels (`MAX_NESTING_EXCEEDED`).
- Field names are capped at 256 characters and cannot contain control characters (`INVALID_FIELD_NAME`).
- A serialized document may not exceed 1 MiB (`DOCUMENT_TOO_LARGE`).

:::tip
References (`$t: "ref"`) must be valid canonical paths in the same project. They are plain path strings on the wire — VELLUM does not fetch the target document for you.
:::

## Common pitfalls

- **Mixing up document and collection paths.** A document path has an even number of segments; a collection path has an odd number.
- **Using a reserved segment.** Names like `__name__` are engine metadata and are rejected on user paths.
- **Expecting `create` to be idempotent.** It fails with `ALREADY_EXISTS`; use `set` when an overwrite is intended.
- **Assuming `delete` removes the row immediately.** It is a soft delete (tombstone), with cleanup handled by the retention worker.

## Verified example

:::example-tabs crud

## What to read next

- [Field transforms](./field-transforms.md) — atomic server-side field operations.
- [Query](./query.md) — filter, sort, and project documents.
- [Realtime](./realtime.md) — subscribe to changes on a document or collection.
