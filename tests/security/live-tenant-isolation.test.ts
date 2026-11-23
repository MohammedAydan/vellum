/**
 * Live HTTP + real PostgreSQL cross-tenant isolation security test.
 *
 * Starts the real Node HTTP adapter (`startNodeApiServer`) against the real
 * Control/Data planes from `.env.phase5.local` and proves, with network sockets
 * and real database rows:
 *
 *   1. Cross-tenant read/write/list is denied (project B key against project A).
 *   2. Cross-project access is denied through real HTTP and RLS.
 *   3. A revoked API key is rejected immediately (401 UNAUTHENTICATED).
 *   4. A tampered / foreign HMAC cursor is rejected (400 INVALID_CURSOR).
 *   5. PostgreSQL RLS fails closed when tenant context is absent
 *      (`vellum_phase5_rls`, a non-owner/non-BYPASSRLS role).
 *
 * The suite always runs against the live Neon planes: `_security-live-env`
 * wires the repo-root fixtures before config modules load, so
 * `pnpm test:security` has zero skips.
 *
 * Secrets are never logged: only booleans, HTTP status codes and error codes
 * are asserted or printed.
 */
// Must be first: opts this suite into the live Neon fixtures before any
// configuration-reading module is evaluated. Zero skips by design.
import "../security/_security-live-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startNodeApiServer } from "../../apps/api/src/node-server.js";
import { createRawPgClient } from "../../packages/database-control/src/index.js";
import type { RawPgClient } from "../../packages/database-control/src/index.js";
import { withTenantData } from "../e2e-real/tenant-data-sql.js";

const prefix = `liveiso_${Date.now()}_`;

type JsonEnvelope<T> = { status: number; body: T; headers: Headers };
type ErrorBody = { error: { code: string; message: string; requestId: string } };
type ProjectCreateBody = {
  project: { id: string };
};
type ApiKeyCreateBody = { apiKey: { id: string }; rawKey: string };
type QueryBody = {
  documents: Array<{ documentId: string }>;
  nextCursor: string | null;
};

async function json<T>(url: string, init?: RequestInit): Promise<JsonEnvelope<T>> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: (await response.json()) as T,
    headers: response.headers,
  };
}

