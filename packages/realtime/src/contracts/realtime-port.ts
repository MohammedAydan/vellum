/**
 * @vellum/realtime - Canonical Realtime Port Contracts
 */

import type { ServerFrame } from "@vellum/api-contract";
import type { OutboxEvent, StorageAdapter, TenantContext } from "@vellum/storage";
import type { ConnectionSession, ConnectionSessionHandle } from "../types.js";
import type { OutboxPollerStats } from "../outbox-poller.js";

/** Outbound PostgreSQL LISTEN/NOTIFY pub/sub port. */
export interface RealtimePubSubPort {
  publish(channel: string, payload: string): Promise<void>;
  subscribe(channel: string, handler: (payload: string) => void): Promise<() => void>;
  close(): Promise<void>;
}

/** Minimal session state inspected by the outbox poller for tenant discovery and eviction. */
export interface RealtimeSessionDescriptor {
  readonly authenticated: boolean;
  readonly closed: boolean;
  /** Epoch ms when the connection opened, when known. */
  readonly connectedAt?: number | undefined;
  readonly projectId: string | null;
}

/** Outbound fan-out sink port satisfied by `RealtimeGatewayHub` and lightweight test doubles. */
export interface RealtimeEventSink {
  notifyCommittedEvents(projectId: string, events: OutboxEvent[]): Promise<void>;
  readonly connections?: ReadonlyMap<string, RealtimeSessionDescriptor> | undefined;
}

/** Optional storage adapter capability exposing a monotonic in-memory outbox sequence watermark. */
export interface OutboxSeqReadable {
  readonly outboxSeq: bigint;
}

/** Type guard narrowing a `StorageAdapter` to `OutboxSeqReadable` without unsafe structural casts. */
export function isOutboxSeqReadable(
  store: StorageAdapter
): store is StorageAdapter & OutboxSeqReadable {
  return "outboxSeq" in store && typeof store.outboxSeq === "bigint";
}

/** Inbound durable outbox poller port. */
export interface OutboxPollerPort {
  readonly stats: OutboxPollerStats;
  start(): Promise<void>;
  stop(): Promise<void>;
  getWatermark(projectId: string): bigint | null;
  handleNotification(payload: string): void;
  discoverTenants(): TenantContext[];
}

/** Inbound WebSocket realtime gateway port implemented by `RealtimeGatewayHub`. */
export interface RealtimeGatewayPort extends RealtimeEventSink {
  readonly connections: ReadonlyMap<string, ConnectionSession>;
  readonly watermarks: ReadonlyMap<string, bigint>;
  createConnectionSession(sendFrameCallback: (frame: ServerFrame) => void): ConnectionSessionHandle;
  handleClientFrame(connectionId: string, rawFrame: unknown): Promise<void>;
  notifyCommittedEvents(projectId: string, events: OutboxEvent[]): Promise<void>;
}
