import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentEngine } from "@vellum/document-engine";
import { PgStorageAdapter } from "@vellum/storage/adapters";
import { createRawPgClient } from "@vellum/database-control";

const url = process.env.DATA_DATABASE_URL;
const enabled = process.env.SCAN_PG_TEST === "1";
const projectId = randomUUID();
const TENANT = { projectId, internal: true as const };

class Control {
  getActiveRuleset() { return null; }
  incrementUsage() {}
}

// Real PostgreSQL: run migrations first, then SCAN_PG_TEST=1 DATA_DATABASE_URL=... npx vitest run tests/integration/scan-cap-pg.test.ts
describe.skipIf(!enabled)("unindexed scan cap on PostgreSQL", () => {
  let store: PgStorageAdapter;
  let engine: DocumentEngine;
  const previous = process.env.VELLUM_UNINDEXED_QUERY_MAX_DOCS;

  beforeAll(async () => {
    if (!url) throw new Error("scan cap PG test requires DATA_DATABASE_URL");
    process.env.VELLUM_UNINDEXED_QUERY_MAX_DOCS = "100";
    store = new PgStorageAdapter({ connectionString: url });
    engine = new DocumentEngine({ controlStore: new Control() as never, dataStore: store });
    for (let i = 0; i < 150; i++) {
      await engine.createDocument({ ...TENANT, path: `items/i${String(i).padStart(4, "0")}`, data: { n: i, kind: i % 2 ? "a" : "b" } });
    }
    for (let i = 0; i < 20; i++) {
      await engine.createDocument({ ...TENANT, path: `small/s${i}`, data: { n: i } });
    }
  }, 60000);

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

  it("refuses a range filter on a collection over the limit and names the index", async () => {
    await expect(
      engine.executeQuery({ ...TENANT, querySpec: { collectionPath: "items", where: [{ field: "n", op: ">", value: 10 }], limit: 10 } })
    ).rejects.toMatchObject({
      code: "FAILED_PRECONDITION",
      details: { maxUnindexedDocs: 100, suggestedIndex: { fields: [{ path: "n", dir: "asc" }] } },
    });
  });

  it("refuses a single-field custom order and search the same way", async () => {
    await expect(
      engine.executeQuery({ ...TENANT, querySpec: { collectionPath: "items", orderBy: [{ field: "n", dir: "desc" }], limit: 10 } })
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
    await expect(
      engine.executeQuery({ ...TENANT, querySpec: { collectionPath: "items", search: "i00", limit: 10 } })
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
  });

  it("still serves equality, in, and system-field orders on the big collection", async () => {
    const eq = await engine.executeQuery({ ...TENANT, querySpec: { collectionPath: "items", where: [{ field: "kind", op: "==", value: "a" }], limit: 10 } });
    expect(eq.documents).toHaveLength(10);
    const ord = await engine.executeQuery({ ...TENANT, querySpec: { collectionPath: "items", orderBy: [{ field: "updatedAt", dir: "desc" }], limit: 10 } });
    expect(ord.documents).toHaveLength(10);
  });

  it("serves the same risky shapes on a collection under the limit", async () => {
    const r = await engine.executeQuery({ ...TENANT, querySpec: { collectionPath: "small", where: [{ field: "n", op: ">", value: 10 }], orderBy: [{ field: "n", dir: "asc" }], limit: 50 } });
    expect(r.documents).toHaveLength(9);
  });
});
