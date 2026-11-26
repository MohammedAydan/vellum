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

/**
 * Regression: two concurrent writes to one document can reach a client in the
 * opposite order. A stale update (older version) must not overwrite the newer
 * state already held, otherwise the snapshot stays wrong until the next write.
 */
describe("realtime events that arrive out of order", () => {
  it("ignores an update older than the version already held", async () => {
    const sockets: MockSocket[] = [];
    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      webSocketFactory: () => { const s = new MockSocket(); sockets.push(s); return s; },
    });
    const seen: number[] = [];
    const off = db.collection("chats").where("memberIds", "array-contains", "u1").onSnapshot((snap) => {
      const d = snap.docs.find((x) => x.id === "c1");
      if (d) seen.push((d.data() as { n: number }).n);
    });
    await Promise.resolve();
    const sock = sockets[0]!;
    sock.onopen?.({});
    await Promise.resolve();
    sock.receive({ type: "auth_ack" });
    const sub = sock.sent.map((s) => JSON.parse(s) as Record<string, unknown>).find((f) => f["type"] === "subscribe");
    const subId = String(sub?.["subId"]);
    const doc = (version: number, n: number) => ({ documentId: "c1", path: "chats/c1", version, data: { n } });
    sock.receive({ type: "initial_sync", subId, seqId: 1, documents: [doc(1, 0)] });
    sock.receive({ type: "mutation", subId, seqId: 3, operation: "update", document: doc(3, 2) });
    sock.receive({ type: "mutation", subId, seqId: 2, operation: "update", document: doc(2, 1) });
    expect(seen[seen.length - 1]).toBe(2);
    sock.receive({ type: "mutation", subId, seqId: 4, operation: "update", document: doc(4, 3) });
    expect(seen[seen.length - 1]).toBe(3);
    off();
  });
});
