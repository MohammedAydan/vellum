---
title: Batch Writes & Transactions
order: 10
group: Core concepts
description: Atomic batchWrite, auto-chunked bulk writes (batchWriteChunked and commitChunked), and interactive OCC runTransaction() with automatic ABORTED_CONFLICT retry.
---

# Batch Writes & Transactions

Choose the right write primitive for your consistency and throughput requirements:

| Primitive | Atomicity | Max Ops per Request | Use Case |
| --- | --- | --- | --- |
| `batchWrite` / `batch().commit()` | All-or-nothing single SQL transaction | 500 writes | Atomic multi-document writes without read dependencies. |
| `batchWriteChunked` / `commitChunked` | Atomic per chunk (not across chunks) | Unlimited (auto-chunked) | High-throughput imports, migrations, and catalog syncs. |
| `runTransaction` | Serializable OCC read-modify-write | Bounded interactive set | Balances, inventory reservations, uniqueness invariants. |

---

## Atomic Batch Writes & Auto-Chunked Bulk Writes

### TypeScript (`@vellumdb/sdk-js`)

```ts
import { fieldOp } from "@vellumdb/sdk-js";

// 1. Single atomic batch (<= 500 operations)
await db.batchWrite([
  { type: "set", path: "products/sku_1", data: { priceCents: 1999 }, merge: true },
  { type: "update", path: "products/sku_2", data: { stock: fieldOp.increment(-1) } },
  { type: "delete", path: "products/sku_old" },
]);

// 2. Auto-chunked bulk writes with bounded concurrency, progress, and AbortSignal
const ac = new AbortController();
const result = await db.batchWriteChunked(thousandsOfWrites, {
  chunkSize: 500,    // default 500 ops per HTTP batchWrite
  concurrency: 4,    // default 4 concurrent in-flight chunks
  signal: ac.signal,
  onProgress: ({ completedChunks, totalChunks, completedOperations, totalOperations }) => {
    console.log(`Chunk ${completedChunks}/${totalChunks} (${completedOperations}/${totalOperations} ops)`);
  },
});

console.log(`Committed ${result.totalOperations} ops across ${result.totalChunks} chunks`);
```

### Flutter / Dart (`vellum_flutter`)

```dart
// 1. Fluent batch builder for atomic or auto-chunked writes
final batch = client.batch();
for (final item in catalogItems) {
  batch.set(
    client.collection('products').doc(item.sku),
    item.toMap(),
    merge: true,
  );
}

// Single atomic batch (<= 500 ops)
await batch.commit(idempotencyKey: 'catalog-atomic-1');

// Auto-chunked sequential submission with deterministic per-chunk idempotency keys
// Sends "catalog-sync-0", "catalog-sync-1", ...
final chunkResponses = await batch.commitChunked(
  chunkSize: 500,
  idempotencyKeyPrefix: 'catalog-sync',
);

// 2. Direct list helper
await client.writeBatchChunked(
  rawWriteMaps,
  chunkSize: 500,
  idempotencyKeyPrefix: 'bulk-import',
);
```

---

## Interactive OCC Transactions (`runTransaction`)

Transactions acquire a server `transactionToken` (`POST /transactions:begin`), track read versions via `tx.get(...)`, stage mutations (`create`, `set`, `update`, `delete`), and commit atomically (`POST /transactions:commit`). If a concurrent writer modifies a read document, the server responds with `ABORTED_CONFLICT` (`409`) and the SDK automatically retries with jittered backoff up to `maxAttempts` (default `5`).

### TypeScript (`@vellumdb/sdk-js`)

```ts
const { result } = await db.runTransaction(
  async (tx) => {
    const fromSnap = await tx.get(db.doc("accounts/acc_a"));
    const toSnap = await tx.get(db.doc("accounts/acc_b"));

    const fromBalance = Number(fromSnap.data()["balance"] ?? 0);
    if (fromBalance < 250) {
      throw new Error("INSUFFICIENT_FUNDS");
    }

    tx.update(fromSnap.path, { balance: fromBalance - 250 });
    tx.update(toSnap.path, { balance: Number(toSnap.data()["balance"] ?? 0) + 250 });
    tx.create("ledger/tx_9001", { from: "acc_a", to: "acc_b", amount: 250 });

    return { newFromBalance: fromBalance - 250 };
  },
  { maxAttempts: 5, signal: ac.signal }
);
```

### Flutter / Dart (`vellum_flutter`)

```dart
final newBalance = await client.runTransaction<int>((tx) async {
  final fromRef = client.doc('accounts/acc_a');
  final toRef = client.doc('accounts/acc_b');
  final fromSnap = await tx.get(fromRef);
  final toSnap = await tx.get(toRef);

  final fromBalance = (fromSnap.data()?['balance'] as num?)?.toInt() ?? 0;
  if (fromBalance < 250) {
    throw StateError('INSUFFICIENT_FUNDS');
  }

  tx.update(fromRef, {'balance': fromBalance - 250});
  tx.update(toRef, {'balance': ((toSnap.data()?['balance'] as num?)?.toInt() ?? 0) + 250});
  return fromBalance - 250;
}, maxAttempts: 5);
```

> **Keep transaction callbacks pure**: Because `updateFunction` may re-run on `ABORTED_CONFLICT`, avoid side effects (sending emails, charging cards, mutating external state) inside the callback until `runTransaction` resolves.
