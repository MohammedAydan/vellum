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
