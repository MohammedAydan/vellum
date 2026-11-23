/**
 * Shared harness for live auth integration tests (data_db + control_db + real HTTP).
 *
 * This is a test-only helper. It loads `.env.phase5.local`, boots the real Node
 * HTTP adapter against the real PostgreSQL planes, provisions an isolated
 * organization/project with real API keys, and exposes raw PG clients for
 * durable assertions. Secrets (DB URLs, API keys, JWTs) are never logged.
 */
import "./_live-env.js";
import { expect } from "vitest";
import { startNodeApiServer } from "../../apps/api/src/node-server.js";
import {
  createRawPgClient,
  type RawPgClient,
} from "../../packages/database-control/src/index.js";
import { withTenantData } from "../e2e-real/tenant-data-sql.js";
import { ensureLiveEnv } from "./_live-env.js";

export type JsonEnvelope<T> = { status: number; body: T; headers: Headers };
export type ErrorBody = { error: { code: string; message: string; requestId?: string } };
export type ServerHandle = Awaited<ReturnType<typeof startNodeApiServer>>;

export interface LiveAuthHarness {
  server: ServerHandle;
  baseUrl: string;
  controlClient: RawPgClient;
  dataClient: RawPgClient;
  organizationId: string;
  projectId: string;
  publicKey: string;
  serverKey: string;
  /** Ed25519 JWT signed by the shared operator session service (owner role). */
  superAdminToken: string;
  superAdminUserId: string;
}

/** Collision-proof prefix, e.g. `authreplay_1731…_a1b2c3_`. */
export function newPrefix(tag: string): string {
  return `${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_`;
}

export async function json<T>(url: string, init?: RequestInit): Promise<JsonEnvelope<T>> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: (await response.json()) as T,
    headers: response.headers,
  };
}

/** Headers for an end-user / document request: canonical API key + optional bearer. */
export function userHeaders(
  apiKey: string,
  bearer?: string | null,
  withJson = false
): Record<string, string> {
  return {
    ...(withJson ? { "content-type": "application/json" } : {}),
    "x-vellum-api-key": apiKey,
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
  };
}

export function authUrl(baseUrl: string, projectId: string, suffix = ""): string {
  return `${baseUrl}/v1/projects/${projectId}/auth${suffix}`;
}

export function adminUrl(baseUrl: string, projectId: string, suffix = ""): string {
  return `${baseUrl}/v1/projects/${projectId}/auth/admin${suffix}`;
}

export function documentUrl(
  baseUrl: string,
  projectId: string,
  docPath: string
): string {
  return `${baseUrl}/v1/projects/${projectId}/documents/${docPath}`;
}

/**
 * Boot the live harness. Throws (never silently uses memory) when the Postgres
 * planes are unavailable, so a `PHASE5_REAL=1` run can never falsely pass.
 */
