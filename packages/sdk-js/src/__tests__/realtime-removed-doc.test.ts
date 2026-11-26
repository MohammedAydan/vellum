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
  it("reports exists=false and null data for a deleted document", async () => {
    const sockets: MockSocket[] = [];
    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      webSocketFactory: () => { const s = new MockSocket(); sockets.push(s); return s; },
    });
    const seen: Array<{ type: string; exists: boolean; data: unknown }> = [];
    const off = db.doc("chats/c1").onSnapshot((snap) => {
      for (const c of snap.changes) seen.push({ type: c.type, exists: c.doc.exists, data: c.doc.data() });
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
    expect(seen[0]).toMatchObject({ type: "added", exists: true });
    expect(seen[1]).toEqual({ type: "removed", exists: false, data: null });
    off();
  });
});
