import { describe, it, expect, beforeEach } from "vitest";
import { DocumentEngine } from "../engine.js";
import { DataPlaneStore } from "@vellum/storage/adapters";

const TENANT = { projectId: "11111111-1111-1111-1111-111111111111", internal: true as const };

class Control {
  public ruleset: unknown = null;
  getActiveRuleset() { return this.ruleset; }
  incrementUsage() {}
}

const PUBLIC = {
  id: "public_test", projectId: TENANT.projectId, name: "public", keyType: "public", keyPrefix: "public_t", secretHash: "h",
  scopes: ["documents:read", "documents:write"], rateLimitRps: 100, lastUsedAt: null, expiresAt: null, revokedAt: null,
  createdBy: null, createdAt: new Date().toISOString(),
};

const signedIn = { op: "!=", left: { var: "auth.uid" }, right: { val: null } };
const member = { op: "in", left: { var: "auth.uid" }, right: { var: "resource.data.memberIds" } };
const channel = { op: "==", left: { var: "resource.data.chatType" }, right: { val: "channel" } };

// Recipe 1 (P0-2): `.select()` must not hide fields that the per-doc `allow get` rule reads.
describe("select projection under per-document get rules", () => {
  let engine: DocumentEngine;
  const asAlice = { ...TENANT, apiKeyRecord: PUBLIC, authContext: { uid: "alice", claims: {} } };

  beforeEach(async () => {
    const control = new Control();
    engine = new DocumentEngine({ controlStore: control, dataStore: new DataPlaneStore() });
    const base = "chats/c1/messages";
    await engine.createDocument({ ...TENANT, path: `${base}/m1`, data: { priority: 1, text: "a", memberIds: ["alice"], chatType: "dm" } });
    await engine.createDocument({ ...TENANT, path: `${base}/m2`, data: { priority: 8, text: "b", memberIds: ["alice"], chatType: "dm" } });
    await engine.createDocument({ ...TENANT, path: `${base}/m3`, data: { priority: 8, text: "secret", memberIds: ["bob"], chatType: "dm" } });
    control.ruleset = {
      rulesAst: {
        version: 1,
        rules: [{ match: "chats/{c}/messages/{m}", allow: { list: signedIn, get: { op: "all", conditions: [signedIn, { op: "any", conditions: [member, channel] }] } } }],
      },
    };
  });

  it("where + select returns the 2 readable docs with only the selected keys", async () => {
    const res = await engine.executeQuery({
      ...asAlice,
      querySpec: { collection: "chats/c1/messages", where: [{ field: "priority", op: ">=", value: 1 }], select: ["priority", "text"] },
    });
    expect(res.documents).toHaveLength(2);
    for (const d of res.documents) expect(Object.keys(d.data).sort()).toEqual(["priority", "text"]);
    expect(res.documents.map((d) => d.data["text"]).sort()).toEqual(["a", "b"]);
  });

  it("or + select returns the same 2 docs without leaking memberIds/chatType", async () => {
    const res = await engine.executeQuery({
      ...asAlice,
      querySpec: {
        collection: "chats/c1/messages",
        or: [[{ field: "priority", op: "==", value: 1 }], [{ field: "priority", op: "==", value: 8 }]],
        select: ["priority", "text"],
      },
    });
    expect(res.documents).toHaveLength(2);
    for (const d of res.documents) expect(Object.keys(d.data).sort()).toEqual(["priority", "text"]);
  });
});
