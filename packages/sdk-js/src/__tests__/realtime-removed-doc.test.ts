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
}

describe("realtime removed documents", () => {
  it("reports exists=false and null data for a deleted document (P0-4 DocumentSnapshot contract)", async () => {
    const sockets: MockSocket[] = [];
    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      webSocketFactory: () => { const s = new MockSocket(); sockets.push(s); return s; },
    });
    const seen: Array<{ exists: boolean; data: unknown }> = [];
    const off = db.doc("chats/c1").onSnapshot((snap) => {
      seen.push({ exists: snap.exists, data: snap.data() });
    });
    await Promise.resolve();
    const sock = sockets[0]!;
    sock.onopen?.({});
    await Promise.resolve();
    sock.receive({ type: "auth_ack" });
    const sub = sock.sent.map((s) => JSON.parse(s) as Record<string, unknown>).find((f) => f["type"] === "subscribe");
    const subId = String(sub?.["subId"]);
    const doc = { documentId: "c1", path: "chats/c1", version: 2, data: { n: 1 } };
    sock.receive({ type: "initial_sync", subId, seqId: 1, documents: [doc] });
    sock.receive({ type: "mutation", subId, seqId: 2, operation: "delete", document: doc });
    expect(seen[0]).toEqual({ exists: true, data: { n: 1 } });
    expect(seen[1]).toEqual({ exists: false, data: null });
    expect(seen).toHaveLength(2);
    off();
  });

  it("emits exists=false for a document missing at initial sync and dedupes state replays", async () => {
    const sockets: MockSocket[] = [];
    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      webSocketFactory: () => { const s = new MockSocket(); sockets.push(s); return s; },
    });
    const seen: Array<{ exists: boolean; data: unknown }> = [];
    const off = db.doc("chats/nope").onSnapshot((snap) => {
      seen.push({ exists: snap.exists, data: snap.data() });
    });
    await Promise.resolve();
    const sock = sockets[0]!;
    sock.onopen?.({});
    await Promise.resolve();
    sock.receive({ type: "auth_ack" });
    const sub = sock.sent.map((s) => JSON.parse(s) as Record<string, unknown>).find((f) => f["type"] === "subscribe");
    const subId = String(sub?.["subId"]);
    // Missing at subscribe time: empty initial_sync still yields exactly one emit.
    sock.receive({ type: "initial_sync", subId, seqId: 1, documents: [] });
    // A replayed identical empty state (SSE reconnect overlap) is deduped.
    sock.receive({ type: "initial_sync", subId, seqId: 1, documents: [] });
    const doc = { documentId: "nope", path: "chats/nope", version: 1, data: { n: 1 } };
    sock.receive({ type: "mutation", subId, seqId: 2, operation: "create", document: doc });
    // Same-version replay of the create is deduped as well.
    sock.receive({ type: "mutation", subId, seqId: 3, operation: "update", document: doc });
    expect(seen).toEqual([
      { exists: false, data: null },
      { exists: true, data: { n: 1 } },
    ]);
    off();
  });
});
