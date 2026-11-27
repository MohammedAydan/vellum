import { beforeEach, describe, expect, it } from "vitest";
import { createFallbackSocketFactory, resetRealtimeFallbackCache } from "../realtime/fallback-socket.js";
import type { WebSocketLike } from "../realtime/realtime-transport.js";

class FakeWs implements WebSocketLike {
  public readyState = 0;
  public sent: string[] = [];
  public onopen: ((e: unknown) => void) | null = null;
  public onmessage: ((e: { data: unknown }) => void) | null = null;
  public onerror: ((e: unknown) => void) | null = null;
  public onclose: ((e: { code?: number }) => void) | null = null;
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
}

function sseFetch(calls: string[]) {
  return async (_url: string, init: Record<string, unknown>) => {
    calls.push(init["body"] as string);
    return {
      ok: true,
      status: 200,
      text: async () => "",
      body: {
        getReader: () => ({
          read: () => new Promise<never>(() => undefined),
          cancel: async () => undefined,
        }),
      },
    };
  };
}

beforeEach(() => resetRealtimeFallbackCache());

describe("WebSocket-first socket with SSE fallback", () => {
  it("stays on WebSocket when it opens", async () => {
    const ws = new FakeWs();
    const calls: string[] = [];
    const factory = createFallbackSocketFactory({ webSocketFactory: () => ws, sse: { fetchFn: sseFetch(calls) as never } });
    const socket = await factory("wss://h.example/v1/realtime");
    let opened = false;
    socket.onopen = () => (opened = true);
    ws.readyState = 1;
    ws.onopen?.({});
    expect(opened).toBe(true);
    socket.send('{"type":"auth","projectId":"p","apiKey":"k"}');
    expect(ws.sent).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it("falls back to SSE when the WebSocket OPENS but never delivers a frame (proxy stall)", async () => {
    const ws = new FakeWs();
    const calls: string[] = [];
    const factory = createFallbackSocketFactory({
      webSocketFactory: () => ws,
      sse: { fetchFn: sseFetch(calls) as never },
      openTimeoutMs: 30,
    });
    const socket = await factory("wss://stall.example/v1/realtime");
    const opened = new Promise<void>((r) => (socket.onopen = () => r()));
    // The upgrade completes, so onopen fires - but no server frame ever arrives.
    ws.readyState = 1;
    ws.onopen?.({});
    await opened;
    // After the timeout the socket must be in SSE mode anyway: auth frames replay there.
    await new Promise((r) => setTimeout(r, 60));
    socket.send('{"type":"auth","projectId":"p","apiKey":"k"}');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBeGreaterThan(0);
  });

  it("falls back to SSE when the WebSocket errors before opening, and remembers the host", async () => {
    const ws = new FakeWs();
    const calls: string[] = [];
    let wsCreated = 0;
    const factory = createFallbackSocketFactory({
      webSocketFactory: () => {
        wsCreated += 1;
        return ws;
      },
      sse: { fetchFn: sseFetch(calls) as never },
    });
    const socket = await factory("wss://h.example/v1/realtime");
    const opened = new Promise<void>((r) => (socket.onopen = () => r()));
    ws.onerror?.({});
    await opened;
    socket.send('{"type":"auth","projectId":"p","apiKey":"k"}');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!).frames[0].type).toBe("auth");
    // later sockets for the same host go straight to SSE
    await factory("wss://h.example/v1/realtime");
    expect(wsCreated).toBe(1);
  });

  it("falls back when the WebSocket factory throws (unsupported runtime)", async () => {
    const calls: string[] = [];
    const factory = createFallbackSocketFactory({
      webSocketFactory: () => {
        throw new Error("no WebSocket");
      },
      sse: { fetchFn: sseFetch(calls) as never },
    });
    const socket = await factory("wss://other.example/v1/realtime");
    await new Promise<void>((r) => (socket.onopen = () => r()));
    socket.send('{"type":"auth","projectId":"p","apiKey":"k"}');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
  });

  it("falls back and replays auth + subscriptions when the socket closes before any server frame", async () => {
    const ws = new FakeWs();
    const calls: string[] = [];
    const factory = createFallbackSocketFactory({ webSocketFactory: () => ws, sse: { fetchFn: sseFetch(calls) as never } });
    const socket = await factory("wss://third.example/v1/realtime");
    socket.onopen = () => undefined;
    ws.readyState = 1;
    ws.onopen?.({});
    socket.send('{"type":"auth","projectId":"p","apiKey":"k"}');
    socket.send('{"type":"subscribe","subId":"s1","path":"a/b"}');
    ws.onclose?.({ code: 1006 });
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const last = JSON.parse(calls.at(-1)!);
    expect(last.frames.map((f: { type: string }) => f.type)).toEqual(["auth", "subscribe"]);
  });
});
