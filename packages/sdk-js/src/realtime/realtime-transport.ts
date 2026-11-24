/**
 * @vellumdb/sdk-js - Native RFC 6455 Realtime Transport 
 *
 * Node: the `ws` package. Browser: the global `WebSocket`.
 * PostgreSQL-native server. Single multiplexed connection, auth handshake, heartbeat,
 * bounded offline queue, per-subscription resume watermarks and decorrelated-jitter reconnect.
 */

import { computeDecorrelatedJitterMs } from "../core/backoff.js";
import { safeJsonParse } from "../core/safe-json.js";

/** A protocol frame. Frame contents are validated at the boundary by `decodeRealtimeFrame`. */
export interface RealtimeFrame {
  type: string;
  [key: string]: unknown;
}

/** Minimal structural WebSocket surface shared by `ws` and the browser global. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: unknown }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike | Promise<WebSocketLike>;

export interface RealtimeAuthMaterial {
  projectId: string;
  apiKey: string;
  authToken?: string;
}

export interface RealtimeSubscriptionTarget {
  resolveIncludes?: boolean;
  include?: unknown[];
  path?: string;
  query?: unknown;
}

interface TrackedSubscription {
  target: RealtimeSubscriptionTarget;
  lastSeqId: number | null;
}

export type RealtimeTransportState = "idle" | "connecting" | "authenticated" | "reconnecting" | "closed";

export interface RealtimeTransportOptions {
  /** Fully-qualified ws(s) URL, e.g. `ws://localhost:8080/v1/realtime`. */
  url: string;
  /** Produces the canonical `auth` frame payload (token may be async). */
  auth: () => Promise<RealtimeAuthMaterial> | RealtimeAuthMaterial;
  /** Called for every validated server frame. */
  onFrame: (frame: RealtimeFrame) => void;
  /** Called for transport-level faults (not protocol `error` frames). */
  onError?: ((error: unknown) => void) | null;
  /** Called whenever the transport transitions between connection states. */
  onStateChange?: ((state: RealtimeTransportState, previousState: RealtimeTransportState) => void) | null;
  /** Test seam / browser override. Defaults to `ws` in Node, global WebSocket in browsers. */
  webSocketFactory?: WebSocketFactory | null;
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxOutboundQueueSize?: number;
  randomFn?: (() => number) | null;
}

const OPEN = 1;
const DEFAULT_HEARTBEAT_MS = 25_000;
const DEFAULT_PONG_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTBOUND_QUEUE = 1_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSeqId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function dataToText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder("utf-8").decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new TextDecoder("utf-8").decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  return null;
}

/**
 * Close a socket whose listeners are no longer needed. `ws` (Node) emits an
 * asynchronous `error` event when close() races a still-CONNECTING socket;
 * with every listener detached that event crashes the host process. Swallow
 * late errors on intentionally closed sockets.
 */
function closeSocketQuietly(socket: WebSocketLike, code?: number, reason?: string): void {
  detachSocketListeners(socket);
  socket.onerror = () => {
    // Intentional close: swallow the async CONNECTING-close error emitted by `ws`.
  };
  try {
    socket.close(code, reason);
  } catch {
    // best effort
  }
}

function detachSocketListeners(socket: WebSocketLike): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
}

/** Decode a WebSocket message payload into a prototype-safe validated protocol frame. */
export function decodeRealtimeFrame(data: unknown): RealtimeFrame | null {
  const text = dataToText(data);
  if (text === null) return null;
  try {
    const parsed: unknown = safeJsonParse(text);
    if (!isRecord(parsed) || typeof parsed["type"] !== "string") return null;
    return parsed as RealtimeFrame;
  } catch {
    return null;
  }
}

/** Encode a protocol frame for WebSocket transport. */
export function encodeRealtimeFrame(frame: RealtimeFrame): string {
  return JSON.stringify(frame);
}

/** Convert an arbitrary endpoint into the canonical realtime WebSocket URL. */
export function toRealtimeUrl(endpoint: string): string {
  let value = endpoint.replace(/\/+$/, "");
  if (/^ws:\/\//i.test(value) || /^wss:\/\//i.test(value)) {
    return /\/v1\/realtime$/.test(value) ? value : `${value}/v1/realtime`;
  }
  value = value.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
  return /\/v1\/realtime$/.test(value) ? value : `${value}/v1/realtime`;
}

