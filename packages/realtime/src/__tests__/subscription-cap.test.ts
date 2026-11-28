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



// P0-1.3: the server answers the 26th subscription on one connection with an explicit frame naming the limit.
describe("realtime: per-connection subscription cap", () => {
  it("accepts 25 subscriptions and rejects the 26th with SUBSCRIPTION_LIMIT_EXCEEDED and limit 25", async () => {
    const hub = new RealtimeGatewayHub({ controlStore: makeControlStore(), dataStore: new DataPlaneStore() });
    const frames: ServerFrame[] = [];
    const session = hub.createConnectionSession((f) => frames.push(f));
    await session.handleClientFrame({ type: "auth", projectId: TENANT.projectId, apiKey: PK });
    hub.connections.get(session.connectionId)!.authContext.uid = "alice";
    for (let i = 0; i < 26; i += 1) {
      await session.handleClientFrame({ type: "subscribe", subId: `s${i}`, path: `chats/c1/messages/m${i}` });
    }
    expect(frames.filter((f) => f.type === "initial_sync")).toHaveLength(25);
    const err = frames.find((f) => f.type === "error") as Record<string, unknown> | undefined;
    expect(err?.["code"]).toBe("SUBSCRIPTION_LIMIT_EXCEEDED");
    expect(JSON.stringify(err)).toContain("25");
    expect(err?.["limit"]).toBe(25);
  });
});

// P0-4 leak audit: connection churn must leave no per-connection state behind (no LISTEN is opened per
// connection; the process owns one dedicated LISTEN client).
describe("realtime: connection churn leaves no state behind", () => {
  it("200 connections x 5 subscriptions opened and closed leave the hub empty", async () => {
    const hub = new RealtimeGatewayHub({ controlStore: makeControlStore(), dataStore: new DataPlaneStore() });
    for (let c = 0; c < 200; c += 1) {
      const session = hub.createConnectionSession(() => undefined);
      await session.handleClientFrame({ type: "auth", projectId: TENANT.projectId, apiKey: PK });
      hub.connections.get(session.connectionId)!.authContext.uid = "alice";
      for (let i = 0; i < 5; i += 1) {
        await session.handleClientFrame({ type: "subscribe", subId: `s${i}`, path: `chats/c1/messages/m${c}_${i}` });
      }
      session.close();
    }
    expect(hub.connections.size).toBe(0);
    const h = hub as unknown as { subscriptionIndex: Map<string, unknown>; connectionsByProject: Map<string, Set<unknown>> };
    expect(h.subscriptionIndex.size).toBe(0);
    expect([...h.connectionsByProject.values()].every((set) => set.size === 0)).toBe(true);
  });
});
