import { describe, it, expect } from "vitest";
import { RealtimeGatewayHub } from "../hub.js";
import { OutboxPoller, parseOutboxNotification } from "../outbox-poller.js";
import {
  assertValidNotifyPayload,
  createPgNotifyBus,
  type PgNotifyBus,
} from "../pg-notify-pubsub.js";
import { type OutboxEvent } from "@vellum/storage";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { hashApiKey, type ApiKeyRecord } from "@vellum/authorization";
import type { ServerFrame } from "@vellum/api-contract";

const PROJECT_A = "11111111-1111-1111-1111-111111111111";
const PROJECT_B = "22222222-2222-2222-2222-222222222222";
const KEY_A = "pk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_B = "pk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function makeMockControlStore() {
  const apiKeysByPrefix = new Map<string, ApiKeyRecord>();
  for (const [id, projectId, raw] of [
    ["key_a", PROJECT_A, KEY_A],
    ["key_b", PROJECT_B, KEY_B],
  ] as const) {
    const keyPrefix = raw.slice(0, 16);
    apiKeysByPrefix.set(keyPrefix, {
      id,
      projectId,
      name: id,
      keyType: "server",
      keyPrefix,
      secretHash: hashApiKey(raw),
      scopes: ["documents:read", "documents:write", "*"],
      rateLimitRps: 1000,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdBy: null,
      createdAt: new Date().toISOString(),
    });
  }
  return {
    apiKeysByPrefix,
    getProject(projectId: string) {
      return { project: { id: projectId, name: projectId } };
    },
    getAuthConfig() {
      return null;
    },
    getActiveRuleset() {
      return null;
    },
    incrementUsage() {},
  };
}

