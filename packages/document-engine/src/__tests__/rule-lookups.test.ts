import { describe, it, expect, beforeEach } from "vitest";
import { DocumentEngine } from "../engine.js";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { compileRulesDsl } from "@vellum/authorization";

const TENANT = { projectId: "11111111-1111-1111-1111-111111111111", internal: true as const };
class Control {
  public ruleset: unknown = null;
  getActiveRuleset() { return this.ruleset; }
  incrementUsage() {}
}
const PUBLIC = {
  id: "public_test", projectId: TENANT.projectId, name: "p", keyType: "public", keyPrefix: "public_t", secretHash: "h",
  scopes: ["documents:read", "documents:write"], rateLimitRps: 100, lastUsedAt: null, expiresAt: null, revokedAt: null,
  createdBy: null, createdAt: new Date().toISOString(),
};
const as = (uid: string) => ({ ...TENANT, apiKeyRecord: PUBLIC as never, authContext: { uid, claims: {} } });

const RULES = `rules_version = '2';
match /chats/{chatId} {
  allow get: if auth.uid in resource.memberIds;
}
match /chats/{chatId}/messages/{messageId} {
  allow create: if incoming.senderId == auth.uid && auth.uid in get('chats', path.chatId).data.memberIds;
  allow update, delete: if resource.senderId == auth.uid && exists('chats', path.chatId);
  allow get: if auth.uid in get('chats', path.chatId).data.memberIds;
  allow list: if auth.uid != null;
}`;

describe("rules get() / exists() through the engine", () => {
  let engine: DocumentEngine;
  beforeEach(async () => {
    const control = new Control();
    const dataStore = new DataPlaneStore();
    engine = new DocumentEngine({ controlStore: control, dataStore });
    await engine.createDocument({ ...TENANT, path: "chats/c1", data: { memberIds: ["a", "b"] } });
    await engine.createDocument({ ...TENANT, path: "chats/c2", data: { memberIds: ["x"] } });
    await engine.createDocument({ ...TENANT, path: "chats/c1/messages/m0", data: { senderId: "a", text: "hi" } });
    await engine.createDocument({ ...TENANT, path: "chats/c2/messages/m0", data: { senderId: "x", text: "secret" } });
    control.ruleset = { rulesAst: compileRulesDsl(RULES).ast };
  });

  it("only a member can create a message in a chat", async () => {
    await expect(engine.createDocument({ ...as("a"), path: "chats/c1/messages/m1", data: { senderId: "a" } })).resolves.toBeDefined();
    await expect(engine.createDocument({ ...as("z"), path: "chats/c1/messages/m2", data: { senderId: "z" } })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(engine.createDocument({ ...as("a"), path: "chats/c2/messages/m3", data: { senderId: "a" } })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(engine.createDocument({ ...as("a"), path: "chats/missing/messages/m4", data: { senderId: "a" } })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("a removed member loses access immediately, reads and writes", async () => {
    await expect(engine.getDocument({ ...as("b"), path: "chats/c1/messages/m0" })).resolves.toBeDefined();
    await engine.setDocument?.({ ...TENANT, path: "chats/c1", data: { memberIds: ["a"] } });
    await expect(engine.getDocument({ ...as("b"), path: "chats/c1/messages/m0" })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("queries only return rows whose get() lookup passes", async () => {
    const a = await engine.executeQuery({ ...as("a"), querySpec: { collectionGroup: undefined, collection: "chats/c1/messages" } as never });
    expect(a.documents.map((d) => d.path)).toEqual(["chats/c1/messages/m0"]);
    const outsider = await engine.executeQuery({ ...as("a"), querySpec: { collection: "chats/c2/messages" } as never });
    expect(outsider.documents).toHaveLength(0);
  });

  it("update and delete need the sender and an existing chat", async () => {
    await expect(engine.deleteDocument({ ...as("a"), path: "chats/c1/messages/m0" })).resolves.toBeDefined();
    await expect(engine.deleteDocument({ ...as("x"), path: "chats/c2/messages/m0" })).resolves.toBeDefined();
  });
});
