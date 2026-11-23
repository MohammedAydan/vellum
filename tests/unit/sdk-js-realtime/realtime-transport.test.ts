/**
 * Unit tests for @vellumdb/sdk-js native realtime transport .
 * Uses an in-memory fake WebSocket — no network, no Redis.
 */
import { describe, it, expect } from "vitest";
import {
  RealtimeTransport,
  decodeRealtimeFrame,
  encodeRealtimeFrame,
  toRealtimeUrl,
  type RealtimeFrame,
  type WebSocketFactory,
  type WebSocketLike,
} from "../../../packages/sdk-js/src/realtime-transport.js";

class FakeSocket implements WebSocketLike {
  public readyState = 0;
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public onclose: ((event: { code?: number; reason?: unknown }) => void) | null = null;
  public readonly sent: RealtimeFrame[] = [];
  public closed = false;

  constructor(public readonly url: string) {}

  public open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  public receive(frame: RealtimeFrame): void {
    this.onmessage?.({ data: encodeRealtimeFrame(frame) });
  }

  public send(data: string): void {
    const frame = decodeRealtimeFrame(data);
    if (frame) this.sent.push(frame);
  }

  public close(): void {
    this.closed = true;
    this.readyState = 3;
  }
}

function createFakeFactory(): { factory: WebSocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory: WebSocketFactory = (url: string) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function happyAuth(): { projectId: string; apiKey: string } {
  return { projectId: "p1", apiKey: "pk_test" };
}

describe("sdk-js realtime frame codec & URL", () => {
  it("encodes/decodes frames and rejects malformed payloads", () => {
    const frame: RealtimeFrame = { type: "subscribe", subId: "s1", path: "users/u1" };
    expect(decodeRealtimeFrame(encodeRealtimeFrame(frame))).toEqual(frame);
    expect(decodeRealtimeFrame("not json")).toBeNull();
    expect(decodeRealtimeFrame(JSON.stringify({ nope: 1 }))).toBeNull();
    expect(decodeRealtimeFrame(12345)).toBeNull();
  });

  it("converts http(s) and ws(s) endpoints to the canonical realtime URL", () => {
    expect(toRealtimeUrl("http://localhost:8080")).toBe("ws://localhost:8080/v1/realtime");
    expect(toRealtimeUrl("https://api.example.com/")).toBe("wss://api.example.com/v1/realtime");
    expect(toRealtimeUrl("ws://host:9000")).toBe("ws://host:9000/v1/realtime");
    expect(toRealtimeUrl("wss://host/v1/realtime")).toBe("wss://host/v1/realtime");
  });
});

describe("sdk-js RealtimeTransport", () => {
  it("performs auth handshake then flushes queued subscribes", async () => {
    const { factory, sockets } = createFakeFactory();
    const frames: RealtimeFrame[] = [];
    const transport = new RealtimeTransport({
      url: "ws://local/v1/realtime",
      auth: happyAuth,
      onFrame: (frame) => frames.push(frame),
      webSocketFactory: factory,
    });

    const connecting = transport.connect();
    await waitFor(() => sockets.length === 1);
    const socket = sockets[0]!;
    expect(socket.url).toBe("ws://local/v1/realtime");

    // Subscribe while connecting — must be queued behind auth.
    transport.subscribe("s1", { path: "users/u1" });
    socket.open();
    await waitFor(() => socket.sent.some((f) => f.type === "auth"));
    expect(socket.sent[0]).toMatchObject({
      type: "auth",
      projectId: "p1",
      apiKey: "pk_test",
    });

    socket.receive({ type: "auth_ack", status: "authenticated", connectionId: "c1" });
    await connecting;
    expect(transport.state).toBe("authenticated");
    expect(socket.sent.some((f) => f.type === "subscribe" && f.subId === "s1")).toBe(true);

    transport.close();
  });

  it("sends application-level heartbeat pings after auth", async () => {
    const { factory, sockets } = createFakeFactory();
    const transport = new RealtimeTransport({
      url: "ws://local/v1/realtime",
      auth: happyAuth,
      onFrame: () => undefined,
      webSocketFactory: factory,
      heartbeatIntervalMs: 20,
      pongTimeoutMs: 1000,
    });
    const connecting = transport.connect();
    await waitFor(() => sockets.length === 1);
    const socket = sockets[0]!;
    socket.open();
    socket.receive({ type: "auth_ack", status: "authenticated", connectionId: "c1" });
    await connecting;

    await waitFor(() => socket.sent.some((f) => f.type === "ping"));
    expect(socket.sent.find((f) => f.type === "ping")?.["ts"]).toEqual(expect.any(Number));
    transport.close();
  });

  it("reconnects with jittered backoff and resumes from the last sequence id", async () => {
    const { factory, sockets } = createFakeFactory();
    const transport = new RealtimeTransport({
      url: "ws://local/v1/realtime",
      auth: happyAuth,
      onFrame: () => undefined,
      webSocketFactory: factory,
      randomFn: () => 0.02, // 10ms reconnect delay
      heartbeatIntervalMs: 10_000,
    });
    const connecting = transport.connect();
    await waitFor(() => sockets.length === 1);
    const first = sockets[0]!;
    first.open();
    first.receive({ type: "auth_ack", status: "authenticated", connectionId: "c1" });
    await connecting;
    transport.subscribe("s1", { query: { collectionPath: "tickets" } });
    first.receive({ type: "mutation", subId: "s1", seqId: 7, operation: "create", document: { path: "tickets/t1" } });

    // Server drops the connection.
    first.onclose?.({ code: 1006 });
    await waitFor(() => sockets.length === 2);
    const second = sockets[1]!;
    second.open();
    second.receive({ type: "auth_ack", status: "authenticated", connectionId: "c2" });
    await waitFor(() => second.sent.some((f) => f.type === "subscribe" && f.subId === "s1"));
    const resubscribe = second.sent.find((f) => f.type === "subscribe" && f.subId === "s1");
    expect(resubscribe).toMatchObject({ subId: "s1", resumeSeqId: 7 });
    transport.close();
  });
});
