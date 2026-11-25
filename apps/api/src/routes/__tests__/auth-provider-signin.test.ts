import { describe, expect, it } from "vitest";
import { generateProjectApiKey } from "@vellum/authorization";
import { createVellumPlatform } from "../../index.js";

async function fixture() {
  const platform = createVellumPlatform();
  const org = await platform.controlStore.createOrganization({ name: "Prov Org", slug: "prov-org", billingEmail: "ops@example.com" });
  const { project } = await platform.controlStore.createProject({ organizationId: org.id, name: "Prov App", slug: "prov-app" });
  const issue = async (keyType: "public" | "server") => {
    const key = generateProjectApiKey({ keyType });
    await platform.controlStore.registerApiKey({
      projectId: project.id, name: `${keyType} key`, keyType, keyPrefix: key.keyPrefix, secretHash: key.secretHash,
    });
    return key.fullKey;
  };
  const publicKey = await issue("public");
  const serverKey = await issue("server");
  const base = `/v1/projects/${project.id}/auth`;
  const post = (url: string, body: unknown, key: string) =>
    platform.fetch(new Request(`http://localhost${base}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vellum-api-key": key },
      body: JSON.stringify(body),
    }));
  return { platform, post, publicKey, serverKey };
}

describe("POST /sign-in/provider", () => {

  it("does not let a publishable key sign in as an existing user by email", async () => {
    const { post, publicKey } = await fixture();
    const signup = await post("/sign-up/email", { email: "victim@example.com", password: "Password123!", displayName: "V" }, publicKey);
    expect(signup.status).toBe(201);
    const attack = await post("/sign-in/provider", { provider: "google", providerUserId: "attacker-chosen", email: "victim@example.com" }, publicKey);
    expect(attack.status).toBe(403);
    const body = (await attack.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("accessToken");
  });

  it("does not let a publishable key mint an account with a self-declared verified email", async () => {
    const { post, publicKey } = await fixture();
    const res = await post("/sign-in/provider", { provider: "google", providerUserId: "x1", email: "new@example.com", emailVerified: true }, publicKey);
    expect(res.status).toBe(403);
  });

  it("refuses to link an existing account on an unverified email claim, even from a backend", async () => {
    const { post, publicKey, serverKey } = await fixture();
    await post("/sign-up/email", { email: "victim2@example.com", password: "Password123!", displayName: "V" }, publicKey);
    const res = await post("/sign-in/provider", { provider: "google", providerUserId: "p2", email: "victim2@example.com" }, serverKey);
    expect(res.status).toBe(409);
  });

  it("pre-hijack: a verified provider login takes over an unverified password account and kills the squatter's access", async () => {
    const { post, publicKey, serverKey } = await fixture();
    const squat = await post("/sign-up/email", { email: "squat@example.com", password: "Password123!", displayName: "S" }, publicKey);
    expect(squat.status).toBe(201);
    const squatSession = (await squat.json()) as { refreshToken: string };
    const link = await post("/sign-in/provider", { provider: "google", providerUserId: "owner1", email: "squat@example.com", emailVerified: true }, serverKey);
    expect(link.status).toBe(200);
    const login = await post("/sign-in/email", { email: "squat@example.com", password: "Password123!" }, publicKey);
    expect(login.status).toBe(401);
    const refresh = await post("/token/refresh", { refreshToken: squatSession.refreshToken }, publicKey);
    expect(refresh.status).toBe(401);
  });

  it("still works for a trusted backend that asserts a verified email", async () => {
    const { post, publicKey, serverKey } = await fixture();
    await post("/sign-up/email", { email: "ok@example.com", password: "Password123!", displayName: "O" }, publicKey);
    const link = await post("/sign-in/provider", { provider: "google", providerUserId: "p3", email: "ok@example.com", emailVerified: true }, serverKey);
    expect(link.status).toBe(200);
    expect(await link.json()).toHaveProperty("accessToken");
    const created = await post("/sign-in/provider", { provider: "github", providerUserId: "g9", email: "fresh@example.com", emailVerified: true }, serverKey);
    expect(created.status).toBe(200);
  });
});
