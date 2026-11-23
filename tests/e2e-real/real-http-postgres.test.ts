/**
 * Real backend verification. Every case below uses a real HTTP socket and/or
 * a real PostgreSQL connection. No in-memory stores are imported here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startNodeApiServer } from "../../apps/api/src/node-server.js";
import { createRawPgClient, loadEnvFiles } from "../../packages/database-control/src/index.js";
import { withTenantData } from "./tenant-data-sql.js";
import path from "node:path";

process.env.PHASE5_REAL = "1";

const prefix = `p5_${Date.now()}_`;
let server: Awaited<ReturnType<typeof startNodeApiServer>>;
let baseUrl = "";
let projectId = "";
let organizationId = "";
let key = "";
let controlClient: Awaited<ReturnType<typeof createRawPgClient>>;
let dataClient: Awaited<ReturnType<typeof createRawPgClient>>;

async function json<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(url, init);
  return { status: response.status, body: (await response.json()) as T, headers: response.headers };
}

describe("Real HTTP + PostgreSQL backend", () => {
  beforeAll(async () => {
    loadEnvFiles([path.resolve(".env.phase5.local"), path.resolve(".env")]);
    server = await startNodeApiServer({ port: 0 });
    baseUrl = `http://127.0.0.1:${server.port}`;
    const org = await json<{ id: string }>(`${baseUrl}/v1/organizations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Real Test Org", slug: `${prefix}org`.replace(/_/g, "-"), planTier: "free" }),
    });
    expect(org.status).toBe(201);
    organizationId = org.body.id;
    const project = await json<{ project: { id: string } }>(`${baseUrl}/v1/organizations/${org.body.id}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Real Project", slug: `${prefix}project`.replace(/_/g, "-") }),
    });
    expect(project.status).toBe(201);
    projectId = project.body.project.id;
    const apiKey = await json<{ rawKey: string }>(`${baseUrl}/v1/projects/${projectId}/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Real test key", keyType: "secret" }),
    });
    expect(apiKey.status).toBe(201);
    key = apiKey.body.rawKey;
    controlClient = createRawPgClient({ connectionString: process.env.CONTROL_DATABASE_URL_DIRECT || process.env.CONTROL_DATABASE_URL || "", applicationName: "vellum-e2e-real-control" });
    dataClient = createRawPgClient({ connectionString: process.env.DATA_DATABASE_URL_DIRECT || process.env.DATA_DATABASE_URL || "", applicationName: "vellum-e2e-real-data" });
    await controlClient.connect();
    await dataClient.connect();
  }, 30_000);

  afterAll(async () => {
    if (dataClient) {
      // FORCE ROW LEVEL SECURITY is active: bind tenant context before any raw
      // DELETE, otherwise these helpers would see (and delete) zero rows.
      await withTenantData(dataClient, projectId, async (tx) => {
        await tx.query("DELETE FROM documents WHERE data->>'phase5Prefix' = $1", [prefix]);
        await tx.query("DELETE FROM document_index_entries WHERE path LIKE $1", [`${prefix}%`]);
      });
      await dataClient.end();
    }
    if (controlClient) {
      await controlClient.query("DELETE FROM audit_logs WHERE metadata->>'phase5Prefix' = $1", [prefix]).catch(() => undefined);
      if (projectId) {
        await controlClient.query("DELETE FROM audit_logs WHERE project_id = $1", [projectId]);
        await controlClient.query("DELETE FROM api_keys WHERE project_id = $1", [projectId]);
        await controlClient.query("DELETE FROM security_rulesets WHERE project_id = $1", [projectId]);
        await controlClient.query("DELETE FROM projects WHERE id = $1", [projectId]);
      }
      await controlClient.query("DELETE FROM audit_logs WHERE organization_id = $1", [organizationId]);
      await controlClient.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
      await controlClient.end();
    }
    if (server) await server.stop();
  }, 30_000);

  it("health reports connected control and data planes", async () => {
    const result = await json<{ planes: { controlDb: string; dataDb: string } }>(`${baseUrl}/v1/health`);
    expect(result.status).toBe(200);
    expect(result.body.planes.controlDb).toBe("connected");
    expect(result.body.planes.dataDb).toBe("connected");
  });

  it.each(Array.from({ length: 20 }, (_, index) => index))("real CRUD round trip %i", async (index) => {
    const pathName = `${prefix}collection/doc_${index}`;
    const url = `${baseUrl}/v1/projects/${projectId}/documents/${pathName}`;
    const payload = { data: { phase5Prefix: prefix, index, active: true } };
    const written = await json<{ version: number }>(url, { method: "PUT", headers: { "content-type": "application/json", "x-project-key": key }, body: JSON.stringify(payload) });
    expect(written.status).toBe(200);
    expect(written.body.version).toBe(1);
    const read = await json<{ data: { phase5Prefix: string; index: number } }>(url, { headers: { "x-project-key": key } });
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({ phase5Prefix: prefix, index });
    const raw = await withTenantData(dataClient, projectId, (tx) =>
      tx.query("select count(*)::int as count from documents where project_id = $1 and path = $2", [projectId, pathName])
    );
    expect(raw.rows[0]?.count).toBe(1);
  }, 30_000);

  it.each(Array.from({ length: 20 }, (_, index) => index))("real update preserves durable version %i", async (index) => {
    const url = `${baseUrl}/v1/projects/${projectId}/documents/${prefix}collection/doc_${index}`;
    const result = await json<{ version: number }>(url, { method: "PATCH", headers: { "content-type": "application/json", "x-project-key": key }, body: JSON.stringify({ data: { changed: true } }) });
    expect(result.status).toBe(200);
    expect(result.body.version).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it.each(Array.from({ length: 10 }, (_, index) => index))("real SQL metadata query %i", async () => {
    const result = await withTenantData(dataClient, projectId, (tx) =>
      tx.query("select count(*)::int as count from documents where project_id = $1", [projectId])
    );
    expect(Number(result.rows[0]?.count)).toBeGreaterThanOrEqual(20);
  });

  it.each(Array.from({ length: 9 }, (_, index) => index))("real HTTP error envelope %i", async (index) => {
    const result = await json<{ error: { code: string; requestId: string } }>(`${baseUrl}/v1/projects/${projectId}/documents/${prefix}invalid/${"x".repeat(1600)}_${index}`, { headers: { "x-project-key": key } });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("INVALID_DOCUMENT_PATH");
    expect(result.body.error.requestId).toBeTruthy();
    expect(result.headers.get("x-request-id")).toBe(result.body.error.requestId);
  }, 30_000);

  it("real PostgreSQL RLS denies missing tenant context", async () => {
    const role = "vellum_phase5_rls";
    await dataClient.query(`GRANT ${role} TO CURRENT_USER`);
    await dataClient.query("BEGIN");
    await dataClient.query(`SET LOCAL ROLE ${role}`);
    const result = await dataClient.query("select count(*)::int as count from documents");
    await dataClient.query("ROLLBACK");
    expect(result.rows[0]?.count).toBe(0);
  });

  it("real database has hardened RLS policies on every tenant table", async () => {
    // 0011_drop_environments.sql replaced the per-command env-scoped policies
    // with ONE fail-closed FOR ALL policy per table, keyed only on
    // app.current_project_id, with both USING and WITH CHECK, and FORCE RLS.
    const policies = await dataClient.query(
      "select tablename, count(*)::int as count from pg_policies " +
        "where schemaname = 'public' and tablename in ('documents','document_index_entries','document_indexes','realtime_outbox') " +
        "group by tablename order by tablename"
    );
    expect(policies.rows).toHaveLength(4);
    for (const row of policies.rows as Array<{ tablename: string; count: number }>) {
      expect(row.count, `policy count for ${row.tablename}`).toBe(1);
    }

    const withCheck = await dataClient.query(
      "select count(*)::int as count from pg_policies " +
        "where schemaname = 'public' and tablename in ('documents','document_index_entries','document_indexes','realtime_outbox') " +
        "and with_check is not null and with_check <> '' and with_check like '%app.current_project_id%'"
    );
    expect(withCheck.rows[0]?.count).toBe(4);

    const forced = await dataClient.query(
      "select relname from pg_class where relname in ('documents','document_index_entries','document_indexes','realtime_outbox') " +
        "and relrowsecurity and relforcerowsecurity order by relname"
    );
    expect(forced.rows).toHaveLength(4);

    const role = await dataClient.query(
      "select rolname from pg_roles where rolname = 'vellum_app' and not rolsuper and not rolbypassrls"
    );
    expect(role.rows).toHaveLength(1);
  });
});
