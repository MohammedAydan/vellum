/**
 * Silent refresh & refresh-token concurrency — integration suite.
 *
 * Hermetic by default: boots the real @vellum/api app via createVellumPlatform()
 * with in-memory planes and exercises the real HTTP routes plus the @vellumdb/sdk-js
 * client. Live Neon is not required, so no PHASE5_REAL gating is necessary.
 *
 * Covers:
 *  1. An expiring/short-TTL end-user access token is silently refreshed by the
 *     SDK; a document request succeeds without the raw session error message.
 *  2. Five concurrent `/token/refresh` calls with the same refresh token all
 *     succeed inside the 15 s grace window and revoke no sessions.
 *  3. A replay outside the grace window revokes every session for the user.
 *  4. Console and super-admin refresh rotation works and cross-realm refresh
 *     tokens are rejected.
 *
 * No secrets, DB URLs, emails or token values are logged.
 */
import crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import { createVellumPlatform } from "../../apps/api/src/index.js";
import { createClient } from "@vellumdb/sdk-js";
import { generateProjectApiKey } from "@vellum/authorization";
import { generateEd25519KeyPair } from "@vellum/auth";

type Platform = ReturnType<typeof createVellumPlatform>;

function jsonPost(url: string, body: Record<string, unknown>, apiKey?: string): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { "x-vellum-api-key": apiKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function seedTenant(platform: Platform, accessTokenTtlSeconds?: number) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await platform.controlStore.createUser({
    email: `owner-${suffix}@example.test`,
    name: "Silent Refresh Owner",
    platformRole: "owner",
  });
  const org = await platform.controlStore.createOrganization({
    name: "Silent Refresh Org",
    slug: `silent-refresh-${suffix}`,
    billingEmail: `billing-${suffix}@example.test`,
    ownerUserId: owner.id,
  });
  const { project } = await platform.controlStore.createProject({
    organizationId: org.id,
    name: "Silent Refresh Project",
    slug: `silent-refresh-project-${suffix}`,
    actorUserId: owner.id,
  });

  const generated = generateProjectApiKey({
    keyType: "server",
  });
  await platform.controlStore.registerApiKey({
    projectId: project.id,
    name: "Silent refresh server key",
    keyType: "server",
    keyPrefix: generated.keyPrefix,
    secretHash: generated.secretHash,
  });

  // Use the same master key the API uses to encrypt/decrypt the private key.
  const pair = generateEd25519KeyPair(process.env.MASTER_ENCRYPTION_KEY);
  await platform.controlStore.upsertAuthConfig({
    projectId: project.id,
    jwtKeyId: pair.keyId,
    jwtPublicKeyPem: pair.publicKeyPem,
    jwtPrivateKeyEncrypted: pair.privateKeyEncrypted,
    ...(accessTokenTtlSeconds !== undefined ? { accessTokenTtlSeconds } : {}),
  });
  await platform.controlStore.publishSecurityRuleset({
    projectId: project.id,
    createdBy: owner.id,
    rulesAst: {
      version: 1,
      rules: [{ match: "items/{itemId}", allow: { read: true, write: true } }],
    },
  });

  return {
    owner,
    org,
    project,
    apiKey: generated.fullKey,
    base: `/v1/projects/${project.id}/auth`,
  };
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

describe("auth silent refresh & concurrency (hermetic)", () => {
  it("SDK transparently refreshes an expiring access token on a document read", async () => {
    const platform = createVellumPlatform();
    // 2 s TTL is below the SDK's 45 s pre-flight skew, so every request must
    // obtain a fresh access token from /auth/token/refresh.
    const { project, apiKey } = await seedTenant(platform, 2);
    let refreshCalls = 0;
    const client = createClient({
      projectId: project.id,
      apiKey,
      customFetch: (url, init) => {
        if (String(url).includes("/auth/token/refresh")) refreshCalls += 1;
        return platform.fetch(new Request(url, init));
      },
    });

    const session = await client.signUpWithEmailAndPassword({
      email: `sdk-refresh-${crypto.randomUUID().slice(0, 8)}@example.test`,
      password: "Password123!",
      displayName: "SDK Refresh User",
    });
    expect(session.refreshToken).toBeTypeOf("string");

    // Let the minted access token expire before issuing the document request.
    await new Promise((resolve) => setTimeout(resolve, 2_200));

    const refreshCallsBefore = refreshCalls;
    const page = await client.collection("items").get();
    expect(page.docs).toEqual([]);
    expect(refreshCalls, "SDK must have called /auth/token/refresh").toBeGreaterThan(refreshCallsBefore);
  });

  it("five concurrent refreshes with the same token all succeed inside the grace window", async () => {
    const platform = createVellumPlatform();
    const { base, apiKey, project } = await seedTenant(platform);
    const signUp = await platform.fetch(
      jsonPost(
        `${base}/sign-up/email`,
        {
          email: `grace-${crypto.randomUUID().slice(0, 8)}@example.test`,
          password: "Password123!",
          name: "Grace Window User",
        },
        apiKey
      )
    );
    expect(signUp.status).toBe(201);
    const { refreshToken, user } = (await signUp.json()) as { refreshToken: string; user: { id: string } };

    // Truly simultaneous: all five tabs present the exact same refresh token
    // with no staggering. The rotation race is absorbed by the 15 s grace window.
    const withKey = await Promise.all(
      Array.from({ length: 5 }, () =>
        platform.fetch(
          new Request(`http://localhost${base}/token/refresh`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-vellum-api-key": apiKey },
            body: JSON.stringify({ refreshToken }),
          })
        )
      )
    );
    expect(withKey.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const bodies = (await Promise.all(withKey.map((r) => r.json()))) as Array<{ refreshToken: string }>;
    expect(new Set(bodies.map((b) => b.refreshToken)).size).toBe(5);

    const sessions = Array.from(platform.dataStore.authMemory.sessions.values()).filter(
      (s) => s.userId === user.id && s.projectId === project.id
    );
    expect(sessions.length).toBeGreaterThanOrEqual(5);
    expect(sessions.some((s) => s.revoked)).toBe(false);
  });

  it("a replay outside the grace window revokes every session for the user", async () => {
    const platform = createVellumPlatform();
    const { base, apiKey, project } = await seedTenant(platform);
    const signUp = await platform.fetch(
      jsonPost(
        `${base}/sign-up/email`,
        {
          email: `replay-${crypto.randomUUID().slice(0, 8)}@example.test`,
          password: "Password123!",
          name: "Replay User",
        },
        apiKey
      )
    );
    expect(signUp.status).toBe(201);
    const { refreshToken, user } = (await signUp.json()) as { refreshToken: string; user: { id: string } };

    const refresh = await platform.fetch(
      new Request(`http://localhost${base}/token/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-vellum-api-key": apiKey },
        body: JSON.stringify({ refreshToken }),
      })
    );
    expect(refresh.status).toBe(200);

    // Move rotatedAt outside the 15 s grace window directly in the memory store.
    const oldHash = sha256(refreshToken);
    const rotated = Array.from(platform.dataStore.authMemory.sessions.values()).find(
      (s) => s.previousRefreshTokenHash === oldHash
    );
    expect(rotated).toBeDefined();
    if (rotated) rotated.rotatedAt = new Date(Date.now() - 60_000).toISOString();

    const replay = await platform.fetch(
      new Request(`http://localhost${base}/token/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-vellum-api-key": apiKey },
        body: JSON.stringify({ refreshToken }),
      })
    );
    expect(replay.status).toBe(401);

    const sessions = Array.from(platform.dataStore.authMemory.sessions.values()).filter(
      (s) => s.userId === user.id && s.projectId === project.id
    );
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.revoked)).toBe(true);
    expect(sessions.every((s) => s.revokedReason === "refresh_token_replay_detected")).toBe(true);
  });

  it("console and admin refresh rotation works and cross-realm tokens are rejected", async () => {
    const platform = createVellumPlatform();

    // Console session via HTTP sign-up followed by sign-in.
    const consoleEmail = `console-refresh-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const consoleSignUp = await platform.fetch(
      jsonPost("/v1/auth/sign-up/email", {
        email: consoleEmail,
        name: "Console Refresh User",
        password: "Password123!",
      })
    );
    expect(consoleSignUp.status).toBe(201);
    const consoleSignIn = await platform.fetch(
      jsonPost("/v1/auth/sign-in/email", { email: consoleEmail, password: "Password123!" })
    );
    expect(consoleSignIn.status).toBe(200);
    const consoleSession = (await consoleSignIn.json()) as { refreshToken: string };

    const consoleRefresh = await platform.fetch(
      jsonPost("/v1/console/auth/refresh", { refreshToken: consoleSession.refreshToken })
    );
    expect(consoleRefresh.status).toBe(200);
    const rotatedConsole = (await consoleRefresh.json()) as { refreshToken: string };
    expect(rotatedConsole.refreshToken).not.toBe(consoleSession.refreshToken);

    // Super-admin owner + admin login.
    const adminEmail = `admin-refresh-${crypto.randomUUID().slice(0, 8)}@vellum.dev`;
    const setup = await platform.fetch(
      jsonPost("/v1/admin/setup-owner", {
        name: "Admin Refresh Owner",
        email: adminEmail,
        password: "Password123!",
      })
    );
    expect(setup.status).toBe(201);
    const adminLogin = await platform.fetch(
      jsonPost("/v1/admin/login", { email: adminEmail, password: "Password123!" })
    );
    expect(adminLogin.status).toBe(200);
    const adminSession = (await adminLogin.json()) as { refreshToken: string };

    const adminRefresh = await platform.fetch(
      jsonPost("/v1/admin/auth/session/refresh", { refreshToken: adminSession.refreshToken })
    );
    expect(adminRefresh.status).toBe(200);
    const rotatedAdmin = (await adminRefresh.json()) as { refreshToken: string };
    expect(rotatedAdmin.refreshToken).not.toBe(adminSession.refreshToken);

    // Cross-realm refresh tokens must never be accepted.
    const adminRejectsConsole = await platform.fetch(
      jsonPost("/v1/admin/auth/session/refresh", { refreshToken: rotatedConsole.refreshToken })
    );
    expect(adminRejectsConsole.status).toBe(401);
    const consoleRejectsAdmin = await platform.fetch(
      jsonPost("/v1/console/auth/refresh", { refreshToken: rotatedAdmin.refreshToken })
    );
    expect(consoleRejectsAdmin.status).toBe(401);
  });
});