describe("@vellum/realtime - Security, Reliability & Performance Hardening", () => {
  it("rejects NUL bytes in NOTIFY payload and non-Postgres URIs in createPgNotifyBus", () => {
    expect(() => assertValidNotifyPayload("bad\u0000payload")).toThrow();
    expect(() => createPgNotifyBus({ connectionString: "http://evil.example/db" })).toThrow();
    expect(() => createPgNotifyBus({ connectionString: "not-a-uri" })).toThrow();
  });

  it("rejects oversized, negative, or non-UUID outbox notifications", () => {
    expect(parseOutboxNotification("x".repeat(2000))).toBeNull();
    expect(parseOutboxNotification(JSON.stringify({ seqId: -5, projectId: PROJECT_A }))).toBeNull();
    expect(parseOutboxNotification(JSON.stringify({ seqId: "12", projectId: "not-a-uuid" }))).toBeNull();
    expect(parseOutboxNotification(JSON.stringify({ seqId: 42, projectId: PROJECT_A }))).toEqual({
      seqId: "42",
      projectId: PROJECT_A,
    });
  });

  it("never skips intermediate outbox rows when bursty NOTIFY wake-ups jump ahead", async () => {
    const delivered: string[] = [];
    const rows: OutboxEvent[] = [1, 2, 3, 4, 5].map((n) => ({
      seqId: String(n),
      projectId: PROJECT_A,
      collectionPath: "items",
      path: `items/i${n}`,
      documentId: `i${n}`,
      opType: "created",
      version: 1,
      beforeData: null,
      afterData: { n },
      committedAt: new Date().toISOString(),
    }));

    const fakeBus: PgNotifyBus = {
      async publish() {},
      async subscribe() {
        return () => {};
      },
      async close() {},
    };
    const dataStore = new DataPlaneStore();
    dataStore.queryOutboxSince = async (_ctx, afterSeqId = "0") => {
      const after = BigInt(afterSeqId);
      return rows.filter((r) => BigInt(r.seqId) > after);
    };

    const poller = new OutboxPoller({
      bus: fakeBus,
      dataStore,
      sink: {
        async notifyCommittedEvents(_pid, evs) {
          for (const e of evs) delivered.push(e.seqId);
        },
      },
      pollIntervalMs: 60_000,
    });

    await poller.start();
    // Seed initial watermark at 1 via notification for seq 2, then jump straight to 5.
    poller.handleNotification(JSON.stringify({ seqId: 2, projectId: PROJECT_A }));
    poller.handleNotification(JSON.stringify({ seqId: 5, projectId: PROJECT_A }));
    await new Promise((r) => setTimeout(r, 30));
    await poller.stop();

    expect(delivered).toEqual(["2", "3", "4", "5"]);
    expect(poller.getWatermark(PROJECT_A)).toBe(5n);
  });

  it("polls a tenant with no connected client far less often than one with a client", async () => {
    let calls = 0;
    const fakeBus: PgNotifyBus = { async publish() {}, async subscribe() { return () => {}; }, async close() {} };
    const dataStore = new DataPlaneStore();
    dataStore.queryOutboxSince = async () => {
      calls += 1;
      return [];
    };
    const poller = new OutboxPoller({
      bus: fakeBus,
      dataStore,
      sink: { async notifyCommittedEvents() {} },
      pollIntervalMs: 50,
    });
    await poller.start();
    poller.handleNotification(JSON.stringify({ seqId: 1, projectId: PROJECT_A }));
    await new Promise((r) => setTimeout(r, 400));
    await poller.stop();
    // ~8 ticks at 50ms. Without the idle cadence this was one query per tick.
    expect(calls).toBeLessThanOrEqual(3);
  });

  it("clears old subscriptions on re-authentication to prevent cross-tenant hijack", async () => {
    const dataStore = new DataPlaneStore();
    const controlStore = makeMockControlStore();
    const hub = new RealtimeGatewayHub({ controlStore, dataStore });

    const frames: ServerFrame[] = [];
    const handle = hub.createConnectionSession((f) => frames.push(f));

    await handle.handleClientFrame({ type: "auth", projectId: PROJECT_A, apiKey: KEY_A });
    await handle.handleClientFrame({ type: "subscribe", subId: "sub_a", path: "secrets/doc1" });
    expect(hub.connections.get(handle.connectionId)?.subscriptions.size).toBe(1);

    // Re-authenticate to Project B -> old subscription to Project A must be cleared.
    await handle.handleClientFrame({ type: "auth", projectId: PROJECT_B, apiKey: KEY_B });
    expect(hub.connections.get(handle.connectionId)?.subscriptions.size).toBe(0);

    // Events for Project A must never reach the re-authenticated Project B session.
    await hub.notifyCommittedEvents(PROJECT_A, [
      {
        seqId: "1",
        projectId: PROJECT_A,
        collectionPath: "secrets",
        path: "secrets/doc1",
        documentId: "doc1",
        opType: "updated",
        version: 2,
        beforeData: null,
        afterData: { topSecret: true },
        committedAt: new Date().toISOString(),
      },
    ]);
    expect(frames.filter((f) => f.type === "mutation")).toHaveLength(0);
  });

  it("isolates throwing consumer callbacks so healthy subscribers still receive fan-out", async () => {
    const dataStore = new DataPlaneStore();
    const controlStore = makeMockControlStore();
    const hub = new RealtimeGatewayHub({ controlStore, dataStore });

    let throwOnMutation = false;
    const brokenHandle = hub.createConnectionSession((f) => {
      if (throwOnMutation && f.type === "mutation") {
        throw new Error("Socket write EPIPE");
      }
    });
    const healthyFrames: ServerFrame[] = [];
    const healthyHandle = hub.createConnectionSession((f) => healthyFrames.push(f));

    await brokenHandle.handleClientFrame({ type: "auth", projectId: PROJECT_A, apiKey: KEY_A });
    await brokenHandle.handleClientFrame({ type: "subscribe", subId: "s1", path: "posts/p1" });

    await healthyHandle.handleClientFrame({ type: "auth", projectId: PROJECT_A, apiKey: KEY_A });
    await healthyHandle.handleClientFrame({ type: "subscribe", subId: "s2", path: "posts/p1" });

    throwOnMutation = true;
    await hub.notifyCommittedEvents(PROJECT_A, [
      {
        seqId: "1",
        projectId: PROJECT_A,
        collectionPath: "posts",
        path: "posts/p1",
        documentId: "p1",
        opType: "updated",
        version: 2,
        beforeData: null,
        afterData: { title: "hello" },
        committedAt: new Date().toISOString(),
      },
    ]);

    expect(healthyFrames.filter((f) => f.type === "mutation")).toHaveLength(1);
    expect(hub.connections.has(brokenHandle.connectionId)).toBe(false);
  });

  it("disconnects sessions whose end-user JWT expires after the initial handshake", async () => {
    const dataStore = new DataPlaneStore();
    const controlStore = makeMockControlStore();
    const hub = new RealtimeGatewayHub({ controlStore, dataStore });

    const frames: ServerFrame[] = [];
    const handle = hub.createConnectionSession((f) => frames.push(f));
    await handle.handleClientFrame({ type: "auth", projectId: PROJECT_A, apiKey: KEY_A });
    await handle.handleClientFrame({ type: "subscribe", subId: "s1", path: "posts/p1" });

    // Simulate an already-expired JWT on the session's authContext.
    const session = hub.connections.get(handle.connectionId)!;
    session.authContext.token = { exp: Math.floor(Date.now() / 1000) - 10 };

    await hub.notifyCommittedEvents(PROJECT_A, [
      {
        seqId: "1",
        projectId: PROJECT_A,
        collectionPath: "posts",
        path: "posts/p1",
        documentId: "p1",
        opType: "updated",
        version: 2,
        beforeData: null,
        afterData: { secret: "should-not-deliver" },
        committedAt: new Date().toISOString(),
      },
    ]);

    expect(frames.filter((f) => f.type === "mutation")).toHaveLength(0);
    expect(frames.some((f) => f.type === "error" && f.code === "TOKEN_EXPIRED")).toBe(true);
    expect(hub.connections.has(handle.connectionId)).toBe(false);
  });
});

