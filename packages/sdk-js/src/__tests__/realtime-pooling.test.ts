import { describe, expect, it } from "vitest";
import { createClient, type WebSocketLike } from "../index.js";

class MockSocket implements WebSocketLike {
  public readyState = 1;
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public onclose: ((event: { code?: number; reason?: unknown }) => void) | null = null;
  public readonly sent: string[] = [];
  public send(data: string): void { this.sent.push(data); }
  public close(): void { this.readyState = 3; this.onclose?.({}); }
  public receive(frame: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  public subs(): string[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((f) => f["type"] === "subscribe").map((f) => String(f["subId"]));
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Recipe 4.1 (P0-1 / P1-4): one socket for <= 25 subscriptions, automatic pooling beyond, 30/30 delivered.
describe("realtime WS multiplexing and pooling", () => {
  it("uses 1 socket for 20 subscriptions, 2 for 30, and delivers 30/30", async () => {
    const sockets: MockSocket[] = [];
    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      realtimeTransport: "websocket",
      webSocketFactory: () => { const s = new MockSocket(); sockets.push(s); return s; },
    });
    const got = new Map<number, number>();
    const errors: unknown[] = [];
    const offs: Array<() => void> = [];
    const opened = new Set<MockSocket>();
    const open = async (): Promise<void> => {
      for (const s of sockets) if (!opened.has(s)) s.onopen?.({});
      await tick();
      for (const s of sockets) if (!opened.has(s)) { opened.add(s); s.receive({ type: "auth_ack" }); }
      await tick();
    };
    for (let i = 0; i < 20; i += 1) {
      offs.push(db.doc(`chats/c${i}`).onSnapshot(() => { got.set(i, (got.get(i) ?? 0) + 1); }, (e) => errors.push(e)));
    }
    await tick();
    await open();
    expect(sockets).toHaveLength(1);
    for (let i = 20; i < 30; i += 1) {
      offs.push(db.doc(`chats/c${i}`).onSnapshot(() => { got.set(i, (got.get(i) ?? 0) + 1); }, (e) => errors.push(e)));
    }
    await tick();
    await open();
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.subs()).toHaveLength(25);
    expect(sockets[1]!.subs()).toHaveLength(5);
    // Every subscription gets its initial_sync on the socket that carries it.
    for (const s of sockets) {
      for (const subId of s.subs()) s.receive({ type: "initial_sync", subId, seqId: 1, documents: [] });
    }
    expect(errors).toHaveLength(0);
    expect(got.size).toBe(30);
    for (const off of offs) off();
  });

  it("surfaces SUBSCRIPTION_LIMIT_EXCEEDED once the pool cap is reached", async () => {
    const sockets: MockSocket[] = [];
    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      realtimeTransport: "websocket",
      realtimeTransportOptions: { maxSockets: 1 },
      webSocketFactory: () => { const s = new MockSocket(); sockets.push(s); return s; },
    } as never);
    const errors: Array<{ code?: string }> = [];
    for (let i = 0; i < 26; i += 1) db.doc(`chats/c${i}`).onSnapshot(() => undefined, (e) => errors.push(e as { code?: string }));
    await tick();
    expect(sockets.length).toBeLessThanOrEqual(1);
    expect(errors.map((e) => e.code)).toEqual(["SUBSCRIPTION_LIMIT_EXCEEDED"]);
  });
});
