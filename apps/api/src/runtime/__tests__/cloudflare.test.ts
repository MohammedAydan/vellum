import { afterEach, describe, expect, it } from "vitest";
import { handleWorkerRealtimeUpgrade } from "../cloudflare.js";
import type { createEdgePlatform } from "../edge-platform.js";

type Platform = ReturnType<typeof createEdgePlatform>;
type Listener = (event: { data: string | ArrayBuffer }) => void;

interface FakeSocket {
  accepted: boolean;
  sent: string[];
  closed: boolean;
  listeners: Listener[];
  accept(): void;
  send(message: string): void;
  close(): void;
  addEventListener(type: "message", listener: Listener): void;
}

function makeSocket(): FakeSocket {
  return {
    accepted: false,
    sent: [],
    closed: false,
    listeners: [],
    accept() {
      this.accepted = true;
    },
    send(message: string) {
      this.sent.push(message);
    },
    close() {
      this.closed = true;
    },
    addEventListener(_type: "message", listener: Listener) {
      this.listeners.push(listener);
    },
  };
}

const frameCalls: unknown[] = [];
let sendFrame: ((frame: unknown) => void) | null = null;

function fakePlatform(): Platform {
  return {
    realtimeHub: {
      createConnectionSession: (callback: (frame: unknown) => void) => {
        sendFrame = callback;
        return {
          connectionId: "conn_test",
          handleClientFrame: async (raw: unknown) => {
            frameCalls.push(raw);
          },
          setSimulatedBackpressureBytes: () => undefined,
          close: () => undefined,
        };
      },
    },
  } as unknown as Platform;
}

const originalPair = (globalThis as { WebSocketPair?: unknown }).WebSocketPair;

afterEach(() => {
  (globalThis as { WebSocketPair?: unknown }).WebSocketPair = originalPair;
  frameCalls.length = 0;
  sendFrame = null;
});

describe("Cloudflare Worker runtime - realtime bridge", () => {
  it("accepts a WebSocketPair and reuses the shared hub session", async () => {
    const client = makeSocket();
    const server = makeSocket();
    (globalThis as { WebSocketPair?: unknown }).WebSocketPair = class {
      0 = client;
      1 = server;
    };

    const request = new Request("https://api.example.com/v1/realtime", {
      headers: { Origin: "https://app.example.com", Upgrade: "websocket" },
    });
    const response = handleWorkerRealtimeUpgrade(
      request,
      { CORS_ALLOWED_ORIGINS: "https://app.example.com" } as never,
      fakePlatform()
    );

    expect([101, 200]).toContain(response.status);
    expect(server.accepted).toBe(true);
    expect(sendFrame).not.toBeNull();

    sendFrame?.({ type: "initial_sync" });
    expect(server.sent).toEqual(['{"type":"initial_sync"}']);

    server.listeners[0]?.({ data: '{"type":"subscribe"}' });
    await Promise.resolve();
    expect(frameCalls).toEqual([{ type: "subscribe" }]);
  });

  it("rejects disallowed origins before upgrading", () => {
    const request = new Request("https://api.example.com/v1/realtime", {
      headers: { Origin: "https://evil.example.com", Upgrade: "websocket" },
    });
    const response = handleWorkerRealtimeUpgrade(
      request,
      { CORS_ALLOWED_ORIGINS: "https://app.example.com" } as never,
      fakePlatform()
    );
    expect(response.status).toBe(403);
  });
});
