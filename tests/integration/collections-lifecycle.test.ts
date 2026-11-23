/**
 * tests/integration/collections-lifecycle
 *
 * LIVE (PHASE5_REAL=1) proof of the Collections Lifecycle contract:
 *   1. An API-created empty collection is listed with documentCount 0.
 *   2. A direct document write auto-registers an unregistered collection.
 *   3. requiredFields rejects invalid writes; defaultTtlSeconds stamps expiresAt.
 *   4. Clear keeps the (empty) registration; Delete removes it and its documents.
 *   5. project_collections FORCE RLS fails closed across projects.
 *
 * Skipped unless PHASE5_REAL=1 so the ordinary CI suite stays green. The QA
 * tenant is addressed through VELLUM_QA_* env vars (with the known live values
 * as fallback). Collection lists always request `limit=500`: the live registry
 * already holds more than the API's default page of 50.
 *
 * No secrets (API keys, DB URLs, JWTs) are ever logged.
 */
import "./_live-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { createClient, type VellumClient } from "@vellumdb/sdk-js";
import { startNodeApiServer } from "../../apps/api/src/node-server.js";
import {
  createRawPgClient,
  type RawPgClient,
} from "../../packages/database-control/src/index.js";
import { withTenantData } from "../e2e-real/tenant-data-sql.js";
import { ensureLiveEnv } from "./_live-env.js";

const REAL_DATABASE_ENABLED = process.env.PHASE5_REAL === "1";
const ORG_ID = process.env.VELLUM_QA_ORG_ID ?? "d29c31e0-e93f-402c-8499-74909e9bfb0a";
const PROJECT_ID = process.env.VELLUM_QA_PROJECT_ID ?? "1382468e-5dc0-44a8-9b68-5427a5b6ea5c";
const LIST_LIMIT = 500;
const PREFIX = `qa_lc_${Date.now()}_`;

const EMPTY_COL = `${PREFIX}empty`;
const AUTO_COL = `${PREFIX}auto`;
const TTL_COL = `${PREFIX}ttl`;
const CLEAR_COL = `${PREFIX}clear`;
const ALL_NAMES = [EMPTY_COL, AUTO_COL, TTL_COL, CLEAR_COL] as const;

interface JsonResult<T> {
  status: number;
  body: T;
}

async function json<T>(url: string, init?: RequestInit): Promise<JsonResult<T>> {
  const response = await fetch(url, init);
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, body: (parsed ?? {}) as T };
}

let server: Awaited<ReturnType<typeof startNodeApiServer>> | undefined;
let baseUrl = "";
let db: VellumClient | undefined;
let serverKeyId = "";
let dataClient: RawPgClient | undefined;
let controlClient: RawPgClient | undefined;

/** All raw statements bind the tenant GUCs; no superuser/bypass role is used. */
async function rawScalar<T extends string | number | null>(
  sql: string,
  params: unknown[]
): Promise<T | null> {
  const client = dataClient as RawPgClient;
  const { rows } = await withTenantData(client, PROJECT_ID, (tx) =>
    tx.query<{ value: T }>(sql, params)
  );
  return rows[0]?.value ?? null;
}

