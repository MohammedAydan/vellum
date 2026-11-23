import { afterEach, describe, expect, it, vi } from "vitest";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { DocumentEngine } from "../engine.js";
import { scanReferencedBy } from "../referenced-by.js";
import type { DocumentRecord, TxHandle } from "@vellum/storage";

const tenant = { projectId: "11111111-1111-1111-1111-111111111111", internal: true as const };
const publicKey = {
  id: "lookup-test", projectId: tenant.projectId, name: "public", keyType: "public",
  keyPrefix: "lookup", secretHash: "unused", scopes: ["documents:read"], rateLimitRps: 10000,
  lastUsedAt: null, expiresAt: null, revokedAt: null, createdBy: null, createdAt: new Date().toISOString(),
};
function setup(allowList = true) {
  const store = new DataPlaneStore();
  const control = {
    getActiveRuleset: () => ({ rulesAst: { version: 1, rules: [
      { match: "users/{id}", allow: { get: { op: "==", left: { var: "path.id" }, right: { val: "u1" } } } },
      { match: "posts/{id}", allow: {
        get: { op: "==", left: { var: "resource.data.visible" }, right: { val: true } }, list: allowList,
      } },
    ] } }),
    incrementUsage: () => undefined,
  };
  return new DocumentEngine({ controlStore: control, dataStore: store, cursorSecret: "test-only-lookup-cursor" });
}
async function seed(engine: DocumentEngine) {
  await engine.createDocument({ ...tenant, path: "users/u1", data: { name: "Alice" } });
  await engine.createDocument({ ...tenant, path: "users/u2", data: { name: "hidden target" } });
  await engine.createDocument({ ...tenant, path: "posts/a", data: { visible: true, ref: { $ref: "users/u1" }, other: "users/u2" } });
  await engine.createDocument({ ...tenant, path: "posts/b", data: { visible: false, ref: "users/u1", secret: "hidden dependent" } });
  await engine.createDocument({ ...tenant, path: "posts/c", data: { visible: true, nest: { refs: ["users/u1"] } } });
  await engine.createDocument({ ...tenant, path: "posts/d", data: { visible: true, ref: "u1" } });
}
const request = { targetPath: "users/u1" };
afterEach(() => vi.useRealTimers());

