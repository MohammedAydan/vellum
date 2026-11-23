/**
 * @vellum/sdk-js - Contract-First SDK Port Interfaces
 *
 * Explicit boundary contracts for HTTP transport, auth session storage,
 * realtime WebSocket transport, and bounded document read caching.
 */

import type { HttpAuthHooks } from "../core/http-transport.js";
import type {
  RealtimeFrame,
  RealtimeSubscriptionTarget,
  RealtimeTransportState,
} from "../realtime/realtime-transport.js";
import type { AuthState } from "../types.js";

/** Port for the hardened HTTP request/retry/auth-refresh transport layer. */
export interface HttpTransportPort {
  setAuthHooks(hooks: HttpAuthHooks): void;
  request<R = unknown>(
    method: string,
    relativePath: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    includeAuth?: boolean,
    signal?: AbortSignal
  ): Promise<R>;
}

/** Port for pluggable end-user authentication session persistence. */
export interface AuthStoragePort {
  load(): AuthState | null;
  save(session: AuthState): void;
  clear(): void;
}

/** Port for multiplexed realtime WebSocket transport with resume watermarks. */
export interface RealtimeTransportPort {
  readonly state: RealtimeTransportState;
  connect(): Promise<void>;
  subscribe(
    subId: string,
    target: RealtimeSubscriptionTarget,
    resumeSeqId?: number | null
  ): void;
  unsubscribe(subId: string): void;
  reauthenticate(): void;
  send(frame: RealtimeFrame): void;
  close(): void;
}

/** Port for bounded LRU + TTL document read caching with targeted invalidation. */
export interface ReadCachePort<V = unknown> {
  readonly size: number;
  get(key: string): V | undefined;
  set(key: string, path: string, value: V): void;
  invalidatePath(path: string): void;
  invalidateCollection(collectionPath: string): void;
  clear(): void;
}