function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && typeof process.versions?.node === "string";
}

export async function defaultWebSocketFactory(url: string): Promise<WebSocketLike> {
  if (!isNodeRuntime()) {
    const GlobalWebSocket = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
    if (typeof GlobalWebSocket !== "function") {
      throw new Error("@vellumdb/sdk-js: no WebSocket implementation available in this runtime");
    }
    return new GlobalWebSocket(url);
  }
  // Resolved lazily, through a non-literal specifier, so bundlers (webpack, Vite,
  // esbuild, Metro) never try to resolve `node:module` for browser builds.
  const globalCtor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  try {
    const specifier = ["node", "module"].join(":");
    const { createRequire } = (await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)) as {
      createRequire: (url: string) => (id: string) => unknown;
    };
    const nodeRequire = createRequire(import.meta.url);
    const wsModule = nodeRequire("ws") as { WebSocket: new (url: string) => WebSocketLike };
    return new wsModule.WebSocket(url);
  } catch (error: unknown) {
    // Runtimes that report a Node-like `process` but cannot load `ws` (some edge
    // and serverless hosts) still ship a global WebSocket.
    if (typeof globalCtor === "function") return new globalCtor(url);
    throw error;
  }
}

interface TransportInternalState {
  socket: WebSocketLike | null;
  stateValue: RealtimeTransportState;
  lastReconnectDelayMs: number;
  outboundQueue: string[];
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connectTimer: ReturnType<typeof setTimeout> | null;
  lastPongAt: number;
  intentionallyClosed: boolean;
  connectWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

/**
 * A single multiplexed realtime connection with reconnect/resume semantics.
 */
export class RealtimeTransport {
  private readonly url: string;
  private readonly auth: RealtimeTransportOptions["auth"];
  private readonly onFrame: RealtimeTransportOptions["onFrame"];
  private readonly onError: ((error: unknown) => void) | null;
  private readonly onStateChange:
    | ((state: RealtimeTransportState, previousState: RealtimeTransportState) => void)
    | null;
  private readonly factoryOverride: WebSocketFactory | null;
  private readonly randomFn: () => number;
  private readonly heartbeatIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly maxOutboundQueueSize: number;
  private readonly subscriptions = new Map<string, TrackedSubscription>();
  private readonly internal: TransportInternalState;

  public constructor(options: RealtimeTransportOptions) {
    this.url = options.url;
    this.auth = options.auth;
    this.onFrame = options.onFrame;
    this.onError = options.onError ?? null;
    this.onStateChange = options.onStateChange ?? null;
    this.factoryOverride = options.webSocketFactory ?? null;
    this.randomFn = options.randomFn ?? Math.random;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.maxOutboundQueueSize = Math.max(1, options.maxOutboundQueueSize ?? DEFAULT_MAX_OUTBOUND_QUEUE);
    this.internal = {
      socket: null,
      stateValue: "idle",
      lastReconnectDelayMs: RECONNECT_BASE_MS,
      outboundQueue: [],
      heartbeatTimer: null,
      reconnectTimer: null,
      connectTimer: null,
      lastPongAt: 0,
      intentionallyClosed: false,
      connectWaiters: [],
    };
    Object.freeze(this);
  }

  public get state(): RealtimeTransportState {
    return this.internal.stateValue;
  }

  /** Safe JSON representation that never exposes auth material or queued frames. */
  public toJSON(): { url: string; state: RealtimeTransportState; subscriptions: number } {
    return {
      url: this.url,
      state: this.internal.stateValue,
      subscriptions: this.subscriptions.size,
    };
  }

  /** Safe string representation. */
  public toString(): string {
    return `RealtimeTransport(url=${this.url}, state=${this.internal.stateValue}, subscriptions=${this.subscriptions.size})`;
  }

