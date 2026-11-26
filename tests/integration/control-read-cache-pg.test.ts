import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgControlPlaneStore } from "@vellum/database-control/adapters";
import { createRawPgClient, type RawPgClient } from "@vellum/database-control";

const controlUrl = process.env.CONTROL_DATABASE_URL;
const enabled = process.env.CONTROL_CACHE_PG_TEST === "1";
const projectId = randomUUID();
const orgId = randomUUID();
const TTL = 400;
let raw: RawPgClient;
let a: PgControlPlaneStore;
let b: PgControlPlaneStore;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function countQueries(store: PgControlPlaneStore): { n: () => number } {
  const pool = (store as unknown as { pool: { query: (...a: unknown[]) => unknown } }).pool;
  const orig = pool.query.bind(pool);
  let n = 0;
  pool.query = (...args: unknown[]) => {
    n += 1;
    return orig(...args);
  };
  return { n: () => n };
}

// Two stores stand in for two API instances; only PostgreSQL is shared.
describe.skipIf(!enabled)("control-plane hot-path reads are cached for a few seconds", () => {
  beforeAll(async () => {
    process.env["CONTROL_READ_CACHE_TTL_MS"] = String(TTL);
    raw = createRawPgClient({ connectionString: controlUrl! });
    await raw.connect();
    await raw.query("INSERT INTO organizations(id,slug,name,billing_email) VALUES($1,$2,'Cache PG','c@example.invalid')", [orgId, `cc-${orgId}`]);
    await raw.query("INSERT INTO projects(id,organization_id,slug,name) VALUES($1,$2,'cache-pg','Cache PG')", [projectId, orgId]);
    a = new PgControlPlaneStore({ connectionString: controlUrl! });
    b = new PgControlPlaneStore({ connectionString: controlUrl! });
  }, 30000);

  afterAll(async () => {
    await raw.query("DELETE FROM audit_logs WHERE project_id=$1", [projectId]);
    await raw.query("DELETE FROM security_rulesets WHERE project_id=$1", [projectId]);
    await raw.query("DELETE FROM projects WHERE id=$1", [projectId]);
    await raw.query("DELETE FROM organizations WHERE id=$1", [orgId]);
    await raw.end();
    await Promise.all([a.close(), b.close()]);
  });

  it("repeated project and ruleset reads hit PostgreSQL once per TTL", async () => {
    const q = countQueries(a);
    for (let i = 0; i < 50; i += 1) {
      await a.getProjectAsync(projectId);
      await a.getActiveRulesetAsync(projectId);
    }
    // project is cached; a null ruleset is deliberately not cached, so it is read each time
    expect(q.n()).toBe(1 + 50);
    await a.publishSecurityRuleset({ projectId, rulesAst: { v: 1 } });
    const q2 = countQueries(a);
    for (let i = 0; i < 50; i += 1) await a.getActiveRulesetAsync(projectId);
    expect(q2.n()).toBe(1);
  });

  it("a ruleset published on instance A is applied by A immediately and by B within the TTL", async () => {
    expect(((await b.getActiveRulesetAsync(projectId))?.rulesAst as { v: number }).v).toBe(1);
    await a.publishSecurityRuleset({ projectId, rulesAst: { v: 2 } });
    expect(((await a.getActiveRulesetAsync(projectId))?.rulesAst as { v: number }).v).toBe(2);
    await sleep(TTL + 100);
    expect(((await b.getActiveRulesetAsync(projectId))?.rulesAst as { v: number }).v).toBe(2);
  });

  it("callers cannot corrupt the cache by mutating a result, and invalidateReadCache applies a change at once", async () => {
    const first = (await a.getActiveRulesetAsync(projectId))!;
    (first.rulesAst as { v: number }).v = 999;
    expect(((await a.getActiveRulesetAsync(projectId))?.rulesAst as { v: number }).v).toBe(2);
    await raw.query("UPDATE security_rulesets SET rules_ast = '{\"v\":3}'::jsonb WHERE project_id=$1 AND is_active", [projectId]);
    expect(((await a.getActiveRulesetAsync(projectId))?.rulesAst as { v: number }).v).toBe(2);
    a.invalidateReadCache();
    expect(((await a.getActiveRulesetAsync(projectId))?.rulesAst as { v: number }).v).toBe(3);
  });

  it("a project suspended behind the cache is refused once the TTL passes, and errors are never cached", async () => {
    await b.getProjectAsync(projectId);
    await raw.query("UPDATE projects SET status='suspended' WHERE id=$1", [projectId]);
    await sleep(TTL + 100);
    await expect(b.getProjectAsync(projectId)).rejects.toThrow(/suspended/);
    await raw.query("UPDATE projects SET status='active' WHERE id=$1", [projectId]);
    expect((await b.getProjectAsync(projectId)).project.id).toBe(projectId);
  });
});
