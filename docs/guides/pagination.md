---
title: Pagination
order: 7
group: Core concepts
description: HMAC-signed opaque cursors, startAfter vs startAt, bounded-memory streaming with pages()/stream() in JS and streamPages()/streamDocuments() in Flutter.
---

# Pagination

VELLUM uses **keyset cursor pagination** backed by HMAC-signed opaque cursors and a deterministic `document_id` tie-breaker. SQL `OFFSET` is never used, so deep pages stay O(log N) and never skip or duplicate rows under concurrent inserts.

---

## Manual Cursor Pagination (`startAfter` / `startAt`)

Every `QuerySnapshot` returns `nextCursor: string | null`. Pass it to `startAfter(cursor)` for the next exclusive page (or `startAt(cursor)` in `@vellumdb/sdk-js` for an inclusive boundary):

### TypeScript (`@vellumdb/sdk-js`)

```ts
let cursor: string | null = null;

do {
  let q = db
    .collection("invoices")
    .where("status", "==", "paid")
    .orderBy("createdAt", "desc")
    .limit(50);

  if (cursor) q = q.startAfter(cursor);

  const page = await q.get();
  renderInvoices(page.docs);
  cursor = page.nextCursor;
} while (cursor);
```

### Flutter / Dart (`vellum_flutter`)

```dart
String? cursor;

do {
  var q = client
      .collection('invoices')
      .where('status', '==', 'paid')
      .orderBy('createdAt', dir: 'desc')
      .limit(50);

  if (cursor != null) q = q.startAfter(cursor);

  final page = await q.get();
  renderInvoices(page.docs);
  cursor = page.nextCursor;
} while (cursor != null);
```

---

## Enterprise Bounded-Memory Streaming

For ETL pipelines, exports, backfills, or infinite scroll feeds, prefer the built-in streaming iterators instead of hand-rolled cursor loops. Both SDKs guard against empty pages and stuck cursors automatically.

### TypeScript: `pages()` and `stream()`

Supports `pageSize`, `maxPages`, `maxDocs`, and cooperative cancellation via `AbortSignal`:

```ts
const controller = new AbortController();

// 1. Stream individual DocumentSnapshots with hard safety caps
for await (const doc of db
  .collection("events")
  .where("type", "==", "purchase")
  .orderBy("createdAt", "desc")
  .stream({
    pageSize: 200,
    maxPages: 50,
    maxDocs: 5_000,
    signal: controller.signal,
  })) {
  await processEvent(doc.id, doc.data());
}

// 2. Stream one QuerySnapshot page at a time
for await (const page of db
  .collection("events")
  .orderBy("createdAt", "desc")
  .pages({ pageSize: 200, signal: controller.signal })) {
  await writeWarehouseBatch(page.docs);
}
```

### Flutter / Dart: `streamPages()` and `streamDocuments()`

Standard Dart `Stream`s that pause automatically on backpressure and stop immediately when the `StreamSubscription` is cancelled:

```dart
final query = client
    .collection('events')
    .where('type', '==', 'purchase')
    .orderBy('createdAt', dir: 'desc');

// 1. Stream individual DocumentSnapshots lazily
await for (final doc in query.streamDocuments(pageSize: 200, maxPages: 50)) {
  await processEvent(doc.id, doc.data());
}

// 2. Stream one QuerySnapshot page at a time
await for (final page in query.streamPages(pageSize: 200, maxPages: 50)) {
  await writeWarehouseBatch(page.docs);
}
```

---

## Best Practices

1. **Always set an explicit `orderBy`**: Combine `orderBy` with matching composite indexes for deterministic cursor order.
2. **Use `maxPages` / `maxDocs` and `AbortSignal` on unbounded collections**: Prevent runaway background jobs from scanning millions of records unexpectedly.
3. **Never parse or modify `nextCursor`**: Cursors are HMAC-signed by the server; tampering results in an `INVALID_ARGUMENT` error.
