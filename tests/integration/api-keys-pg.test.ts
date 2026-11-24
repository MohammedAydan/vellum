import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateProjectApiKey, verifyApiKeyAsync } from "@vellum/authorization";
import { PgControlPlaneStore } from "@vellum/database-control/adapters";
import { createRawPgClient, type RawPgClient } from "@vellum/database-control";

const controlUrl = process.env.CONTROL_DATABASE_URL;
const enabled = process.env.API_KEYS_PG_TEST === "1";
const projectId = randomUUID();
const orgId = randomUUID();
let raw: RawPgClient;
let a: PgControlPlaneStore;
let b: PgControlPlaneStore;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

// Two independent stores stand in for two API instances. Nothing is shared except PostgreSQL.
describe.skipIf(!enabled)("API keys are read from PostgreSQL on every call", () => {
  beforeAll(async () => {
    if (!controlUrl) throw new Error("API key PG tests require CONTROL_DATABASE_URL");
    raw = createRawPgClient({ connectionString: controlUrl });
    await raw.connect();
    await raw.query("INSERT INTO organizations(id,slug,name,billing_email) VALUES($1,$2,'Keys PG','keys@example.invalid')", [orgId, `kp-${orgId}`]);
    await raw.query("INSERT INTO projects(id,organization_id,slug,name) VALUES($1,$2,'keys-pg','Keys PG')", [projectId, orgId]);
    a = new PgControlPlaneStore({ connectionString: controlUrl });
    b = new PgControlPlaneStore({ connectionString: controlUrl });
  }, 30000);

  afterAll(async () => {
    await raw.query("DELETE FROM api_keys WHERE project_id=$1", [projectId]);
    await raw.query("DELETE FROM projects WHERE id=$1", [projectId]);
    await raw.query("DELETE FROM organizations WHERE id=$1", [orgId]);
    await raw.end();
    await Promise.all([a.close(), b.close()]);
  });

  it("a key made, edited and revoked through instance A is seen by instance B immediately", async () => {
    const g = generateProjectApiKey({ keyType: "public" });
    const rec = await a.registerApiKey({ projectId, name: "k", keyType: "public", keyPrefix: g.keyPrefix, secretHash: g.secretHash });

    expect((await verifyApiKeyAsync(g.fullKey, b)).id).toBe(rec.id);
    expect(await b.listActiveApiKeyOrigins(projectId)).toEqual([]);

    await a.security.updateApiKeyRestrictions(rec.id, { allowedOrigins: ["https://shop.example"] });
    expect(await b.listActiveApiKeyOrigins(projectId)).toEqual(["https://shop.example"]);
    expect((await b.findApiKeyByPrefix(g.keyPrefix))?.allowedOrigins).toEqual(["https://shop.example"]);
    expect((await b.listProjectApiKeys(projectId)).map((k) => k.id)).toContain(rec.id);

    await a.revokeApiKey(rec.id, null);
    expect(await b.findApiKeyByPrefix(g.keyPrefix)).toBeNull();
    expect(await b.listActiveApiKeyOrigins(projectId)).toEqual([]);
    await expect(verifyApiKeyAsync(g.fullKey, b)).rejects.toThrow(/revoked/i);
    expect((await b.findApiKeyById(rec.id))?.revokedAt).not.toBeNull();
  });

  it("an expired key opens no origins", async () => {
    const g = generateProjectApiKey({ keyType: "public" });
    const rec = await a.registerApiKey({ projectId, name: "e", keyType: "public", keyPrefix: g.keyPrefix, secretHash: g.secretHash });
    await a.security.updateApiKeyRestrictions(rec.id, { allowedOrigins: ["https://old.example"], expiresAt: "2020-01-01T00:00:00.000Z" });
    expect(await b.listActiveApiKeyOrigins(projectId)).toEqual([]);
  });

  it("uses the indexes and stays fast (latency report)", async () => {
    const g = generateProjectApiKey({ keyType: "public" });
    await a.registerApiKey({ projectId, name: "p", keyType: "public", keyPrefix: g.keyPrefix, secretHash: g.secretHash });
    // The planner may seq-scan a tiny table; force the choice to prove the partial indexes serve both queries.
    await raw.query("SET enable_seqscan = off");
    const byPrefix = await raw.query(`EXPLAIN SELECT id FROM api_keys WHERE key_prefix = '${g.keyPrefix}' AND revoked_at IS NULL LIMIT 1`);
    const byProject = await raw.query(`EXPLAIN SELECT id FROM api_keys WHERE project_id = '${projectId}' AND revoked_at IS NULL`);
    await raw.query("RESET enable_seqscan");
    expect(JSON.stringify(byPrefix.rows)).toContain("idx_api_keys_lookup");
    expect(JSON.stringify(byProject.rows)).toContain("idx_api_keys_project_active");
    const times: number[] = [];
    for (let i = 0; i < 300; i += 1) {
      const t0 = performance.now();
      await verifyApiKeyAsync(g.fullKey, b);
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    const report = { n: times.length, p50: percentile(times, 50), p95: percentile(times, 95), p99: percentile(times, 99) };
    console.log("verifyApiKeyAsync latency ms (CI localhost PG):", JSON.stringify(report));
    expect(report.p99).toBeLessThan(250);
  });
});