export async function setupLiveAuthHarness(prefix: string): Promise<LiveAuthHarness> {
  ensureLiveEnv();

  const controlUrl =
    process.env.CONTROL_DATABASE_URL_DIRECT ?? process.env.CONTROL_DATABASE_URL ?? "";
  const dataUrl = process.env.DATA_DATABASE_URL_DIRECT ?? process.env.DATA_DATABASE_URL ?? "";
  if (!controlUrl || !dataUrl) {
    throw new Error("PHASE5_REAL=1 requires CONTROL_DATABASE_URL[_DIRECT] and DATA_DATABASE_URL[_DIRECT]");
  }
  if ((process.env.DATABASE_MODE ?? "memory") !== "postgres") {
    throw new Error("PHASE5_REAL=1 requires DATABASE_MODE=postgres (real PostgreSQL planes)");
  }

  const server = await startNodeApiServer({ port: 0 });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  const ready = await json<{
    mode: string;
    checks: {
      controlDb: { state: string };
      dataDb: { state: string };
    };
  }>(`${baseUrl}/v1/health/ready`);
  expect([200, 503]).toContain(ready.status);
  expect(ready.body.mode).toBe("postgres");
  expect(ready.body.checks.controlDb.state).toBe("ok");
  expect(ready.body.checks.dataDb.state).toBe("ok");

  const controlClient = createRawPgClient({
    connectionString: controlUrl,
    applicationName: "vellum-auth-live-control",
  });
  const dataClient = createRawPgClient({
    connectionString: dataUrl,
    applicationName: "vellum-auth-live-data",
  });
  await controlClient.connect();
  await dataClient.connect();

  const org = await json<{ id: string }>(`${baseUrl}/v1/organizations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Auth Live Org",
      slug: `${prefix}org`.replace(/_/g, "-"),
      planTier: "pro",
    }),
  });
  if (org.status !== 201) throw new Error(`organization create failed (status ${org.status})`);

  const project = await json<{ project: { id: string } }>(
    `${baseUrl}/v1/organizations/${org.body.id}/projects`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Auth Live Project",
        slug: `${prefix}proj`.replace(/_/g, "-"),
      }),
    }
  );
  if (project.status !== 201) throw new Error(`project create failed (status ${project.status})`);

  const projectId = project.body.project.id;

  const keysUrl = `${baseUrl}/v1/projects/${projectId}/api-keys`;
  const pub = await json<{ rawKey: string }>(keysUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "auth-live-public", keyType: "publishable" }),
  });
  const srv = await json<{ rawKey: string }>(keysUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "auth-live-server", keyType: "secret" }),
  });
  if (pub.status !== 201 || srv.status !== 201) throw new Error("API key provisioning failed");

  // Owner operator session for the super-admin auth routes. Signed locally by
  // the same in-process session service the server verifies with. The uid must
  // be a real platform user: audit_logs.actor_user_id is a UUID with an FK to
  // users(id), and the super-admin PATCH route writes an audit row.
  const ownerUser = await server.platform.controlStore.createUser({
    email: `${prefix}owner@example.com`,
    name: "Live Auth Super Admin",
    platformRole: "owner",
  });
  // `/v1/admin/auth/*` verifies with the realm-bound super-admin session
  // service AND requires this explicit control-store privilege flag.
  await server.platform.controlStore.setPlatformSuperAdmin(ownerUser.id, true);
  const superAdminToken = server.platform.superAdminSessionService.signAccess({
    sub: ownerUser.id,
    uid: ownerUser.id,
    role: "owner",
    orgIds: [org.body.id],
  });

  return {
    server,
    baseUrl,
    controlClient,
    dataClient,
    organizationId: org.body.id,
    projectId,
    publicKey: pub.body.rawKey,
    serverKey: srv.body.rawKey,
    superAdminToken,
    superAdminUserId: ownerUser.id,
  };
}

/**
 * Delete every row created by the harness, in dependency order. Auth child
 * tables are removed before users; all raw data-plane DML binds the tenant GUCs.
 */
export async function teardownLiveAuthHarness(h: LiveAuthHarness): Promise<void> {
  if (h.dataClient) {
    await withTenantData(h.dataClient, h.projectId, async (tx) => {
      await tx.query("DELETE FROM project_auth_tokens WHERE project_id = $1::uuid", [h.projectId]);
      await tx.query("DELETE FROM project_auth_mfa WHERE project_id = $1::uuid", [h.projectId]);
      await tx.query("DELETE FROM project_auth_sessions WHERE project_id = $1::uuid", [h.projectId]);
      await tx.query("DELETE FROM project_auth_identities WHERE project_id = $1::uuid", [h.projectId]);
      await tx.query("DELETE FROM project_auth_users WHERE project_id = $1::uuid", [h.projectId]);
      await tx.query("DELETE FROM realtime_outbox WHERE project_id = $1::uuid", [h.projectId]);
      await tx.query(
        "DELETE FROM document_index_entries WHERE project_id = $1::uuid",
        [h.projectId]
      );
      await tx.query("DELETE FROM document_indexes WHERE project_id = $1::uuid", [h.projectId]);
      await tx.query("DELETE FROM documents WHERE project_id = $1::uuid", [h.projectId]);
      await tx.query("DELETE FROM transactions WHERE project_id = $1::uuid", [h.projectId]);
    });
    await h.dataClient.end();
  }
  if (h.controlClient) {
    const p = [h.projectId];
    // Super-admin audit rows have no project_id, so remove them by actor first
    // (audit_logs.actor_user_id has an FK to users(id)).
    await h.controlClient.query("DELETE FROM audit_logs WHERE actor_user_id = $1::uuid", [
      h.superAdminUserId,
    ]);
    await h.controlClient.query("DELETE FROM users WHERE id = $1::uuid", [h.superAdminUserId]);
    await h.controlClient.query(
      "DELETE FROM project_auth_configs WHERE project_id = $1::uuid",
      p
    );
    await h.controlClient.query("DELETE FROM project_usage_daily WHERE project_id = $1::uuid", p);
    await h.controlClient.query("DELETE FROM audit_logs WHERE project_id = $1::uuid", p);
    await h.controlClient.query("DELETE FROM api_keys WHERE project_id = $1::uuid", p);
    await h.controlClient.query("DELETE FROM security_rulesets WHERE project_id = $1::uuid", p);
    await h.controlClient.query("DELETE FROM projects WHERE id = $1::uuid", p);
    await h.controlClient.query(
      "DELETE FROM audit_logs WHERE organization_id = $1::uuid",
      [h.organizationId]
    );
    await h.controlClient.query("DELETE FROM organizations WHERE id = $1::uuid", [h.organizationId]);
    await h.controlClient.end();
  }
  if (h.server) await h.server.stop();
}

export { withTenantData };
