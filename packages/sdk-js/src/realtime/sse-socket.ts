/**
 * @vellumdb/sdk-js - Server-Sent Events realtime socket
 *
 * Some networks, proxies and runtimes cannot use WebSocket. `SseSocket` implements
 * the `WebSocketLike` surface on top of a streaming `fetch` to
 * `POST /v1/realtime/stream`, so `RealtimeTransport` (auth handshake,
 * heartbeat, resume watermarks, backoff with jitter) works unchanged.
 *
 * The endpoint is stateless: each stream request carries the auth frame and all
 * active subscriptions. When subscriptions change (or the server ends a stream
 * after its bounded lifetime) the socket opens a new stream, passing the last
 * seen `seqId` of each subscription as `resumeSeqId` so no event is lost.
 */

import type { WebSocketLike } from "./realtime-transport.js";

type FetchLike = (input: string, init: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
  text(): Promise<string>;
}>;

export interface SseSocketOptions {
  fetchFn?: FetchLike | null;
  /** Delay that batches several subscribe/unsubscribe frames into one stream request. */
  restartDebounceMs?: number;
  /**
   * Abort the stream when no bytes (including the server's 15s keep-alive comments) arrive for
   * this long. A stalled or half-open stream otherwise looks connected forever. Default 45s.
   */
  stallTimeoutMs?: number;
}

