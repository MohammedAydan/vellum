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
  allow get: if resource.data.visibility == 'public';
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

const doc = (id: string, visibility: string) => ({
  projectId: TENANT.projectId,
  path: `posts/${id}`,
  collectionPath: "posts",
  collectionGroup: "posts",
  documentId: id,
  pathDepth: 2,
  data: { visibility },
  sizeBytes: 30,
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  deletedAt: null,
});

const event = (id: string, seq: string, visibility: string) => ({
  seqId: seq,
  projectId: TENANT.projectId,
  collectionPath: "posts",
  path: `posts/${id}`,
  documentId: id,
  opType: "updated" as const,
  version: 2,
  beforeData: { visibility: "public" },
  afterData: { visibility },
  committedAt: new Date().toISOString(),
});

describe("realtime: resource-based get rules", () => {
  async function connect() {
    const dataStore = new DataPlaneStore();
    await dataStore.putDocument(TENANT, doc("pub", "public"));
    await dataStore.putDocument(TENANT, doc("priv", "private"));
    const hub = new RealtimeGatewayHub({ controlStore: makeControlStore(), dataStore });
    const frames: ServerFrame[] = [];
    const session = hub.createConnectionSession((f) => frames.push(f));
    await session.handleClientFrame({ type: "auth", projectId: TENANT.projectId, apiKey: PK });
    return { hub, session, frames };
  }

  it("denies the initial snapshot of a document the rule hides, allows one it permits", async () => {
    const { session, frames } = await connect();
    await session.handleClientFrame({ type: "subscribe", subId: "s1", path: "posts/pub" });
    const sync = frames.find((f) => f.type === "initial_sync");
    expect(sync).toMatchObject({ type: "initial_sync" });
    expect((sync as Extract<ServerFrame, { type: "initial_sync" }>).documents).toHaveLength(1);

    await Promise.resolve(session.handleClientFrame({ type: "subscribe", subId: "s2", path: "posts/priv" })).catch(() => undefined);
    const syncs = frames.filter((f) => f.type === "initial_sync") as Extract<ServerFrame, { type: "initial_sync" }>[];
    expect(syncs.every((s) => s.subId !== "s2" || s.documents.length === 0)).toBe(true);
    expect(JSON.stringify(frames)).not.toContain('"private"');
  });

  it("stops live events once the new document state fails the rule", async () => {
    const { hub, session, frames } = await connect();
    await session.handleClientFrame({ type: "subscribe", subId: "s1", path: "posts/pub" });
    await hub.notifyCommittedEvents(TENANT.projectId, [event("pub", "2", "public")]);
    expect(frames.filter((f) => f.type === "mutation")).toHaveLength(1);
    await hub.notifyCommittedEvents(TENANT.projectId, [event("pub", "3", "private")]);
    expect(frames.filter((f) => f.type === "mutation")).toHaveLength(1);
    expect(JSON.stringify(frames)).not.toContain('"private"');
  });

  it("never leaks a collection query's hidden documents", async () => {
    const { session, frames } = await connect();
    await Promise.resolve(session.handleClientFrame({
      type: "subscribe",
      subId: "q1",
      query: { collectionPath: "posts" },
    } as never)).catch(() => undefined);
    expect(JSON.stringify(frames)).not.toContain('"private"');
    expect(JSON.stringify(frames)).not.toContain("posts/priv");
  });
});
