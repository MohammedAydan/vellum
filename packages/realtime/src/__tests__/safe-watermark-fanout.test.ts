import { describe, it, expect } from "vitest";
import { RealtimeGatewayHub } from "../hub.js";
import { DataPlaneStore } from "@vellum/storage/adapters";
import type { OutboxEvent } from "@vellum/storage";
import { hashApiKey, compileRulesDsl, type ApiKeyRecord, type SecurityRulesetRecord } from "@vellum/authorization";
import type { ServerFrame } from "@vellum/api-contract";

const TENANT = { projectId: "11111111-1111-1111-1111-111111111111" };
const PK = "pk_abcdef1234567890abcdef1234567890";

const ruleset: SecurityRulesetRecord = {
  id: "r1",
  projectId: TENANT.projectId,
  version: 1,
  isActive: true,
  createdBy: null,
  createdAt: "",
  rulesAst: compileRulesDsl(`rules_version = '2';
match /posts/{postId} {
  allow get, list: if true;
  allow write: if false;
}
match /big/{docId} {
  allow get, list: if true;
  allow write: if false;
}`).ast as unknown as Record<string, unknown>,
};

function makeControlStore() {
  const keyPrefix = PK.slice(0, 16);
  const record: ApiKeyRecord = {
    id: "key_pk",
    projectId: TENANT.projectId,
    name: "pk",
    keyType: "public",
    keyPrefix,
    secretHash: hashApiKey(PK),
    scopes: ["documents:read"],
    rateLimitRps: 1000,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdBy: null,
    createdAt: new Date().toISOString(),
  };
  return {
    apiKeysByPrefix: new Map([[keyPrefix, record]]),
    getProject: (projectId: string) => ({ project: { id: projectId, name: "t" } }),
    getAuthConfig: () => null,
    getActiveRuleset: () => ruleset,
    incrementUsage() {},
  };
}

const doc = (path: string, version: number, n: number) => {
  const collectionPath = path.split("/")[0]!;
  return {
    projectId: TENANT.projectId,
    path,
    collectionPath,
    collectionGroup: collectionPath,
    documentId: path.split("/")[1]!,
    pathDepth: 2,
    data: { n },
    sizeBytes: 10,
    version,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  };
};

const ev = (seqId: string, path: string, version: number, n: number): OutboxEvent => ({
  seqId,
  projectId: TENANT.projectId,
  collectionPath: path.split("/")[0]!,
  path,
  documentId: path.split("/")[1]!,
  opType: "updated",
  version,
  beforeData: { n: n - 1 },
  afterData: { n },
  committedAt: new Date().toISOString(),
});

const mutationSeqs = (frames: ServerFrame[]): number[] =>
  frames
    .filter((f): f is Extract<ServerFrame, { type: "mutation" }> => f.type === "mutation")
    .map((f) => Number(f.seqId));

describe("P0-2: 200x connect-write race (hub transport shared by WS and SSE)", () => {
  it("every race converges to exactly one observation of the write", async () => {
    for (let i = 0; i < 200; i += 1) {
      const snapshotVersion = i % 2 === 0 ? 1 : 2; // half the races land in the snapshot, half after it
      const dataStore = new DataPlaneStore();
      await dataStore.putDocument(TENANT, doc("posts/p1", snapshotVersion, snapshotVersion));
      const hub = new RealtimeGatewayHub({ controlStore: makeControlStore(), dataStore });
      const frames: ServerFrame[] = [];
      const session = hub.createConnectionSession((f) => frames.push(f));
      await session.handleClientFrame({ type: "auth", projectId: TENANT.projectId, apiKey: PK });
      const realTx = dataStore.withTransaction.bind(dataStore);
      (dataStore as unknown as { withTransaction: unknown }).withTransaction = async (
        t: unknown,
        fn: (tx: unknown) => Promise<unknown>
      ) =>
        realTx(t as never, async (tx) => {
          // The write is fanned out while the initial snapshot is still being read.
          await hub.notifyCommittedEvents(TENANT.projectId, [ev("5", "posts/p1", 2, 2)]);
          return fn(tx);
        });
      await session.handleClientFrame({ type: "subscribe", subId: "d", path: "posts/p1" } as never);

      const mutations = mutationSeqs(frames);
      const sync = frames.find((f) => f.type === "initial_sync") as
        | Extract<ServerFrame, { type: "initial_sync" }>
        | undefined;
      const syncHasWrite = sync?.documents.some((d) => d.version >= 2) ?? false;
      if (snapshotVersion >= 2) {
        // Snapshot already reflects the write: no live duplicate, ever.
        expect(mutations).toEqual([]);
        expect(syncHasWrite).toBe(true);
      } else {
        // Snapshot predates the write: exactly one live event, after the sync.
        expect(mutations).toEqual([5]);
        const syncIndex = frames.findIndex((f) => f.type === "initial_sync");
        const mutationIndex = frames.findIndex((f) => f.type === "mutation");
        expect(mutationIndex).toBeGreaterThan(syncIndex);
      }
    }
  });
});

