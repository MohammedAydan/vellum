import { describe, expect, it } from "vitest";
import { SseSocket, toRealtimeSseUrl } from "../realtime/sse-socket.js";

describe("toRealtimeSseUrl", () => {
  it.each([
    ["https://api.example.com", "https://api.example.com/v1/realtime/stream"],
    ["https://api.example.com/", "https://api.example.com/v1/realtime/stream"],
    ["wss://api.example.com/v1/realtime", "https://api.example.com/v1/realtime/stream"],
    ["ws://localhost:8080/v1/realtime", "http://localhost:8080/v1/realtime/stream"],
    ["https://api.example.com/v1/realtime/stream", "https://api.example.com/v1/realtime/stream"],
    ["wss://api.example.com/v1/realtime#", "https://api.example.com/v1/realtime/stream"],
  ])("normalizes %s", (input, expected) => {
    const out = toRealtimeSseUrl(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(":0/");
    expect(out).not.toContain("#");
  });
});

function sseResponse(chunks: string[], hold = false) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    text: async () => "",
    body: {
      getReader: () => ({
        read: async () => {
          if (i < chunks.length) return { done: false, value: encoder.encode(chunks[i++]) };
          if (hold) return new Promise<never>(() => undefined);
          return { done: true };
        },
        cancel: async () => undefined,
      }),
    },
  };
}

describe("SseSocket", () => {
  it("opens a stream with auth + subscriptions, forwards frames, answers pings, tracks seqId for resume", async () => {
    const bodies: Array<{ frames: Array<Record<string, unknown>> }> = [];
    const fetchFn = async (_url: string, init: Record<string, unknown>) => {
      bodies.push(JSON.parse(init["body"] as string));
      if (bodies.length === 1) {
        return sseResponse(
          ['data: {"type":"auth_ack","status":"authenticated","connectionId":"c"}\n\n'],
          true
        );
      }
      return sseResponse(
        [
          'data: {"type":"auth_ack","status":"authenticated","connectionId":"c2"}\n\n',
          'id: 7\ndata: {"type":"mutation","subId":"s1","seqId":7,"operation":"create","document":{}}\n\n',
          ": keep-alive\n\n",
        ],
        true
      );
    };
    const received: Array<Record<string, unknown>> = [];
    const socket = new SseSocket("wss://h.example/v1/realtime", { fetchFn: fetchFn as never });
    socket.onmessage = (e) => received.push(JSON.parse(e.data as string));
    await new Promise<void>((r) => {
      socket.onopen = () => r();
    });
    socket.send(JSON.stringify({ type: "auth", projectId: "p", apiKey: "k" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(received.map((f) => f["type"])).toEqual(["auth_ack"]);
    socket.send(JSON.stringify({ type: "ping", ts: 5 }));
    expect(received.at(-1)).toMatchObject({ type: "pong", ts: 5 });
    socket.send(JSON.stringify({ type: "subscribe", subId: "s1", path: "items/a" }));
    await new Promise((r) => setTimeout(r, 40));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.frames.map((f) => f["type"])).toEqual(["auth", "subscribe"]);
    // the renewed stream's auth_ack is internal and not forwarded again
    expect(received.filter((f) => f["type"] === "auth_ack")).toHaveLength(1);
    expect(received.some((f) => f["type"] === "mutation" && f["seqId"] === 7)).toBe(true);
    // adding another subscription resumes s1 from its last seqId
    socket.send(JSON.stringify({ type: "subscribe", subId: "s2", path: "items/b" }));
    await new Promise((r) => setTimeout(r, 40));
    expect(bodies[2]!.frames.find((f) => f["subId"] === "s1")).toMatchObject({ resumeSeqId: 7 });
    socket.close();
  });

  it("reports HTTP failures as an error frame and closes so the transport backs off", async () => {
    const fetchFn = async () => ({
      ok: false,
      status: 401,
      body: null,
      text: async () => JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "bad key" } }),
    });
    const socket = new SseSocket("https://h.example", { fetchFn: fetchFn as never });
    const frames: Array<Record<string, unknown>> = [];
    socket.onmessage = (e) => frames.push(JSON.parse(e.data as string));
    const closed = new Promise<{ code?: number }>((r) => {
      socket.onclose = r;
    });
    await new Promise<void>((r) => {
      socket.onopen = () => r();
    });
    socket.send(JSON.stringify({ type: "auth", projectId: "p", apiKey: "k" }));
    expect((await closed).code).toBe(1008);
    expect(frames[0]).toMatchObject({ type: "error", code: "UNAUTHENTICATED" });
  });

  it("renews the stream on a server reconnect event without losing resume position", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return calls === 1
        ? sseResponse(['data: {"type":"auth_ack","status":"authenticated","connectionId":"c"}\n\n', "event: reconnect\ndata: {}\n\n"])
        : sseResponse([], true);
    };
    const socket = new SseSocket("https://h.example", { fetchFn: fetchFn as never });
    let closedCalled = false;
    socket.onclose = () => {
      closedCalled = true;
    };
    await new Promise<void>((r) => {
      socket.onopen = () => r();
    });
    socket.send(JSON.stringify({ type: "auth", projectId: "p", apiKey: "k" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(2);
    expect(closedCalled).toBe(false);
    socket.close();
  });
});

describe("SseSocket stall detection", () => {
  it("closes a stream that goes silent so the transport can reconnect", async () => {
    const fetchFn = async () => sseResponse([": stream-open\n\n"], true);
    const socket = new SseSocket("https://api.example.com/v1/realtime", { fetchFn: fetchFn as never, stallTimeoutMs: 60, restartDebounceMs: 0 });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.onclose = (e: { code: number; reason: string }) => resolve(e);
    });
    await new Promise((r) => setTimeout(r, 5));
    socket.send(JSON.stringify({ type: "auth", projectId: "p", apiKey: "k" }));
    const e = await closed;
    expect(e.reason).toBe("stream stalled");
  });
});
