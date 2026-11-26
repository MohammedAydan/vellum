import { describe, it, expect } from "vitest";
import { RealtimeGatewayHub } from "../hub.js";
import { type OutboxEvent } from "@vellum/storage";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { hashApiKey, type ApiKeyRecord } from "@vellum/authorization";
import type { ServerFrame } from "@vellum/api-contract";

const TENANT = {
  projectId: "11111111-1111-1111-1111-111111111111",
};

const RAW_API_KEY = "pk_1234567890abcdef1234567890abcdef";

class MockControlStore {
  public apiKeysByPrefix = new Map<string, ApiKeyRecord>();
  public realtimeMessagesSent = 0;
  public authConfig: { jwtPublicKeyPem: string } | null = null;

  constructor() {
    const keyPrefix = RAW_API_KEY.slice(0, 16);
    this.apiKeysByPrefix.set(keyPrefix, {
      id: "key_1",
      projectId: TENANT.projectId,
      name: "Default Key",
      keyType: "server",
      keyPrefix,
      secretHash: hashApiKey(RAW_API_KEY),
      scopes: ["documents:read", "documents:write", "*"],
      rateLimitRps: 1000,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdBy: null,
      createdAt: new Date().toISOString(),
    });
  }

  getProject(projectId: string) {
    return { project: { id: projectId, name: "Test Project" } };
  }

  getAuthConfig() {
    return this.authConfig;
  }

  getActiveRuleset() {
    return null;
  }

  incrementUsage(_projectId: string, usage: { realtimeMessagesSent?: number }) {
    if (usage.realtimeMessagesSent) {
      this.realtimeMessagesSent += usage.realtimeMessagesSent;
    }
  }
}


describe("hub subscription index", () => {
  const ev = (seq: number, collectionPath: string, id: string): OutboxEvent => ({
    seqId: String(seq), projectId: TENANT.projectId, collectionPath, path: `${collectionPath}/${id}`, documentId: id,
    opType: "updated", version: seq, beforeData: { n: 0 }, afterData: { n: seq }, committedAt: new Date().toISOString(),
  });

  async function connect(hub: RealtimeGatewayHub) {
    const frames: ServerFrame[] = [];
    const session = hub.createConnectionSession((f) => frames.push(f));
    await session.handleClientFrame({ type: "auth", projectId: TENANT.projectId, apiKey: RAW_API_KEY });
    return { session, frames };
  }

  it("delivers exactly what a full scan would, across path subs, query subs, unsubscribe and re-auth", async () => {
    const hub = new RealtimeGatewayHub({ controlStore: new MockControlStore() as never, dataStore: new DataPlaneStore() });
    const a = await connect(hub);
    const b = await connect(hub);
    const c = await connect(hub);
    await a.session.handleClientFrame({ type: "subscribe", subId: "a-doc", path: "posts/p1" });
    await a.session.handleClientFrame({ type: "subscribe", subId: "a-q", query: { collectionPath: "posts" } } as never);
    await b.session.handleClientFrame({ type: "subscribe", subId: "b-q", query: { collectionPath: "notes" } } as never);
    await b.session.handleClientFrame({ type: "subscribe", subId: "b-doc", path: "posts/p2" });
    await c.session.handleClientFrame({ type: "subscribe", subId: "c-doc", path: "posts/p1" });
    await c.session.handleClientFrame({ type: "unsubscribe", subId: "c-doc" } as never);
    const ids = (f: ServerFrame[]) => f.filter((x) => x.type === "mutation").map((x) => (x as { subId: string }).subId).sort();

    await hub.notifyCommittedEvents(TENANT.projectId, [ev(1, "posts", "p1"), ev(2, "notes", "n1"), ev(3, "posts", "p2"), ev(4, "other", "x")]);
    // expected by brute force: a-doc(p1), a-q(p1,p2), b-q(n1), b-doc(p2); nothing for c (unsubscribed)
    expect(ids(a.frames)).toEqual(["a-doc", "a-q", "a-q"]);
    expect(ids(b.frames)).toEqual(["b-doc", "b-q"]);
    expect(ids(c.frames)).toEqual([]);

    await a.session.handleClientFrame({ type: "unsubscribe", subId: "a-q" } as never);
    await hub.notifyCommittedEvents(TENANT.projectId, [ev(5, "posts", "p1")]);
    expect(ids(a.frames)).toEqual(["a-doc", "a-doc", "a-q", "a-q"]);

    a.session.close();
    await hub.notifyCommittedEvents(TENANT.projectId, [ev(6, "posts", "p1")]);
    expect(ids(a.frames)).toEqual(["a-doc", "a-doc", "a-q", "a-q"]);
    expect((hub as unknown as { subscriptionIndex: Map<string, unknown> }).subscriptionIndex.size).toBe(2);
  });

  it("20k subscriptions: an event for one collection only visits that collection's subscribers", async () => {
    const hub = new RealtimeGatewayHub({ controlStore: new MockControlStore() as never, dataStore: new DataPlaneStore() });
    const conns = [];
    for (let i = 0; i < 800; i += 1) conns.push(await connect(hub)); // 25 subscriptions per connection is the limit
    for (let i = 0; i < 20_000; i += 1) {
      const conn = conns[Math.floor(i / 25)]!;
      await conn.session.handleClientFrame({ type: "subscribe", subId: `s${i}`, query: { collectionPath: `col${i % 1000}` } } as never);
    }
    const before = conns.reduce((n, c) => n + c.frames.filter((f) => f.type === "mutation").length, 0);
    const t0 = performance.now();
    for (let i = 0; i < 20; i += 1) await hub.notifyCommittedEvents(TENANT.projectId, [ev(100 + i, "col7", `d${i}`)]);
    const perEventMs = (performance.now() - t0) / 20;
    const delivered = conns.reduce((n, c) => n + c.frames.filter((f) => f.type === "mutation").length, 0) - before;
    console.log(`20k subs: ${perEventMs.toFixed(2)} ms per event, ${delivered / 20} deliveries per event`);
    expect(delivered).toBe(20 * 20);
  }, 120_000);
});
