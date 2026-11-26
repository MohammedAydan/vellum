import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentEngine } from "@vellum/document-engine";
import { PgStorageAdapter } from "@vellum/storage/adapters";
import { createRawPgClient } from "@vellum/database-control";

const url = process.env.DATA_DATABASE_URL;
const enabled = process.env.HOT_PG_TEST === "1";
const projectId = randomUUID();
const T = { projectId, internal: true as const };
class Control { getActiveRuleset() { return null; } incrementUsage() {} }

// Real PostgreSQL: HOT_PG_TEST=1 DATA_DATABASE_URL=... npx vitest run tests/integration/hot-doc-pg.test.ts
describe.skipIf(!enabled)("contended blind writes on PostgreSQL", () => {
  let store: PgStorageAdapter;
  let engine: DocumentEngine;

  beforeAll(async () => {
    if (!url) throw new Error("hot doc PG test requires DATA_DATABASE_URL");
    store = new PgStorageAdapter({ connectionString: url, maxConnections: 10 });
    engine = new DocumentEngine({ controlStore: new Control() as never, dataStore: store });
    await engine.createDocument({ ...T, path: "hot/counter", data: { counter: 0 } });
    await engine.createDocument({ ...T, path: "hot/a", data: { n: 0 } });
    await engine.createDocument({ ...T, path: "hot/b", data: { n: 0 } });
  }, 30000);

  afterAll(async () => {
    const raw = createRawPgClient({ connectionString: url! });
    await raw.connect();
    await raw.query("SELECT set_config('app.current_project_id', $1, false)", [projectId]);
    await raw.query("DELETE FROM realtime_outbox WHERE project_id = $1::uuid", [projectId]);
    await raw.query("DELETE FROM documents WHERE project_id = $1::uuid", [projectId]);
    await raw.end();
    await (store as unknown as { close?: () => Promise<void> }).close?.();
  });

  it("200 concurrent increments on one document all apply, none fail", async () => {
    let next = 0;
    const errors: unknown[] = [];
    await Promise.all(Array.from({ length: 20 }, async () => {
      while (next++ < 200) {
        try {
          await engine.updateDocument({ ...T, path: "hot/counter", data: { counter: { $op: "increment", by: 1 } } });
        } catch (e) { errors.push(e); }
      }
    }));
    expect(errors).toHaveLength(0);
    const doc = await engine.getDocument({ ...T, path: "hot/counter" });
    expect((doc as { data: { counter: number } }).data.counter).toBe(200);
  }, 60000);

  it("overlapping batches that list the same paths in opposite order do not deadlock", async () => {
    const ab = [{ type: "update" as const, path: "hot/a", data: { n: { $op: "increment", by: 1 } } }, { type: "update" as const, path: "hot/b", data: { n: { $op: "increment", by: 1 } } }];
    const ba = [...ab].reverse();
    const results = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => engine.batchWrite({ ...T, writes: (i % 2 ? ab : ba) as never })));
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    const a = await engine.getDocument({ ...T, path: "hot/a" });
    const b = await engine.getDocument({ ...T, path: "hot/b" });
    expect((a as { data: { n: number } }).data.n).toBe(60);
    expect((b as { data: { n: number } }).data.n).toBe(60);
  }, 60000);

  it("60 concurrent blind sets of a document that does not exist yet leave an exact version history", async () => {
    let next = 0;
    const versions: number[] = [];
    await Promise.all(Array.from({ length: 20 }, async () => {
      while (next < 60) {
        const n = next++;
        const r = await engine.setDocument({ ...T, path: "hot/fresh", data: { n } });
        versions.push(Number((r as { version: number }).version));
      }
    }));
    expect(new Set(versions).size).toBe(60);
    const doc = await engine.getDocument({ ...T, path: "hot/fresh" });
    expect(Number((doc as { version: number }).version)).toBe(60);
  }, 60000);
});
