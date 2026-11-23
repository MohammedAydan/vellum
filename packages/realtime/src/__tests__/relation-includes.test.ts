import { describe, expect, it } from "vitest";
import { hashApiKey, type ApiKeyRecord } from "@vellum/authorization";
import { DocumentEngine } from "@vellum/document-engine";
import { DataPlaneStore } from "@vellum/storage/adapters";
import type { ServerFrame } from "@vellum/api-contract";
import { RealtimeGatewayHub } from "../hub.js";

const projectId = "11111111-1111-1111-1111-111111111111";
const tenant = { projectId, internal: true as const };
const serverRaw = `sk_${"a".repeat(32)}`;
const publicRaw = `pk_${"b".repeat(32)}`;
async function fixture() {
  const store = new DataPlaneStore();
  let batchCalls = 0;
  let rejectRefReads = false;
  const originalTx = store.withTransaction.bind(store);
  store.withTransaction = async (ctx, fn) => originalTx(ctx, async (tx) => {
    const batch = tx.batchGetDocuments!.bind(tx);
    tx.batchGetDocuments = async (paths, includeDeleted) => { batchCalls++; if (rejectRefReads) throw new Error("test reference read failure"); return batch(paths, includeDeleted); };
    return fn(tx);
  });
  const keys = new Map<string, ApiKeyRecord>();
  for (const [raw, keyType] of [[serverRaw, "server"], [publicRaw, "public"]] as const) {
    keys.set(raw.slice(0, 16), { id: keyType, projectId, name: keyType, keyType, keyPrefix: raw.slice(0, 16),
      secretHash: hashApiKey(raw), scopes: ["documents:read", "documents:write"], rateLimitRps: 1000,
      lastUsedAt: null, expiresAt: null, revokedAt: null, createdBy: null, createdAt: new Date().toISOString() });
  }
  const control = {
    apiKeysByPrefix: keys, getProject: () => ({ id: projectId }), incrementUsage: () => undefined,
    getActiveRuleset: () => ({ id: "rules", projectId, version: 1, isActive: true, createdBy: null, createdAt: new Date().toISOString(), rulesAst: { version: 1, rules: [
      { match: "posts/{id}", allow: { get: true, list: true } },
      { match: "users/{id}", allow: { get: false } },
    ] } }),
  };
  const engine = new DocumentEngine({ controlStore: control, dataStore: store });
  await engine.createDocument({ ...tenant, path: "users/u1", data: { name: "Secret Author" } });
  await engine.createDocument({ ...tenant, path: "users/u2", data: { name: "Second Author" } });
  await engine.createDocument({ ...tenant, path: "posts/p1", data: { author: { $ref: "users/u1" }, reviewer: "users/u2" } });
  const hub = new RealtimeGatewayHub({ controlStore: control, dataStore: store });
  const connect = async (raw = serverRaw, extra: Record<string, unknown> = {}) => {
    const frames: ServerFrame[] = [];
    const session = hub.createConnectionSession((frame) => frames.push(frame));
    await session.handleClientFrame({ type: "auth", projectId, apiKey: raw });
    await session.handleClientFrame({ type: "subscribe", subId: "s", path: "posts/p1", ...extra });
    return { frames, session };
  };
  return { store, engine, hub, connect, failReads: () => { rejectRefReads = true; }, batches: () => batchCalls, reset: () => { batchCalls = 0; } };
}
function lastDocument(frames: ServerFrame[]) {
  const frame = frames.filter((f) => f.type === "mutation").at(-1);
  if (!frame || frame.type !== "mutation") throw new Error("No mutation frame");
  return frame.document;
}