describe("P0-2: forced disconnect mid-stream", () => {
  it("resume after disconnect delivers every event exactly once (0 missed, 0 duplicates)", async () => {
    const dataStore = new DataPlaneStore();
    const hub = new RealtimeGatewayHub({ controlStore: makeControlStore(), dataStore });
    // Durable history 1..8 (the outbox is what resume replays from).
    for (let seq = 1; seq <= 8; seq += 1) {
      await dataStore.appendOutbox(TENANT, {
        collectionPath: "posts",
        path: "posts/p1",
        documentId: "p1",
        opType: "updated",
        version: seq,
        beforeData: { n: seq - 1 },
        afterData: { n: seq },
      });
    }

    const firstFrames: ServerFrame[] = [];
    const first = hub.createConnectionSession((f) => firstFrames.push(f));
    await first.handleClientFrame({ type: "auth", projectId: TENANT.projectId, apiKey: PK });
    await first.handleClientFrame({ type: "subscribe", subId: "d", path: "posts/p1" } as never);
    // Live delivery of 1..5, then the connection drops.
    for (let seq = 1; seq <= 5; seq += 1) {
      await hub.notifyCommittedEvents(TENANT.projectId, [ev(String(seq), "posts/p1", seq, seq)]);
    }
    const receivedFirst = mutationSeqs(firstFrames);
    expect(receivedFirst).toEqual([1, 2, 3, 4, 5]);
    first.close();

    // Reconnect and resume from the last received seq.
    const secondFrames: ServerFrame[] = [];
    const second = hub.createConnectionSession((f) => secondFrames.push(f));
    await second.handleClientFrame({ type: "auth", projectId: TENANT.projectId, apiKey: PK });
    await second.handleClientFrame({
      type: "subscribe",
      subId: "d",
      path: "posts/p1",
      resumeSeqId: 5,
    } as never);
    const resume = secondFrames.find((f) => f.type === "resume_complete") as
      | Extract<ServerFrame, { type: "resume_complete" }>
      | undefined;
    expect(resume).toBeDefined();
    // A live event right after resume is delivered once as well.
    await hub.notifyCommittedEvents(TENANT.projectId, [ev("9", "posts/p1", 9, 9)]);

    const receivedSecond = mutationSeqs(secondFrames);
    expect(receivedSecond).toEqual([6, 7, 8, 9]);
    // Across both connections: 1..9, each exactly once.
    const all = [...receivedFirst, ...receivedSecond];
    expect(all).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("P0-2: 1,000-subscription fan-out", () => {
  it("delivers one event to 100 sessions x 10 subscriptions in well under 1s", async () => {
    const dataStore = new DataPlaneStore();
    const hub = new RealtimeGatewayHub({ controlStore: makeControlStore(), dataStore });
    const SESSIONS = 100;
    const SUBS_PER_SESSION = 10;
    const framesPerSession: ServerFrame[][] = [];
    for (let s = 0; s < SESSIONS; s += 1) {
      const frames: ServerFrame[] = [];
      framesPerSession.push(frames);
      const session = hub.createConnectionSession((f) => frames.push(f));
      await session.handleClientFrame({ type: "auth", projectId: TENANT.projectId, apiKey: PK });
      for (let sub = 0; sub < SUBS_PER_SESSION; sub += 1) {
        await session.handleClientFrame({
          type: "subscribe",
          subId: `s${sub}`,
          query: { collectionPath: "big" },
        } as never);
      }
    }

    const started = performance.now();
    await hub.notifyCommittedEvents(TENANT.projectId, [ev("42", "big/d1", 1, 1)]);
    const tookMs = performance.now() - started;

    expect(tookMs).toBeLessThan(1_000);
    for (const frames of framesPerSession) {
      expect(mutationSeqs(frames)).toHaveLength(SUBS_PER_SESSION);
    }
  }, 30_000);
});
