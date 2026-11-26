import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgControlPlaneStore } from "@vellum/database-control/adapters";
import { createRawPgClient, type RawPgClient } from "@vellum/database-control";

const controlUrl = process.env.CONTROL_DATABASE_URL;
const enabled = process.env.CONFIG_PG_TEST === "1";
const projectId = randomUUID();
const orgId = randomUUID();
const userId = randomUUID();
let raw: RawPgClient;
let a: PgControlPlaneStore;
let b: PgControlPlaneStore;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

// Two independent stores stand in for two API instances. Nothing is shared except PostgreSQL.
describe.skipIf(!enabled)("rulesets, auth config, projects and users are read from PostgreSQL", () => {
  beforeAll(async () => {
    if (!controlUrl) throw new Error("config PG tests require CONTROL_DATABASE_URL");
    raw = createRawPgClient({ connectionString: controlUrl });
    await raw.connect();
    await raw.query("INSERT INTO organizations(id,slug,name,billing_email) VALUES($1,$2,'Cfg PG','cfg@example.invalid')", [orgId, `cfg-${orgId}`]);
    await raw.query("INSERT INTO projects(id,organization_id,slug,name) VALUES($1,$2,'cfg-pg','Cfg PG')", [projectId, orgId]);
    await raw.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Cfg User')", [userId, `cfg-${userId}@example.invalid`]);
    // This suite proves the uncached read path; the short-TTL cache has its own suite (control-read-cache-pg).
    process.env["CONTROL_READ_CACHE_TTL_MS"] = "0";
    a = new PgControlPlaneStore({ connectionString: controlUrl });
    b = new PgControlPlaneStore({ connectionString: controlUrl });
  }, 30000);

  afterAll(async () => {
    await raw.query("DELETE FROM security_rulesets WHERE project_id=$1", [projectId]);
    await raw.query("DELETE FROM project_auth_configs WHERE project_id=$1", [projectId]);
    await raw.query("DELETE FROM audit_logs WHERE project_id=$1", [projectId]);
    await raw.query("DELETE FROM projects WHERE id=$1", [projectId]);
    await raw.query("DELETE FROM organizations WHERE id=$1", [orgId]);
    await raw.query("DELETE FROM users WHERE id=$1", [userId]);
    await raw.end();
    await Promise.all([a.close(), b.close()]);
  });

  it("a ruleset published through A is the active ruleset on B at once, and a rollback too", async () => {
    expect(await b.getActiveRulesetAsync(projectId)).toBeNull();
    const v1 = await a.publishSecurityRuleset({ projectId, rulesAst: { rules: [{ match: "/a/{id}", allow: ["read"] }] } });
    expect((await b.getActiveRulesetAsync(projectId))?.version).toBe(v1.version);
    const v2 = await a.publishSecurityRuleset({ projectId, rulesAst: { rules: [] } });
    const seen = await b.getActiveRulesetAsync(projectId);
    expect(seen?.version).toBe(v2.version);
    expect(seen?.rulesAst).toEqual({ rules: [] });
  });

  it("a project suspended in the database is refused by the other instance immediately", async () => {
    expect((await b.getProjectAsync(projectId)).project.id).toBe(projectId);
    await raw.query("UPDATE projects SET status='suspended' WHERE id=$1", [projectId]);
    await expect(b.getProjectAsync(projectId)).rejects.toThrow(/suspended/i);
    expect((await b.findProjectById(projectId))?.status).toBe("suspended");
    await raw.query("UPDATE projects SET status='active' WHERE id=$1", [projectId]);
    expect((await b.getProjectAsync(projectId)).project.id).toBe(projectId);
    await expect(b.getProjectAsync(randomUUID())).rejects.toThrow(/not found/i);
  });

  it("super admin demotion and suspension apply on the next call", async () => {
    expect(await b.isPlatformSuperAdmin(userId)).toBe(false);
    await raw.query("UPDATE users SET is_platform_super_admin=true WHERE id=$1", [userId]);
    expect(await b.isPlatformSuperAdmin(userId)).toBe(true);
    await raw.query("UPDATE users SET is_suspended=true WHERE id=$1", [userId]);
    expect(await b.isPlatformSuperAdmin(userId)).toBe(false);
    expect((await b.findUserById(userId))?.isSuspended).toBe(true);
    await raw.query("UPDATE users SET is_platform_super_admin=false, is_suspended=false WHERE id=$1", [userId]);
    expect(await b.findUserById(randomUUID())).toBeNull();
  });

  it("auth config written through A is read on B at once", async () => {
    expect(await b.getAuthConfigAsync(projectId)).toBeNull();
    await a.upsertAuthConfig({ projectId, jwtKeyId: "k1", jwtPublicKeyPem: "pem", jwtPrivateKeyEncrypted: "enc", authServiceSuspended: true });
    expect((await b.getAuthConfigAsync(projectId))?.authServiceSuspended).toBe(true);
    await a.upsertAuthConfig({ projectId, jwtKeyId: "k1", jwtPublicKeyPem: "pem", jwtPrivateKeyEncrypted: "enc", authServiceSuspended: false });
    expect((await b.getAuthConfigAsync(projectId))?.authServiceSuspended).toBe(false);
  });

  it("uses indexes and reports latency", async () => {
    await raw.query("SET enable_seqscan = off");
    const plans = await Promise.all([
      raw.query(`EXPLAIN SELECT id FROM security_rulesets WHERE project_id = '${projectId}' AND is_active = true LIMIT 1`),
      raw.query(`EXPLAIN SELECT id FROM project_auth_configs WHERE project_id = '${projectId}'`),
      raw.query(`EXPLAIN SELECT id FROM projects WHERE id = '${projectId}'`),
      raw.query(`EXPLAIN SELECT id FROM users WHERE id = '${userId}'`),
    ]);
    await raw.query("RESET enable_seqscan");
    for (const plan of plans) expect(JSON.stringify(plan.rows)).toMatch(/Index/);
    for (const [name, fn] of [
      ["getActiveRulesetAsync", () => b.getActiveRulesetAsync(projectId)],
      ["getAuthConfigAsync", () => b.getAuthConfigAsync(projectId)],
      ["getProjectAsync", () => b.getProjectAsync(projectId)],
      ["findUserById", () => b.findUserById(userId)],
    ] as const) {
      const samples: number[] = [];
      for (let i = 0; i < 200; i += 1) {
        const t = performance.now();
        await fn();
        samples.push(performance.now() - t);
      }
      samples.sort((x, y) => x - y);
      console.log(`${name} ms p50=${percentile(samples, 50).toFixed(2)} p95=${percentile(samples, 95).toFixed(2)} p99=${percentile(samples, 99).toFixed(2)}`);
      expect(percentile(samples, 99)).toBeLessThan(250);
    }
  });
});
