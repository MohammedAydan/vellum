// Examples for the Advanced configuration page. They mirror the public SDK
// surface of @vellumdb/sdk-js and vellum_flutter 0.0.7.

export const autoIdTs = `// doc() without an id creates a new 20-character, time-sortable id locally.
// No network call is made until you write.
const ref = db.collection("tasks").doc();
console.log(ref.id); // e.g. "0mhx3k9b2q7f4a1c8d5e"
await ref.set({ title: "Write docs" });

// add() is the same thing in one step.
const created = await db.collection("tasks").add({ title: "Ship it" });`;

export const autoIdDart = `// doc() without an id creates a new 20-character, time-sortable id locally.
final ref = db.collection('tasks').doc();
print(ref.id);
await ref.set({'title': 'Write docs'});

// add() is the same thing in one step.
final created = await db.collection('tasks').add({'title': 'Ship it'});`;

export const authTs = `// Defaults: the session is stored for you and refreshed about 60 s before expiry
// and again on a 401. You do not need to configure anything.
const db = createClient({ endpoint, projectId, apiKey });

// Bring your own identity provider token:
db.setCustomToken(tokenFromYourBackend); // used as the bearer
db.setCustomToken(null); // back to the VELLUM session

// Manage tokens yourself (for example in a short-lived worker):
const manual = createClient({ endpoint, projectId, apiKey, autoRefresh: false });
await manual.auth.getIdToken(true); // an explicit refresh still works`;

export const authDart = `// Defaults: works out of the box. The session lives in memory and is refreshed
// about 60 s before expiry and again on a 401.
final db = VellumClient(endpoint: 'https://api.example.com', projectId: 'PROJECT_ID', apiKey: 'API_KEY');

// Bring your own identity provider token:
db.setCustomToken(tokenFromYourBackend);
db.setCustomToken(null); // back to the VELLUM session

// Manage tokens yourself:
final manual = VellumClient(
  endpoint: 'https://api.example.com', projectId: 'PROJECT_ID', apiKey: 'API_KEY',
  autoRefresh: false,
);`;

export const secureStorageDart = `// Optional: only if you want your own storage instead of the built-in encrypted storage.
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

class SecureAuthTokenStorage implements AuthTokenStorage {
  final _store = const FlutterSecureStorage();

  @override
  Future<String?> readAccessToken() => _store.read(key: 'vellum_access_token');
  @override
  Future<void> writeAccessToken(String? token) async => token == null
      ? _store.delete(key: 'vellum_access_token')
      : _store.write(key: 'vellum_access_token', value: token);
  @override
  Future<String?> readRefreshToken() => _store.read(key: 'vellum_refresh_token');
  @override
  Future<void> writeRefreshToken(String? token) async => token == null
      ? _store.delete(key: 'vellum_refresh_token')
      : _store.write(key: 'vellum_refresh_token', value: token);
  @override
  Future<Map<String, Object?>?> readUser() async {
    final raw = await _store.read(key: 'vellum_user');
    if (raw == null) return null;
    final decoded = jsonDecode(raw);
    return decoded is Map ? decoded.cast<String, Object?>() : null;
  }
  @override
  Future<void> writeUser(Map<String, Object?>? user) async => user == null
      ? _store.delete(key: 'vellum_user')
      : _store.write(key: 'vellum_user', value: jsonEncode(user));
}

final db = VellumClient(
  endpoint: 'https://api.example.com', projectId: 'PROJECT_ID', apiKey: 'API_KEY',
  authTokenStorage: SecureAuthTokenStorage(),
);
await db.auth.restore(); // once at startup`;

export const cacheTs = `// Default is "networkFirst": always try the network, and if the device is offline
// return the stored copy with metadata.fromCache === true.
const db = createClient({ endpoint, projectId, apiKey, cachePolicy: "networkFirst" });

// Override per read:
const fast = await ref.get({ cachePolicy: "cacheFirst" }); // fresh copy (5 min) else network
const live = await ref.get({ cachePolicy: "networkOnly" });
const offline = await ref.get({ cachePolicy: "cacheOnly" }); // miss => exists === false

// Tune or replace the store:
createClient({
  endpoint, projectId, apiKey,
  cache: { cacheTtlMs: 60_000, maxCacheSizeBytes: 50 * 1024 * 1024 },
  // cache: { store: false }  // turn the store off
  // cache: { store: myDocStore }  // your own DocStore
});`;

export const cacheDart = `// Default is CachePolicy.networkFirst with a bounded in-memory store.
final db = VellumClient(
  endpoint: 'https://api.example.com', projectId: 'PROJECT_ID', apiKey: 'API_KEY',
  cachePolicy: CachePolicy.networkFirst,
  cacheTtl: const Duration(minutes: 5),
);

final fast = await ref.get(cachePolicy: CachePolicy.cacheFirst);
final live = await ref.get(cachePolicy: CachePolicy.networkOnly);

// Persist to disk by implementing DocumentCacheStore, then:
// VellumClient(..., cacheStore: MyDiskCacheStore());
// Or turn the cache off: VellumClient(..., enableCache: false);`;

export const relationsTs = `// A reference value in your data is stored as a tagged reference.
const author = db.doc("users/u1");
const post = await db.collection("posts").add({ title: "Hello", author });

// Create a parent and its children in ONE atomic request (max 100 documents).
const order = await db.collection("orders").addWithRelated(
  { total: 42 },
  { items: { collection: "orderItems", parentField: "order", docs: [{ sku: "a" }, { sku: "b" }] } },
);
// order.items is [ref, ref]; each item has order: ref(order). All or nothing.`;

export const relationsDart = `final author = db.doc('users/u1');
await db.collection('posts').add({'title': 'Hello', 'author': author});

final order = await db.collection('orders').addWithRelated(
  {'total': 42},
  {
    'items': RelatedWrite(
      collection: 'orderItems',
      parentField: 'order',
      docs: [{'sku': 'a'}, {'sku': 'b'}],
    ),
  },
); // all or nothing, at most 100 documents`;

export const realtimeTs = `// Default "auto": WebSocket first, automatic fallback to HTTP streaming (SSE).
const db = createClient({ endpoint, projectId, apiKey });

// Force one transport only if you must:
createClient({ endpoint, projectId, apiKey, realtimeTransport: "websocket" }); // no fallback
createClient({ endpoint, projectId, apiKey, realtimeTransport: "sse" });

const stop = db.collection("tasks").onSnapshot((snap) => console.log(snap.docs.length));`;

export const secureStoragePubspec = `dependencies:
  vellum_flutter: ^0.0.7 # persistent encrypted sessions are built in`;