describe("@vellum/realtime - outbox rows that commit late", () => {
  it("delivers a lower seq that becomes visible after a higher seq was already delivered", async () => {
    const mk = (n: number): OutboxEvent => ({
      seqId: String(n), projectId: PROJECT_A, collectionPath: "items", path: `items/i${n}`, documentId: `i${n}`,
      opType: "updated", version: 1, beforeData: null, afterData: { n }, committedAt: new Date().toISOString(),
    });
    // Seq 11 committed first; seq 10 (inserted earlier, committed later) appears only on the next read.
    const rows: OutboxEvent[] = [mk(9), mk(11)];
    const delivered: string[] = [];
    const dataStore = new DataPlaneStore();
    dataStore.queryOutboxSince = async (_ctx, afterSeqId = "0") => rows.filter((r) => BigInt(r.seqId) > BigInt(afterSeqId));
    const poller = new OutboxPoller({
      bus: { async publish() {}, async subscribe() { return () => {}; }, async close() {} },
      dataStore,
      sink: { async notifyCommittedEvents(_p, evs) { for (const e of evs) delivered.push(e.seqId); } },
      pollIntervalMs: 60_000,
    });
    await poller.start();
    poller.handleNotification(JSON.stringify({ seqId: 9, projectId: PROJECT_A }));
    await new Promise((r) => setTimeout(r, 50));
    expect(delivered).toEqual(["9", "11"]);
    rows.splice(1, 0, mk(10));
    poller.handleNotification(JSON.stringify({ seqId: 10, projectId: PROJECT_A }));
    await new Promise((r) => setTimeout(r, 50));
    expect(delivered).toEqual(["9", "11", "10"]);
    // Re-reading must not duplicate anything.
    poller.handleNotification(JSON.stringify({ seqId: 11, projectId: PROJECT_A }));
    await new Promise((r) => setTimeout(r, 50));
    expect(delivered).toEqual(["9", "11", "10"]);
    await poller.stop();
  });
});