  private setState(next: RealtimeTransportState): void {
    if (this.internal.stateValue === next) return;
    const previous = this.internal.stateValue;
    this.internal.stateValue = next;
    if (this.onStateChange) {
      try {
        this.onStateChange(next, previous);
      } catch {
        // A misbehaving listener must not break transport state transitions.
      }
    }
  }

  /** Open the socket, authenticate, and resolve once `auth_ack` is received. */
  public connect(): Promise<void> {
    if (this.internal.stateValue === "authenticated") return Promise.resolve();
    if (this.internal.intentionallyClosed) {
      return Promise.reject(new Error("@vellumdb/sdk-js: realtime transport is closed"));
    }
    return new Promise<void>((resolve, reject) => {
      this.internal.connectWaiters.push({ resolve, reject });
      if (this.internal.stateValue === "idle" || this.internal.stateValue === "reconnecting") {
        this.clearReconnectTimer();
        void this.openSocket();
      }
    });
  }

  /** Register a subscription. Frames are (re)sent with a resume watermark after reconnect. */
  public subscribe(subId: string, target: RealtimeSubscriptionTarget, resumeSeqId: number | null = null): void {
    if (this.internal.intentionallyClosed) return;
    const isNew = !this.subscriptions.has(subId);
    this.subscriptions.set(subId, { target, lastSeqId: resumeSeqId });
    if (this.internal.stateValue === "authenticated") {
      this.writeFrame({
        type: "subscribe",
        subId,
        ...target,
        ...(isNew && resumeSeqId !== null ? { resumeSeqId } : {}),
      });
    } else if (this.internal.stateValue === "idle") {
      // `resubscribeAll()` sends this after auth_ack; just kick off the connection.
      void this.connect().catch(() => undefined);
    }
  }

  public unsubscribe(subId: string): void {
    this.subscriptions.delete(subId);
    if (this.internal.intentionallyClosed) return;
    if (this.internal.stateValue === "authenticated") {
      this.writeFrame({ type: "unsubscribe", subId });
    }
    // When offline/reconnecting, removing from `this.subscriptions` is sufficient:
    // `resubscribeAll()` will not re-register it on reconnect.
  }

  /**
   * Re-send the auth frame on an already-authenticated connection after the
   * bearer rotates. The server re-verifies it and replies with `auth_ack`.
   */
  public reauthenticate(): void {
    if (this.internal.intentionallyClosed || this.internal.stateValue !== "authenticated") return;
    const currentSocket = this.internal.socket;
    if (!currentSocket) return;
    void this.performAuth(currentSocket).catch((error: unknown) => {
      if (this.onError) this.onError(error);
    });
  }

  /** Send a frame now or queue it until authentication completes. */
  public send(frame: RealtimeFrame): void {
    if (this.internal.intentionallyClosed) return;
    if (this.internal.stateValue === "authenticated") {
      this.writeFrame(frame);
    } else {
      this.enqueue(frame);
      if (this.internal.stateValue === "idle") void this.connect().catch(() => undefined);
    }
  }

  /** Permanently close the transport (no reconnect) and release all timers/listeners/queues. */
  public close(): void {
    this.internal.intentionallyClosed = true;
    this.clearHeartbeat();
    this.clearReconnectTimer();
    this.clearConnectTimer();
    this.subscriptions.clear();
    this.internal.outboundQueue = [];
    this.flushWaitersReject(new Error("@vellumdb/sdk-js: realtime transport closed before authentication"));
    const socket = this.internal.socket;
    this.internal.socket = null;
    this.setState("closed");
    if (socket) {
      closeSocketQuietly(socket, 1000, "client closed");
    }
  }

