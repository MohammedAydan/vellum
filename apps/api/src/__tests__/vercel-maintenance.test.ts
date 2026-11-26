import { describe, expect, it } from "vitest";
import { handleMaintenanceRequest, runPurgeRounds, MAINTENANCE_OUTBOX_BATCH } from "../runtime/vercel-maintenance.js";

const store = (counts: number[]) => {
  let i = 0;
  return {
    calls: () => i,
    runOutboxCompactionWorker: async () => ({ purgedCount: counts[i++] ?? 0 }),
    runTombstonePurgeWorker: async () => ({ purgedCount: 0 }),
  };
};
const SECRET = "s".repeat(32);
const req = (headers: Record<string, string> = {}, path = "/v1/internal/maintenance", method = "GET") =>
  new Request(`https://api.example.com${path}`, { method, headers });

describe("vercel maintenance", () => {
  it("repeats while the outbox batch comes back full, then stops", async () => {
    const s = store([MAINTENANCE_OUTBOX_BATCH, MAINTENANCE_OUTBOX_BATCH, 7]);
    const r = await runPurgeRounds(s);
    expect(r.outboxEventsPurged).toBe(2 * MAINTENANCE_OUTBOX_BATCH + 7);
    expect(r.rounds).toBe(3);
  });
  it("stops at the time budget", async () => {
    let t = 0;
    const s = store(Array(50).fill(MAINTENANCE_OUTBOX_BATCH));
    const r = await runPurgeRounds(s, 100, () => (t += 60));
    expect(r.rounds).toBeLessThanOrEqual(3);
  });
  it("is invisible without the right bearer token", async () => {
    const s = store([0]);
    expect((await handleMaintenanceRequest(req(), s, {}))!.status).toBe(404);
    expect((await handleMaintenanceRequest(req(), s, { CRON_SECRET: SECRET }))!.status).toBe(404);
    expect((await handleMaintenanceRequest(req({ authorization: "Bearer wrong" }), s, { CRON_SECRET: SECRET }))!.status).toBe(404);
    expect((await handleMaintenanceRequest(req({ authorization: `Bearer ${SECRET}` }), s, { CRON_SECRET: "short" }))!.status).toBe(404);
    expect(s.calls()).toBe(0);
  });
  it("runs with the right token and ignores other paths", async () => {
    const s = store([3]);
    const res = await handleMaintenanceRequest(req({ authorization: `Bearer ${SECRET}` }), s, { CRON_SECRET: SECRET });
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ outboxEventsPurged: 3 });
    expect(await handleMaintenanceRequest(req({}, "/v1/health"), s, { CRON_SECRET: SECRET })).toBeNull();
  });
});