describe("@vellum/realtime - poll-only tenant bootstrap", () => {
  it("does not drop a write made after a client connected but before the first poll", async () => {
    const connectedAt = Date.now();
    const old = (n: number): OutboxEvent => ({
      seqId: String(n), projectId: PROJECT_A, collectionPath: "items", path: `items/i${n}`, documentId: `i${n}`,
      opType: "updated", version: 1, beforeData: null, afterData: { n },
      committedAt: new Date(connectedAt - 60_000).toISOString(),
    });
    const fresh: OutboxEvent = { ...old(8), committedAt: new Date(connectedAt + 100).toISOString() };
    const rows = [old(6), old(7), fresh];
    const delivered: string[] = [];
    const dataStore = new DataPlaneStore();
    dataStore.queryOutboxSince = async (_ctx, afterSeqId = "0") => rows.filter((r) => BigInt(r.seqId) > BigInt(afterSeqId));
    const connections = new Map([["c1", { authenticated: true, closed: false, projectId: PROJECT_A, connectedAt }]]);
    const poller = new OutboxPoller({
      bus: { async publish() {}, async subscribe() { return () => {}; }, async close() {} },
      dataStore,
      sink: { connections, async notifyCommittedEvents(_p, evs) { for (const e of evs) delivered.push(e.seqId); } },
      pollIntervalMs: 50,
    });
    await poller.start();
    await new Promise((r) => setTimeout(r, 200));
    await poller.stop();
    expect(delivered).toEqual(["8"]);
  });
});

describe("@vellum/realtime - stuck drain", () => {
  it("replaces a drain that never finishes so the tenant is not silenced", async () => {
    const delivered: string[] = [];
    let calls = 0;
    const ev: OutboxEvent = {
      seqId: "5", projectId: PROJECT_A, collectionPath: "items", path: "items/a", documentId: "a",
      opType: "updated", version: 2, beforeData: null, afterData: { n: 1 }, committedAt: new Date().toISOString(),
    };
    const dataStore = new DataPlaneStore();
    dataStore.queryOutboxSince = async (_ctx, afterSeqId = "0") => {
      calls += 1;
      if (calls === 1) return await new Promise<OutboxEvent[]>(() => {}); // a query on a dead connection
      return BigInt(ev.seqId) > BigInt(afterSeqId) ? [ev] : [];
    };
    const connections = new Map([["c1", { authenticated: true, closed: false, projectId: PROJECT_A, connectedAt: Date.now() - 1_000 }]]);
    const poller = new OutboxPoller({
      bus: { async publish() {}, async subscribe() { return () => {}; }, async close() {} },
      dataStore,
      sink: { connections, async notifyCommittedEvents(_p, evs) { for (const e of evs) delivered.push(e.seqId); } },
      pollIntervalMs: 50,
      drainStuckMs: 100,
    });
    await poller.start();
    await new Promise((r) => setTimeout(r, 600));
    await poller.stop();
    expect(delivered).toEqual(["5"]);
  });
});

