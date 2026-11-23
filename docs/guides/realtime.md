---
title: Realtime
order: 9
group: Core concepts
description: Multiplexed RFC 6455 WebSocket sync, resumeSeqId gapless replay, decorrelated jitter reconnect, heartbeat, connectionState observability, and onSnapshot/snapshots().
---

# Realtime

VELLUM delivers low-latency document and query updates over a **single multiplexed RFC 6455 WebSocket** backed by PostgreSQL `LISTEN`/`NOTIFY` and a durable outbox sequence log.

---

## Protocol & Transport Guarantees

| Capability | `@vellum/sdk-js` | `vellum_flutter` |
| --- | --- | --- |
| Connection multiplexing | Single `RealtimeTransport` shared across all `onSnapshot` subscriptions | Single `VellumRealtimeTransport` managed by `VellumRealtimeManager` |
| Reconnect backoff | Decorrelated jitter (`500ms` base, `30_000ms` cap) | Decorrelated jitter (`500ms` base, `30_000ms` cap) |
| Gapless resume | Tracks `lastSeqId` per subscription and sends `resumeSeqId` on reconnect | Tracks `lastSeqId` per subscription and sends `resumeSeqId` on reconnect |
| Heartbeat / dead-socket detection | `25s` ping, `60s` pong timeout, `10s` connect timeout | `25s` ping, `60s` pong timeout, `10s` connect timeout |
| Bounded offline queue | `1_000` frames max (configurable via `realtimeTransportOptions`) | `256` frames max (drops oldest when full) |
| Auth token rotation | Automatically sends fresh `auth` frame on live socket (`reauthenticateRealtime`) | Re-resolves bearer token on every reconnect handshake |

---

## Subscribing in TypeScript (`@vellum/sdk-js`)

### Connection State Observability

```ts
console.log(db.connectionState); // "disconnected" | "connecting" | "connected" | "reconnecting"

const offState = db.onConnectionStateChange((next, prev) => {
  updateConnectionBanner(next);
  console.log(`Realtime transition: ${prev} -> ${next}`);
});
```

### Document & Query `onSnapshot`

```ts
// Single document subscription
const offDoc = db.doc("orders/ord_101").onSnapshot(
  (snapshot) => {
    for (const change of snapshot.changes) {
      console.log(change.type, change.seqId, change.doc.data());
    }
  },
  (err) => console.error("Document realtime error:", err)
);

// Query subscription (maintains materialized docs + incremental changes)
const offQuery = db
  .collection("messages")
  .where("roomId", "==", "general")
  .orderBy("createdAt", "desc")
  .limit(50)
  .onSnapshot(
    (snapshot) => {
      console.log("Watermark:", snapshot.watermarkSeqId);
      renderMessages(snapshot.docs);
    },
    (err) => console.error("Query realtime error:", err)
  );

// Unsubscribe when component unmounts; closing the last subscription closes the socket
offDoc();
offQuery();
offState();
```

> **Cache Consistency**: Incoming realtime `initial_sync` and `mutation` frames automatically invalidate the matching path in `BoundedReadCache`.

---

## Subscribing in Flutter / Dart (`vellum_flutter`)

```dart
// Document stream (emits cached snapshot immediately when present, then live frames)
final docSub = client.doc('orders/ord_101').snapshots().listen(
  (DocumentSnapshot<Map<String, dynamic>> snap) {
    print('Order v${snap.version}: ${snap.data()}');
  },
  onError: (Object err) => print('Doc realtime error: $err'),
);

// Query stream via builder or watchCollection() shorthand
final querySub = client
    .collection('messages')
    .where('roomId', '==', 'general')
    .orderBy('createdAt', dir: 'desc')
    .limit(50)
    .snapshots()
    .listen(
      (QuerySnapshot<Map<String, dynamic>> snapshot) {
        print('Watermark: ${snapshot.watermarkSeqId}, docs: ${snapshot.docs.length}');
      },
      onError: (Object err) => print('Query realtime error: $err'),
    );

// Always cancel subscriptions when the widget or controller disposes
await docSub.cancel();
await querySub.cancel();
```

---

## Operational Notes

- **Cursors are excluded from live subscriptions**: Both SDKs automatically strip `startAt`/`startAfter` before sending a WebSocket `subscribe` frame. Use `limit()` + `orderBy()` for bounded live windows.
- **Always unsubscribe & dispose**: Call the returned unsubscribe function (JS) or `StreamSubscription.cancel()` (Dart), and invoke `dispose()` on client teardown.
