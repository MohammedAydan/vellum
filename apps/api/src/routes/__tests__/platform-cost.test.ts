import { describe, it, expect, afterAll } from "vitest";
import { createVellumPlatform } from "../../platform.js";

// Platform cost routes run against the in-memory control store here, which is
// also the documented offline mode: no durable buckets, live counters only, and
// a price book that comes from the shipped defaults.
const platform = createVellumPlatform({});
const ownerId = `owner-${Date.now()}`;

async function ownerToken(): Promise<string> {
  const user = await platform.controlStore.createUser({
    email: `${ownerId}@example.invalid`,
    name: "Cost owner",
    platformRole: "owner",
  });
  await platform.controlStore.setPlatformSuperAdmin(user.id, true);
  return platform.superAdminSessionService.signAccess({ sub: user.id, uid: user.id, role: "owner", orgIds: [] });
}

async function readonlyToken(): Promise<string> {
  const user = await platform.controlStore.createUser({
    email: `readonly-${ownerId}@example.invalid`,
    name: "Cost reader",
    platformRole: "support_readonly",
  });
  await platform.controlStore.setPlatformSuperAdmin(user.id, true);
  return platform.superAdminSessionService.signAccess({
    sub: user.id,
    uid: user.id,
    role: "support_readonly",
    orgIds: [],
  });
}

afterAll(async () => {
  await platform.platformUsage.stop();
});

describe("platform cost routes", () => {
  it("rejects every cost endpoint without an operator session", async () => {
    for (const path of ["/v1/admin/cost/usage", "/v1/admin/cost/summary", "/v1/admin/cost/projects", "/v1/admin/cost/price-book"]) {
      expect((await platform.app.request(path)).status).toBe(401);
    }
    expect((await platform.app.request("/v1/admin/cost/price-book", { method: "POST" })).status).toBe(401);
  });

  it("returns a priced summary labelled as an estimate, with its reasons", async () => {
    // Any request before the summary is counted by the platform meter.
    await platform.app.request("/health");
    const token = await ownerToken();
    const res = await platform.app.request("/v1/admin/cost/summary", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("memory");
    expect(body.accuracy.level).toBe("estimate");
    expect(body.accuracy.reasons.join(" ")).toContain("not synced");
    expect(typeof body.totalUsd).toBe("string");
    expect(body.totalMicros).toBeGreaterThanOrEqual(0);
    expect(body.counters.requestsRead).toBeGreaterThanOrEqual(1);
    // The process clock, CPU time and byte totals are recorded too.
    expect(body.counters.cpuMs).toBeGreaterThanOrEqual(0);
  });

  it("serves the daily series and says so when nothing durable exists yet", async () => {
    const token = await ownerToken();
    const res = await platform.app.request("/v1/admin/cost/usage?from=2026-11-01&to=2026-11-28", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.granularity).toBe("day");
    expect(body.series).toEqual([]);
    expect(body.note).toContain("No durable buckets");
  });

  it("serves the price book with the shipped vendor rates", async () => {
    const token = await ownerToken();
    const res = await platform.app.request("/v1/admin/cost/price-book", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("memory");
    expect(body.entries.length).toBeGreaterThanOrEqual(10);
    expect(body.entries.map((entry: { sku: string }) => entry.sku)).toContain("neon_compute");
  });

  it("refuses a price-book write without a PostgreSQL control store, and for read-only operators", async () => {
    const readonly = await readonlyToken();
    const payload = {
      method: "POST",
      headers: { authorization: `Bearer ${readonly}`, "content-type": "application/json" },
      body: JSON.stringify({
        provider: "vercel",
        sku: "cdn_requests",
        unit: "request",
        unitSize: 1_000_000,
        priceMicros: 2_500_000,
        includedUnits: 10_000_000,
        sourceUrl: "https://vercel.com/pricing",
      }),
    };
    expect((await platform.app.request("/v1/admin/cost/price-book", payload)).status).toBe(403);

    const owner = await ownerToken();
    const res = await platform.app.request("/v1/admin/cost/price-book", {
      ...payload,
      headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
    });
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe("FAILED_PRECONDITION");
  });

  it("validates a price-book payload before touching the store", async () => {
    const token = await ownerToken();
    const res = await platform.app.request("/v1/admin/cost/price-book", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "vercel" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ARGUMENT");
  });

  it("ranks projects by cost and falls back to a safe range on bad dates", async () => {
    const token = await ownerToken();
    const res = await platform.app.request("/v1/admin/cost/projects?from=not-a-date&to=also-bad&limit=5", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toEqual([]);
    expect(body.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
