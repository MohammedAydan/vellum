---
title: Query
order: 6
group: Core concepts
description: All 13 filter operators, disjunctive or() groups, eager include() relations, dot-path select() projections, server-side aggregate(), and index advisor hooks.
---

# Query

VELLUM compiles declarative queries into parameterized PostgreSQL queries over `JSONB` with composite index validation and automatic index-advisor feedback. Both `@vellumdb/sdk-js` and `vellum_flutter` expose an immutable, chainable query builder.

---

## All 13 Filter Operators

| Category | Operators | Notes |
| --- | --- | --- |
| Equality & Comparison | `==`, `!=`, `<`, `<=`, `>`, `>=` | Type-preserving comparison on scalar fields. |
| Membership | `in`, `not-in` | Accepts up to 30 values per clause. |
| Array Membership | `array-contains`, `array-contains-any` | Matches array elements (`array-contains-any` up to 30 values). |
| V2 Text & Full-Text | `contains_ci`, `starts_with_ci`, `text_search` | Case-insensitive substring/prefix match and full-text search. |

---

## Filters, Disjunctive `or()`, `include()` & `select()`

### TypeScript (`@vellumdb/sdk-js`)

```ts
const snapshot = await db
  .collection("orders")
  .where("status", "in", ["paid", "shipped"])
  .where("notes", "contains_ci", "priority")
  .or([
    [{ field: "tier", op: "==", value: "enterprise" }],
    [{ field: "totalCents", op: ">=", value: 50_000 }],
  ])
  .include([
    "customerId",
    {
      field: "assigneeId",
      collection: "users",
      as: "assignee",
      select: ["name", "email"],
    },
  ])
  .select("status", "totalCents", "customerId", "shipping.country")
  .orderBy("createdAt", "desc")
  .limit(25)
  .get();

for (const doc of snapshot.docs) {
  console.log(doc.id, doc.data(), doc.included, doc.redactedRefs);
}
```

### Flutter / Dart (`vellum_flutter`)

```dart
final snapshot = await client
    .collection('orders')
    .where('status', 'in', ['paid', 'shipped'])
    .where('notes', 'contains_ci', 'priority')
    .or([
      [
        {'field': 'tier', 'op': '==', 'value': 'enterprise'},
      ],
      [
        {'field': 'totalCents', 'op': '>=', 'value': 50000},
      ],
    ])
    .include([
      'customerId',
      const VellumInclude(
        field: 'assigneeId',
        collection: 'users',
        as: 'assignee',
        select: ['name', 'email'],
      ),
    ])
    .select(['status', 'totalCents', 'customerId', 'shipping.country'])
    .orderBy('createdAt', dir: 'desc')
    .limit(25)
    .get();

for (final doc in snapshot.docs) {
  print('${doc.id}: ${doc.data()} included=${doc.included}');
}
```

- **Disjunctive `or()`**: Clauses inside each inner array are `AND`ed together; outer groups are `OR`ed.
- **Eager `include()`**: Pass a bare field name (`"customerId"`) or an explicit `IncludeSpecInput` / `VellumInclude` with `collection`, `as`, `select`, and nested `include`. Any relation denied by Security Rules appears in `doc.redactedRefs` rather than failing the parent query.

---

### Filtering on timestamps

Compare a timestamp field with a `Date`, a `Timestamp` or an ISO 8601 string (`"2026-11-27T02:00:00.000Z"`). A plain millisecond number only matches fields that hold a number, so `where("createdAt", ">", Date.now() - 60000)` against a server timestamp returns no rows. Use `new Date(Date.now() - 60000)` instead. The server does not reject the number, because a number is a valid value for a numeric field.

## Server-Side Aggregations (`aggregate()`)

Run `count`, `sum`, `avg`, `min`, and `max` directly in PostgreSQL without transferring raw documents over the wire.

### TypeScript (`@vellumdb/sdk-js`)

```ts
// Scalar shortcuts
const openCount = await db.collection("orders").where("status", "==", "open").count();
const totalRevenue = await db.collection("orders").where("status", "==", "paid").sum("totalCents");
const avgTicket = await db.collection("orders").where("status", "==", "paid").avg("totalCents");
const minTicket = await db.collection("orders").where("status", "==", "paid").min("totalCents");
const maxTicket = await db.collection("orders").where("status", "==", "paid").max("totalCents");

// Grouped aggregation (returns AggregateRow[])
const byCurrency = await db
  .collection("orders")
  .where("status", "==", "paid")
  .aggregate({
    groupBy: ["currency"],
    metrics: {
      orders: { op: "count" },
      grossCents: { op: "sum", field: "totalCents" },
      avgCents: { op: "avg", field: "totalCents" },
    },
  });
```

### Flutter / Dart (`vellum_flutter`)

```dart
final openCount = await client.collection('orders').where('status', '==', 'open').count();
final totalRevenue = await client.collection('orders').where('status', '==', 'paid').sum('totalCents');
final avgTicket = await client.collection('orders').where('status', '==', 'paid').avg('totalCents');

final grouped = await client.collection('orders').where('status', '==', 'paid').aggregate(
  groupBy: ['currency'],
  metrics: {
    'orders': const AggregateMetric.count(),
    'grossCents': const AggregateMetric.sum('totalCents'),
    'minCents': const AggregateMetric.min('totalCents'),
    'maxCents': const AggregateMetric.max('totalCents'),
  },
);
```

---

## Filtered Bulk Delete (`deleteWhere()`)

```ts
// TypeScript
const { deletedCount } = await db
  .collection("sessions")
  .where("expired", "==", true)
  .deleteWhere({ limit: 500 });
```

```dart
// Dart
final deletedCount = await client
    .collection('sessions')
    .where('expired', '==', true)
    .deleteWhere(limit: 500);
```

---

## Automatic Index Advisor

When the server detects a slow or unindexed query, it returns `x-vellum-index-url` and `x-vellum-index-suggestion` headers. Both SDKs deduplicate warnings by fingerprint, print a one-click creation link in development (`warnOnMissingIndexes: true`), and expose an `onIndexSuggestion` callback for structured telemetry.
