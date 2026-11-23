/**
 * Real Backend E2E Test - Optimistic Concurrency Control (OCC) Contention & Retry
 * Validates against real Node.js HTTP server and real Neon PostgreSQL:
 * 1. Concurrent transactions on the same document: 1 wins, 1 receives ABORTED_CONFLICT (409)
 * 2. SDK transaction runner with jitter backoff successfully resolves contention within 5 attempts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { startNodeApiServer } from "../../apps/api/src/node-server.js";
import { createRawPgClient, loadEnvFiles } from "../../packages/database-control/src/index.js";
import { withTenantData } from "./tenant-data-sql.js";
import { createClient } from "../../packages/sdk-js/src/index.js";

process.env.PHASE5_REAL = "1";

const prefix = `occ_${Date.now()}_`;
let server: Awaited<ReturnType<typeof startNodeApiServer>>;
let baseUrl = "";
let projectId = "";
let organizationId = "";
let apiKey = "";
let dataClient: Awaited<ReturnType<typeof createRawPgClient>>;
let controlClient: Awaited<ReturnType<typeof createRawPgClient>>;

async function json<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(url, init);
  return { status: response.status, body: (await response.json()) as T, headers: response.headers };
}

describe("Real OCC Contention & SDK Jitter Retry", () => {
  beforeAll(async () => {
    loadEnvFiles([path.resolve(".env.phase5.local"), path.resolve(".env")]);
    server = await startNodeApiServer({ port: 0 });
    baseUrl = `http://127.0.0.1:${server.port}`;

    const org = await json<{ id: string }>(`${baseUrl}/v1/organizations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "OCC Real Test Org", slug: `${prefix}org`.replace(/_/g, "-"), planTier: "pro" }),
    });
    expect(org.status).toBe(201);
    organizationId = org.body.id;

    const project = await json<{ project: { id: string } }>(`${baseUrl}/v1/organizations/${org.body.id}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "OCC Real Project", slug: `${prefix}proj`.replace(/_/g, "-") }),
    });
    expect(project.status).toBe(201);
    projectId = project.body.project.id;

    const keyRes = await json<{ rawKey: string }>(`${baseUrl}/v1/projects/${projectId}/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "OCC server key", keyType: "secret" }),
    });
    expect(keyRes.status).toBe(201);
    apiKey = keyRes.body.rawKey;

    controlClient = createRawPgClient({
      connectionString: process.env.CONTROL_DATABASE_URL_DIRECT || process.env.CONTROL_DATABASE_URL || "",
      applicationName: "vellum-e2e-occ-control",
    });
    dataClient = createRawPgClient({
      connectionString: process.env.DATA_DATABASE_URL_DIRECT || process.env.DATA_DATABASE_URL || "",
      applicationName: "vellum-e2e-occ-data",
    });
    await controlClient.connect();
    await dataClient.connect();
  }, 30_000);

  afterAll(async () => {
    if (dataClient) {
      await withTenantData(dataClient, projectId, async (tx) => {
        await tx.query("DELETE FROM documents WHERE project_id = $1::uuid", [projectId]);
        await tx.query("DELETE FROM realtime_outbox WHERE project_id = $1::uuid", [projectId]);
      });
      await dataClient.end();
    }
    if (controlClient) {
      if (projectId) {
        await controlClient.query("DELETE FROM audit_logs WHERE project_id = $1", [projectId]);
        await controlClient.query("DELETE FROM api_keys WHERE project_id = $1", [projectId]);
        await controlClient.query("DELETE FROM projects WHERE id = $1", [projectId]);
      }
      await controlClient.query("DELETE FROM audit_logs WHERE organization_id = $1", [organizationId]);
      await controlClient.query("DELETE FROM organizations WHERE id = $1", [organizationId]);
      await controlClient.end();
    }
    if (server) await server.stop();
  }, 30_000);

  it("concurrent transactions on same document: 1 wins, 1 receives ABORTED_CONFLICT (409)", async () => {
    const docPath = `${prefix}accounts/acc_contention_1`;
    const docUrl = `${baseUrl}/v1/projects/${projectId}/documents/${docPath}`;

    // 1. Create baseline document with initial balance
    const initRes = await json<{ version: number }>(docUrl, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-project-key": apiKey },
      body: JSON.stringify({ data: { balance: 100 } }),
    });
    expect(initRes.status).toBe(200);
    expect(initRes.body.version).toBe(1);

    // 2. Begin Transaction A and Transaction B concurrently
    const txA = await json<{ transactionToken: string }>(
      `${baseUrl}/v1/projects/${projectId}/transactions:begin`,
      { method: "POST", headers: { "x-project-key": apiKey } }
    );
    expect(txA.status).toBe(200);

    const txB = await json<{ transactionToken: string }>(
      `${baseUrl}/v1/projects/${projectId}/transactions:begin`,
      { method: "POST", headers: { "x-project-key": apiKey } }
    );
    expect(txB.status).toBe(200);

    // 3. Both transactions read the same document (both observe version 1)
    const readA = await json<{ version: number; data: { balance: number } }>(
      `${docUrl}?transactionToken=${encodeURIComponent(txA.body.transactionToken)}`,
      { headers: { "x-project-key": apiKey } }
    );
    expect(readA.status).toBe(200);
    expect(readA.body.version).toBe(1);
    expect(readA.body.data.balance).toBe(100);

    const readB = await json<{ version: number; data: { balance: number } }>(
      `${docUrl}?transactionToken=${encodeURIComponent(txB.body.transactionToken)}`,
      { headers: { "x-project-key": apiKey } }
    );
    expect(readB.status).toBe(200);
    expect(readB.body.version).toBe(1);
    expect(readB.body.data.balance).toBe(100);

    // 4. Tx A commits first -> should succeed and bump version to 2
    const commitA = await json<{ results: Array<{ version: number }> }>(
      `${baseUrl}/v1/projects/${projectId}/transactions:commit`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-project-key": apiKey },
        body: JSON.stringify({
          transactionToken: txA.body.transactionToken,
          writes: [{ type: "update", path: docPath, data: { balance: 150 } }],
        }),
      }
    );
    expect(commitA.status).toBe(200);
    expect(commitA.body.results[0]?.version).toBe(2);

    // 5. Tx B attempts to commit based on stale version 1 -> MUST fail with 409 ABORTED_CONFLICT
    const commitB = await json<{ error: { code: string; message: string; details: any } }>(
      `${baseUrl}/v1/projects/${projectId}/transactions:commit`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-project-key": apiKey },
        body: JSON.stringify({
          transactionToken: txB.body.transactionToken,
          writes: [{ type: "update", path: docPath, data: { balance: 200 } }],
        }),
      }
    );
    expect(commitB.status).toBe(409);
    expect(commitB.body.error.code).toBe("ABORTED_CONFLICT");
    expect(commitB.body.error.details.expectedVersion).toBe(1);
    expect(commitB.body.error.details.actualVersion).toBe(2);

    // 6. Verify final document state in Postgres: balance is 150 (Tx A won)
    const finalDoc = await json<{ version: number; data: { balance: number } }>(docUrl, {
      headers: { "x-project-key": apiKey },
    });
    expect(finalDoc.status).toBe(200);
    expect(finalDoc.body.version).toBe(2);
    expect(finalDoc.body.data.balance).toBe(150);
  });

  it("SDK transaction runner with jitter backoff resolves contention automatically", async () => {
    const docPath = `${prefix}counters/shared_counter`;
    const docUrl = `${baseUrl}/v1/projects/${projectId}/documents/${docPath}`;

    // 1. Baseline document with counter = 0
    await json(docUrl, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-project-key": apiKey },
      body: JSON.stringify({ data: { count: 0 } }),
    });

    const client = createClient({
      projectId,
      apiKey,
      endpoint: baseUrl,
    });

    // 2. Launch 3 concurrent transactions that all read and increment count
    const runWorker = async (workerId: number) => {
      return client.runTransaction(async (tx) => {
        const snap = await tx.get<{ count: number }>(docPath);
        const currentCount = snap.data().count ?? 0;

        // Artificial delay to induce real concurrent collision
        await new Promise((r) => setTimeout(r, 10 + (workerId % 3) * 15));

        tx.update(docPath, { count: currentCount + 1, lastWorker: workerId });
        return currentCount + 1;
      });
    };

    const results = await Promise.all([runWorker(1), runWorker(2), runWorker(3)]);
    const finalCheck = await json<{ version: number; data: { count: number } }>(docUrl, {
      headers: { "x-project-key": apiKey },
    });
    expect(finalCheck.status).toBe(200);
    expect(finalCheck.body.version).toBe(4);
    expect(finalCheck.body.data.count).toBe(3);
  });
});
