import { describe, it, expect } from "vitest";
import type { OutboxEvent, StorageAdapter, TenantContext } from "@vellum/storage";
import {
  OutboxPoller,
  parseOutboxNotification,
  type OutboxFanoutSink,
} from "@vellum/realtime";
import type { PgNotifyBus } from "@vellum/realtime";

const TENANT_A: TenantContext = {
  projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const TENANT_B: TenantContext = {
  projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

function event(ctx: TenantContext, seq: number): OutboxEvent {
  return {
    seqId: String(seq),
    projectId: ctx.projectId,
    collectionPath: "messages",
    path: `messages/m${seq}`,
    documentId: `m${seq}`,
    opType: "created",
    version: 1,
    beforeData: null,
    afterData: { text: `msg-${seq}` },
    committedAt: new Date().toISOString(),
  };
}

class FakeBus implements PgNotifyBus {
  private handlers: Array<(payload: string) => void> = [];
  public async publish(): Promise<void> {}
  public async subscribe(_channel: string, handler: (payload: string) => void): Promise<() => void> {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }
  public async close(): Promise<void> {}
  public emit(payload: string): void {
    for (const handler of [...this.handlers]) handler(payload);
  }
}

class FakeSink implements OutboxFanoutSink {
  public readonly batches: Array<{ projectId: string; events: OutboxEvent[] }> = [];
  public readonly connections = new Map<string, {
    authenticated: boolean;
    closed: boolean;
    projectId: string | null;
  }>();
  public async notifyCommittedEvents(projectId: string, events: OutboxEvent[]): Promise<void> {
    this.batches.push({ projectId, events });
  }
}

function fakeStore(rows: OutboxEvent[]): StorageAdapter {
  return {
    queryOutboxSince: async (_ctx: TenantContext, afterSeqId = "0") => {
      const after = BigInt(afterSeqId);
      return rows.filter((row) => BigInt(row.seqId) > after).slice(0, 500);
    },
  } as unknown as StorageAdapter;
}

/** Poll-only bootstrap intentionally skips pre-existing history, so tests must
 * insert rows *after* the first poll has established the tenant watermark. */
function mutableStore(): { store: StorageAdapter; rows: OutboxEvent[] } {
  const rows: OutboxEvent[] = [];
  return { store: fakeStore(rows), rows };
}

function note(ctx: TenantContext, seq: number): string {
  return JSON.stringify({
    seqId: String(seq),
    projectId: ctx.projectId,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) throw new Error("Timed out waiting for condition");
}

describe("realtime outbox poller (unit)", () => {
  it("parses only well-formed tenant notifications", () => {
    expect(parseOutboxNotification(note(TENANT_A, 7))).toEqual({
      seqId: "7",
      projectId: TENANT_A.projectId,
    });
    expect(parseOutboxNotification("{}")).toBeNull();
    expect(parseOutboxNotification("not json")).toBeNull();
    expect(parseOutboxNotification(JSON.stringify({
      seqId: "7",
      projectId: "not-a-uuid",
    }))).toBeNull();
  });

  it("delivers an event once when NOTIFY and polling both observe it", async () => {
    const bus = new FakeBus();
    const sink = new FakeSink();
    const store = fakeStore([event(TENANT_A, 1)]);
    const poller = new OutboxPoller({
      bus,
      dataStore: store,
      sink,
      pollIntervalMs: 30,
    });
    await poller.start();
    try {
      bus.emit(note(TENANT_A, 1));
      await waitFor(() => sink.batches.length > 0);
      await new Promise((r) => setTimeout(r, 120)); // several extra poll ticks + duplicate NOTIFY
      bus.emit(note(TENANT_A, 1));
      await new Promise((r) => setTimeout(r, 120));

      expect(sink.batches).toHaveLength(1);
      expect(sink.batches[0]?.events.map((e) => e.seqId)).toEqual(["1"]);
      expect(poller.stats.notifications).toBe(2);
      expect(poller.getWatermark(TENANT_A.projectId)).toBe(1n);
    } finally {
      await poller.stop();
    }
  });

  it("catches up in 500-event batches through the plain poll loop (no LISTEN)", async () => {
    const bus = new FakeBus();
    const sink = new FakeSink();
    // Simulate LISTEN being unavailable: never emit any notification.
    sink.connections.set("conn_1", {
      authenticated: true,
      closed: false,
      projectId: TENANT_A.projectId,
    });
    const { store, rows } = mutableStore();
    const poller = new OutboxPoller({
      bus,
      dataStore: store,
      sink,
      pollIntervalMs: 30,
    });
    await poller.start();
    try {
      await waitFor(() => poller.stats.polls > 0);
      await new Promise((r) => setTimeout(r, 60)); // let poll-only HEAD bootstrap finish
      rows.push(...Array.from({ length: 1_200 }, (_, i) => event(TENANT_A, i + 1)));
      await waitFor(() => sink.batches.reduce((n, b) => n + b.events.length, 0) === 1_200, 5_000);
      const sizes = sink.batches.map((b) => b.events.length);
      expect(sizes).toEqual([500, 500, 200]);
      expect(poller.stats.gapsDetected).toBe(0);
      expect(poller.getWatermark(TENANT_A.projectId)).toBe(1_200n);
    } finally {
      await poller.stop();
    }
  });

  it("detects gaps and filters cross-tenant rows from fan-out", async () => {
    const bus = new FakeBus();
    const sink = new FakeSink();
    const { store, rows } = mutableStore();
    const poller = new OutboxPoller({
      bus,
      dataStore: store,
      sink,
      pollIntervalMs: 30,
    });
    await poller.start();
    try {
      bus.emit(note(TENANT_A, 2)); // establishes watermark=1 without poll-only bootstrap
      rows.push(event(TENANT_A, 2), event(TENANT_B, 3), event(TENANT_A, 10));
      bus.emit(note(TENANT_A, 10)); // seq 3..9 missing for tenant A => gap
      await waitFor(() => sink.batches.length > 0);
      expect(sink.batches[0]?.events.every((e) => e.projectId === TENANT_A.projectId)).toBe(true);

      await waitFor(() => poller.stats.gapsDetected > 0);
      expect(poller.stats.gapsDetected).toBeGreaterThan(0);
      const delivered = sink.batches.flatMap((b) => b.events).map((e) => e.seqId);
      expect(delivered).not.toContain("3"); // TENANT_B row must never be fanned out
    } finally {
      await poller.stop();
    }
  });
});
