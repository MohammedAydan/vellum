import { describe, it, expect } from "vitest";
import { RealtimeGatewayHub } from "../hub.js";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { hashApiKey, compileRulesDsl, type ApiKeyRecord, type SecurityRulesetRecord } from "@vellum/authorization";
import type { ServerFrame } from "@vellum/api-contract";

const TENANT = { projectId: "11111111-1111-1111-1111-111111111111" };
const PK = "pk_abcdef1234567890abcdef1234567890";

// Reads depend on the document itself, not only on the path.
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
}`).ast as unknown as Record<string, unknown>,
};

function makeControlStore(rs: SecurityRulesetRecord = ruleset) {
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
    getActiveRuleset: () => rs,
    incrementUsage() {},
  };
}


describe("realtime: write racing the initial snapshot", () => {
  const doc = (n: number, version: number) => ({
    projectId: TENANT.projectId, path: "posts/p1", collectionPath: "posts", collectionGroup: "posts",
    documentId: "p1", pathDepth: 2, data: { n }, sizeBytes: 10, version,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null,
  });
  const ev = (seqId: string, version: number, n: number) => ({
    seqId, projectId: TENANT.projectId, collectionPath: "posts", path: "posts/p1", documentId: "p1",
    opType: "updated" as const, version, beforeData: { n: n - 1 }, afterData: { n }, committedAt: new Date().toISOString(),
  });

  async function run(snapshotVersion: number) {
    const dataStore = new DataPlaneStore();
    await dataStore.putDocument(TENANT, doc(snapshotVersion, snapshotVersion));
    const hub = new RealtimeGatewayHub({ controlStore: makeControlStore(), dataStore });
    const frames: ServerFrame[] = [];
    const session = hub.createConnectionSession((f) => frames.push(f));
    await session.handleClientFrame({ type: "auth", projectId: TENANT.projectId, apiKey: PK });
    // The write commits (and is fanned out) while the initial snapshot is still being read.
    const realTx = dataStore.withTransaction.bind(dataStore);
    (dataStore as unknown as { withTransaction: unknown }).withTransaction = async (t: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      realTx(t as never, async (tx) => {
        await hub.notifyCommittedEvents(TENANT.projectId, [ev("5", 2, 2)]);
        return fn(tx);
      });
    await session.handleClientFrame({ type: "subscribe", subId: "d", path: "posts/p1" } as never);
    return Object.assign(frames, { hub });
  }

  it("delivers the racing update after initial_sync, never before it", async () => {
    const frames = await run(1);
    const types = frames.map((f) => f.type);
    const sync = types.indexOf("initial_sync");
    const mutation = types.indexOf("mutation");
    expect(sync).toBeGreaterThanOrEqual(0);
    expect(mutation).toBeGreaterThan(sync);
  });

  it("does not replay an update the snapshot already contains", async () => {
    const frames = await run(2);
    expect(frames.some((f) => f.type === "mutation")).toBe(false);
  });

  it("drops a later duplicate of an event the snapshot already contained", async () => {
    const frames = await run(2);
    await frames.hub.notifyCommittedEvents(TENANT.projectId, [ev("5", 2, 2)]);
    expect(frames.some((f) => f.type === "mutation")).toBe(false);
  });
});
