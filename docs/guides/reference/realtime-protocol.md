---
title: Realtime WebSocket Protocol
order: 3
group: Reference
description: Canonical client/server frames, auth handshake, subscribe/resume, watermarks, gap detection and connection limits for /v1/realtime.
---

# Realtime WebSocket Protocol

The realtime gateway is a native RFC 6455 WebSocket endpoint at:

```text
wss://<host>/v1/realtime
```

Implementation sources: `packages/api-contract/src/schemas/realtime.ts` (canonical frame schemas), `packages/realtime/src/hub.ts`, `outbox-poller.ts`, `pg-notify-pubsub.ts`, `types.ts`, and `apps/api/src/ws-rfc6455.ts` (transport).

:::warning Naming discrepancy between code and the older narrative doc
`docs/05-http-and-realtime-api.md` describes an earlier vocabulary: `auth_ok`, `sub_ack` (`mode: "initial_sync"\|"resumed"`), `change` (`changeType: added/modified/removed`), and `sync_complete`. The **canonical frame names are those in the `@vellum/api-contract` Zod schemas and the live hub**: `auth_ack`, `initial_sync`, `mutation` (`operation: create/update/delete`), `resume_complete`, `error`, `pong`. This page and the SDKs use the canonical names. The older doc also mentions Redis Pub/Sub; per the Zero-Redis doctrine broker is **revoked** — delivery is PostgreSQL `LISTEN/NOTIFY` plus a durable outbox poller.
:::

## Connection & lifecycle

| Stage | Behavior |
| :--- | :--- |
| Upgrade | `GET /v1/realtime` with standard WS headers. Requires `Sec-WebSocket-Key` and version `13`. Wrong path → `404`; bad handshake → `400`. |
| Origin check | A missing `Origin` is accepted (native clients). A present `Origin` must match the CORS allowlist (`CORS_ALLOWED_ORIGINS`), otherwise `403 Forbidden`. An empty allowlist fails closed for browser clients. |
| Per-IP cap | 50 concurrent connections per client IP → `429 Too Many Requests` beyond that. |
| Auth deadline | Code default: **5,000 ms** to send a valid `auth` frame (`DEFAULT_AUTH_TIMEOUT_MS`), then an `error` frame `UNAUTHENTICATED` and close 1008. The older narrative doc says 10,000 ms — the code value is authoritative. |
| Frame size | 1 MiB hard cap per inbound frame, enforced before allocation. Oversized → `PAYLOAD_TOO_LARGE` and close 1009 (`MAX_WS_FRAME_BYTES`). |
| Heartbeat / idle | Server sends a WS-level ping every 30,000 ms; one outstanding ping must be answered within the 30,000 ms idle window, else close 1000. Application-level `ping`/`pong` JSON frames are also supported. |
| Outbound backpressure | 1 MiB cap (`MAX_WS_OUTBOUND_BUFFER_BYTES`). Exceeding it emits `errorSLOW_CONSUMER_DISCONNECT` and closes 1008. |

A client must authenticate before any other operation; sending `subscribe`/`unsubscribe` first raises `UNAUTHENTICATED` (delivered as an `error` frame by the transport).

## Client → server frames

Defined by `ClientFrameSchema` (discriminated union on `type`).

| `type` | Fields | Purpose |
| :--- | :--- | :--- |
| `subscribe` | `subId` (min 1), `path?` (document path) **or** `query?` (`QuerySpec`), `resumeSeqId?` (non-negative int) | Subscribe to one document or a collection query. Exactly one of `path`/`query` is required; supplying `resumeSeqId` replays outbox events after that sequence. |
| `unsubscribe` | `subId` (min 1) | Stop a subscription. |
| `ping` | `ts` (number) | Application heartbeat; answered by `pong`. |

```json
{ "type": "auth", "projectId": "prj_...", "apiKey": "sk_...", "authToken": "<jwt>" }
{ "type": "subscribe", "subId": "sub_1", "path": "users/u_123" }
{ "type": "subscribe", "subId": "sub_2", "query": { "collectionPath": "users", "limit": 50 }, "resumeSeqId": 1042 }
{ "type": "ping", "ts": 1794753000123 }
```

Auth validation: the API key is verified and must belong to the addressed project (`PERMISSION_DENIED` otherwise); `authToken` is verified via `verifyEndUserJwt`. The server replies with `auth_ack`.

## Server → client frames

Defined by `ServerFrameSchema` (discriminated union on `type`).

