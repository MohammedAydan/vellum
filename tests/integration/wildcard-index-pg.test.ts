import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentEngine } from "@vellum/document-engine";
import { PgStorageAdapter } from "@vellum/storage/adapters";
import { createRawPgClient } from "@vellum/database-control";

const url = process.env.DATA_DATABASE_URL;
const enabled = process.env.WILDCARD_PG_TEST === "1";
const projectId = randomUUID();
const TENANT = { projectId, internal: true as const };

class Control {
  getActiveRuleset() { return null; }
  incrementUsage() {}
}

// Recipe 6 (0.0.10 P1-1.1): a wildcard template index must cover every parent's subcollection once the
// collection is over the unindexed-scan cap. The cap is lowered to 100 so the same code path runs without
// writing 50,000 rows; the 84k-row benchmark is recorded in ADR-006.
describe.skipIf(!enabled)("wildcard template index on PostgreSQL", () => {
  let store: PgStorageAdapter;
  let engine: DocumentEngine;
  const previous = process.env.VELLUM_UNINDEXED_QUERY_MAX_DOCS;
  const parents = ["c1", "c2", "c3"];
  const perParent = 60;

  beforeAll(async () => {
    if (!url) throw new Error("wildcard index PG test requires DATA_DATABASE_URL");
    process.env.VELLUM_UNINDEXED_QUERY_MAX_DOCS = "100";
    store = new PgStorageAdapter({ connectionString: url });
    engine = new DocumentEngine({ controlStore: new Control() as never, dataStore: store });
    for (const p of parents) {
      for (let i = 0; i < perParent; i++) {
        // Same document ids under every parent on purpose: the index key must include the concrete path.
        await engine.createDocument({ ...TENANT, path: `chats/${p}/messages/m${String(i).padStart(3, "0")}`, data: { n: i, from: p } });
      }
    }
  }, 120000);

  afterAll(async () => {
    if (previous === undefined) delete process.env.VELLUM_UNINDEXED_QUERY_MAX_DOCS;
    else process.env.VELLUM_UNINDEXED_QUERY_MAX_DOCS = previous;
    const raw = createRawPgClient({ connectionString: url! });
    await raw.connect();
    await raw.query("SELECT set_config('app.current_project_id', $1, false)", [projectId]);
    await raw.query("DELETE FROM documents WHERE project_id = $1::uuid", [projectId]);
    await raw.end();
    await (store as unknown as { close?: () => Promise<void> }).close?.();
  });

  const query = (parent: string) =>
    engine.executeQuery({
      ...TENANT,
      querySpec: { collectionPath: `chats/${parent}/messages`, where: [{ field: "n", op: ">=", value: 10 }], orderBy: [{ field: "n", dir: "asc" }], limit: 100 },
    });

  it("is covered for every parent after one template index is built, with correct rows and no dropped entries", async () => {
    await store.createCompositeIndex(TENANT, "chats/*/messages", [{ path: "n", dir: "asc" }]);
    await store.runIndexBuilderWorker();
    for (const p of parents) {
      const r = await query(p);
      expect(r.documents).toHaveLength(perParent - 10);
      expect(r.documents.every((d: { data?: { from?: string } }) => (d.data?.from ?? p) === p)).toBe(true);
    }
    const raw = createRawPgClient({ connectionString: url! });
    await raw.connect();
    await raw.query("SELECT set_config('app.current_project_id', $1, false)", [projectId]);
    const res = await raw.query("SELECT count(*)::int AS c FROM document_index_entries WHERE project_id = $1::uuid", [projectId]);
    await raw.end();
    expect(res.rows[0].c).toBe(parents.length * perParent);
  }, 60000);
});

