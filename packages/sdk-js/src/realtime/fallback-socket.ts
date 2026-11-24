/**
 * @vellumdb/sdk-js - WebSocket-first realtime socket with automatic SSE fallback
 *
 * WebSocket stays the primary transport. When the connection cannot be
 * established (the host or a proxy refuses the upgrade; the client
 * runtime has no WebSocket; a proxy drops it before the first server frame), the
 * socket switches to `SseSocket` (HTTP streaming) and replays the auth frame and
 * active subscriptions. The decision is remembered per host for a few minutes so
 * later reconnects skip the failing upgrade.
 */

import type { WebSocketFactory, WebSocketLike } from "./realtime-transport.js";
import { SseSocket, type SseSocketOptions } from "./sse-socket.js";

const STICKY_MS = 10 * 60_000;
const DEFAULT_WS_OPEN_TIMEOUT_MS = 4_000;
const stickyFallback = new Map<string, number>();

function hostKey(url: string): string {
  try {
    return new URL(url.replace(/^ws(s?):\/\//i, "http$1://")).host;
  } catch {
    return url;
  }
}

/** Test helper: forget which hosts fell back to SSE. */
export function resetRealtimeFallbackCache(): void {
  stickyFallback.clear();
}

export interface FallbackSocketOptions {
  /** Creates the primary WebSocket. May throw or reject when WebSocket is unsupported. */
  webSocketFactory: (url: string) => WebSocketLike | Promise<WebSocketLike>;
  sse?: SseSocketOptions;
  /** How long to wait for the WebSocket to open before falling back. */
  openTimeoutMs?: number;
  /** Called once when the socket falls back to SSE. */
  onFallback?: (reason: unknown) => void;
}

class FallbackSocket implements WebSocketLike {
  public readyState = 0;
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public onclose: ((event: { code?: number; reason?: unknown }) => void) | null = null;

  private inner: WebSocketLike | null = null;
  private mode: "ws" | "sse" = "ws";
  private opened = false;
  private gotMessage = false;
  private closed = false;
  private authRaw: string | null = null;
  private readonly subsRaw = new Map<string, string>();
  private openTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    private readonly url: string,
    private readonly options: FallbackSocketOptions
  ) {}

  /** Starts in WebSocket mode (or SSE directly for hosts known to refuse upgrades). */
  public async start(): Promise<void> {
    const until = stickyFallback.get(hostKey(this.url));
    if (until !== undefined && until > Date.now()) {
      this.useSse("remembered: host does not support WebSocket");
      return;
    }
    try {
      const ws = await this.options.webSocketFactory(this.url);
      this.attach(ws);
      this.openTimer = setTimeout(() => {
        if (this.mode === "ws" && !this.opened) this.useSse(new Error("WebSocket open timed out"));
      }, this.options.openTimeoutMs ?? DEFAULT_WS_OPEN_TIMEOUT_MS);
      this.openTimer.unref?.();
    } catch (error: unknown) {
      this.useSse(error);
    }
  }

  private attach(socket: WebSocketLike): void {
    this.inner = socket;
    socket.onopen = (event) => {
      if (this.inner !== socket) return;
      this.clearOpenTimer();
      const reopening = this.opened;
      this.opened = true;
      this.readyState = 1;
      if (this.mode === "sse" && reopening) {
        this.replay();
        return;
      }
      this.onopen?.(event);
    };
    socket.onmessage = (event) => {
      if (this.inner !== socket) return;
      this.gotMessage = true;
      this.onmessage?.(event);
    };
    socket.onerror = (event) => {
      if (this.inner !== socket) return;
      if (this.mode === "ws" && !this.gotMessage) {
        this.useSse(event);
        return;
      }
      this.onerror?.(event);
    };
    socket.onclose = (event) => {
      if (this.inner !== socket) return;
      if (this.mode === "ws" && !this.gotMessage && !this.closed) {
        this.useSse(event);
        return;
      }
      this.readyState = 3;
      this.onclose?.(event);
    };
  }

  private useSse(reason: unknown): void {
    if (this.mode === "sse" || this.closed) return;
    this.mode = "sse";
    this.clearOpenTimer();
    stickyFallback.set(hostKey(this.url), Date.now() + STICKY_MS);
    const old = this.inner;
    this.inner = null;
    if (old) {
      old.onopen = old.onmessage = old.onclose = null;
      old.onerror = () => undefined;
      try {
        old.close(1000, "falling back to SSE");
      } catch {
        // best effort
      }
    }
    try {
      this.options.onFallback?.(reason);
    } catch {
      // listener errors must not break the transport
    }
    this.attach(new SseSocket(this.url, this.options.sse));
  }

  private replay(): void {
    const inner = this.inner;
    if (!inner) return;
    try {
      if (this.authRaw) inner.send(this.authRaw);
      for (const raw of this.subsRaw.values()) inner.send(raw);
    } catch {
      // the transport will reconnect on the next close
    }
  }

  public send(data: string): void {
    if (this.readyState !== 1 || !this.inner) throw new Error("socket is not open");
    try {
      const frame = JSON.parse(data) as { type?: string; subId?: string };
      if (frame.type === "auth") this.authRaw = data;
      else if (frame.type === "subscribe" && typeof frame.subId === "string") this.subsRaw.set(frame.subId, data);
      else if (frame.type === "unsubscribe" && typeof frame.subId === "string") this.subsRaw.delete(frame.subId);
    } catch {
      // not JSON: forward untouched
    }
    this.inner.send(data);
  }

  public close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearOpenTimer();
    this.readyState = 3;
    const inner = this.inner;
    this.inner = null;
    if (inner) {
      inner.onerror = () => undefined;
      try {
        inner.close(code, reason);
      } catch {
        // best effort
      }
    }
  }

  private clearOpenTimer(): void {
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
  }
}

/** Factory for `RealtimeTransport`: WebSocket first, SSE when WebSocket cannot be used. */
export function createFallbackSocketFactory(options: FallbackSocketOptions): WebSocketFactory {
  return (url: string) => {
    const socket = new FallbackSocket(url, options);
    // start() is async (the default Node WebSocket loads lazily); the transport awaits the factory.
    return socket.start().then(() => socket) as unknown as WebSocketLike;
  };
}