describe("opt-in realtime includes", () => {
  it("resolves initial sync only when explicitly opted in", async () => {
    const f = await fixture();
    const legacy = await f.connect(serverRaw, { include: [{ field: "author" }] });
    expect(JSON.stringify(legacy.frames)).not.toContain("Secret Author");
    const opted = await f.connect(serverRaw, { resolveIncludes: true, include: [{ field: "author" }] });
    const initial = opted.frames.find((frame) => frame.type === "initial_sync");
    expect(JSON.stringify(initial)).toContain("Secret Author");
    expect(JSON.stringify(initial)).toContain("_included");
  });
  it("fetches the union once per live event and redacts per subscriber", async () => {
    const f = await fixture();
    const server = await f.connect(serverRaw, { resolveIncludes: true, include: [{ field: "author", as: "authorProfile" }] });
    const publicClient = await f.connect(publicRaw, { resolveIncludes: true, include: [{ field: "author", as: "authorProfile" }, { field: "reviewer" }] });
    f.reset();
    await f.engine.updateDocument({ ...tenant, path: "posts/p1", data: { title: "Changed" } });
    const events = await f.store.queryOutboxSince(tenant);
    const event = events.at(-1)!;
    f.reset();
    f.hub.watermarks.set(projectId, BigInt(event.seqId) - 1n);
    await f.hub.notifyCommittedEvents(projectId, [event]);
    expect(f.batches()).toBe(1);
    expect(lastDocument(server.frames)._included?.["authorProfile"]).toMatchObject({ data: { name: "Secret Author" } });
    const redacted = lastDocument(publicClient.frames);
    expect(redacted._included?.["authorProfile"]).toBeNull();
    expect(redacted._redactedRefs).toContain("authorProfile");
    expect(JSON.stringify(redacted)).not.toMatch(/Secret Author|Second Author/);
    expect(JSON.stringify(lastDocument(server.frames)._included)).not.toContain("projectId");
  });
  it("does not retrigger the parent when only a reference target changes", async () => {
    const f = await fixture();
    const client = await f.connect(serverRaw, { resolveIncludes: true, include: [{ field: "author" }] });
    const before = client.frames.length;
    f.reset();
    await f.engine.updateDocument({ ...tenant, path: "users/u1", data: { name: "New Name" } });
    const event = (await f.store.queryOutboxSince(tenant)).at(-1)!;
    f.reset();
    f.hub.watermarks.set(projectId, BigInt(event.seqId) - 1n);
    await f.hub.notifyCommittedEvents(projectId, [event]);
    expect(client.frames).toHaveLength(before); expect(f.batches()).toBe(0);
  });
  it("rejects nested realtime includes and caps unique reference fan-out", async () => {
    const f = await fixture();
    const nested = await f.connect(serverRaw, { resolveIncludes: true, include: [{ field: "author", include: [{ field: "friend" }] }] });
    expect(nested.frames).toContainEqual(expect.objectContaining({ type: "error", code: "INVALID_ARGUMENT" }));
    await f.engine.updateDocument({ ...tenant, path: "posts/p1", data: { refs: Array.from({ length: 1001 }, (_, i) => `users/u${i}`) } });
    const huge = await f.connect(serverRaw, { resolveIncludes: true, include: [{ field: "refs" }] });
    expect(huge.frames).toContainEqual(expect.objectContaining({ type: "error", code: "RESPONSE_TOO_LARGE" }));
    expect(huge.frames.some((frame) => frame.type === "initial_sync")).toBe(false);
  });
  it("preserves opt-in include resolution during replay and prevents duplicates", async () => {
    const f = await fixture();
    const replay = await f.connect(serverRaw, { resolveIncludes: true, include: [{ field: "author" }], resumeSeqId: 0 });
    expect(lastDocument(replay.frames)._included?.["author"]).toMatchObject({ data: { name: "Secret Author" } });
    expect(replay.frames.at(-1)?.type).toBe("resume_complete");
    const before = replay.frames.length;
    await f.hub.notifyCommittedEvents(projectId, await f.store.queryOutboxSince(tenant));
    expect(replay.frames).toHaveLength(before);
  });
  it("supports include specs on an opted-in query subscription", async () => {
    const f = await fixture();
    const client = await f.connect(serverRaw, { path: undefined, query: { collectionPath: "posts", limit: 10, include: [{ field: "author" }] }, resolveIncludes: true });
    expect(JSON.stringify(client.frames)).toContain("Secret Author");
    expect(client.frames.some((frame) => frame.type === "error")).toBe(false);
  });
  it("isolates reference-read failures and removes the failed subscription", async () => {
    const f = await fixture();
    const legacy = await f.connect();
    const opted = await f.connect(serverRaw, { resolveIncludes: true, include: [{ field: "author" }] });
    await f.engine.updateDocument({ ...tenant, path: "posts/p1", data: { title: "after failure" } });
    const event = (await f.store.queryOutboxSince(tenant)).at(-1)!;
    f.failReads();
    f.hub.watermarks.set(projectId, BigInt(event.seqId) - 1n);
    await f.hub.notifyCommittedEvents(projectId, [event]);
    expect(lastDocument(legacy.frames).data["title"]).toBe("after failure");
    expect(opted.frames.at(-1)).toMatchObject({ type: "error", code: "INTERNAL_ERROR" });
    expect(f.hub.connections.get(opted.session.connectionId)!.subscriptions.size).toBe(0);
  });

  it("keeps the original removal payload without hydrating query exits", async () => {
    const f = await fixture();
    await f.engine.updateDocument({ ...tenant, path: "posts/p1", data: { active: true } });
    const query = await f.connect(serverRaw, { path: undefined, resolveIncludes: true,
      query: { collectionPath: "posts", where: [{ field: "active", op: "==", value: true }], include: [{ field: "author" }] } });
    await f.engine.updateDocument({ ...tenant, path: "posts/p1", data: { active: false } });
    const event = (await f.store.queryOutboxSince(tenant)).at(-1)!;
    f.reset(); f.hub.watermarks.set(projectId, BigInt(event.seqId) - 1n);
    await f.hub.notifyCommittedEvents(projectId, [event]);
    expect(f.batches()).toBe(0);
    const last = query.frames.at(-1);
    expect(last).toMatchObject({ type: "mutation", operation: "delete", document: { data: { active: true } } });
    expect(lastDocument(query.frames)._included).toBeUndefined();
  });

});
