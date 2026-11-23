import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DocumentEngine } from "@vellum/document-engine";
import { DataPlaneStore, PgStorageAdapter } from "@vellum/storage/adapters";
import { RealtimeGatewayHub } from "@vellum/realtime";
import { hashApiKey, type ApiKeyRecord, type SecurityRulesetRecord } from "@vellum/authorization";
import type { ServerFrame } from "@vellum/api-contract";

const localUrl = process.env.VELLUM_AUDIT_PG_URL;
if (localUrl && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(localUrl).hostname)) {
  throw new Error("Audit regression PostgreSQL URL must point at a disposable loopback database");
}
const tenants = new Set<string>();
function tenantId(): string { const id = randomUUID(); tenants.add(id); return id; }
const stores = [new DataPlaneStore(), ...(localUrl ? [new PgStorageAdapter({ connectionString: localUrl })] : [])];
afterAll(async () => {
  for (const store of stores) {
    try {
      if (store instanceof PgStorageAdapter) for (const projectId of tenants) {
        await store.withTransaction({ projectId }, async (tx) => {
          const sql = tx as typeof tx & { query: (text: string, params: unknown[]) => Promise<unknown> };
          for (const table of ["realtime_outbox", "document_index_entries", "document_indexes", "documents", "project_collections"]) {
            await sql.query(`DELETE FROM ${table} WHERE project_id = $1::uuid`, [projectId]);
          }
        });
      }
    } finally { await store.close(); }
  }
});

for (const store of stores) describe(`data audit ${store.constructor.name}`, () => {
  it.each([
    ["nested reference", "link.author", { link: { author: { $ref: "users/u1" } } }],
    ["tagged reference", "author", { author: { $t: "ref", $v: "users/u1" } }],
    ["array reference", "authors", { authors: [{ $ref: "users/u1" }] }],
  ])("restrict covers %s", async (_name, field, data) => {
    const ctx = { projectId: tenantId(), internal: true as const };
    const control = { getActiveRuleset: () => null, incrementUsage() {} };
    const engine = new DocumentEngine({ dataStore: store, controlStore: control });
    await engine.createDocument({ ...ctx, path: "users/u1", data: { name: "Test" } });
    await engine.createDocument({ ...ctx, path: "posts/p1", data });
    await expect(engine.deleteDocument({ ...ctx, path: "users/u1", relationRules: [{ collection: "posts", field, onDelete: "restrict" }] })).rejects.toMatchObject({ code: "RELATION_RESTRICT_VIOLATION" });
    expect((await engine.getDocument({ ...ctx, path: "users/u1" })).data.name).toBe("Test");
  });
  it("rejects fanout over the dependency cap without deleting any rows", async () => {
    const ctx = { projectId: tenantId(), internal: true as const };
    const engine = new DocumentEngine({ dataStore: store, controlStore: { getActiveRuleset: () => null, incrementUsage() {} } });
    await engine.createDocument({ ...ctx, path: "users/u1", data: {} });
    for (let start = 0; start < 501; start += 100) await engine.batchWrite({ ...ctx, writes: Array.from({ length: Math.min(100, 501 - start) }, (_, offset) => ({ type: "create", path: `posts/p${start + offset}`, data: { author: "users/u1" } })) });
    await expect(engine.deleteDocument({ ...ctx, path: "users/u1", relationRules: [{ collection: "posts", field: "author", onDelete: "cascade" }] })).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
    expect((await engine.getDocument({ ...ctx, path: "users/u1" })).path).toBe("users/u1");
    expect((await engine.getDocument({ ...ctx, path: "posts/p500" })).path).toBe("posts/p500");
  });
  it("honors same-batch dependent tombstones before restrict evaluation", async () => {
    const ctx = { projectId: tenantId(), internal: true as const };
    const engine = new DocumentEngine({ dataStore: store, controlStore: { getActiveRuleset: () => null, incrementUsage() {} } });
    await engine.createDocument({ ...ctx, path: "users/u1", data: {} });
    await engine.createDocument({ ...ctx, path: "posts/p1", data: { author: "users/u1" } });
    await expect(engine.batchWrite({ ...ctx, relationRules: [{ collection: "posts", field: "author", onDelete: "restrict" }], writes: [{ type: "delete", path: "posts/p1" }, { type: "delete", path: "users/u1" }] })).resolves.toMatchObject({ results: [{ status: "deleted" }, { status: "deleted" }] });
  });
  it("fails closed rather than partially cascading through an over-depth chain", async () => {
    const ctx = { projectId: tenantId(), internal: true as const };
    const engine = new DocumentEngine({ dataStore: store, controlStore: { getActiveRuleset: () => null, incrementUsage() {} } });
    for (let i = 0; i < 5; i++) await engine.createDocument({ ...ctx, path: `nodes/n${i}`, data: { parent: i ? `nodes/n${i - 1}` : null } });
    await expect(engine.deleteDocument({ ...ctx, path: "nodes/n0", relationRules: [{ collection: "nodes", field: "parent", onDelete: "cascade" }] })).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
    for (let i = 0; i < 5; i++) expect((await engine.getDocument({ ...ctx, path: `nodes/n${i}` })).path).toBe(`nodes/n${i}`);
  });

});

