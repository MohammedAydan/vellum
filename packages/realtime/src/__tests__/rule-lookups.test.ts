import { describe, it, expect } from "vitest";
import { RealtimeGatewayHub } from "../hub.js";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { hashApiKey, compileRulesDsl, type ApiKeyRecord, type SecurityRulesetRecord } from "@vellum/authorization";
import type { ServerFrame } from "@vellum/api-contract";

const TENANT = { projectId: "11111111-1111-1111-1111-111111111111" };
const PK = "pk_abcdef1234567890abcdef1234567890";

const lookupRuleset: SecurityRulesetRecord = {
  id: "r2", projectId: TENANT.projectId, version: 1, isActive: true, createdBy: null, createdAt: "",
  rulesAst: compileRulesDsl(`rules_version = '2';
match /chats/{chatId}/messages/{messageId} {
  allow get: if get('chats', path.chatId).data.open == true;
  allow list: if true;
}`).ast as unknown as Record<string, unknown>,
};

function makeStore(rs: SecurityRulesetRecord) {
  const keyPrefix = PK.slice(0, 16);
  const record: ApiKeyRecord = {
    id: "key_pk", projectId: TENANT.projectId, name: "pk", keyType: "public", keyPrefix, secretHash: hashApiKey(PK),
    scopes: ["documents:read"], rateLimitRps: 1000, lastUsedAt: null, expiresAt: null, revokedAt: null, createdBy: null,
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

const row = (path: string, data: Record<string, unknown>) => {
  const parts = path.split("/");
  return {
    projectId: TENANT.projectId, path, collectionPath: parts.slice(0, -1).join("/"), collectionGroup: parts[parts.length - 2]!,
    documentId: parts[parts.length - 1]!, pathDepth: parts.length, data, sizeBytes: 30, version: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null,
  };
};

describe("realtime: rules that read another document (get / exists)", () => {
  async function connect(chat: string) {
    const dataStore = new DataPlaneStore();
    await dataStore.putDocument(TENANT, row("chats/c1", { open: true }));
    await dataStore.putDocument(TENANT, row("chats/c2", { open: false }));
    await dataStore.putDocument(TENANT, row("chats/c2/messages/m1", { text: "secret" }));
    await dataStore.putDocument(TENANT, row("chats/c1/messages/m1", { text: "hi" }));
    const hub = new RealtimeGatewayHub({ controlStore: makeStore(lookupRuleset), dataStore });
    const frames: ServerFrame[] = [];
    const session = hub.createConnectionSession((f) => frames.push(f));
    await session.handleClientFrame({ type: "auth", projectId: TENANT.projectId, apiKey: PK });
    return { hub, session, frames, dataStore, chat };
  }

  it("a member's query snapshot and live events pass, a non-member gets nothing", async () => {
    const member = await connect("c1");
    await member.session.handleClientFrame({ type: "subscribe", subId: "q", query: { collectionPath: `chats/${member.chat}/messages` } } as never);
    const sync = member.frames.find((f) => f.type === "initial_sync") as Extract<ServerFrame, { type: "initial_sync" }>;
    expect(sync.documents.map((d) => d.path)).toEqual(["chats/c1/messages/m1"]);
    await member.hub.notifyCommittedEvents(TENANT.projectId, [{
      seqId: "2", projectId: TENANT.projectId, collectionPath: `chats/${member.chat}/messages`, path: `chats/${member.chat}/messages/m2`, documentId: "m2",
      opType: "created", version: 1, beforeData: null, afterData: { text: "new" }, committedAt: new Date().toISOString(),
    } as never]);
    expect(member.frames.filter((f) => f.type === "mutation")).toHaveLength(1);

    const outsider = await connect("c2");
    await outsider.session.handleClientFrame({ type: "subscribe", subId: "q", query: { collectionPath: `chats/${outsider.chat}/messages` } } as never);
    const sync2 = outsider.frames.find((f) => f.type === "initial_sync") as Extract<ServerFrame, { type: "initial_sync" }>;
    expect(sync2.documents).toHaveLength(0);
    await outsider.hub.notifyCommittedEvents(TENANT.projectId, [{
      seqId: "2", projectId: TENANT.projectId, collectionPath: `chats/${outsider.chat}/messages`, path: `chats/${outsider.chat}/messages/m2`, documentId: "m2",
      opType: "created", version: 1, beforeData: null, afterData: { text: "new" }, committedAt: new Date().toISOString(),
    } as never]);
    expect(outsider.frames.filter((f) => f.type === "mutation")).toHaveLength(0);
  });
});
