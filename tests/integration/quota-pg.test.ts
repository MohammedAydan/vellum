import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QuotaGuard, UsageMeteringEngine } from "@vellum/billing";
import { PgControlPlaneStore } from "@vellum/database-control/adapters";
import { createRawPgClient, type RawPgClient } from "@vellum/database-control";

const controlUrl = process.env.CONTROL_DATABASE_URL;
const enabled = process.env.QUOTA_PG_TEST === "1";
const orgId = randomUUID();
const projectId = randomUUID();
const month = new Date().toISOString().slice(0, 7);
const date = new Date().toISOString().slice(0, 10);
let raw: RawPgClient;
let a: PgControlPlaneStore;
let b: PgControlPlaneStore;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

// Two independent pools stand in for two API instances. Nothing is shared except PostgreSQL.
describe.skipIf(!enabled)("quota and usage live in PostgreSQL", () => {
  beforeAll(async () => {
    if (!controlUrl) throw new Error("quota PG tests require CONTROL_DATABASE_URL");
    raw = createRawPgClient({ connectionString: controlUrl });
    await raw.connect();
    await raw.query("INSERT INTO organizations(id,slug,name,billing_email) VALUES($1,$2,'Quota PG','q@example.invalid')", [orgId, `qp-${orgId}`]);
    a = new PgControlPlaneStore({ connectionString: controlUrl });
    b = new PgControlPlaneStore({ connectionString: controlUrl });
    await a.billing.ensureSubscription(orgId);
  }, 30000);

  afterAll(async () => {
    for (const t of ["usage_monthly_rollups", "usage_daily_rollups", "usage_active_users"]) {
      await raw.query(`DELETE FROM ${t} WHERE org_id=$1`, [orgId]);
    }
    await raw.query("DELETE FROM org_subscriptions WHERE org_id=$1", [orgId]);
    await raw.query("DELETE FROM organizations WHERE id=$1", [orgId]);
    await raw.end();
    await Promise.all([a.close(), b.close()]);
  });

  it("concurrent additive flushes from two instances sum exactly and never overwrite", async () => {
    const delta = (ids: string[]) => ({
      orgId, projectId, billingMonth: month, usageDate: date,
      docReads: 3, docWrites: 2, docDeletes: 1, storageBytes: 100, egressBytes: 10,
      peakConcurrentWs: 2, authUserIds: ids,
    });
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 25; i++) {
      jobs.push(a.billing.applyUsageDelta(delta([`u${i}`])));
      jobs.push(b.billing.applyUsageDelta(delta([`u${i + 10}`])));
    }
    await Promise.all(jobs);
    const state = await a.billing.getQuotaState(orgId, month);
    expect(state?.usage.docReads).toBe(150);
    expect(state?.usage.docWrites).toBe(100);
    expect(state?.usage.docDeletes).toBe(50);
    expect(state?.usage.storageBytes).toBe(5000);
    expect(state?.usage.egressBytes).toBe(500);
    expect(state?.usage.peakConcurrentWs).toBe(2);
    // u0..u24 and u10..u34 overlap: 35 distinct users, counted once across instances.
    expect(state?.usage.authMau).toBe(35);
    const daily = await a.billing.listDaily(orgId, date, date);
    expect(daily[0]?.docReads).toBe(150);
  });

  it("negative storage deltas apply and storage never goes below zero", async () => {
    await a.billing.applyUsageDelta({ orgId, projectId, billingMonth: month, usageDate: date, docReads: 0, docWrites: 0, docDeletes: 0, storageBytes: -1000, egressBytes: 0, peakConcurrentWs: 0, authUserIds: [] });
    expect((await b.billing.getQuotaState(orgId, month))?.usage.storageBytes).toBe(4000);
    await a.billing.applyUsageDelta({ orgId, projectId, billingMonth: month, usageDate: date, docReads: 0, docWrites: 0, docDeletes: 0, storageBytes: -999999, egressBytes: 0, peakConcurrentWs: 0, authUserIds: [] });
    expect((await b.billing.getQuotaState(orgId, month))?.usage.storageBytes).toBe(0);
  });

  it("a suspension written through instance A blocks instance B on its very next check", async () => {
    const guardB = new QuotaGuard({ billing: b.billing });
    expect((await guardB.checkQuota(orgId, "read")).allowed).toBe(true);
    await a.billing.updateSubscription(orgId, { status: "suspended" });
    const decision = await guardB.checkQuota(orgId, "read");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("SUBSCRIPTION_SUSPENDED");
    await a.billing.updateSubscription(orgId, { status: "active" });
    expect((await guardB.checkQuota(orgId, "read")).allowed).toBe(true);
  });

  it("a cold instance enforces the plan hard limit from the database", async () => {
    const plan = await b.billing.getPlan((await b.billing.getSubscription(orgId))!.planId);
    const limit = plan?.includedDocReads ?? 0;
    if (!plan?.hardLimitEnforced || limit <= 0) return;
    await a.billing.applyUsageDelta({ orgId, projectId, billingMonth: month, usageDate: date, docReads: limit, docWrites: 0, docDeletes: 0, storageBytes: 0, egressBytes: 0, peakConcurrentWs: 0, authUserIds: [] });
    const cold = new QuotaGuard({ billing: new PgControlPlaneStore({ connectionString: controlUrl! }).billing });
    expect((await cold.checkQuota(orgId, "read")).code).toBe("QUOTA_EXCEEDED");
  });

  it("an engine flush failure keeps the delta and retries it without double counting", async () => {
    const real = a.billing;
    let fail = true;
    const flaky = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === "applyUsageDelta") {
          return async (input: Parameters<typeof real.applyUsageDelta>[0]) => {
            if (fail) throw new Error("db down");
            return target.applyUsageDelta(input);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const org2 = orgId;
    const proj2 = randomUUID();
    const engine = new UsageMeteringEngine({ billing: flaky as never, logger: { error() {} } });
    engine.recordReads(org2, proj2, 7);
    await engine.flush();
    fail = false;
    await engine.flush();
    await engine.flush();
    const rows = await real.listMonthly(org2, month);
    expect(rows.find((r) => r.projectId === proj2)?.docReads).toBe(7);
  });

  it("reports quota read latency", async () => {
    const guard = new QuotaGuard({ billing: b.billing });
    const samples: number[] = [];
    for (let i = 0; i < 300; i++) {
      const t = performance.now();
      await guard.checkQuota(orgId, "write");
      samples.push(performance.now() - t);
    }
    samples.sort((x, y) => x - y);
    console.log(`checkQuota ms p50=${percentile(samples, 50).toFixed(2)} p95=${percentile(samples, 95).toFixed(2)} p99=${percentile(samples, 99).toFixed(2)}`);
    expect(percentile(samples, 99)).toBeLessThan(200);
  });
});