describe("referencedBy", () => {
  it("matches exact nested/array/tagged paths, not inferred bare IDs", async () => {
    const engine = setup(); await seed(engine);
    const result = await engine.referencedBy({ ...tenant, request });
    expect(result.documents.map((d) => d.path)).toEqual(["posts/a", "posts/b", "posts/c"]);
    expect(result.nextCursor).toBeNull();
  });
  it("filters unreadable dependents and requires list as well as get", async () => {
    const engine = setup(); await seed(engine);
    const result = await engine.referencedBy({ ...tenant, apiKeyRecord: publicKey, request });
    expect(result.documents.map((d) => d.path)).toEqual(["posts/a", "posts/c"]);
    expect(JSON.stringify(result)).not.toContain("hidden dependent");
    const noList = setup(false); await seed(noList);
    expect((await noList.referencedBy({ ...tenant, apiKeyRecord: publicKey, request })).documents).toEqual([]);
  });
  it("supports collection, nested field filtering, select and included-target redaction", async () => {
    const engine = setup(); await seed(engine);
    expect((await engine.referencedBy({ ...tenant, request: { ...request, field: "nest.refs", collection: "posts" } })).documents.map((d) => d.path)).toEqual(["posts/c"]);
    expect((await engine.referencedBy({ ...tenant, request: { ...request, collection: "missing" } })).documents).toEqual([]);
    const result = await engine.referencedBy({ ...tenant, apiKeyRecord: publicKey, request: { ...request, field: "ref" },
      include: [{ field: "other", collection: "users", as: "otherUser" }] });
    expect(result.documents[0]?._included?.["otherUser"]).toBeNull();
    expect(result.documents[0]?._redactedRefs).toContain("otherUser");
    const selected = await engine.referencedBy({ ...tenant, request, select: ["visible"] });
    expect(selected.documents[0]?.data).toEqual({ visible: true });
  });
  it("paginates authorized rows without skipping the lookahead or revealing hidden paths", async () => {
    const engine = setup(); await seed(engine);
    const first = await engine.referencedBy({ ...tenant, apiKeyRecord: publicKey, request: { ...request, limit: 1 } });
    expect(first.documents.map((d) => d.path)).toEqual(["posts/a"]);
    expect(first.nextCursor).toBeTypeOf("string");
    expect(Buffer.from(first.nextCursor!, "base64url").toString()).not.toContain("posts/b");
    const second = await engine.referencedBy({ ...tenant, apiKeyRecord: publicKey, request: { ...request, limit: 1, cursor: first.nextCursor! } });
    expect(second.documents.map((d) => d.path)).toEqual(["posts/c"]);
    expect(second.nextCursor).toBeNull();
  });
  it("rejects tampered, expired and query/caller-bound cursors", async () => {
    const engine = setup(); await seed(engine);
    const first = await engine.referencedBy({ ...tenant, request: { ...request, limit: 1 } });
    for (const changed of [{ cursor: "not-valid" }, { cursor: first.nextCursor!, collection: "posts" }, { cursor: first.nextCursor!, field: "ref" }]) {
      await expect(engine.referencedBy({ ...tenant, request: { ...request, ...changed } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    await expect(engine.referencedBy({ ...tenant, apiKeyRecord: publicKey, request: { ...request, cursor: first.nextCursor! } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 3600001);
    await expect(engine.referencedBy({ ...tenant, request: { ...request, cursor: first.nextCursor! } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it("requires a readable existing target", async () => {
    const engine = setup(); await seed(engine);
    await expect(engine.referencedBy({ ...tenant, apiKeyRecord: publicKey, request: { targetPath: "users/u2" } })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(engine.referencedBy({ ...tenant, request: { targetPath: "users/absent" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it.each([0, -1, 101, 1.5, NaN])("rejects invalid limit %s", async (limit) => {
    const engine = setup(); await seed(engine);
    await expect(engine.referencedBy({ ...tenant, request: { ...request, limit } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it("does not leak another tenant's matching rows", async () => {
    const engine = setup(); await seed(engine);
    await engine.createDocument({ ...tenant, projectId: "22222222-2222-2222-2222-222222222222", path: "posts/other", data: { ref: "users/u1" } });
    expect((await engine.referencedBy({ ...tenant, request })).documents.map((d) => d.path)).not.toContain("posts/other");
  });
  it("does not use the public legacy cursor default for private continuations", async () => {
    const controlStore = { getActiveRuleset: () => null, incrementUsage: () => undefined };
    const engines = [1, 2].map(() => new DocumentEngine({ controlStore, dataStore: new DataPlaneStore() }));
    for (const e of engines) await seed(e);
    const page = await engines[0]!.referencedBy({ ...tenant, request: { ...request, limit: 1 } });
    await expect(engines[1]!.referencedBy({ ...tenant, request: { ...request, cursor: page.nextCursor! } })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it("round-trips encrypted cursors for long UTF-8 dependent paths", async () => {
    const engine = setup();
    await engine.createDocument({ ...tenant, path: "users/u1", data: { ok: true } });
    const longPath = ["a", "é".repeat(750), "b", "é".repeat(750), "c", "é".repeat(750)].join("/");
    for (const path of [longPath, "zz/z"]) await engine.createDocument({ ...tenant, path, data: { ref: "users/u1" } });
    const first = await engine.referencedBy({ ...tenant, request: { ...request, limit: 1 } });
    expect(first.documents[0]?.path).toBe(longPath);
    expect(first.nextCursor!.length).toBeGreaterThan(4096);
    const second = await engine.referencedBy({ ...tenant, request: { ...request, cursor: first.nextCursor! } });
    expect(second.documents.map((row) => row.path)).toEqual(["zz/z"]);
  });
  it("excludes expired rows and tombstones from the lookup", async () => {
    const engine = setup(); await seed(engine);
    await engine.deleteDocument({ ...tenant, path: "posts/a" });
    await engine.createDocument({ ...tenant, path: "posts/expired", data: { ref: "users/u1" }, expiresAt: new Date(Date.now() + 1000).toISOString() });
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 2000);
    const found = await engine.referencedBy({ ...tenant, request });
    expect(found.documents.map((row) => row.path)).toEqual(["posts/b", "posts/c"]);
  });
  it("bounds candidate scans and can return an empty continuation page", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ path: `posts/${String(i).padStart(4, "0")}` }) as DocumentRecord);
    const tx = { referencedByPage: async (r: { afterPath?: string | null | undefined; limit: number }) => rows.filter((row) => !r.afterPath || row.path > r.afterPath).slice(0, r.limit) } satisfies Pick<TxHandle, "referencedByPage">;
    const first = await scanReferencedBy({ request, tx, scope: "test", secret: "secret", canRead: () => false, format: () => { throw new Error(); } });
    expect(first.scanned).toBe(1000); expect(first.documents).toEqual([]); expect(first.nextCursor).toBeTypeOf("string");
    const last = await scanReferencedBy({ request: { ...request, cursor: first.nextCursor! }, tx, scope: "test", secret: "secret", canRead: () => false, format: () => { throw new Error(); } });
    expect(last.scanned).toBe(1); expect(last.nextCursor).toBeNull();
  });
});