describe("realtime initial state", () => {
  async function fixture(publicAccess = false) {
    const store = new DataPlaneStore();
    const projectId = randomUUID();
    const raw = "pk_audit_local_123456789012345678901234567890";
    const key: ApiKeyRecord = { id: "audit", projectId, name: "audit", keyType: publicAccess ? "public" : "server", keyPrefix: raw.slice(0, 16), secretHash: hashApiKey(raw), scopes: ["*"], rateLimitRps: 1000, lastUsedAt: null, expiresAt: null, revokedAt: null, createdBy: null, createdAt: new Date().toISOString() };
    const ruleset = { rulesAst: { version: 1, rules: [
      { match: "items/{id}", allow: { list: true, get: { op: "==", left: { var: "resource.data.visible" }, right: { val: true } } } },
    ] } } as unknown as SecurityRulesetRecord;
    const control = { apiKeysByPrefix: new Map([[key.keyPrefix, key]]), getProject: () => ({ id: projectId }), getActiveRuleset: () => publicAccess ? ruleset : null, incrementUsage() {} };
    const engine = new DocumentEngine({ dataStore: store, controlStore: control });
    await engine.createDocument({ projectId, internal: true, path: "items/a", data: { visible: false, rank: 1, secret: "hidden" } });
    await engine.createDocument({ projectId, internal: true, path: "items/b", data: { visible: true, rank: 20, secret: "selected-out" } });
    const hub = new RealtimeGatewayHub({ dataStore: store, controlStore: control });
    const frames: ServerFrame[] = [];
    const session = hub.createConnectionSession((f) => frames.push(f));
    await session.handleClientFrame({ type: "auth", projectId, apiKey: raw });
    return { store, hub, frames, session, control, key, projectId };
  }
  it("does not send rows denied by their resource-data get rule", async () => {
    const { session, frames } = await fixture(true);
    await session.handleClientFrame({ type: "subscribe", subId: "s", query: { collectionPath: "items" } });
    const initial = frames.find((f) => f.type === "initial_sync");
    expect(initial?.type).toBe("initial_sync");
    if (initial?.type === "initial_sync") expect(initial.documents.map((d) => d.path)).toEqual(["items/b"]);
  });
  it("evaluates document subscription rules against actual resource data", async () => {
    const { session, frames } = await fixture(true);
    await session.handleClientFrame({ type: "subscribe", subId: "s", path: "items/b" });
    expect(frames.find((f) => f.type === "initial_sync")?.type).toBe("initial_sync");
  });
  it("keeps selected-out fields out of live query mutations", async () => {
    const { session, frames, projectId, hub } = await fixture();
    await session.handleClientFrame({ type: "subscribe", subId: "s", query: { collectionPath: "items", select: ["rank"] } });
    await hub.notifyCommittedEvents(projectId, [{ seqId: "1", projectId, collectionPath: "items", path: "items/b", documentId: "b", opType: "updated", version: 2, beforeData: { rank: 20 }, afterData: { rank: 21, secret: "not-selected" }, committedAt: new Date().toISOString() }]);
    const mutation = frames.find((f) => f.type === "mutation");
    expect(mutation?.type).toBe("mutation");
    if (mutation?.type === "mutation") expect(mutation.document.data).toEqual({ rank: 21 });
  });
  it("stops existing realtime sessions when their API key is removed from the current mirror", async () => {
    const { session, frames, control, key, projectId, hub } = await fixture();
    await session.handleClientFrame({ type: "subscribe", subId: "s", path: "items/b" });
    control.apiKeysByPrefix.delete(key.keyPrefix);
    await hub.notifyCommittedEvents(projectId, [{ seqId: "1", projectId, collectionPath: "items", path: "items/b", documentId: "b", opType: "updated", version: 2, beforeData: null, afterData: { confidential: true }, committedAt: new Date().toISOString() }]);
    expect(frames.filter((f) => f.type === "mutation")).toHaveLength(0);
    expect(hub.connections.has(session.connectionId)).toBe(false);
  });
  it("orders before applying limit and applies select", async () => {
    const { session, frames } = await fixture();
    await session.handleClientFrame({ type: "subscribe", subId: "s", query: { collectionPath: "items", orderBy: [{ field: "rank", dir: "desc" }], select: ["rank"], limit: 1 } });
    const initial = frames.find((f) => f.type === "initial_sync");
    expect(initial?.type).toBe("initial_sync");
    if (initial?.type === "initial_sync") {
      expect(initial.documents.map((d) => d.path)).toEqual(["items/b"]);
      expect(initial.documents[0]?.data).toEqual({ rank: 20 });
    }
  });
});
