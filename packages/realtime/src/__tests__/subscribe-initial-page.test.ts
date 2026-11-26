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


describe("realtime: query subscribe initial page", () => {
  it("returns only the first `limit` rows in order, not the whole collection", async () => {
    const dataStore = new DataPlaneStore();
    const mk = (n: number) => ({
      projectId: TENANT.projectId, path: `posts/p${String(n).padStart(2, "0")}`, collectionPath: "posts",
      collectionGroup: "posts", documentId: `p${String(n).padStart(2, "0")}`, pathDepth: 2, data: { n }, sizeBytes: 10,
      version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null,
    });
    for (let i = 0; i < 40; i += 1) await dataStore.putDocument(TENANT, mk(i));
    const hub = new RealtimeGatewayHub({ controlStore: makeControlStore(), dataStore });
    const frames: ServerFrame[] = [];
    const session = hub.createConnectionSession((f) => frames.push(f));
    await session.handleClientFrame({ type: "auth", projectId: TENANT.projectId, apiKey: PK });
    await session.handleClientFrame({
      type: "subscribe", subId: "q", query: { collectionPath: "posts", orderBy: [{ field: "n", direction: "desc" }], limit: 3 },
    } as never);
    const sync = frames.find((f) => f.type === "initial_sync") as Extract<ServerFrame, { type: "initial_sync" }>;
    expect(sync.documents.map((d) => (d as { documentId: string }).documentId)).toEqual(["p39", "p38", "p37"]);
  });

  it("fills the page when most rows are denied by their own get rule", async () => {
    const denyMost: SecurityRulesetRecord = {
      ...ruleset,
      rulesAst: compileRulesDsl(`rules_version = '2';
match /posts/{postId} {
  allow list: if true;
  allow get: if resource.data.visible == true;
  allow write: if false;
}`).ast as unknown as Record<string, unknown>,
    };
    const dataStore = new DataPlaneStore();
    const mk = (n: number) => ({
      projectId: TENANT.projectId, path: `posts/p${String(n).padStart(3, "0")}`, collectionPath: "posts",
      collectionGroup: "posts", documentId: `p${String(n).padStart(3, "0")}`, pathDepth: 2, data: { n, visible: n % 10 === 0 }, sizeBytes: 10,
      version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null,
    });
    for (let i = 0; i < 400; i += 1) await dataStore.putDocument(TENANT, mk(i));
    const hub = new RealtimeGatewayHub({ controlStore: makeControlStore(denyMost), dataStore });
    const frames: ServerFrame[] = [];
    const session = hub.createConnectionSession((f) => frames.push(f));
    await session.handleClientFrame({ type: "auth", projectId: TENANT.projectId, apiKey: PK });
    await session.handleClientFrame({
      type: "subscribe", subId: "q", query: { collectionPath: "posts", orderBy: [{ field: "n", direction: "desc" }], limit: 30 },
    } as never);
    const sync = frames.find((f) => f.type === "initial_sync") as Extract<ServerFrame, { type: "initial_sync" }>;
    const ids = sync.documents.map((d) => (d as { documentId: string }).documentId);
    expect(ids.length).toBe(30);
    expect(ids[0]).toBe("p390");
    expect(ids[29]).toBe("p100");
  });
});
