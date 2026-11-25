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
  const get = (url: string, key: string, token: string) =>
    platform.fetch(new Request(`http://localhost${base}${url}`, {
      headers: { "x-vellum-api-key": key, authorization: `Bearer ${token}` },
    }));
  const patch = (url: string, body: unknown, key: string, token: string) =>
    platform.fetch(new Request(`http://localhost${base}${url}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-vellum-api-key": key, authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }));
  const del = (url: string, body: unknown, key: string, token: string) =>
    platform.fetch(new Request(`http://localhost${base}${url}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-vellum-api-key": key, authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }));
  return { platform, post, get, patch, del, publicKey, serverKey, projectId: project.id };
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

describe("access token session binding", () => {
  it("stops working as soon as the session is signed out", async () => {
    const { get, post, publicKey } = await fixture();
    const signup = await post("/sign-up/email", { email: "bind@example.com", password: "Password123!", displayName: "B" }, publicKey);
    const { accessToken, refreshToken } = (await signup.json()) as { accessToken: string; refreshToken: string };
    expect((await get("/user", publicKey, accessToken)).status).toBe(200);
    expect((await post("/sign-out", { refreshToken }, publicKey)).status).toBe(200);
    expect((await get("/user", publicKey, accessToken)).status).toBe(401);
  });
});

describe("PATCH /user email change", () => {
  it("needs the current password, so a stolen access token cannot move the account", async () => {
    const { patch, post, publicKey } = await fixture();
    const signup = await post("/sign-up/email", { email: "mv@example.com", password: "Password123!", displayName: "M" }, publicKey);
    const { accessToken } = (await signup.json()) as { accessToken: string };
    expect((await patch("/user", { email: "evil@example.com" }, publicKey, accessToken)).status).toBe(401);
    expect((await patch("/user", { email: "evil@example.com", currentPassword: "wrong" }, publicKey, accessToken)).status).toBe(401);
    const ok = await patch("/user", { email: "new@example.com", currentPassword: "Password123!" }, publicKey, accessToken);
    expect(ok.status).toBe(200);
    expect((await patch("/user", { displayName: "Still fine" }, publicKey, accessToken)).status).toBe(200);
  });
});

describe("re-authentication for account-keeping changes", () => {
  it("refuses link, unlink, password change and delete without the current password", async () => {
    const { post, del, publicKey } = await fixture();
    const signup = await post("/sign-up/email", { email: "re@example.com", password: "Password123!", displayName: "R" }, publicKey);
    const { accessToken } = (await signup.json()) as { accessToken: string };
    expect((await del("/identities/google", {}, publicKey, accessToken)).status).toBe(401);
    expect((await del("/user", {}, publicKey, accessToken)).status).toBe(401);
    expect((await del("/user", { password: "wrong-password" }, publicKey, accessToken)).status).toBe(401);
  });

  it("locks out repeated wrong passwords", async () => {
    const { post, del, publicKey } = await fixture();
    const signup = await post("/sign-up/email", { email: "lock@example.com", password: "Password123!", displayName: "L" }, publicKey);
    const { accessToken } = (await signup.json()) as { accessToken: string };
    let last = 0;
    for (let i = 0; i < 8; i += 1) last = (await del("/user", { password: `wrong-${i}-password` }, publicKey, accessToken)).status;
    expect(last).toBe(429);
    expect((await del("/user", { password: "Password123!" }, publicKey, accessToken)).status).toBe(429);
  });
});

describe("GET /collections/:name/export", () => {
  it("is for server keys only: a publishable key cannot dump a collection", async () => {
    const { platform, publicKey, serverKey, projectId } = await fixture();
    const call = (key: string) =>
      platform.fetch(new Request(`http://localhost/v1/projects/${projectId}/collections/conversations/export`, {
        headers: { "x-vellum-api-key": key },
      }));
    expect((await call(publicKey)).status).toBe(403);
    expect((await call(serverKey)).status).toBe(200);
  });
});
