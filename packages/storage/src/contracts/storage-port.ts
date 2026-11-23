/**
 * @vellum/storage - Canonical Storage Port Contracts
 */

import type { StorageAdapter, TxHandle, TenantContext, OutboxEvent } from "../types.js";
import type {
  CacheInvalidationMessage,
  TtlCache,
  TtlCacheOptions,
} from "../cache.js";

/** Outbound storage port implemented by Memory, PostgreSQL, and Neon adapters. */
export type StorageAdapterPort = StorageAdapter;

/** Transaction-scoped storage port passed inside `withTransaction`. */
export type TxHandlePort = TxHandle;

/** Outbound durable outbox read port. */
export interface OutboxPort {
  queryOutboxSince(ctx: TenantContext, afterSeqId?: string): Promise<OutboxEvent[]>;
}

/** Bounded in-process TTL cache port. */
export type BoundedCachePort<V> = TtlCache<V>;
export type BoundedCachePortOptions = TtlCacheOptions;

/** Cross-instance cache invalidation bus port (e.g. PostgreSQL LISTEN/NOTIFY). */
export interface CacheInvalidationBusPort {
  publish(message: CacheInvalidationMessage): Promise<void>;
  close(): Promise<void>;
  isListening(): boolean;
}
