import { describe, expect, it } from "vitest";
import { createVellumPlatform } from "../../index.js";

const call = (platform: ReturnType<typeof createVellumPlatform>, method: string, path: string, token?: string, body?: unknown) =>
  platform.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

async function signup(platform: ReturnType<typeof createVellumPlatform>, tag: string) {
  const res = await call(platform, "POST", "/v1/auth/sign-up/email", undefined, {
    name: `Tenant ${tag}`, email: `${tag}@example.invalid`, password: "FixtureOnly123!",
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; organization: { id: string } };
}

describe("paid plans are not self-serve", () => {
  it("refuses a customer who creates an organization on a paid plan", async () => {
    const platform = createVellumPlatform({});
    const user = await signup(platform, "plan-create");
    const res = await call(platform, "POST", "/v1/organizations", user.token, { name: "Mine", slug: "mine-org", planTier: "enterprise" });
    expect(res.status).toBe(403);
    const free = await call(platform, "POST", "/v1/organizations", user.token, { name: "Mine", slug: "mine-free", planTier: "free" });
    expect(free.status).toBe(201);
  });

  it("refuses an owner who patches their subscription to a paid plan", async () => {
    const platform = createVellumPlatform({});
    const user = await signup(platform, "plan-patch");
    const path = `/v1/console/orgs/${user.organization.id}/billing/subscription`;
    const res = await call(platform, "PATCH", path, user.token, { planId: "enterprise" });
    expect(res.status).toBe(403);
    const same = await call(platform, "PATCH", path, user.token, { planId: "free" });
    expect(same.status).toBe(200);
  });
});
