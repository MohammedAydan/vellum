---
title: Quickstart
order: 2
group: Getting started
description: Install @vellumdb/sdk-js or vellum_flutter, initialize a hardened client, and run your first create, read, atomic update, and delete.
---

# Quickstart

Get your first document into and out of VELLUM in under three minutes using either **TypeScript/JavaScript (`@vellumdb/sdk-js`)** or **Flutter/Dart (`vellum_flutter`)**.

## Prerequisites

- A VELLUM project ID (`proj_...`) and API endpoint (`https://api.example.com` or `http://localhost:8080`).
- An API key: use a **publishable key (`pk_...`)** in browsers and mobile apps, or a **secret key (`sk_...`)** in trusted backend services.

---

## TypeScript / JavaScript (`@vellumdb/sdk-js`)

### 1. Install

```bash
npm install @vellumdb/sdk-js
```

### 2. Initialize, Write, Read, Update & Clean Up

```ts
import { createClient, fieldOp } from "@vellumdb/sdk-js";

const db = createClient({
  projectId: process.env.VELLUM_PROJECT_ID!,
  apiKey: process.env.VELLUM_API_KEY!,
  endpoint: process.env.VELLUM_ENDPOINT ?? "http://localhost:8080",
  timeoutMs: 15_000,
  maxRetries: 3,
  cache: { enabled: true, ttlMs: 30_000, maxEntries: 1_000 },
  dedupeReads: true,
});

try {
  const userRef = db.collection("users").doc("usr_ada");

  // Create with atomic server timestamp and optional TTL
  await userRef.create(
    {
      name: "Ada Lovelace",
      role: "admin",
      loginCount: 1,
      tags: ["engineering"],
      createdAt: fieldOp.serverTimestamp(),
    },
    { ttlSeconds: 86_400 }
  );

  // Read back with field projection
  const snap = await userRef.get({ select: ["name", "role", "loginCount"] });
  console.log("Created:", snap.id, "v" + snap.version, snap.data());

  // Atomic partial update with optimistic concurrency (ifVersion)
  await userRef.update(
    {
      loginCount: fieldOp.increment(1),
      tags: fieldOp.arrayUnion("founders"),
    },
    { ifVersion: snap.version }
  );

  // Delete with version guard
  await userRef.delete({ ifVersion: snap.version + 1 });
} finally {
  // Release auth timers, caches, and WebSocket connections
  db.dispose?.();
}
```

---

## Flutter / Dart (`vellum_flutter`)

### 1. Install

```yaml
dependencies:
  vellum_flutter: ^0.0.1
```

### 2. Initialize, Write, Read, Update & Clean Up

```dart
import 'package:vellum_flutter/vellum_flutter.dart';

Future<void> main() async {
  final client = VellumClient(
    endpoint: 'http://localhost:8080',
    projectId: 'proj_01j9...',
    apiKey: 'pk_live_...',
    requestTimeout: const Duration(seconds: 15),
    maxRetries: 3,
    coalesceInFlightGets: true,
  );

  try {
    final userRef = client.collection('users').doc('usr_ada');

    await userRef.create(
      {
        'name': 'Ada Lovelace',
        'role': 'admin',
        'loginCount': 1,
        'tags': ['engineering'],
        'createdAt': FieldValue.serverTimestamp(),
      },
      ttlSeconds: 86400,
    );

    final snap = await userRef.get(select: ['name', 'role', 'loginCount']);
    print('Created: ${snap.id} v${snap.version} ${snap.data()}');

    await userRef.update(
      {
        'loginCount': FieldValue.increment(1),
        'tags': FieldValue.arrayUnion(['founders']),
      },
      ifVersion: snap.version,
    );

    await userRef.delete(ifVersion: snap.version + 1);
  } finally {
    client.dispose();
  }
}
```

---

## Next Steps

- [Querying, Relations & Aggregations](./query.md)
- [Cursor Pagination & Streaming](./pagination.md)
- [Realtime Subscriptions](./realtime.md)
- [Batch Writes & Transactions](./batch-and-transactions.md)
- [Production Checklist](./production-checklist.md)