describe("@vellum/realtime - LISTEN unavailable", () => {
  it("still polls the outbox when the LISTEN subscription fails", async () => {
    const ev: OutboxEvent = {
      seqId: "7", projectId: PROJECT_A, collectionPath: "items", path: "items/a", documentId: "a",
      opType: "updated", version: 3, beforeData: null, afterData: { n: 2 }, committedAt: new Date().toISOString(),
    };
    const delivered: string[] = [];
    const dataStore = new DataPlaneStore();
    dataStore.queryOutboxSince = async (_ctx, afterSeqId = "0") => (BigInt(ev.seqId) > BigInt(afterSeqId) ? [ev] : []);
    const connections = new Map([["c1", { authenticated: true, closed: false, projectId: PROJECT_A, connectedAt: Date.now() - 1_000 }]]);
    const errors: string[] = [];
    const poller = new OutboxPoller({
      bus: { async publish() {}, async subscribe() { throw new Error("listen down"); }, async close() {} },
      dataStore,
      sink: { connections, async notifyCommittedEvents(_p, evs) { for (const e of evs) delivered.push(e.seqId); } },
      pollIntervalMs: 50,
      onError: (e) => errors.push(e.message),
    });
    await poller.start();
    await new Promise((r) => setTimeout(r, 300));
    await poller.stop();
    expect(errors).toContain("listen down");
    expect(delivered).toEqual(["7"]);
  });
});

describe("@vellum/realtime - cold instance does not replay history", () => {
  it("delivers only the committed event, not older outbox rows, when a project's seq has a gap", async () => {
    const mk = (n: number): OutboxEvent => ({
      seqId: String(n), projectId: PROJECT_A, collectionPath: "items", path: `items/i${n}`, documentId: `i${n}`,
      opType: "updated", version: 1, beforeData: null, afterData: { n }, committedAt: new Date().toISOString(),
    });
    const dataStore = new DataPlaneStore();
    let catchupQueries = 0;
    // History that already exists in the database (global bigserial: other projects use the gaps in between).
    dataStore.queryOutboxSince = async () => {
      catchupQueries += 1;
      return [mk(3), mk(7), mk(9)];
    };
    const hub = new RealtimeGatewayHub({ controlStore: makeMockControlStore(), dataStore });
    const frames: ServerFrame[] = [];
    const handle = hub.createConnectionSession((f) => frames.push(f));
    await handle.handleClientFrame({ type: "auth", projectId: PROJECT_A, apiKey: KEY_A });
    await handle.handleClientFrame({ type: "subscribe", subId: "s1", query: { collectionPath: "items" } });
    catchupQueries = 0;
    frames.length = 0;
    await hub.notifyCommittedEvents(PROJECT_A, [mk(50)]);
    const delivered = frames.filter((f) => f.type === "mutation").map((f) => (f as { seqId?: unknown }).seqId);
    expect(delivered.map(Number)).toEqual([50]);
    expect(catchupQueries).toBe(0);
  });
});

describe("@vellum/realtime - subscribe watermark", () => {
  it("uses the project's newest outbox seq, not the end of the oldest 500 rows", async () => {
    const dataStore = new DataPlaneStore();
    const old = (n: number): OutboxEvent => ({
      seqId: String(n), projectId: PROJECT_A, collectionPath: "items", path: `items/i${n}`, documentId: `i${n}`,
      opType: "updated", version: 1, beforeData: null, afterData: { n }, committedAt: new Date().toISOString(),
    });
    dataStore.queryOutboxSince = async () => Array.from({ length: 500 }, (_, i) => old(i + 1));
    (dataStore as unknown as { queryOutboxMaxSeq: () => Promise<string> }).queryOutboxMaxSeq = async () => "9000";
    // A PostgreSQL-backed store has no in-process counter; hide the memory store's.
    Object.defineProperty(dataStore, "outboxSeq", { value: undefined });
    const hub = new RealtimeGatewayHub({ controlStore: makeMockControlStore(), dataStore });
    const frames: ServerFrame[] = [];
    const handle = hub.createConnectionSession((f) => frames.push(f));
    await handle.handleClientFrame({ type: "auth", projectId: PROJECT_A, apiKey: KEY_A });
    await handle.handleClientFrame({ type: "subscribe", subId: "s1", path: "items/i1" });
    const sync = frames.find((f) => f.type === "initial_sync") as { seqId?: unknown } | undefined;
    expect(Number(sync?.seqId)).toBe(9000);
  });
});