// Recipe 6 at the real default cap: 50,100 documents seeded in one statement.
describe.skipIf(!enabled)("wildcard template index at 50,100 documents (default scan cap)", () => {
  const pid = randomUUID();
  const T = { projectId: pid, internal: true as const };
  let store: PgStorageAdapter;
  let engine: DocumentEngine;

  beforeAll(async () => {
    if (!url) throw new Error("wildcard index PG test requires DATA_DATABASE_URL");
    delete process.env.VELLUM_UNINDEXED_QUERY_MAX_DOCS;
    store = new PgStorageAdapter({ connectionString: url });
    engine = new DocumentEngine({ controlStore: new Control() as never, dataStore: store });
    const raw = createRawPgClient({ connectionString: url });
    await raw.connect();
    await raw.query("SELECT set_config('app.current_project_id', $1, false)", [pid]);
    await raw.query(
      `INSERT INTO documents (project_id, path, collection_path, collection_group, document_id, path_depth, data, size_bytes)
       SELECT $1::uuid, 'chats/idx_test/messages/m' || lpad(g::text, 6, '0'), 'chats/idx_test/messages', 'messages',
              'm' || lpad(g::text, 6, '0'), 4, jsonb_build_object('seq', g, 'text', CASE WHEN g % 1000 = 0 THEN 'launch day' ELSE 'hello' END,
              'tag', 't' || (g % 500), 'tags', jsonb_build_array('a' || (g % 700), 'b' || (g % 11)), 'grp', g % 10), 60
       FROM generate_series(0, 50099) g`,
      [pid]
    );
    await raw.end();
  }, 180000);

  afterAll(async () => {
    const raw = createRawPgClient({ connectionString: url! });
    await raw.connect();
    await raw.query("SELECT set_config('app.current_project_id', $1, false)", [pid]);
    await raw.query("DELETE FROM documents WHERE project_id = $1::uuid", [pid]);
    await raw.end();
    await (store as unknown as { close?: () => Promise<void> }).close?.();
  });

  it("refuses unindexed orderBy(seq) with the chats/*/messages template; the template index serves it, including deep cursors", async () => {
    const q = { collectionPath: "chats/idx_test/messages", orderBy: [{ field: "seq", dir: "asc" as const }], limit: 30 };
    await expect(engine.executeQuery({ ...T, querySpec: q })).rejects.toMatchObject({
      code: "FAILED_PRECONDITION",
      details: { suggestedIndex: { collectionPath: "chats/*/messages", fields: [{ path: "seq", dir: "asc" }] } },
    });
    await store.createCompositeIndex(T, "chats/*/messages", [{ path: "seq", dir: "asc" }]);
    await store.runIndexBuilderWorker();
    const page1 = await engine.executeQuery({ ...T, querySpec: q });
    expect(page1.documents).toHaveLength(30);
    expect(page1.documents[0]!.data["seq"]).toBe(0);
    let cursor = page1.nextCursor as string | undefined;
    let last = page1;
    for (let hop = 0; hop < 5 && cursor; hop += 1) {
      last = await engine.executeQuery({ ...T, querySpec: { ...q, startAfter: cursor } });
      cursor = last.nextCursor as string | undefined;
    }
    expect(last.documents[0]!.data["seq"]).toBe(150);
  }, 180000);

  it("text_search above the cap is refused with a template suggestion instead of scanning", async () => {
    await expect(
      engine.executeQuery({ ...T, querySpec: { collectionPath: "chats/idx_test/messages", where: [{ field: "text", op: "text_search", value: "launch" }], limit: 10 } })
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION", details: { suggestedIndex: { collectionPath: "chats/*/messages", fields: [{ path: "text", dir: "text" }] } } });
  }, 120000);

  it("Recipe 6: after creating the suggested full-text index, text_search succeeds at 50,100 docs through the GIN lookup", async () => {
    const q = { collectionPath: "chats/idx_test/messages", where: [{ field: "text", op: "text_search" as const, value: "launch" }], limit: 100 };
    const err = (await engine.executeQuery({ ...T, querySpec: q }).catch((e: unknown) => e)) as { details?: { suggestedIndex?: { fields: Array<{ path: string; dir: "asc" | "desc" | "text" }> } } };
    const fields = err.details?.suggestedIndex?.fields;
    expect(fields).toEqual([{ path: "text", dir: "text" }]);
    await store.createCompositeIndex(T, "chats/*/messages", fields!);
    await store.runIndexBuilderWorker();
    const res = await engine.executeQuery({ ...T, querySpec: q });
    // 50,100 docs, one in 1,000 says "launch day": seq 0, 1000, ... 50000 = 51 matches.
    expect(res.documents).toHaveLength(51);
    for (const d of res.documents) expect(String(d.data["text"])).toContain("launch");
  }, 180000);

  it("search is served by the whole-document full-text index at 50,100 docs", async () => {
    const q = { collectionPath: "chats/idx_test/messages", search: "launch", limit: 100 };
    const err = (await engine.executeQuery({ ...T, querySpec: q }).catch((e: unknown) => e)) as { details?: { suggestedIndex?: { fields: Array<{ path: string; dir: "asc" | "desc" | "text" }> } } };
    const fields = err.details?.suggestedIndex?.fields;
    expect(fields).toEqual([{ path: "*", dir: "text" }]);
    await store.createCompositeIndex(T, "chats/*/messages", fields!);
    await store.runIndexBuilderWorker();
    const res = await engine.executeQuery({ ...T, querySpec: q });
    expect(res.documents).toHaveLength(51);
  }, 180000);

  // EXPLAIN (ANALYZE) on the real SQL each query shape runs on a 50,100-document collection. Indexed shapes
  // must never read documents or index entries with a sequential scan; unindexed shapes must be refused
  // before they reach SQL. Plans are checked after ANALYZE (in production autovacuum keeps statistics fresh).
  it("EXPLAIN ANALYZE: no sequential scan on eq, in, array-contains, range+composite, orderBy+composite, text_search, search", async () => {
    const plans: Array<{ sql: string; params: unknown[] }> = [];
    (globalThis as { __vellumPlanSpy?: (c: { sql: string; params: unknown[] }) => void }).__vellumPlanSpy = (c) => plans.push({ sql: c.sql, params: c.params });
    const col = "chats/idx_test/messages";
    const run = async (name: string, querySpec: Record<string, unknown>) => {
      plans.length = 0;
      const res = await engine.executeQuery({ ...T, querySpec: { collectionPath: col, limit: 50, ...querySpec } as never }).catch((e: unknown) => {
        throw new Error(`shape '${name}' failed: ${(e as Error).message}`);
      });
      expect(plans.length, name).toBeGreaterThan(0);
      return { res, plan: plans[0]! };
    };
    const ensureIndex = async (fields: Array<{ path: string; dir: "asc" | "desc" | "text" }>) => {
      await store.createCompositeIndex(T, "chats/*/messages", fields as never).catch(() => undefined);
    };
    // A "scan" is a Seq Scan, or an index scan that reads most of the collection and filters rows away.
    const seqScans = (node: Record<string, unknown>, out: string[] = []): string[] => {
      if (node["Node Type"] === "Seq Scan") out.push(String(node["Relation Name"]));
      const removed = Number(node["Rows Removed by Filter"] ?? 0);
      if (removed > 5000) out.push(`${String(node["Relation Name"])}(filtered ${removed} rows)`);
      for (const child of (node["Plans"] as Array<Record<string, unknown>> | undefined) ?? []) seqScans(child, out);
      return out;
    };
    const explain = async (sql: string, params: unknown[]) => {
      const raw = createRawPgClient({ connectionString: url! });
      await raw.connect();
      await raw.query("SELECT set_config('app.current_project_id', $1, false)", [pid]);
      const r = await raw.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
      await raw.end();
      const doc = (r.rows[0]["QUERY PLAN"] as Array<{ Plan: Record<string, unknown>; "Execution Time": number }>)[0]!;
      return { seq: seqScans(doc.Plan), ms: doc["Execution Time"] };
    };

    // Unindexed shapes are refused, never executed as a scan.
    await expect(engine.executeQuery({ ...T, querySpec: { collectionPath: col, where: [{ field: "grp", op: ">=", value: 5 }], orderBy: [{ field: "grp", dir: "asc" }], limit: 50 } as never })).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
    await expect(engine.executeQuery({ ...T, querySpec: { collectionPath: col, orderBy: [{ field: "grp", dir: "asc" }], limit: 50 } as never })).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });

    await ensureIndex([{ path: "seq", dir: "asc" }]);
    await ensureIndex([{ path: "grp", dir: "asc" }]);
    await ensureIndex([{ path: "text", dir: "text" }]);
    await ensureIndex([{ path: "*", dir: "text" }]);
    await store.runIndexBuilderWorker();

    const shapes: Array<[string, Record<string, unknown>]> = [
      ["eq", { where: [{ field: "tag", op: "==", value: "t7" }] }],
      ["in", { where: [{ field: "tag", op: "in", value: ["t7", "t8", "t9"] }] }],
      ["array-contains", { where: [{ field: "tags", op: "array-contains", value: "a5" }] }],
      ["range + composite index", { where: [{ field: "seq", op: ">=", value: 40000 }], orderBy: [{ field: "seq", dir: "asc" }] }],
      ["orderBy custom field + composite index", { orderBy: [{ field: "grp", dir: "asc" }] }],
      ["text_search", { where: [{ field: "text", op: "text_search", value: "launch" }] }],
      ["search", { search: "launch" }],
    ];
    const report: string[] = [];
    for (const phase of ["analyzed"]) {
      if (phase === "analyzed") {
        const raw = createRawPgClient({ connectionString: url! });
        await raw.connect();
        await raw.query("ANALYZE documents");
        await raw.query("ANALYZE document_index_entries");
        await raw.end();
      }
      for (const [name, spec] of shapes) {
        const { plan } = await run(name, spec);
        const { seq, ms } = await explain(plan.sql, plan.params);
        report.push(`${phase} | ${name} | ${ms.toFixed(1)}ms | seq scans: ${seq.length ? seq.join(",") : "none"}`);
        expect(seq, `${phase}: ${name} must not scan the collection`).toEqual([]);
      }
    }
    console.log("EXPLAIN ANALYZE report (50,100 docs)\n" + report.join("\n"));
    delete (globalThis as { __vellumPlanSpy?: unknown }).__vellumPlanSpy;
  }, 240000);

  it("Recipe 6: aggregate() over more than 10,000 member-scoped rows returns FAILED_PRECONDITION, not PERMISSION_DENIED", async () => {
    class RulesControl { getActiveRuleset() { return { rulesAst: { version: 1, rules: [{ match: "chats/{c}/messages/{m}", allow: { list: { op: "!=", left: { var: "auth.uid" }, right: { val: null } }, get: { op: "!=", left: { var: "resource.data.seq" }, right: { val: null } } } }] } }; } incrementUsage() {} }
    const scoped = new DocumentEngine({ controlStore: new RulesControl() as never, dataStore: store });
    const publicKey = {
      id: "pk", projectId: pid, name: "pk", keyType: "public", keyPrefix: "pk_t", secretHash: "h", scopes: ["documents:read"],
      rateLimitRps: 100, lastUsedAt: null, expiresAt: null, revokedAt: null, createdBy: null, createdAt: new Date().toISOString(),
    };
    await expect(
      scoped.aggregateDocuments({
        projectId: pid,
        apiKeyRecord: publicKey as never,
        authContext: { uid: "u1", claims: {} },
        request: { collectionPath: "chats/idx_test/messages", metrics: { count: { op: "count" } } },
      } as never)
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION", details: { reason: "SCOPED_AGGREGATE_ROW_LIMIT" } });
  }, 180000);
});