  private async openSocket(): Promise<void> {
    if (this.internal.intentionallyClosed) return;
    this.setState("connecting");
    this.clearConnectTimer();
    this.internal.connectTimer = setTimeout(() => {
      if (this.internal.stateValue === "connecting") {
        this.failConnection(new Error("@vellumdb/sdk-js: realtime connection timed out"));
      }
    }, this.connectTimeoutMs);
    this.internal.connectTimer.unref?.();

    let socket: WebSocketLike;
    try {
      if (this.factoryOverride) {
        // Only yield when the factory is async, so synchronous factories attach handlers in the same tick.
        const made = this.factoryOverride(this.url);
        socket = typeof (made as Promise<WebSocketLike>).then === "function" ? await made : (made as WebSocketLike);
      } else {
        socket = await defaultWebSocketFactory(this.url);
      }
    } catch (error: unknown) {
      this.failConnection(error);
      return;
    }

    if (this.internal.intentionallyClosed) {
      closeSocketQuietly(socket, 1000, "client closed");
      return;
    }

    this.internal.socket = socket;
    this.internal.lastPongAt = Date.now();

    socket.onopen = () => {
      if (this.internal.socket !== socket || this.internal.intentionallyClosed) return;
      void this.performAuth(socket).catch((error: unknown) => this.failConnection(error));
    };

    socket.onmessage = (event: { data: unknown }) => {
      if (this.internal.socket !== socket || this.internal.intentionallyClosed) return;
      const frame = decodeRealtimeFrame(event.data);
      if (!frame) return;
      this.handleFrame(frame);
    };

    socket.onerror = (event: unknown) => {
      if (this.internal.socket !== socket || this.internal.intentionallyClosed) return;
      if (this.onError) this.onError(event);
    };

    socket.onclose = (event: { code?: number; reason?: unknown }) => {
      if (this.internal.socket !== socket) return;
      detachSocketListeners(socket);
      this.internal.socket = null;
      this.clearConnectTimer();
      this.clearHeartbeat();
      if (this.internal.intentionallyClosed) return;
      // 1008 = policy violation (e.g. bad auth) — retrying with same credentials
      // is still correct because getAuthToken may mint a fresh token.
      this.setState("reconnecting");
      this.flushWaitersReject(
        new Error(`@vellumdb/sdk-js: realtime connection closed (code ${String(event.code ?? 1006)})`)
      );
      this.scheduleReconnect();
    };
  }

  private async performAuth(targetSocket: WebSocketLike): Promise<void> {
    const material = await this.auth();
    if (this.internal.intentionallyClosed || this.internal.socket !== targetSocket) return;
    const authFrame: RealtimeFrame = {
      type: "auth",
      projectId: material.projectId,
      apiKey: material.apiKey,
      ...(material.authToken !== undefined ? { authToken: material.authToken } : {}),
    };
    this.writeFrame(authFrame);
  }

  private handleFrame(frame: RealtimeFrame): void {
    if (frame["type"] === "auth_ack") {
      this.clearConnectTimer();
      this.setState("authenticated");
      this.internal.lastReconnectDelayMs = RECONNECT_BASE_MS;
      this.internal.lastPongAt = Date.now();
      this.startHeartbeat();
      this.flushOutboundQueue();
      this.resubscribeAll();
      this.flushWaitersResolve();
      return;
    }
    if (frame["type"] === "pong") {
      this.internal.lastPongAt = Date.now();
      return;
    }

    const subId = typeof frame["subId"] === "string" ? frame["subId"] : null;
    const seqNum = parseSeqId(frame["seqId"]);
    if (subId !== null && seqNum !== null) {
      const tracked = this.subscriptions.get(subId);
      if (tracked && (tracked.lastSeqId === null || seqNum > tracked.lastSeqId)) {
        tracked.lastSeqId = seqNum;
      }
    }
    this.onFrame(frame);
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.internal.heartbeatTimer = setInterval(() => {
      const socket = this.internal.socket;
      if (!socket || socket.readyState !== OPEN || this.internal.stateValue !== "authenticated") return;
      if (Date.now() - this.internal.lastPongAt > this.pongTimeoutMs) {
        // Dead/half-open socket: proactively detach, transition to reconnecting,
        // and schedule backoff even if `socket.close()` never fires `onclose`.
        closeSocketQuietly(socket, 1001, "heartbeat timeout");
        this.internal.socket = null;
        this.clearHeartbeat();
        this.setState("reconnecting");
        this.scheduleReconnect();
        return;
      }
      this.writeFrame({ type: "ping", ts: Date.now() });
    }, this.heartbeatIntervalMs);
    this.internal.heartbeatTimer.unref?.();
  }

