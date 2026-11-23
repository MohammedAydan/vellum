import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { Socket, AddressInfo } from "node:net";
import { hashApiKey, type ApiKeyRecord } from "@vellum/authorization";
import { RealtimeGatewayHub } from "@vellum/realtime";
import { createClient, type RealtimeSnapshot } from "@vellumdb/sdk-js";
import { attachRealtimeWebSocketServer } from "../../apps/api/src/ws-rfc6455.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgControlPlaneStore } from "@vellum/database-control/adapters";
import { createRawPgClient, type RawPgClient } from "@vellum/database-control";
import { createCacheInvalidationBus, PgStorageAdapter } from "@vellum/storage/adapters";
import { type CacheInvalidationBus } from "@vellum/storage";
import { DocumentEngine } from "@vellum/document-engine";
import { createControlInvalidationHandler } from "../../apps/api/src/workers/control-invalidation.js";

const controlUrl = process.env.CONTROL_DATABASE_URL;
const dataUrl = process.env.DATA_DATABASE_URL;
const enabled = process.env.RELATIONS_PG_TEST === "1";
const projectId = randomUUID();
const orgId = randomUUID();
const tenant = { projectId, internal: true as const };
const edge = { collection: "posts", field: "authorId", targetCollection: "users", onDelete: "cascade" as const };
let control: RawPgClient;
let data: RawPgClient;
let a: PgControlPlaneStore;
let b: PgControlPlaneStore;
let adapter: PgStorageAdapter;
let engine: DocumentEngine;
const buses: CacheInvalidationBus[] = [];

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for PostgreSQL invalidation");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Explicit flag means a CI configuration error fails rather than silently skips.
describe.skipIf(!enabled)("relations / real PostgreSQL", () => {
  beforeAll(async () => {
    if (!controlUrl || !dataUrl) throw new Error("Relations PG tests require both database URLs");
    control = createRawPgClient({ connectionString: controlUrl });
    data = createRawPgClient({ connectionString: dataUrl });
    await control.connect();
    await data.connect();
    await control.query("INSERT INTO organizations(id,slug,name,billing_email) VALUES($1,$2,'Relations PG','relations@example.invalid')", [orgId, `rr-${orgId}`]);
    await control.query("INSERT INTO projects(id,organization_id,slug,name) VALUES($1,$2,'relations-pg','Relations PG')", [projectId, orgId]);
    a = new PgControlPlaneStore({ connectionString: controlUrl });
    b = new PgControlPlaneStore({ connectionString: controlUrl });
    await Promise.all([a.initialize(), b.initialize()]);
    adapter = new PgStorageAdapter({ connectionString: dataUrl });
    // Match the production non-owner role. Queue before any request query.
    adapter.pool.on("connect", (client) => { void client.query("SET ROLE vellum_app"); });
    engine = new DocumentEngine({ controlStore: a, dataStore: adapter });
  }, 30000);

  afterAll(async () => {
    await Promise.all(buses.map((bus) => bus.close()));
    if (data) {
      await data.query("BEGIN");
      await data.query("SELECT set_config('app.current_project_id',$1,true)", [projectId]);
      for (const table of ["transactions", "realtime_outbox", "document_index_entries", "document_indexes", "documents"]) {
        await data.query(`DELETE FROM ${table} WHERE project_id=$1::uuid`, [projectId]);
      }
      await data.query("COMMIT");
      await data.end();
    }
    if (a) await a.close();
    if (b) await b.close();
    if (adapter) await adapter.close();
    if (control) {
      await control.query("DELETE FROM audit_logs WHERE project_id=$1", [projectId]);
      await control.query("DELETE FROM projects WHERE id=$1", [projectId]);
      await control.query("DELETE FROM organizations WHERE id=$1", [orgId]);
      await control.end();
    }
  }, 30000);

  it("persists replacement CRUD and keeps the version after clearing all rules", async () => {
    const v1 = await a.replaceRelationRules({ projectId, rules: [edge], expectedVersion: 0 });
    expect(v1.version).toBe(1);
    await b.refresh();
    expect(b.getRelationRules(projectId)[0]).toMatchObject(edge);
    const v2 = await b.replaceRelationRules({ projectId, rules: [], expectedVersion: 1 });
    expect(v2.version).toBe(2);
    await a.refresh();
    expect(a.getRelationRules(projectId)).toEqual([]);
    expect(a.getRelationRulesVersion(projectId)).toBe(2);
  });

  it("serializes two independent writers and rejects the stale expectedVersion", async () => {
    const version = a.getRelationRulesVersion(projectId);
    const results = await Promise.allSettled([
      a.replaceRelationRules({ projectId, rules: [edge], expectedVersion: version }),
      b.replaceRelationRules({ projectId, rules: [], expectedVersion: version }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure).toMatchObject({ reason: { code: "ABORTED_CONFLICT" } });
    await a.refresh();
    expect(a.getRelationRulesVersion(projectId)).toBe(version + 1);
  });

  it("rolls the entire rule replacement back after a database insert failure", async () => {
    await a.replaceRelationRules({ projectId, rules: [edge] });
    const before = a.getRelationRulesVersion(projectId);
    // PostgreSQL rejects a NUL text value after the transaction has deleted
    // existing rows. This proves rollback, not just pre-write validation.
    await expect(a.replaceRelationRules({ projectId, rules: [{ ...edge, field: "bad\u0000field" }] })).rejects.toThrow();
    await b.refresh();
    expect(b.getRelationRulesVersion(projectId)).toBe(before);
    expect(b.getRelationRules(projectId)[0]).toMatchObject(edge);
  });

  it("refreshes the second instance's engine mirror through real LISTEN/NOTIFY", async () => {
    const errors: unknown[] = [];
    const receiver = createCacheInvalidationBus({ connectionString: controlUrl!, onInvalidate: createControlInvalidationHandler(b, (error) => errors.push(error)) });
    const sender = createCacheInvalidationBus({ connectionString: controlUrl!, onInvalidate: () => undefined });
    buses.push(receiver, sender);
    await until(() => receiver.isListening() && sender.isListening());
    const snapshot = await a.replaceRelationRules({ projectId, rules: [{ ...edge, onDelete: "restrict" }] });
    await sender.publish({ kind: "relation_rules", key: projectId });
    await until(() => b.getRelationRulesVersion(projectId) === snapshot.version);
    expect(errors).toEqual([]);
    expect(b.getRelationRules(projectId)[0]?.onDelete).toBe("restrict");
  });

  it("supports migration rollback and reapplication in an isolated schema", async () => {
    const migration = fs.readFileSync(new URL("../../packages/database-control/migrations/0012_project_relation_rules.sql", import.meta.url), "utf8");
    await control.query("BEGIN");
    try {
      await control.query("CREATE SCHEMA relation_migration_test");
      await control.query("SET LOCAL search_path TO relation_migration_test,public");
      await control.query("CREATE TABLE relation_migration_test.projects(id uuid PRIMARY KEY)");
      await control.query(migration);
      await control.query("DROP TABLE project_relation_rules; DROP TABLE project_relation_rules_meta");
      await control.query(migration);
      const result = await control.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='relation_migration_test' AND tablename LIKE 'project_relation_rules%'");
      expect(result.rows[0].count).toBe(2);
    } finally {
      await control.query("ROLLBACK");
    }
  });

  it("restrict rolls back preceding writes and leaks no dependent identifier", async () => {
    await a.replaceRelationRules({ projectId, rules: [{ ...edge, onDelete: "restrict" }] });
    await engine.createDocument({ ...tenant, path: "users/restricted", data: { name: "Target" } });
    await engine.createDocument({ ...tenant, path: "posts/hidden", data: { authorId: { $ref: "users/restricted" } } });
    let failure: unknown;
    try {
      await engine.batchWrite({ ...tenant, writes: [
        { type: "create", path: "posts/should-rollback", data: { ok: true } },
        { type: "delete", path: "users/restricted" },
      ] });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "RELATION_RESTRICT_VIOLATION" });
    expect(JSON.stringify(failure)).not.toMatch(/hidden|restricted|authorId/);
    await expect(engine.getDocument({ ...tenant, path: "posts/should-rollback" })).rejects.toThrow();
    expect((await engine.getDocument({ ...tenant, path: "users/restricted" })).data.name).toBe("Target");
  });

  it.each(["cascade", "set_null"] as const)("%s applies atomically to dependents on PostgreSQL", async (onDelete) => {
    await a.replaceRelationRules({ projectId, rules: [{ ...edge, onDelete }] });
    const path = `users/${onDelete}`;
    const dependent = `posts/${onDelete}`;
    await engine.createDocument({ ...tenant, path, data: { name: onDelete } });
    await engine.createDocument({ ...tenant, path: dependent, data: { authorId: { $ref: path } } });
    await engine.deleteDocument({ ...tenant, path });
    if (onDelete === "cascade") await expect(engine.getDocument({ ...tenant, path: dependent })).rejects.toThrow();
    else expect((await engine.getDocument({ ...tenant, path: dependent })).data.authorId).toBeNull();
    await expect(engine.getDocument({ ...tenant, path })).rejects.toThrow();
  });
  it("enforces PostgreSQL RLS for a different project under vellum_app", async () => {
    await data.query("BEGIN");
    try {
      await data.query("SET LOCAL ROLE vellum_app");
      await data.query("SELECT set_config('app.current_project_id',$1,true)", [randomUUID()]);
      const rows = await data.query("SELECT path FROM documents WHERE project_id=$1::uuid", [projectId]);
      expect(rows.rows).toEqual([]);
    } finally { await data.query("ROLLBACK"); }
  });

  it("restrict hides unreadable dependents and cascade enforces system integrity", async () => {
    const publicKey = {
      id: randomUUID(), projectId, name: "Relations PG", keyType: "public" as const,
      keyPrefix: "pk_relations_test", secretHash: "test-only", scopes: ["documents:read", "documents:write"],
      rateLimitRps: 1000, lastUsedAt: null, expiresAt: null, revokedAt: null, createdBy: null, createdAt: new Date().toISOString(),
    };
    const securedEngine = new DocumentEngine({
      dataStore: adapter,
      controlStore: {
        getActiveRuleset: () => ({ rulesAst: { version: 1, rules: [
          { match: "users/{id}", allow: { get: true, delete: true } },
          { match: "posts/{id}", allow: { get: false, delete: false } },
        ] } }),
        getRelationRules: a.getRelationRules.bind(a),
        incrementUsage: () => undefined,
      },
    });
    const caller = { projectId, apiKeyRecord: publicKey };
    await engine.createDocument({ ...tenant, path: "users/secure", data: { ok: true } });
    await engine.createDocument({ ...tenant, path: "posts/secret-dependent", data: { authorId: { $ref: "users/secure" }, private: "hidden-content" } });
    await expect(securedEngine.getDocument({ ...caller, path: "posts/secret-dependent" })).rejects.toThrow();
    await a.replaceRelationRules({ projectId, rules: [{ ...edge, onDelete: "restrict" }] });
    let failure: unknown;
    try { await securedEngine.deleteDocument({ ...caller, path: "users/secure" }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "RELATION_RESTRICT_VIOLATION" });
    expect(JSON.stringify(failure)).not.toMatch(/secret-dependent|hidden-content|authorId/);
    await a.replaceRelationRules({ projectId, rules: [edge] });
    await securedEngine.deleteDocument({ ...caller, path: "users/secure" });
    await expect(engine.getDocument({ ...tenant, path: "posts/secret-dependent" })).rejects.toThrow();
  });

  it("referencedBy pages exact nested/array/tagged matches with strict field and collection filters", async () => {
    await engine.createDocument({ ...tenant, path: "people/lookup", data: { label: "target" } });
    const samples = [
      ["edges/a", { ref: "people/lookup" }],
      ["edges/b", { ref: { $ref: "people/lookup" } }],
      ["edges/c", { nested: { values: ["people/lookup"] } }],
      ["edges/d", { nested: [{ values: "people/lookup" }] }],
      ["edges/e", { ref: "lookup" }],
      ["otheredges/a", { ref: "people/lookup" }],
    ] as const;
    for (const [path, fields] of samples) await engine.createDocument({ ...tenant, path, data: fields });
    const first = await engine.referencedBy({ ...tenant, request: { targetPath: "people/lookup", collection: "edges", limit: 2 } });
    expect(first.documents.map((row) => row.path)).toEqual(["edges/a", "edges/b"]);
    const second = await engine.referencedBy({ ...tenant, request: { targetPath: "people/lookup", collection: "edges", limit: 2, cursor: first.nextCursor! } });
    expect(second.documents.map((row) => row.path)).toEqual(["edges/c", "edges/d"]);
    expect(second.nextCursor).toBeNull();
    const nested = await engine.referencedBy({ ...tenant, request: { targetPath: "people/lookup", field: "nested.values" } });
    expect(nested.documents.map((row) => row.path)).toEqual(["edges/c"]);
    const whole = await engine.referencedBy({ ...tenant, request: { targetPath: "people/lookup" } });
    expect(whole.documents.map((row) => row.path)).toEqual(["edges/a", "edges/b", "edges/c", "edges/d", "otheredges/a"]);
  });

  it("referencedBy filters per-row Security Rules under non-owner PostgreSQL RLS", async () => {
    const key = {
      id: randomUUID(), projectId, name: "lookup", keyType: "public" as const,
      keyPrefix: "pk_lookup_test", secretHash: "unused", scopes: ["documents:read"], rateLimitRps: 1000,
      lastUsedAt: null, expiresAt: null, revokedAt: null, createdBy: null, createdAt: new Date().toISOString(),
    };
    const secured = new DocumentEngine({ dataStore: adapter, controlStore: {
      getActiveRuleset: () => ({ rulesAst: { version: 1, rules: [
        { match: "people/{id}", allow: { get: true } },
        { match: "edges/{id}", allow: { get: { op: "==", left: { var: "path.id" }, right: { val: "b" } }, list: true } },
      ] } }), incrementUsage: () => undefined,
    } });
    const result = await secured.referencedBy({ projectId, apiKeyRecord: key, request: { targetPath: "people/lookup", limit: 1 } });
    expect(result.documents.map((row) => row.path)).toEqual(["edges/b"]);
    expect(result.nextCursor).toBeNull();
    const wrongProject = { projectId: randomUUID(), internal: true as const };
    await expect(engine.referencedBy({ ...wrongProject, request: { targetPath: "people/lookup" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("indexes recursive reverse lookup and supports rollback/reapply", async () => {
    const migration = fs.readFileSync(new URL("../../packages/database-data/migrations/0012_referenced_by_gin.sql", import.meta.url), "utf8");
    await data.query("BEGIN");
    try {
      await data.query("CREATE TEMP TABLE documents(path text, data jsonb, deleted_at timestamptz) ON COMMIT DROP");
      await data.query(migration);
      await data.query("SET LOCAL enable_seqscan=off; SET LOCAL enable_indexscan=off");
      const explain = await data.query("EXPLAIN SELECT path FROM documents WHERE deleted_at IS NULL AND data @? $1::jsonpath", ['strict $.** ? (@ == "people/lookup")']);
      const plan = explain.rows.map((row) => row["QUERY PLAN"]).join("\n");
      expect(plan).toContain("idx_docs_reverse_reference_gin_active");
      expect(plan).toContain("Index Cond:");
      await data.query("DROP INDEX pg_temp.idx_docs_reverse_reference_gin_active");
      await data.query(migration);
    } finally { await data.query("ROLLBACK"); }
  });

  it("delivers opt-in resolved/redacted includes over real WebSockets backed by PostgreSQL RLS", async () => {
    const keys = new Map<string, ApiKeyRecord>();
    const rawServer = `sk_${"c".repeat(32)}`;
    const rawPublic = `pk_${"d".repeat(32)}`;
    for (const [raw, keyType] of [[rawServer, "server"], [rawPublic, "public"]] as const) {
      keys.set(raw.slice(0, 16), { id: randomUUID(), projectId, name: "WS PG", keyType,
        keyPrefix: raw.slice(0, 16), secretHash: hashApiKey(raw), scopes: ["documents:read"], rateLimitRps: 1000,
        lastUsedAt: null, expiresAt: null, revokedAt: null, createdBy: null, createdAt: new Date().toISOString() });
    }
    const hub = new RealtimeGatewayHub({ dataStore: adapter, controlStore: {
      apiKeysByPrefix: keys, getProject: () => ({ id: projectId }), incrementUsage: () => undefined,
      getActiveRuleset: () => ({ id: "ws-rules", projectId, version: 1, isActive: true, createdBy: null, createdAt: new Date().toISOString(),
        rulesAst: { version: 1, rules: [
          { match: "posts/{id}", allow: { get: true, list: true } },
          { match: "users/{id}", allow: { get: false } },
        ] } }),
    } });
    await engine.createDocument({ ...tenant, path: "users/ws-author", data: { name: "PG private author" } });
    await engine.createDocument({ ...tenant, path: "posts/ws-parent", data: { author: { $ref: "users/ws-author" } } });
    const server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    const ws = attachRealtimeWebSocketServer(server, hub);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const clients = [rawServer, rawPublic].map((apiKey) => createClient({ projectId, apiKey, endpoint: `http://127.0.0.1:${port}` }));
    const snapshots: RealtimeSnapshot[][] = [[], []];
    const failures: unknown[] = [];
    try {
      for (let index = 0; index < clients.length; index++) clients[index]!.doc("posts/ws-parent").onSnapshot(
        (snapshot) => snapshots[index]!.push(snapshot), (error) => failures.push(error), { resolveIncludes: true, include: ["author"] });
      await until(() => snapshots.every((items) => items.length > 0) || failures.length > 0);
      expect(failures).toEqual([]);
      expect(snapshots[0]![0]!.docs[0]!.included?.["author"]).toMatchObject({ data: { name: "PG private author" } });
      expect(snapshots[1]![0]!.docs[0]!.included?.["author"]).toBeNull();
      expect(snapshots[1]![0]!.docs[0]!.redactedRefs).toContain("author");
      await engine.updateDocument({ ...tenant, path: "posts/ws-parent", data: { title: "live update" } });
      const event = (await adapter.queryOutboxSince(tenant)).at(-1)!;
      hub.watermarks.set(projectId, BigInt(event.seqId) - 1n);
      await hub.notifyCommittedEvents(projectId, [event]);
      await until(() => snapshots.every((items) => items.length >= 2) || failures.length > 0);
      expect(failures).toEqual([]);
      expect(snapshots[0]!.at(-1)!.docs[0]!.included?.["author"]).toMatchObject({ data: { name: "PG private author" } });
      expect(JSON.stringify(snapshots[1]!.at(-1)!.docs[0]!.included)).not.toContain("PG private author");
    } finally {
      for (const client of clients) client.dispose();
      ws.closeAllWebSockets();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

});
