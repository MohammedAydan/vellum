import { describe, it, expect } from "vitest";
import { DataPlaneStore } from "@vellum/storage/adapters";
import type { OutboxEvent } from "@vellum/storage";
import { OutboxPoller } from "../outbox-poller.js";

const P = "11111111-1111-1111-1111-111111111111";
const mk = (n: number): OutboxEvent => ({
  seqId: String(n), projectId: P, collectionPath: "m", path: `m/${n}`, documentId: String(n),
  opType: "created", version: 1, beforeData: null, afterData: { n }, committedAt: new Date().toISOString(),
});

// Recipe 3B: Tx1 holds seq N uncommitted while Tx2 (N+1) commits and NOTIFYs.
describe("out-of-order commit visibility", () => {
  it("delivers N and N+1 without a second NOTIFY once the lower transaction commits", async () => {
    const rows = [mk(10), mk(11)];
    let safe = "9"; // Tx1 (seq 10) still in flight, so the safe watermark stops below it
    const delivered: string[] = [];
    const store = new DataPlaneStore();
    store.queryOutboxSafeWatermark = async () => safe;
    store.queryOutboxSince = async (_c, after = "0", upTo?: string) =>
      rows.filter((r) => BigInt(r.seqId) > BigInt(after) && (upTo === undefined || BigInt(r.seqId) <= BigInt(upTo)));
    const connections = new Map([["c1", { authenticated: true, closed: false, projectId: P, connectedAt: Date.now() }]]);
    const poller = new OutboxPoller({
      bus: { async publish() {}, async subscribe() { return () => {}; }, async close() {} },
      dataStore: store,
      sink: { connections, async notifyCommittedEvents(_p: string, evs: OutboxEvent[]) { for (const e of evs) delivered.push(e.seqId); } } as never,
      pollIntervalMs: 50,
      healthyTenantPollMs: 60_000, // polling is effectively off; only the gap follow-up can deliver
    });
    await poller.start();
    poller.initializeTenantNow(P);
    await new Promise((r) => setTimeout(r, 120));
    poller.handleNotification(JSON.stringify({ seqId: 11, projectId: P }));
    await new Promise((r) => setTimeout(r, 150));
    expect(delivered).toEqual([]);
    safe = "11"; // Tx1 commits 200ms later
    await new Promise((r) => setTimeout(r, 400));
    expect(delivered).toEqual(["10", "11"]);
    await poller.stop();
  });
});