  private resubscribeAll(): void {
    for (const [subId, tracked] of this.subscriptions.entries()) {
      this.writeFrame({
        type: "subscribe",
        subId,
        ...tracked.target,
        ...(tracked.lastSeqId !== null ? { resumeSeqId: tracked.lastSeqId } : {}),
      });
    }
  }

  private writeFrame(frame: RealtimeFrame): void {
    if (this.internal.intentionallyClosed) return;
    const socket = this.internal.socket;
    if (!socket || socket.readyState !== OPEN) {
      if (frame.type !== "ping" && frame.type !== "auth") {
        this.enqueue(frame);
      }
      return;
    }
    try {
      socket.send(encodeRealtimeFrame(frame));
    } catch {
      if (frame.type !== "ping" && frame.type !== "auth") {
        this.enqueue(frame);
      }
    }
  }

  private enqueue(frame: RealtimeFrame): void {
    if (this.internal.intentionallyClosed) return;
    this.internal.outboundQueue.push(encodeRealtimeFrame(frame));
    if (this.internal.outboundQueue.length > this.maxOutboundQueueSize) {
      this.internal.outboundQueue = this.internal.outboundQueue.slice(
        this.internal.outboundQueue.length - this.maxOutboundQueueSize
      );
    }
  }

  private flushOutboundQueue(): void {
    if (this.internal.outboundQueue.length === 0) return;
    const pending = this.internal.outboundQueue;
    this.internal.outboundQueue = [];
    for (let i = 0; i < pending.length; i += 1) {
      const socket = this.internal.socket;
      const item = pending[i];
      if (item === undefined) continue;
      if (!socket || socket.readyState !== OPEN) {
        this.internal.outboundQueue = pending.slice(i).concat(this.internal.outboundQueue);
        if (this.internal.outboundQueue.length > this.maxOutboundQueueSize) {
          this.internal.outboundQueue = this.internal.outboundQueue.slice(
            this.internal.outboundQueue.length - this.maxOutboundQueueSize
          );
        }
        return;
      }
      try {
        socket.send(item);
      } catch {
        this.internal.outboundQueue = pending.slice(i).concat(this.internal.outboundQueue);
        if (this.internal.outboundQueue.length > this.maxOutboundQueueSize) {
          this.internal.outboundQueue = this.internal.outboundQueue.slice(
            this.internal.outboundQueue.length - this.maxOutboundQueueSize
          );
        }
        return;
      }
    }
  }

  private failConnection(error: unknown): void {
    if (this.internal.socket) {
      const socket = this.internal.socket;
      this.internal.socket = null;
      closeSocketQuietly(socket);
    }
    this.clearConnectTimer();
    this.clearHeartbeat();
    this.flushWaitersReject(error);
    if (!this.internal.intentionallyClosed) {
      this.setState("reconnecting");
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.internal.intentionallyClosed || this.internal.reconnectTimer) return;
    const delay = computeDecorrelatedJitterMs(
      this.internal.lastReconnectDelayMs,
      RECONNECT_BASE_MS,
      RECONNECT_MAX_MS,
      this.randomFn
    );
    this.internal.lastReconnectDelayMs = delay;
    this.internal.reconnectTimer = setTimeout(() => {
      this.internal.reconnectTimer = null;
      if (!this.internal.intentionallyClosed) void this.openSocket();
    }, delay);
    this.internal.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.internal.reconnectTimer) {
      clearTimeout(this.internal.reconnectTimer);
      this.internal.reconnectTimer = null;
    }
  }

  private clearConnectTimer(): void {
    if (this.internal.connectTimer) {
      clearTimeout(this.internal.connectTimer);
      this.internal.connectTimer = null;
    }
  }

  private clearHeartbeat(): void {
    if (this.internal.heartbeatTimer) {
      clearInterval(this.internal.heartbeatTimer);
      this.internal.heartbeatTimer = null;
    }
  }

  private flushWaitersResolve(): void {
    const waiters = this.internal.connectWaiters;
    this.internal.connectWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  private flushWaitersReject(error: unknown): void {
    const waiters = this.internal.connectWaiters;
    this.internal.connectWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }
}
