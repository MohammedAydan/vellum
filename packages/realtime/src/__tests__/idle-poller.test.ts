import { describe, it, expect } from "vitest";
import { OutboxPoller } from "../outbox-poller.js";
import type { PgNotifyBus } from "../pg-notify-pubsub.js";

const P = "11111111-1111-1111-1111-111111111111";
const bus: PgNotifyBus = { async publish() {}, async subscribe() { return () => {}; }, async close() {} };

describe("outbox poller with no connected client", () => {
  it("does not touch the database for a tenant nobody is connected to", async () => {
    let reads = 0;
    const store = new Proxy({}, { get: () => () => { reads += 1; return Promise.resolve([]); } });
    const poller = new OutboxPoller({
      bus, dataStore: store as never, sink: { connections: new Map(), notifyCommittedEvents: async () => {} } as never,
      pollIntervalMs: 50,
    });
    poller.handleNotification(JSON.stringify({ seqId: 5, projectId: P }));
    await new Promise((r) => setTimeout(r, 30));
    const afterNotify = reads;
    await poller.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(reads).toBe(afterNotify);
    await poller.stop();
  });
});
