/**
 * REAL Neon verification of metering persistence.
 *
 * Proves that counters written with `incrementUsage()` are NOT queryable via
 * `/v1/projects/:projectId/usage` until `flush()` runs, and that they
 * survive a simulated process restart (a fresh `PgControlPlaneStore` that only
 * calls `initialize()`/`refresh()`).
 *
 * PostgreSQL only — no in-memory stores, no fabricated values. Connection strings are
 * loaded from `.env.phase5.local` and are never printed.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createInMemoryRevocationStore,
  createSessionService,
} from "@vellum/authorization";
import { loadEnvFiles } from "@vellum/database-control";
import { PgControlPlaneStore } from "@vellum/database-control/adapters";
import { PgStorageAdapter } from "@vellum/storage/adapters";
import { createAdminRoutes } from "../../../apps/api/src/routes/admin.js";
import { createUsageRoutes } from "../../../apps/api/src/routes/usage.js";

// The per-package `test:integration` script runs vitest with CWD=apps/api, so
// relative env paths would resolve there. Derive the repository root from the
// test file location instead.
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
loadEnvFiles([path.join(REPO_ROOT, ".env.phase5.local"), path.join(REPO_ROOT, ".env")]);
const REAL_DATABASE_ENABLED = Boolean(
  process.env.CONTROL_DATABASE_URL_DIRECT ||
    process.env.CONTROL_DATABASE_URL ||
    process.env.DATA_DATABASE_URL_DIRECT ||
    process.env.DATA_DATABASE_URL
);

const PREFIX = `m4_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
let control: PgControlPlaneStore;
let restartedControl: PgControlPlaneStore;
let data: PgStorageAdapter;
let app: ReturnType<typeof createUsageRoutes>;
let restartedApp: ReturnType<typeof createUsageRoutes>;
let adminApp: ReturnType<typeof createAdminRoutes>;
let projectId = "";
let organizationId = "";
let userId = "";
let token = "";

function usagePath(): string {
  return `/projects/${projectId}/usage`;
}

async function readUsage(target: ReturnType<typeof createUsageRoutes> = app) {
  const response = await target.request(usagePath(), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status !== 200) {
    throw new Error(`GET /usage failed with ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as {
    totals: {
      documentReads: number;
      documentWrites: number;
      documentDeletes: number;
      realtimeMessagesSent: number;
      egressBytes: number;
      storageBytes: number;
    };
    days: number;
    usage: Array<{ usageDate: string; documentReads: number }>;
  };
}

describe.skipIf(!REAL_DATABASE_ENABLED)("real Neon metering persistence", () => {
  beforeAll(async () => {
    const controlUrl = process.env.CONTROL_DATABASE_URL_DIRECT || process.env.CONTROL_DATABASE_URL;
    const dataUrl = process.env.DATA_DATABASE_URL_DIRECT || process.env.DATA_DATABASE_URL;
    if (!controlUrl || !dataUrl) {
      throw new Error("This real test requires CONTROL_DATABASE_URL and DATA_DATABASE_URL");
    }

    control = new PgControlPlaneStore({ connectionString: controlUrl });
    await control.initialize();
    data = new PgStorageAdapter({ connectionString: dataUrl });

    const user = await control.createUser({
      email: `${PREFIX}@example.test`,
      name: "Metering Test Owner",
      platformRole: "owner",
    });
    userId = user.id;
    const org = await control.createOrganization({
      slug: `${PREFIX}org`.replace(/_/g, "-"),
      name: "Metering Test Org",
      billingEmail: `${PREFIX}@example.test`,
      ownerUserId: user.id,
    });
    organizationId = org.id;
    const created = await control.createProject({
      organizationId: org.id,
      slug: `${PREFIX}project`.replace(/_/g, "-"),
      name: "Metering Test Project",
      actorUserId: user.id,
    });
    projectId = created.project.id;

    const sessionService = createSessionService({
      secret: "neon-test-session-secret-with-32-chars",
      revocationStore: createInMemoryRevocationStore(),
    });
    token = sessionService.signAccess({
      sub: user.id,
      uid: user.id,
      role: "owner",
      orgIds: [org.id],
    });

    app = createUsageRoutes(control, sessionService, data);
    adminApp = createAdminRoutes(control, data, sessionService);

    // Restart simulation: brand-new store instance hydrates from PostgreSQL.
    restartedControl = new PgControlPlaneStore({ connectionString: controlUrl });
    await restartedControl.initialize();
    restartedApp = createUsageRoutes(restartedControl, sessionService, data);
  }, 60_000);

  afterAll(async () => {
    if (!control) return;
    const pool = control.pool;
    await pool.query("DELETE FROM project_usage_daily WHERE project_id = $1::uuid", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM audit_logs WHERE project_id = $1::uuid OR organization_id = $2::uuid", [
      projectId,
      organizationId,
    ]).catch(() => undefined);
    await pool.query("DELETE FROM security_rulesets WHERE project_id = $1::uuid", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM api_keys WHERE project_id = $1::uuid", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM projects WHERE id = $1::uuid", [projectId]).catch(() => undefined);
    await pool.query("DELETE FROM organization_members WHERE organization_id = $1::uuid", [organizationId]).catch(() => undefined);
    await pool.query("DELETE FROM organizations WHERE id = $1::uuid", [organizationId]).catch(() => undefined);
    await pool.query("DELETE FROM users WHERE id = $1::uuid", [userId]).catch(() => undefined);
    await Promise.allSettled([control.close(), restartedControl?.close(), data.close()]);
  }, 60_000);

  it("incrementUsage counters become queryable only after flush(), and survive refresh()", async () => {
    expect(projectId).toBeTruthy();

    const before = await readUsage();
    expect(before.totals.documentReads).toBe(0);

    control.incrementUsage(projectId, {
      documentReads: 7,
      documentWrites: 3,
      documentDeletes: 1,
      realtimeMessagesSent: 2,
      egressBytes: 100,
      storageBytesDelta: 2_048,
    });

    // Still buffered: /usage reads durable rows only.
    const buffered = await readUsage();
    expect(buffered.totals.documentReads).toBe(0);

    await control.flush();

    const flushed = await readUsage();
    expect(flushed.totals.documentReads).toBe(7);
    expect(flushed.totals.documentWrites).toBe(3);
    expect(flushed.totals.documentDeletes).toBe(1);
    expect(flushed.totals.storageBytes).toBe(2_048);
    expect(flushed.days).toBe(1);

    // Simulated restart: a fresh store that only refreshes sees the same data.
    await restartedControl.refresh();
    const afterRestart = await readUsage(restartedApp);
    expect(afterRestart.totals.documentReads).toBe(7);
    expect(afterRestart.totals.documentWrites).toBe(3);
    expect(afterRestart.totals.storageBytes).toBe(2_048);
    expect(afterRestart.days).toBe(1);
  }, 60_000);

  it("a second increment follows the same flush -> query path", async () => {
    control.incrementUsage(projectId, { documentReads: 5 });
    expect((await readUsage()).totals.documentReads).toBe(7);
    await control.flush();
    expect((await readUsage()).totals.documentReads).toBe(12);
    await restartedControl.refresh();
    expect((await readUsage(restartedApp)).totals.documentReads).toBe(12);
  }, 60_000);

  it("admin overview and tenants expose live telemetry from PostgreSQL", async () => {
    const overviewRes = await adminApp.request("/admin/overview", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(overviewRes.status).toBe(200);
    const overview = (await overviewRes.json()) as {
      nodes: Array<{ id: string; type: string; endpoint: string }>;
      metrics: Array<{ source: string; documentReads: number }>;
      telemetry: {
        controlDb: { activeConnections: number; maxConnections: number };
        dataDb: { activeConnections: number; maxConnections: number };
        pool: { control: { total: number }; data: { total: number } };
        outboxLagSeqId: number;
        usageTotals: { documentReads: number };
      };
    };
    expect(overview.nodes.map((node) => node.id)).toEqual(["pg-control-primary", "pg-data-primary"]);
    expect(overview.nodes.some((node) => node.type === "cache")).toBe(false);
    expect(overview.nodes.every((node) => !node.endpoint.includes("postgresql://"))).toBe(true);
    expect(overview.telemetry.controlDb.activeConnections).toBeGreaterThan(0);
    expect(overview.telemetry.controlDb.maxConnections).toBeGreaterThan(0);
    expect(overview.telemetry.dataDb.activeConnections).toBeGreaterThan(0);
    expect(overview.telemetry.pool.control.total).toBeGreaterThan(0);
    expect(overview.telemetry.pool.data.total).toBeGreaterThan(0);
    expect(overview.telemetry.outboxLagSeqId).toBeGreaterThanOrEqual(0);
    expect(overview.telemetry.usageTotals.documentReads).toBeGreaterThanOrEqual(12);
    expect(overview.metrics.some((m) => m.source === "project_usage_daily")).toBe(true);
    expect(overview.metrics.some((m) => m.documentReads >= 12)).toBe(true);

    const tenantsRes = await adminApp.request("/admin/tenants", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(tenantsRes.status).toBe(200);
    const tenants = (await tenantsRes.json()) as Array<{ id: string; dailyReads: number }>;
    const tenant = tenants.find((item) => item.id === organizationId);
    expect(tenant?.dailyReads).toBe(12);
  }, 60_000);
});
