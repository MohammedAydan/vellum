import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgControlPlaneStore } from "@vellum/database-control/adapters";
import { createRawPgClient, type RawPgClient } from "@vellum/database-control";

const controlUrl = process.env.CONTROL_DATABASE_URL;
const enabled = process.env.THROTTLE_PG_TEST === "1";
const projectId = randomUUID();
const orgId = randomUUID();
let raw: RawPgClient;
let a: PgControlPlaneStore;
let b: PgControlPlaneStore;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function timings(label: string, runs: number, fn: () => Promise<unknown>): Promise<void> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((x, y) => x - y);
  console.log(
    `[perf] ${label}: p50=${percentile(samples, 50).toFixed(1)}ms ` +
      `p95=${percentile(samples, 95).toFixed(1)}ms p99=${percentile(samples, 99).toFixed(1)}ms (n=${runs})`
  );
}

// Two independent stores stand in for two API instances. Nothing is shared except PostgreSQL.
describe.skipIf(!enabled)("auth throttles and usage counters are durable in PostgreSQL", () => {
  beforeAll(async () => {
    if (!controlUrl) throw new Error("Throttle PG tests require CONTROL_DATABASE_URL");
    raw = createRawPgClient({ connectionString: controlUrl });
    await raw.connect();
    await raw.query(
      "INSERT INTO organizations(id,slug,name,billing_email) VALUES($1,$2,'Throttle PG','throttle@example.invalid')",
      [orgId, `tp-${orgId}`]
    );
    await raw.query(
      "INSERT INTO projects(id,organization_id,slug,name) VALUES($1,$2,'throttle-pg','Throttle PG')",
      [projectId, orgId]
    );
    a = new PgControlPlaneStore({ connectionString: controlUrl });
    b = new PgControlPlaneStore({ connectionString: controlUrl });
  }, 30000);

  afterAll(async () => {
    await raw.query("DELETE FROM auth_throttle_events WHERE scope LIKE 'tpg-%'");
    await raw.query("DELETE FROM auth_failure_counters WHERE scope LIKE 'tpg-%'");
    await raw.query("DELETE FROM project_usage_daily WHERE project_id=$1", [projectId]);
    await raw.query("DELETE FROM projects WHERE id=$1", [projectId]);
    await raw.query("DELETE FROM organizations WHERE id=$1", [orgId]);
    await raw.end();
    await Promise.all([a.close(), b.close()]);
  });

  it("slots reserved on instance A fill the window seen by instance B", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await a.throttle.acquireThrottleSlot("tpg-login", "id-1", 60_000, 3)).acquired).toBe(true);
    }
    const blocked = await b.throttle.acquireThrottleSlot("tpg-login", "id-1", 60_000, 3);
    expect(blocked.acquired).toBe(false);
    expect(blocked.countBefore).toBe(3);
  });

  it("concurrent reservers across instances cannot all pass one free slot", async () => {
    const stores = [a, b];
    const slots = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        stores[i % 2]!.throttle.acquireThrottleSlot("tpg-race", "id-1", 60_000, 4)
      )
    );
    expect(slots.filter((s) => s.acquired)).toHaveLength(4);
    expect(slots.filter((s) => !s.acquired)).toHaveLength(8);
  });

  it("a slot released on one instance frees capacity on the other", async () => {
    const first = await a.throttle.acquireThrottleSlot("tpg-release", "id-1", 60_000, 1);
    expect(first.acquired).toBe(true);
    expect((await b.throttle.acquireThrottleSlot("tpg-release", "id-1", 60_000, 1)).acquired).toBe(false);
    await a.throttle.releaseThrottleSlot(first.eventId!);
    expect((await b.throttle.acquireThrottleSlot("tpg-release", "id-1", 60_000, 1)).acquired).toBe(true);
  });

  it("window expiry is enforced by the database clock", async () => {
    expect((await a.throttle.acquireThrottleSlot("tpg-window", "id-1", 300, 1)).acquired).toBe(true);
    expect((await b.throttle.acquireThrottleSlot("tpg-window", "id-1", 300, 1)).acquired).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect((await b.throttle.acquireThrottleSlot("tpg-window", "id-1", 300, 1)).acquired).toBe(true);
  });

  it("failure counters increment atomically, cap at max and lock out across instances", async () => {
    for (let i = 1; i <= 5; i += 1) {
      expect(await a.throttle.incrementFailureCounter("tpg-mfa", "subj-1", 60_000, 5)).toBe(i);
    }
    // Capped: never grows past max, and instance B sees the lockout.
    expect(await a.throttle.incrementFailureCounter("tpg-mfa", "subj-1", 60_000, 5)).toBe(5);
    expect(await b.throttle.getFailureCounter("tpg-mfa", "subj-1")).toBe(5);
    await b.throttle.clearFailureCounter("tpg-mfa", "subj-1");
    expect(await a.throttle.getFailureCounter("tpg-mfa", "subj-1")).toBe(0);
    expect(await a.throttle.incrementFailureCounter("tpg-mfa", "subj-1", 60_000, 5)).toBe(1);
  });

  it("concurrent failure increments never lose a count", async () => {
    const counts = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? a : b).throttle.incrementFailureCounter("tpg-mfa", "subj-2", 60_000, 100)
      )
    );
    expect(Math.max(...counts)).toBe(20);
  });

  it("pruning drops old events and expired counters", async () => {
    await a.throttle.acquireThrottleSlot("tpg-prune", "id-1", 60_000, 5);
    await a.throttle.incrementFailureCounter("tpg-prune", "subj", 1, 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await a.throttle.pruneExpiredThrottleState(10);
    expect(await b.throttle.getFailureCounter("tpg-prune", "subj")).toBe(0);
    const { rows } = await raw.query("SELECT count(*)::int AS n FROM auth_throttle_events WHERE scope='tpg-prune'");
    expect(rows[0]!["n"]).toBe(0);
  });

  it("usage increments from two instances land in one atomic row", async () => {
    await a.incrementUsage(projectId, { documentReads: 5, documentWrites: 2, storageBytesDelta: 100 });
    await b.incrementUsage(projectId, { documentReads: 3, realtimeMessagesSent: 4, storageBytesDelta: -40 });
    const concurrent = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? a : b).incrementUsage(projectId, { documentReads: 1 })
      )
    );
    // Concurrent calls resolve in any order: the record with the most reads is the final state.
    const last = concurrent.reduce((m, r) => (r.documentReads > m.documentReads ? r : m));
    expect(last.documentReads).toBe(28);
    expect(last.documentWrites).toBe(2);
    expect(last.realtimeMessagesSent).toBe(4);
    expect(last.storageBytes).toBe(60);
    const { rows } = await raw.query(
      "SELECT document_reads FROM project_usage_daily WHERE project_id=$1",
      [projectId]
    );
    expect(Number(rows[0]!["document_reads"])).toBe(28);
  });

  it("storage bytes never go below zero", async () => {
    const rec = await a.incrementUsage(projectId, { storageBytesDelta: -10_000 });
    expect(rec.storageBytes).toBe(0);
  });

  it("measures per-call latency (informational, printed to CI logs)", async () => {
    await timings("acquireThrottleSlot", 50, () =>
      a.throttle.acquireThrottleSlot("tpg-perf", "id-1", 60_000, 10_000).then((s) => {
        if (s.eventId) return a.throttle.releaseThrottleSlot(s.eventId);
        return undefined;
      })
    );
    await timings("incrementFailureCounter", 50, () =>
      a.throttle.incrementFailureCounter("tpg-perf", "subj", 60_000, 10_000)
    );
    await timings("incrementUsage", 50, () => a.incrementUsage(projectId, { documentReads: 1 }));
  }, 60000);
});
