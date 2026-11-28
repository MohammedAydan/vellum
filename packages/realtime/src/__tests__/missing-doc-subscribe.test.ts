import { describe, it, expect } from "vitest";
import { RealtimeGatewayHub } from "../hub.js";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { hashApiKey, compileRulesDsl, type ApiKeyRecord, type SecurityRulesetRecord } from "@vellum/authorization";
import type { ServerFrame } from "@vellum/api-contract";

const TENANT = { projectId: "11111111-1111-1111-1111-111111111111" };
const PK = "pk_abcdef1234567890abcdef1234567890";

const ruleset: SecurityRulesetRecord = {
  id: "r1", projectId: TENANT.projectId, version: 1, isActive: true, createdBy: null, createdAt: "",
  rulesAst: compileRulesDsl(`rules_version = '2';
match /chats/{c}/messages/{m} {
  allow get: if request.auth != null && request.auth.uid in resource.data.memberIds;
  allow list: if request.auth != null;
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


const event = (id: string, seq: string, op: "created" | "updated" | "deleted", memberIds: string[], version = 1) => ({
  seqId: seq, projectId: TENANT.projectId, collectionPath: "chats/c1/messages", path: `chats/c1/messages/${id}`, documentId: id,
  opType: op, version, beforeData: op === "created" ? null : { memberIds }, afterData: op === "deleted" ? null : { memberIds },
  committedAt: new Date().toISOString(),
});

// Recipe 2 (P0-3): subscribing to a missing document.
describe("realtime: missing-document subscription lifecycle", () => {
  async function connect(uid: string | null) {
    const hub = new RealtimeGatewayHub({ controlStore: makeControlStore(), dataStore: new DataPlaneStore() });
    const frames: ServerFrame[] = [];
    const session = hub.createConnectionSession((f) => frames.push(f));
    await session.handleClientFrame({ type: "auth", projectId: TENANT.projectId, apiKey: PK });
    hub.connections.get(session.connectionId)!.authContext.uid = uid;
    return { hub, session, frames };
  }
  const path = "chats/c1/messages/missing_life_1";

  it("case A: unauthenticated caller is denied (no existence oracle)", async () => {
    const { session, frames } = await connect(null);
    await session.handleClientFrame({ type: "subscribe", subId: "s1", path });
    expect(frames.some((f) => f.type === "initial_sync")).toBe(false);
    expect(frames.find((f) => f.type === "error")).toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("case B: signed-in caller gets an empty initial_sync, no outsider leak, then only authorized changes", async () => {
    const { hub, session, frames } = await connect("alice");
    await session.handleClientFrame({ type: "subscribe", subId: "s1", path });
    expect(frames.filter((f) => f.type === "error")).toHaveLength(0);
    const sync = frames.find((f) => f.type === "initial_sync") as Extract<ServerFrame, { type: "initial_sync" }>;
    expect(sync.documents).toHaveLength(0);

    // Bob creates it with himself as the only member: Alice must not see it.
    await hub.notifyCommittedEvents(TENANT.projectId, [event("missing_life_1", "2", "created", ["bob"])]);
    expect(frames.filter((f) => f.type === "mutation")).toHaveLength(0);

    // Recreated with Alice as a member: she sees it once.
    await hub.notifyCommittedEvents(TENANT.projectId, [event("missing_life_1", "3", "updated", ["alice"], 2)]);
    expect(frames.filter((f) => f.type === "mutation")).toHaveLength(1);
  });

  it("TTL expiry: a subscribed document that expires pushes a delete mutation (exists:false), not an error", async () => {
    const store = new DataPlaneStore();
    const hub = new RealtimeGatewayHub({ controlStore: makeControlStore(), dataStore: store });
    const frames: ServerFrame[] = [];
    const session = hub.createConnectionSession((f) => frames.push(f));
    await session.handleClientFrame({ type: "auth", projectId: TENANT.projectId, apiKey: PK });
    hub.connections.get(session.connectionId)!.authContext.uid = "alice";
    const ttlPath = "chats/c1/messages/ttl_doc";
    const now = new Date().toISOString();
    await store.putDocument(TENANT, {
      projectId: TENANT.projectId, path: ttlPath, collectionPath: "chats/c1/messages", collectionGroup: "messages",
      documentId: "ttl_doc", pathDepth: 4, data: { memberIds: ["alice"] }, sizeBytes: 20, version: 1,
      createdAt: now, updatedAt: now, deletedAt: null, expiresAt: new Date(Date.now() + 400).toISOString(),
    } as never);
    await session.handleClientFrame({ type: "subscribe", subId: "s1", path: ttlPath });
    const sync = frames.find((f) => f.type === "initial_sync") as Extract<ServerFrame, { type: "initial_sync" }>;
    expect(sync.documents).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 900));
    expect(frames.filter((f) => f.type === "error")).toHaveLength(0);
    const del = frames.find((f) => f.type === "mutation") as Extract<ServerFrame, { type: "mutation" }> | undefined;
    expect(del?.operation).toBe("delete");
    expect(del?.document.path).toBe(ttlPath);
  });
});