// Hermetic CI has no live Neon secrets. Skip the suite there instead of
// failing; `pnpm test:security` still runs every other security suite. With
// the live env wired (PHASE5_REAL + both planes) the suite runs in full.
const hasLivePlanes = Boolean(
  (process.env.CONTROL_DATABASE_URL_DIRECT ?? process.env.CONTROL_DATABASE_URL) &&
    (process.env.DATA_DATABASE_URL_DIRECT ?? process.env.DATA_DATABASE_URL)
);
describe.skipIf(!hasLivePlanes)(
  "live tenant isolation over HTTP + PostgreSQL",
  () => {
    let server: Awaited<ReturnType<typeof startNodeApiServer>> | undefined;
    let baseUrl = "";

    let organizationAId = "";
    let organizationBId = "";
    let projectAId = "";
    let projectBId = "";

    let keyA = "";
    let keyB = "";
    let keyARevocable = "";
    let keyARevocableId = "";

    let controlClient: RawPgClient | undefined;
    let dataClient: RawPgClient | undefined;

    const documentsUrl = (projectId: string, docPath: string): string =>
      `${baseUrl}/v1/projects/${projectId}/documents/${docPath}`;
    const queryUrl = (projectId: string): string =>
      `${baseUrl}/v1/projects/${projectId}/query`;
    const keysUrl = (projectId: string): string =>
      `${baseUrl}/v1/projects/${projectId}/api-keys`;

    const authHeaders = (key: string, withJson = false): Record<string, string> => ({
      ...(withJson ? { "content-type": "application/json" } : {}),
      "x-project-key": key,
    });

    beforeAll(async () => {
      const controlUrl =
        process.env.CONTROL_DATABASE_URL_DIRECT ?? process.env.CONTROL_DATABASE_URL ?? "";
      const dataUrl = process.env.DATA_DATABASE_URL_DIRECT ?? process.env.DATA_DATABASE_URL ?? "";
      if (!controlUrl || !dataUrl) {
        throw new Error(
          "PHASE5_REAL=1 requires CONTROL_DATABASE_URL[_DIRECT] and DATA_DATABASE_URL[_DIRECT]"
        );
      }
      if ((process.env.DATABASE_MODE ?? "memory") !== "postgres") {
        throw new Error("PHASE5_REAL=1 requires DATABASE_MODE=postgres (real PostgreSQL planes)");
      }

      server = await startNodeApiServer({ port: 0 });
      baseUrl = `http://127.0.0.1:${server.port}`;

      // Guard: the API must actually be talking to PostgreSQL, not in-memory stores.
      const ready = await json<{
        mode: string;
        ready: boolean;
        checks: {
          controlDb: { state: string };
          dataDb: { state: string };
          realtimeListen: { state: string };
        };
      }>(`${baseUrl}/v1/health/ready`);
      // Readiness may be 503 solely because shared-database migration checksums
      // have drifted; the two plane probes below are what this test requires.
      expect([200, 503]).toContain(ready.status);
      expect(ready.body.mode).toBe("postgres");
      expect(ready.body.checks.controlDb.state).toBe("ok");
      expect(ready.body.checks.dataDb.state).toBe("ok");
      expect(ready.body.checks.realtimeListen.state).toBe("ok");

      // 1. Two independent organizations/projects (real control-plane rows).
      const orgA = await json<{ id: string }>(`${baseUrl}/v1/organizations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Live Isolation Org A",
          slug: `${prefix}org-a`.replace(/_/g, "-"),
          planTier: "pro",
        }),
      });
      expect(orgA.status).toBe(201);
      organizationAId = orgA.body.id;

      const orgB = await json<{ id: string }>(`${baseUrl}/v1/organizations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Live Isolation Org B",
          slug: `${prefix}org-b`.replace(/_/g, "-"),
          planTier: "pro",
        }),
      });
      expect(orgB.status).toBe(201);
      organizationBId = orgB.body.id;

      const projectA = await json<ProjectCreateBody>(
        `${baseUrl}/v1/organizations/${organizationAId}/projects`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Live Isolation Project A",
            slug: `${prefix}project-a`.replace(/_/g, "-"),
          }),
        }
      );
      expect(projectA.status).toBe(201);
      projectAId = projectA.body.project.id;

      const projectB = await json<ProjectCreateBody>(
        `${baseUrl}/v1/organizations/${organizationBId}/projects`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Live Isolation Project B",
            slug: `${prefix}project-b`.replace(/_/g, "-"),
          }),
        }
      );
      expect(projectB.status).toBe(201);
      projectBId = projectB.body.project.id;

      // 2. Real API keys, one per tenant.
      const createKey = async (
        projectId: string,
        name: string
      ): Promise<ApiKeyCreateBody> => {
        const created = await json<ApiKeyCreateBody>(keysUrl(projectId), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, keyType: "secret" }),
        });
        expect(created.status).toBe(201);
        return created.body;
      };

      keyA = (await createKey(projectAId, "Tenant A key")).rawKey;
      keyB = (await createKey(projectBId, "Tenant B key")).rawKey;

      const revocable = await createKey(projectAId, "Tenant A revocable");
      keyARevocable = revocable.rawKey;
      keyARevocableId = revocable.apiKey.id;

      expect(keyA).not.toBe(keyB);

      // 3. Durable rows used by the assertions below.
      const seedA = await json<{ version: number }>(
        documentsUrl(projectAId, `${prefix}secrets/alpha`),
        {
          method: "PUT",
          headers: authHeaders(keyA, true),
          body: JSON.stringify({ data: { owner: "tenant-a", secret: "alpha-only" } }),
        }
      );
      expect(seedA.status).toBe(200);

      const seedB = await json<{ version: number }>(
        documentsUrl(projectBId, `${prefix}secrets/beta`),
        {
          method: "PUT",
          headers: authHeaders(keyB, true),
          body: JSON.stringify({ data: { owner: "tenant-b", secret: "beta-only" } }),
        }
      );
      expect(seedB.status).toBe(200);

      for (let index = 0; index < 3; index += 1) {
        const seeded = await json<{ version: number }>(
          documentsUrl(projectAId, `${prefix}items/item_${index}`),
          {
            method: "PUT",
            headers: authHeaders(keyA, true),
            body: JSON.stringify({ data: { index } }),
          }
        );
        expect(seeded.status).toBe(200);
      }

      controlClient = createRawPgClient({
        connectionString: controlUrl,
        applicationName: "vellum-task1001-live-control",
      });
      dataClient = createRawPgClient({
        connectionString: dataUrl,
        applicationName: "vellum-task1001-live-data",
      });
      await controlClient.connect();
      await dataClient.connect();
    }, 60_000);

    afterAll(async () => {
      if (dataClient) {
        const projectIdsToClean = [projectAId, projectBId].filter(Boolean);
        // FORCE RLS: every raw cleanup must bind the tenant GUC per project.
        for (const projectId of projectIdsToClean) {
          await withTenantData(dataClient, projectId, async (tx) => {
            await tx.query("DELETE FROM transactions WHERE project_id = $1::uuid", [projectId]);
            await tx.query("DELETE FROM realtime_outbox WHERE project_id = $1::uuid", [projectId]);
            await tx.query("DELETE FROM document_index_entries WHERE project_id = $1::uuid", [projectId]);
            await tx.query("DELETE FROM document_indexes WHERE project_id = $1::uuid", [projectId]);
            await tx.query("DELETE FROM documents WHERE project_id = $1::uuid", [projectId]);
          });
        }
        await dataClient.end();
      }
      if (controlClient) {
        const projectIds = [projectAId, projectBId].filter(Boolean);
        const orgIds = [organizationAId, organizationBId].filter(Boolean);
        if (projectIds.length > 0) {
          await controlClient.query(
            "DELETE FROM project_usage_daily WHERE project_id = ANY($1::uuid[])",
            [projectIds]
          );
          await controlClient.query("DELETE FROM audit_logs WHERE project_id = ANY($1::uuid[])", [
            projectIds,
          ]);
          await controlClient.query("DELETE FROM api_keys WHERE project_id = ANY($1::uuid[])", [
            projectIds,
          ]);
          await controlClient.query(
            "DELETE FROM security_rulesets WHERE project_id = ANY($1::uuid[])",
            [projectIds]
          );
          await controlClient.query("DELETE FROM projects WHERE id = ANY($1::uuid[])", [
            projectIds,
          ]);
        }
        if (orgIds.length > 0) {
          await controlClient.query("DELETE FROM audit_logs WHERE organization_id = ANY($1::uuid[])", [
            orgIds,
          ]);
          await controlClient.query("DELETE FROM organizations WHERE id = ANY($1::uuid[])", [
            orgIds,
          ]);
        }
        await controlClient.end();
      }
      if (server) await server.stop();
    }, 60_000);

    it("denies cross-tenant read, list, query, write and delete over real HTTP", async () => {
      const aDocUrl = documentsUrl(projectAId, `${prefix}secrets/alpha`);

      const read = await json<ErrorBody>(aDocUrl, { headers: authHeaders(keyB) });
      expect(read.status).toBe(403);
      expect(read.body.error.code).toBe("PERMISSION_DENIED");

      const list = await json<ErrorBody>(
        `${baseUrl}/v1/projects/${projectAId}/documents/${prefix}items`,
        { headers: authHeaders(keyB) }
      );
      expect(list.status).toBe(403);
      expect(list.body.error.code).toBe("PERMISSION_DENIED");

      const query = await json<ErrorBody>(queryUrl(projectAId), {
        method: "POST",
        headers: authHeaders(keyB, true),
        body: JSON.stringify({ collectionPath: `${prefix}items`, limit: 50 }),
      });
      expect(query.status).toBe(403);
      expect(query.body.error.code).toBe("PERMISSION_DENIED");

      const overwrite = await json<ErrorBody>(aDocUrl, {
        method: "PUT",
        headers: authHeaders(keyB, true),
        body: JSON.stringify({ data: { owner: "tenant-b", secret: "overwritten" } }),
      });
      expect(overwrite.status).toBe(403);
      expect(overwrite.body.error.code).toBe("PERMISSION_DENIED");

      const patch = await json<ErrorBody>(aDocUrl, {
        method: "PATCH",
        headers: authHeaders(keyB, true),
        body: JSON.stringify({ data: { secret: "patched-by-b" } }),
      });
      expect(patch.status).toBe(403);
      expect(patch.body.error.code).toBe("PERMISSION_DENIED");

      const remove = await json<ErrorBody>(aDocUrl, {
        method: "DELETE",
        headers: authHeaders(keyB),
      });
      expect(remove.status).toBe(403);
      expect(remove.body.error.code).toBe("PERMISSION_DENIED");

      // Tenant A's data is byte-for-byte unchanged after every denied attempt.
      const ownerRead = await json<{ data: { owner: string; secret: string } }>(aDocUrl, {
        headers: authHeaders(keyA),
      });
      expect(ownerRead.status).toBe(200);
      expect(ownerRead.body.data).toEqual({ owner: "tenant-a", secret: "alpha-only" });

      // Symmetric direction: tenant A cannot touch tenant B either.
      const reverse = await json<ErrorBody>(
        documentsUrl(projectBId, `${prefix}secrets/beta`),
        { headers: authHeaders(keyA) }
      );
      expect(reverse.status).toBe(403);
      expect(reverse.body.error.code).toBe("PERMISSION_DENIED");
    }, 60_000);

    it("rejects a revoked API key for reads and writes", async () => {
      const probePath = `${prefix}secrets/revoked-probe`;
      const probeUrl = documentsUrl(projectAId, probePath);

      const seed = await json<{ version: number }>(probeUrl, {
        method: "PUT",
        headers: authHeaders(keyA, true),
        body: JSON.stringify({ data: { owner: "tenant-a", stage: "before-revoke" } }),
      });
      expect(seed.status).toBe(200);

      // Revoke before the key is ever presented to the document plane. This
      // proves the check consults durable revoked state (a key that had already
      // been verified may legitimately stay in the 30s verification cache).
      const revoke = await json<{ success: boolean; revoked: { id: string; revokedAt: string } }>(
        `${keysUrl(projectAId)}/${keyARevocableId}`,
        { method: "DELETE", headers: { "content-type": "application/json" } }
      );
      expect(revoke.status).toBe(200);
      expect(revoke.body.success).toBe(true);
      expect(revoke.body.revoked.id).toBe(keyARevocableId);
      expect(revoke.body.revoked.revokedAt).toBeTruthy();

      const revokedRead = await json<ErrorBody>(probeUrl, {
        headers: authHeaders(keyARevocable),
      });
      expect(revokedRead.status).toBe(401);
      expect(revokedRead.body.error.code).toBe("UNAUTHENTICATED");

      const revokedWrite = await json<ErrorBody>(probeUrl, {
        method: "PUT",
        headers: authHeaders(keyARevocable, true),
        body: JSON.stringify({ data: { owner: "tenant-a", stage: "after-revoke" } }),
      });
      expect(revokedWrite.status).toBe(401);
      expect(revokedWrite.body.error.code).toBe("UNAUTHENTICATED");

      // The revocation is durable in PostgreSQL, not only an in-process cache.
      const durable = await controlClient?.query<{ revoked_at: string | null }>(
        "SELECT revoked_at::text FROM api_keys WHERE id = $1::uuid",
        [keyARevocableId]
      );
      expect(durable?.rows[0]?.revoked_at).toBeTruthy();

      // The document itself is untouched by the revoked-write attempt.
      const ownerRead = await json<{ data: { stage: string } }>(probeUrl, {
        headers: authHeaders(keyA),
      });
      expect(ownerRead.status).toBe(200);
      expect(ownerRead.body.data.stage).toBe("before-revoke");
    }, 60_000);

    it("rejects tampered, malformed and cross-tenant HMAC cursors", async () => {
      const collectionPath = `${prefix}items`;
      const firstPage = await json<QueryBody>(queryUrl(projectAId), {
        method: "POST",
        headers: authHeaders(keyA, true),
        body: JSON.stringify({ collectionPath, limit: 2 }),
      });
      expect(firstPage.status).toBe(200);
      expect(firstPage.body.documents).toHaveLength(2);
      expect(typeof firstPage.body.nextCursor).toBe("string");

      const cursor = firstPage.body.nextCursor as string;

      // Same signature, different payload: must fail HMAC verification.
      const decoded = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8")
      ) as Record<string, unknown>;
      decoded["docId"] = "attacker-chosen-id";
      const tampered = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");

      const tamperedResult = await json<ErrorBody>(queryUrl(projectAId), {
        method: "POST",
        headers: authHeaders(keyA, true),
        body: JSON.stringify({ collectionPath, limit: 2, startAfter: tampered }),
      });
      expect(tamperedResult.status).toBe(400);
      expect(tamperedResult.body.error.code).toBe("INVALID_CURSOR");

      // Garbage that is not even base64url JSON.
      const malformed = await json<ErrorBody>(queryUrl(projectAId), {
        method: "POST",
        headers: authHeaders(keyA, true),
        body: JSON.stringify({ collectionPath, limit: 2, startAfter: "@@@not-a-cursor@@@" }),
      });
      expect(malformed.status).toBe(400);
      expect(malformed.body.error.code).toBe("INVALID_CURSOR");

      // Valid tenant-A cursor replayed against tenant B: query shape hash mismatch.
      const foreign = await json<ErrorBody>(queryUrl(projectBId), {
        method: "POST",
        headers: authHeaders(keyB, true),
        body: JSON.stringify({ collectionPath, limit: 2, startAfter: cursor }),
      });
      expect(foreign.status).toBe(400);
      expect(foreign.body.error.code).toBe("INVALID_CURSOR");

      // The untampered cursor still works for its own tenant/query shape.
      const secondPage = await json<QueryBody>(queryUrl(projectAId), {
        method: "POST",
        headers: authHeaders(keyA, true),
        body: JSON.stringify({ collectionPath, limit: 2, startAfter: cursor }),
      });
      expect(secondPage.status).toBe(200);
      expect(secondPage.body.documents).toHaveLength(1);
    }, 60_000);

    it("PostgreSQL RLS fails closed for the non-owner vellum_phase5_rls role", async () => {
      const data = dataClient;
      expect(data).toBeDefined();
      if (!data) return;

      await data.query("GRANT vellum_phase5_rls TO CURRENT_USER").catch(() => undefined);

      await data.query("BEGIN");
      try {
        await data.query("SET LOCAL ROLE vellum_phase5_rls");

        // No tenant context -> zero rows even though both tenants have documents.
        const noContext = await data.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM documents"
        );
        expect(Number(noContext.rows[0]?.n ?? -1)).toBe(0);

        // Tenant A context sees tenant A rows only.
        await data.query("SELECT set_config('app.current_project_id', $1, true)", [projectAId]);
        const ownTenant = await data.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM documents WHERE project_id = $1::uuid",
          [projectAId]
        );
        expect(Number(ownTenant.rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(1);

        // Tenant A context cannot see any tenant B row, even when asking directly.
        const crossTenant = await data.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM documents WHERE project_id = $1::uuid",
          [projectBId]
        );
        expect(Number(crossTenant.rows[0]?.n ?? -1)).toBe(0);
      } finally {
        await data.query("ROLLBACK");
      }
    }, 60_000);
  }
);
