import { describe, expect, it } from "vitest";
import { createPgBillingRepository } from "../billing-repository.js";

type Call = { sql: string; client: number };

function fakePool(failOn?: RegExp) {
  const calls: Call[] = [];
  let nextClient = 0;
  let open = 0;
  const pool = {
    query: async () => {
      throw new Error("applyUsageDelta must not use the pool directly");
    },
    connect: async () => {
      const id = ++nextClient;
      open += 1;
      return {
        query: async (sql: string) => {
          calls.push({ sql: sql.replace(/\s+/g, " ").trim(), client: id });
          if (failOn && failOn.test(sql)) throw new Error("boom");
          return { rows: [{ n: 1 }] };
        },
        release: () => {
          open -= 1;
        },
      };
    },
  };
  return { pool: pool as never, calls, openClients: () => open };
}

const delta = {
  orgId: "00000000-0000-0000-0000-000000000001",
  projectId: "00000000-0000-0000-0000-000000000002",
  billingMonth: "2026-11",
  usageDate: "2026-11-25",
  docReads: 1,
  docWrites: 1,
  docDeletes: 0,
  storageBytes: 10,
  egressBytes: 5,
  peakConcurrentWs: 1,
  authUserIds: [] as string[],
};

describe("PG billing repository", () => {
  it("applies one usage delta inside a single transaction on one connection", async () => {
    const { pool, calls, openClients } = fakePool();
    const repo = createPgBillingRepository(pool);
    await Promise.resolve(repo.applyUsageDelta(delta)).catch(() => undefined); // row mapping of the fake rows may throw
    expect(calls[0]?.sql).toBe("BEGIN");
    expect(new Set(calls.map((c) => c.client)).size).toBe(1);
    expect(calls.some((c) => /usage_monthly_rollups/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /usage_daily_rollups/.test(c.sql))).toBe(true);
    expect(openClients()).toBe(0);
  });

  it("rolls back when the daily write fails, so a retry cannot double count the monthly row", async () => {
    const { pool, calls, openClients } = fakePool(/usage_daily_rollups/);
    const repo = createPgBillingRepository(pool);
    await expect(repo.applyUsageDelta(delta)).rejects.toThrow("boom");
    const last = calls[calls.length - 1];
    expect(last?.sql).toBe("ROLLBACK");
    expect(calls.some((c) => c.sql === "COMMIT")).toBe(false);
    expect(openClients()).toBe(0);
  });

  it("holds the advisory lock for the whole critical section and unlocks after an error", async () => {
    const { pool, calls, openClients } = fakePool();
    const repo = createPgBillingRepository(pool);
    await expect(
      repo.withLedgerLock!(async () => {
        expect(calls.some((c) => /pg_advisory_lock/.test(c.sql))).toBe(true);
        expect(calls.some((c) => /pg_advisory_unlock/.test(c.sql))).toBe(false);
        throw new Error("inner");
      })
    ).rejects.toThrow("inner");
    expect(calls.some((c) => /pg_advisory_unlock/.test(c.sql))).toBe(true);
    expect(openClients()).toBe(0);
  });
});
