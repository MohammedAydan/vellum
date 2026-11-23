export const quickstartTypeScript = `import { createClient, fieldOp } from "@vellum/sdk-js";

const db = createClient({
  endpoint: process.env.VELLUM_ENDPOINT ?? "http://localhost:8080",
  projectId: process.env.VELLUM_PROJECT_ID!,
  apiKey: process.env.VELLUM_API_KEY!,
  dedupeReads: true,
});

try {
  const ref = db.collection("tasks").doc("task_01");

  // 1. Create or overwrite with atomic serverTimestamp
  await ref.set({
    title: "Ship hardened docs",
    status: "open",
    priority: 1,
    tags: ["docs", "launch"],
    createdAt: fieldOp.serverTimestamp(),
  });

  // 2. Read back with version metadata
  const snap = await ref.get();
  console.log("Loaded:", snap.id, "v" + snap.version, snap.data());

  // 3. Patch atomically with optimistic concurrency (ifVersion)
  await ref.update(
    {
      priority: fieldOp.increment(1),
      tags: fieldOp.arrayUnion(["verified"]),
    },
    { ifVersion: snap.version }
  );

  // 4. Query using any of the 13 supported operators
  const page = await db
    .collection("tasks")
    .where("status", "==", "open")
    .where("tags", "array-contains", "launch")
    .where("title", "contains_ci", "hardened")
    .orderBy("priority", "desc")
    .limit(20)
    .get();

  console.log("Matched:", page.docs.length, "nextCursor:", page.nextCursor);

  // 5. Delete cleanly
  await ref.delete();
} finally {
  // Always release timers, caches, and WebSocket connections on shutdown
  db.dispose();
}`;
export const quickstartDart = `import 'package:vellum_flutter/vellum_flutter.dart';

Future<void> main() async {
  final db = VellumClient(
    endpoint: 'http://localhost:8080',
    projectId: const String.fromEnvironment('VELLUM_PROJECT_ID'),
    apiKey: const String.fromEnvironment('VELLUM_API_KEY'),
  );

  try {
    final ref = db.collection('tasks').doc('task_01');

    // 1. Create or overwrite with atomic serverTimestamp
    await ref.set({
      'title': 'Ship hardened docs',
      'status': 'open',
      'priority': 1,
      'tags': ['docs', 'launch'],
      'createdAt': FieldOp.serverTimestamp(),
    });

    // 2. Read back with version metadata
    final snap = await ref.get();
    print('Loaded: \${snap.id} v\${snap.version} \${snap.data()}');

    // 3. Patch atomically with optimistic concurrency (ifVersion)
    await ref.update(
      {
        'priority': FieldOp.increment(1),
        'tags': FieldOp.arrayUnion(['verified']),
      },
      ifVersion: snap.version,
    );

    // 4. Query using any of the 13 supported operators
    final page = await db
        .collection('tasks')
        .where('status', '==', 'open')
        .where('tags', 'array-contains', 'launch')
        .where('title', 'contains_ci', 'hardened')
        .orderBy('priority', dir: 'desc')
        .limit(20)
        .get();

    print('Matched: \${page.docs.length}, nextCursor: \${page.nextCursor}');

    // 5. Delete cleanly
    await ref.delete();
  } finally {
    // Always close auth refresh timers, WebSocket channels, and caches
    db.dispose();
  }
}`;