describe.skipIf(!REAL_DATABASE_ENABLED)("tests/integration/collections-lifecycle", () => {
  beforeAll(async () => {
    ensureLiveEnv();
    if ((process.env.DATABASE_MODE ?? "memory") !== "postgres") {
      throw new Error("PHASE5_REAL=1 requires DATABASE_MODE=postgres");
    }
    const controlUrl =
      process.env.CONTROL_DATABASE_URL_DIRECT ?? process.env.CONTROL_DATABASE_URL ?? "";
    const dataUrl =
      process.env.DATA_DATABASE_URL_DIRECT ?? process.env.DATA_DATABASE_URL ?? "";
    if (!controlUrl || !dataUrl) {
      throw new Error("PHASE5_REAL=1 requires CONTROL_DATABASE_URL and DATA_DATABASE_URL");
    }
    if (!ORG_ID || !PROJECT_ID) {
      throw new Error("QA tenant ids are required (VELLUM_QA_ORG_ID / VELLUM_QA_PROJECT_ID)");
    }

    server = await startNodeApiServer({ port: 0 });
    baseUrl = `http://127.0.0.1:${server.port}`;

    const createdKey = await json<{ apiKey?: { id?: string }; rawKey?: string }>(
      `${baseUrl}/v1/projects/${PROJECT_ID}/api-keys`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `${PREFIX}key`, keyType: "secret" }),
      }
    );
    if (createdKey.status !== 201 || !createdKey.body.rawKey?.startsWith("sk_")) {
      throw new Error(`could not provision a QA server key (HTTP ${createdKey.status})`);
    }
    serverKeyId = createdKey.body.apiKey?.id ?? "";
    db = createClient({
      projectId: PROJECT_ID,
      apiKey: createdKey.body.rawKey,
      endpoint: baseUrl,
    });

    controlClient = createRawPgClient({
      connectionString: controlUrl,
      applicationName: "vellum-collections-lifecycle-control",
    });
    dataClient = createRawPgClient({
      connectionString: dataUrl,
      applicationName: "vellum-collections-lifecycle-data",
    });
    await controlClient.connect();
    await dataClient.connect();

    // Remove leftovers from an interrupted previous run so each name is fresh.
    for (const name of ALL_NAMES) {
      await db.deleteCollection(name).catch(() => undefined);
    }
  }, 60_000);

  afterAll(async () => {
    if (db) {
      for (const name of ALL_NAMES) {
        await db.deleteCollection(name).catch(() => undefined);
      }
    }
    if (baseUrl && serverKeyId) {
      await json(
        `${baseUrl}/v1/projects/${PROJECT_ID}/api-keys/${serverKeyId}`,
        { method: "DELETE" }
      ).catch(() => undefined);
    }
    if (dataClient) await dataClient.end().catch(() => undefined);
    if (controlClient) await controlClient.end().catch(() => undefined);
    if (server) await server.stop();
  }, 60_000);

  it("creates an empty collection via API and lists it with documentCount 0", async () => {
    const client = db as VellumClient;
    const created = await client.createCollection(EMPTY_COL);
    expect(created.name).toBe(EMPTY_COL);
    expect(created.documentCount).toBe(0);

    const listed = await client.listCollections({ limit: LIST_LIMIT, search: EMPTY_COL });
    const row = listed.collections.find((item) => item.name === EMPTY_COL);
    expect(row).toBeDefined();
    expect(row?.documentCount).toBe(0);
  }, 60_000);

  it("auto-discovers a collection written directly to an unregistered path", async () => {
    const client = db as VellumClient;
    await client.collection(AUTO_COL).doc("doc_1").set({ note: "auto-discovered" });

    const listed = await client.listCollections({ limit: LIST_LIMIT, search: AUTO_COL });
    const row = listed.collections.find((item) => item.name === AUTO_COL);
    expect(row).toBeDefined();
    expect(row?.documentCount).toBe(1);
  }, 60_000);

  it("enforces requiredFields and applies defaultTtlSeconds on writes", async () => {
    const client = db as VellumClient;
    await client.createCollection(TTL_COL);
    await client.updateCollection(TTL_COL, {
      schemaValidation: { requiredFields: ["amount"] },
      defaultTtlSeconds: 3600,
    });

    const info = await client.getCollectionInfo(TTL_COL);
    expect(info?.defaultTtlSeconds).toBe(3600);
    expect(info?.schemaValidation?.requiredFields).toEqual(["amount"]);

    let rejected: { status?: number; code?: string } | undefined;
    try {
      await client.collection(TTL_COL).doc("missing").set({ note: "hi" });
    } catch (error: unknown) {
      rejected = error as { status?: number; code?: string };
    }
    expect(rejected?.status).toBe(400);
    expect(rejected?.code).toBe("INVALID_ARGUMENT");

    await client.collection(TTL_COL).doc("valid").set({ amount: 100 });
    const expiresAt = await rawScalar<string>(
      "SELECT expires_at::text AS value FROM documents WHERE path = $1",
      [`${TTL_COL}/valid`]
    );
    expect(expiresAt).toBeTruthy();
    const expiresMs = Date.parse(expiresAt ?? "");
    expect(expiresMs).toBeGreaterThan(Date.now() + 3_000_000);
    expect(expiresMs).toBeLessThan(Date.now() + 4_000_000);
  }, 60_000);

  it("keeps an empty collection after clear and removes it with its documents on delete", async () => {
    const client = db as VellumClient;
    await client.createCollection(CLEAR_COL);
    await client.collection(CLEAR_COL).doc("d1").set({ value: 1 });
    expect((await client.getCollectionInfo(CLEAR_COL))?.documentCount).toBe(1);

    const cleared = await client.clearCollection(CLEAR_COL);
    expect(cleared.deletedCount).toBeGreaterThanOrEqual(1);
    const afterClear = await client.getCollectionInfo(CLEAR_COL);
    expect(afterClear).not.toBeNull();
    expect(afterClear?.documentCount).toBe(0);

    await client.collection(CLEAR_COL).doc("d2").set({ value: 2 });
    const dropped = await client.deleteCollection(CLEAR_COL);
    expect(dropped.deletedCollection).toBe(true);
    expect(dropped.deletedDocuments).toBeGreaterThanOrEqual(1);
    expect(await client.getCollectionInfo(CLEAR_COL)).toBeNull();

    const remaining = await rawScalar<number>(
      "SELECT count(*)::int AS value FROM documents WHERE collection_path = $1",
      [CLEAR_COL]
    );
    expect(Number(remaining ?? -1)).toBe(0);
  }, 60_000);

  it("isolates project_collections across projects under FORCE RLS", async () => {
    const client = dataClient as RawPgClient;
    const name = `${PREFIX}rls`;
    const tenantA = { projectId: crypto.randomUUID() };
    const tenantB = { projectId: crypto.randomUUID() };
    const tenantC = { projectId: crypto.randomUUID() };

    // The direct Neon role has BYPASSRLS; assertions run as the least-privilege
    // `vellum_app` role, exactly like the existing live RLS convention.
    await client.query("GRANT vellum_app TO CURRENT_USER").catch(() => undefined);

    await withTenantData(client, tenantA.projectId, async (tx) => {
      await tx.query("SET LOCAL ROLE vellum_app");
      await tx.query(
        `INSERT INTO project_collections (project_id, name)
         VALUES ($1::uuid, $2)`,
        [tenantA.projectId, name]
      );
      const own = await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM project_collections WHERE name = $1",
        [name]
      );
      expect(Number(own.rows[0]?.n ?? -1)).toBe(1);
    });

    for (const other of [tenantB, tenantC]) {
      await withTenantData(client, other.projectId, async (tx) => {
        await tx.query("SET LOCAL ROLE vellum_app");
        const cross = await tx.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM project_collections WHERE name = $1",
          [name]
        );
        expect(Number(cross.rows[0]?.n ?? -1)).toBe(0);

        let thrownCode = "";
        let inserted = 0;
        try {
          const result = await tx.query(
            `INSERT INTO project_collections (project_id, name)
             VALUES ($1::uuid, $2)`,
            [tenantA.projectId, `${name}_cross`]
          );
          inserted = result.rowCount ?? 0;
        } catch (error: unknown) {
          thrownCode =
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code: unknown }).code)
              : "";
        }
        if (thrownCode) expect(thrownCode).toBe("42501");
        else expect(inserted).toBe(0);
      });
    }

    await withTenantData(client, tenantA.projectId, async (tx) => {
      await tx.query("DELETE FROM project_collections WHERE name = $1", [name]);
    });
  }, 60_000);
});
