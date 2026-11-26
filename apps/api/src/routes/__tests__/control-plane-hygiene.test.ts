import { describe, expect, it } from "vitest";
import { createVellumPlatform } from "../../index.js";

const call = (platform: ReturnType<typeof createVellumPlatform>, method: string, path: string, token?: string, body?: unknown) =>
  platform.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

describe("control plane response hygiene", () => {
  it("rejects an unparseable api key expiry with 400 and never returns a secret hash on revoke", async () => {
    const platform = createVellumPlatform({});
    const res = await call(platform, "POST", "/v1/auth/sign-up/email", undefined, { name: "Tenant hyg", email: "hyg@example.invalid", password: "FixtureOnly123!" });
    const user = (await res.json()) as { token: string; project: { id: string } };
    const keysPath = `/v1/projects/${user.project.id}/api-keys`;

    const bad = await call(platform, "POST", keysPath, user.token, { name: "k", keyType: "secret", expiresAt: "not-a-date" });
    expect(bad.status).toBe(400);

    const ok = await call(platform, "POST", keysPath, user.token, { name: "k", keyType: "secret", expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(ok.status).toBe(201);
    const created = (await ok.json()) as { apiKey: { id: string } };
    const revoke = await call(platform, "DELETE", `${keysPath}/${created.apiKey.id}`, user.token);
    expect(revoke.status).toBe(200);
    expect(JSON.stringify(await revoke.json())).not.toContain("secretHash");
  });

  it("does not expose user counts on the unauthenticated setup status", async () => {
    const platform = createVellumPlatform({});
    const res = await call(platform, "GET", "/v1/admin/setup-status");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("totalUsers");
    expect(body).not.toHaveProperty("ownerCount");
  });
});