| `type` | Fields | Meaning |
| :--- | :--- | :--- |
| `auth_ack` | `status:"authenticated"`, `connectionId` | Auth succeeded. |
| `initial_sync` | `subId`, `seqId` (number), `documents: DocumentPayload[]` | Current matching documents for a fresh subscribe. `seqId` is the current outbox watermark. |
| `mutation` | `subId`, `seqId` (number), `operation:"create"\|"update"\|"delete"`, `document: DocumentPayload` | A committed change matching the subscription (document-path or query membership transition). |
| `resume_complete` | `subId`, `seqId` (string), `count` (int), `truncated` (bool) | Sent after `resumeSeqId` replay finishes; `seqId` is the last delivered sequence. `truncated` means the replay cap was hit. |
| `error` | `subId?`, `code` (canonical error code), `message` | Protocol/subscription error. Transport-level auth timeouts use `subId:"connection"`. |
| `pong` | `ts`, `serverTs` | Reply to an application `ping`. |

```json
{ "type": "auth_ack", "status": "authenticated", "connectionId": "conn_..." }
{ "type": "initial_sync", "subId": "sub_1", "seqId": 1042, "documents": [ /* DocumentPayload[] */ ] }
{ "type": "mutation", "subId": "sub_1", "seqId": 1043, "operation": "update", "document": { /* DocumentPayload */ } }
{ "type": "resume_complete", "subId": "sub_2", "seqId": "1042", "count": 7, "truncated": false }
{ "type": "error", "subId": "sub_3", "code": "PERMISSION_DENIED", "message": "..." }
```

A `DocumentPayload` is `{ path, collectionPath, collectionGroup, documentId, data, version, createdAt, updatedAt, sizeBytes? }` (matches `DocumentPayloadSchema`). The SDKs map `operation` → change type `create → added`, `update → modified`, `delete → removed`.

## Subscription rules & authorization

| Subscription kind | Validation | Rules operation checked |
| :--- | :--- | :--- |
| `path` | `parseDocumentPath` | `get` on the path |
| `query` | `validateAndNormalizeQuery` | `list` on `<collectionPath>/__ws_sub__` |

Both use the active ruleset for the authenticated project plus the API key scopes. A failed check emits an `error` frame with the error code and does not register the subscription.

## Watermarks, resume & gap detection

Delivery is durable and ordered; there is no in-memory-only broker.

1. **Outbox.** Every committed document mutation writes a row to `realtime_outbox` with a monotonic `seq_id` per `(projectId)`.
2. **Wake-up.** PostgreSQL `LISTEN/NOTIFY` on the canonical channel delivers a compact payload `{seqId, projectId, projectId}`. `LISTEN` uses one dedicated, non-pooled client.
3. **Poll fallback.** `OutboxPoller` also polls every 1,000 ms and fetches full rows from the tenant-scoped storage adapter in batches of 500, so a missing NOTIFY never loses events.
4. **Gap detection.** Each tenant keeps one watermark. If a notification's observed seq is greater than `watermark + 1`, a gap is recorded and the catch-up query is run from the watermark; the hub re-fans missed rows in order. `seq ≤ watermark` is never re-delivered (dedupe between NOTIFY and poll is exact at the subscription boundary via `seenSeqIds`).
5. **Fresh subscribe.** `initial_sync` carries the current watermark as `seqId`.
6. **Resume.** `subscribe` with `resumeSeqId` walks the outbox after that value (max 5,000 events per replay, 500-row query batches), then emits `resume_complete`. Live events that arrive during the replay are buffered and flushed afterwards in ascending seq order, so the client observes replay-then-live with no interleaving. `truncated:true` tells the client the replay cap was hit.

The SDKs track the highest `seqId` per subscription and automatically include it as `resumeSeqId` when resubscribing after reconnect. Note that `initial_sync`/`mutation` carry `seqId` as a **number**, while `resume_complete` carries it as a **string** (wire compatibility).

## Error & limit codes

| Condition | Code | HTTP-equivalent |
| :--- | :--- | :--- |
| Auth frame missing/expired | `UNAUTHENTICATED` | 401 |
| Key/project mismatch, rules denial | `PERMISSION_DENIED` | 403 |
| >50 subscriptions on one connection | `SUBSCRIPTION_LIMIT_EXCEEDED` | 400 |
| Outbound buffer >1 MiB | `SLOW_CONSUMER_DISCONNECT` | 429 |
| Inbound frame >1 MiB | `PAYLOAD_TOO_LARGE` | 413 |
| Bad frame / unknown opcode | `INVALID_ARGUMENT` | 400 |

See [Errors](./errors.md) for the full canonical set.

## Quick cross-reference

- HTTP data-plane equivalents: [REST Data Plane](./rest-data-plane.md)
- JS SDK realtime seams (`webSocketFactory`, `realtimeHub`): [JavaScript SDK](../sdks/javascript.md)
- Flutter realtime streams: [Flutter SDK](../sdks/flutter.md)
- Architecture narrative: [Deployment & Operations](../../06-deployment-and-operations.md)
