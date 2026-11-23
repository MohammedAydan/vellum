import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRawPgClient, dataMigrationsDir, runMigrationsOnClient } from "../../packages/database-control/src/index.js";
import { readFileSync } from "node:fs";
import path from "node:path";

// Dedicated disposable CI cluster only. Never run role-state permutations on a
// shared service. The Neon acceptance run uses two fresh pairs without roles DDL.
const url = process.env.VELLUM_DISPOSABLE_PG_URL;
describe.skipIf(!url)("shared-cluster migration role convergence", () => {
  const clients: ReturnType<typeof createRawPgClient>[] = [];
  let admin: ReturnType<typeof createRawPgClient>;
  const names: string[] = [];
  beforeAll(async () => { admin = createRawPgClient({ connectionString: url! }); await admin.connect(); });
  afterAll(async () => {
    for (const client of clients) await client.end();
    for (const name of names) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    if (admin) await admin.end();
  });
  it("migrates two fresh pairs sequentially, reruns safely and enforces runtime RLS", async () => {
    for (let pair = 0; pair < 2; pair++) {
      const suffix = `${process.pid}_${pair}`;
      const control = `remediation_c_${suffix}`; const data = `remediation_d_${suffix}`;
      for (const name of [control, data]) { await admin.query(`CREATE DATABASE ${name}`); names.push(name); }
      // The normal CLI runs both planes; shared roles exist by pair two.
      const { execFileSync } = await import("node:child_process");
      const controlUrl = new URL(url!); controlUrl.pathname = `/${control}`;
      const dataUrl = new URL(url!); dataUrl.pathname = `/${data}`;
      execFileSync("corepack", ["pnpm", "db:migrate"], { cwd: path.resolve(import.meta.dirname, "../.."),
        env: { ...process.env, CONTROL_DATABASE_URL: controlUrl.href, DATA_DATABASE_URL: dataUrl.href }, stdio: "pipe" });
      const client = createRawPgClient({ connectionString: dataUrl.href }); clients.push(client); await client.connect();
      await runMigrationsOnClient({ client, directory: dataMigrationsDir(), label: "data_db" });
      // Re-running the repaired SQL itself is safe, not just its migration ledger.
      await client.query(readFileSync(path.join(dataMigrationsDir(), "0013_vellum_rebrand.sql"), "utf8"));
      const privileges = await client.query("SELECT has_table_privilege('vellum_app','documents','SELECT,INSERT,UPDATE,DELETE') AS crud, has_table_privilege('vellum_app','documents','TRUNCATE') AS truncate");
      expect(privileges.rows[0]).toMatchObject({ crud: true, truncate: false });
      await client.query("BEGIN"); await client.query("SET LOCAL ROLE vellum_app");
      expect((await client.query("SELECT count(*)::int AS count FROM documents")).rows[0]?.count).toBe(0);
      await expect(client.query("INSERT INTO documents(project_id,path,collection_path,collection_group,document_id,path_depth,data,size_bytes,version) VALUES ('00000000-0000-0000-0000-000000000001','tasks/a','tasks','tasks','a',2,'{}',2,1)")).rejects.toThrow();
      await client.query("ROLLBACK");
      await client.query("BEGIN"); await client.query("SET LOCAL ROLE vellum_app");
      await client.query("SELECT set_config('app.current_project_id','00000000-0000-0000-0000-000000000001',true)");
      await client.query("INSERT INTO documents(project_id,path,collection_path,collection_group,document_id,path_depth,data,size_bytes,version) VALUES ('00000000-0000-0000-0000-000000000001','tasks/a','tasks','tasks','a',2,'{}',2,1)");
      await client.query("COMMIT");
      await client.query("BEGIN"); await client.query("SET LOCAL ROLE vellum_app");
      await client.query("SELECT set_config('app.current_project_id','00000000-0000-0000-0000-000000000002',true)");
      expect((await client.query("SELECT count(*)::int AS count FROM documents")).rows[0]?.count).toBe(0);
      await client.query("ROLLBACK");
    }
  }, 120_000);
  it("persists restrictions through PostgreSQL refresh and searches beyond the first page", async () => {
    const { createPostgresAdapters } = await import("../../apps/api/src/composition/root.js");
    const { createVellumPlatform } = await import("../../apps/api/src/platform.js");
    const controlUrl = new URL(url!); controlUrl.pathname = `/${names[0]}`;
    const dataUrl = new URL(url!); dataUrl.pathname = `/${names[1]}`;
    const adapters = await createPostgresAdapters({ controlConnectionString: controlUrl.href, dataConnectionString: dataUrl.href });
    const platform = createVellumPlatform({ controlStore: adapters.controlStore, dataStore: adapters.dataStore });
    try {
      const user = await adapters.controlStore.createUser({ email: "regression@example.invalid", name: "Regression" });
      const org = await adapters.controlStore.createOrganization({ name: "Regression", slug: "regression", billingEmail: user.email, ownerUserId: user.id });
      const { project } = await adapters.controlStore.createProject({ organizationId: org.id, name: "Regression", slug: "regression" });
      const token = platform.consoleSessionService.signAccess({ sub: user.id, uid: user.id, role: "customer", orgIds: [org.id] });
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const base = `http://localhost/v1/console/projects/${project.id}`;
      const request = async (suffix: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
        const response = await platform.fetch(new Request(base + suffix, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
        const json = await response.json(); expect(response.ok, JSON.stringify(json)).toBe(true); return json;
      };
      const created = await request("/api-keys", { name: "restricted", keyType: "publishable" });
      const restrictionsUrl = `http://localhost/v1/console/orgs/${org.id}/projects/${project.id}/keys/${created.apiKey.id}/restrictions`;
      const restrictionResponse = await platform.fetch(new Request(restrictionsUrl, { method: "PATCH", headers,
        body: JSON.stringify({ allowedOrigins: ["https://example.invalid"], allowedIps: ["127.0.0.1"] }) }));
      expect(restrictionResponse.status).toBe(200);
      const immediateKeys = await request("/api-keys");
      expect(immediateKeys[0]).toMatchObject({ allowedOrigins: ["https://example.invalid"], allowedIps: ["127.0.0.1"] });
      const { project: otherProject } = await adapters.controlStore.createProject({ organizationId: org.id, name: "Other", slug: "other" });
      const crossProject = await platform.fetch(new Request(restrictionsUrl.replace(project.id, otherProject.id), { method: "PATCH", headers,
        body: JSON.stringify({ allowedOrigins: [] }) }));
      expect(crossProject.status).toBe(404);
      await adapters.controlStore.refresh();
      const keys = await request("/api-keys");
      expect(keys[0]).toMatchObject({ allowedOrigins: ["https://example.invalid"], allowedIps: ["127.0.0.1"] });
      expect(keys[0]).not.toHaveProperty("secretHash"); expect(created.apiKey).not.toHaveProperty("secretHash");
      await request("/collections", { name: "regression" });
      for (let offset = 0; offset < 60; offset += 20) await request("/collections/regression/import", {
        documents: Array.from({ length: 20 }, (_, i) => ({ id: `row_${String(offset + i).padStart(3, "0")}`, data: { title: offset + i === 59 ? "beyond-first-page" : "ordinary" } })), mode: "upsert",
      });
      const result = await request("/documents/regression?limit=25&search=beyond-first-page");
      expect(result.documents).toHaveLength(1); expect(result.documents[0].documentId).toBe("row_059");
      const exported = await request("/collections/regression/export");
      expect(exported.documents).toHaveLength(60);
      const saved = await request("/documents/regression/row_059", { data: { title: "updated" }, ifVersion: 1 }, "PUT");
      expect(saved.version).toBe(2);
    } finally { await adapters.controlStore.close(); await adapters.dataStore.close(); }
  }, 120_000);

});