/** Converts a realtime WebSocket or HTTP URL into the SSE stream URL (no `:0`, no `#`). */
export function toRealtimeSseUrl(url: string): string {
  const parsed = new URL(url.replace(/^ws(s?):\/\//i, "http$1://"));
  parsed.hash = "";
  parsed.search = "";
  let path = parsed.pathname.replace(/\/+$/, "");
  path = path.replace(/\/v1\/realtime(\/stream)?$/, "");
  parsed.pathname = `${path}/v1/realtime/stream`;
  return parsed.toString();
}

type Frame = Record<string, unknown>;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

export class SseSocket implements WebSocketLike {
  public readyState = CONNECTING;
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public onclose: ((event: { code?: number; reason?: unknown }) => void) | null = null;

  private readonly url: string;
  private readonly fetchFn: FetchLike | null;
  private readonly stallTimeoutMs: number;
  private readonly debounceMs: number;
  private authFrame: Frame | null = null;
  private readonly subs = new Map<string, Frame>();
  private readonly lastSeq = new Map<string, number>();
  private controller: AbortController | null = null;
  private generation = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private ackForwarded = false;
  private streamOpen = false;

  public constructor(url: string, options: SseSocketOptions = {}) {
    this.url = toRealtimeSseUrl(url);
    this.fetchFn = options.fetchFn ?? null;
    this.debounceMs = options.restartDebounceMs ?? 5;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 45_000;
    // A macrotask, so a caller that awaits the factory still attaches handlers before `open`.
    setTimeout(() => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      this.onopen?.({});
    }, 0);
  }

  public send(data: string): void {
    if (this.readyState !== OPEN) throw new Error("SseSocket is not open");
    let frame: Frame;
    try {
      frame = JSON.parse(data) as Frame;
    } catch {
      return;
    }
    switch (frame["type"]) {
      case "auth": {
        const reauth = this.authFrame !== null;
        this.authFrame = frame;
        if (reauth) {
          // Fresh credentials: the server clears subscriptions on auth, so open a new stream.
          this.ackForwarded = true;
          this.scheduleRestart();
        } else {
          this.scheduleRestart(0);
        }
        return;
      }
      case "subscribe": {
        const subId = frame["subId"];
        if (typeof subId !== "string") return;
        const { resumeSeqId, ...rest } = frame;
        if (typeof resumeSeqId === "number" && !this.lastSeq.has(subId)) this.lastSeq.set(subId, resumeSeqId);
        this.subs.set(subId, rest);
        if (this.authFrame) this.scheduleRestart();
        return;
      }
      case "unsubscribe": {
        const subId = frame["subId"];
        if (typeof subId !== "string") return;
        this.subs.delete(subId);
        this.lastSeq.delete(subId);
        if (this.authFrame) this.scheduleRestart();
        return;
      }
      case "ping": {
        if (this.streamOpen) {
          this.emit({ type: "pong", ts: frame["ts"], serverTs: Date.now() });
        }
        return;
      }
      default:
        return;
    }
  }

  public close(code = 1000, reason = ""): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.generation += 1;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.controller?.abort();
    this.controller = null;
    this.onclose?.({ code, reason });
  }

  private emit(frame: Frame): void {
    if (this.readyState !== OPEN) return;
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  private scheduleRestart(delay: number = this.debounceMs): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.startStream();
    }, delay);
  }

  private buildFrames(): Frame[] {
    const frames: Frame[] = [this.authFrame as Frame];
    for (const [subId, sub] of this.subs) {
      const seq = this.lastSeq.get(subId);
      frames.push(seq !== undefined ? { ...sub, resumeSeqId: seq } : sub);
    }
    return frames;
  }

  private fail(generation: number, code: number, reason: string): void {
    if (generation !== this.generation || this.readyState !== OPEN) return;
    this.generation += 1;
    this.streamOpen = false;
    this.controller?.abort();
    this.controller = null;
    this.readyState = CLOSED;
    this.onclose?.({ code, reason });
  }

  private async startStream(): Promise<void> {
    if (this.readyState !== OPEN || !this.authFrame) return;
    this.controller?.abort();
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.streamOpen = false;
    // Plain-function call (no receiver) so browsers do not throw "Illegal invocation".
    const fetchFn = this.fetchFn ?? (globalThis.fetch ? ((input, init) => globalThis.fetch(input, init)) as FetchLike : undefined);
    if (typeof fetchFn !== "function") {
      this.fail(generation, 1011, "fetch is not available");
      return;
    }
    try {
      const response = await fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ frames: this.buildFrames() }),
        signal: controller.signal,
      });
      if (generation !== this.generation) return;
      if (!response.ok || !response.body) {
        let message = `HTTP ${response.status}`;
        let code = "INTERNAL_ERROR";
        try {
          const parsed = JSON.parse(await response.text()) as { error?: { code?: string; message?: string }; code?: string; message?: string };
          code = parsed.error?.code ?? parsed.code ?? code;
          message = parsed.error?.message ?? parsed.message ?? message;
        } catch {
          // keep defaults
        }
        this.emit({ type: "error", code, message });
        this.fail(generation, 1008, message);
        return;
      }
      this.streamOpen = true;
      let lastBytesAt = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastBytesAt > this.stallTimeoutMs) {
          clearInterval(watchdog);
          this.fail(generation, 1006, "stream stalled");
        }
      }, Math.max(5, Math.min(10_000, Math.floor(this.stallTimeoutMs / 3))));
      (watchdog as { unref?: () => void }).unref?.();
      try {
        await this.readStream(response.body.getReader(), generation, () => { lastBytesAt = Date.now(); });
      } finally {
        clearInterval(watchdog);
      }
    } catch (error: unknown) {
      if (generation !== this.generation) return;
      this.onerror?.(error);
      this.fail(generation, 1006, error instanceof Error ? error.message : "stream error");
    }
  }

  private async readStream(
    reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> },
    generation: number,
    onBytes: () => void
  ): Promise<void> {
    try {
      const decoder = new TextDecoder();
      let buffer = "";
      let renew = false;
      for (;;) {
        const { done, value } = await reader.read();
        onBytes();
        if (generation !== this.generation) {
          void reader.cancel().catch(() => undefined);
          return;
        }
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let idx = buffer.indexOf("\n\n");
        while (idx >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf("\n\n");
          if (this.handleBlock(block)) renew = true;
        }
      }
      if (generation !== this.generation) return;
      this.streamOpen = false;
      if (renew) {
        // Bounded server lifetime reached: continue seamlessly with resume.
        this.ackForwarded = true;
        void this.startStream();
      } else {
        this.fail(generation, 1006, "stream ended");
      }
    } finally {
      // nothing to release here; the caller owns the watchdog
    }
  }

  /** Returns true when the block asks the client to renew the stream. */
  private handleBlock(block: string): boolean {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (event === "reconnect") return true;
    if (dataLines.length === 0) return false;
    let frame: Frame;
    try {
      frame = JSON.parse(dataLines.join("\n")) as Frame;
    } catch {
      return false;
    }
    if (frame["type"] === "auth_ack") {
      // Internal stream renewals must not re-trigger the transport's resubscribe.
      if (this.ackForwarded) return false;
      this.ackForwarded = true;
    }
    const subId = frame["subId"];
    const seq = frame["seqId"];
    const seqNum = typeof seq === "number" ? seq : typeof seq === "string" && /^\d+$/.test(seq) ? Number(seq) : null;
    if (typeof subId === "string" && seqNum !== null && this.subs.has(subId)) {
      const prev = this.lastSeq.get(subId);
      // A mutation at or below the last seq already delivered for this subscription is a replay (for example
      // after a stream renewal): drop it so listeners see each change once.
      if (frame["type"] === "mutation" && prev !== undefined && seqNum <= prev) return false;
      if (prev === undefined || seqNum > prev) this.lastSeq.set(subId, seqNum);
    }
    this.emit(frame);
    return false;
  }
}
