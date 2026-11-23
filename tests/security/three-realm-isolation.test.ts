/**
 * Three-realm isolation — hermetic security suite.
 *
 * Proves that tokens minted for one realm can never authenticate against the
 * other two realms:
 *   - customer_console  -> /v1/console/*
 *   - super_admin       -> /v1/admin/*
 *   - project_end_user  -> /v1/projects/:id/* (document plane)
 *
 * Uses the real createVellumPlatform() app via platform.fetch with in-memory
 * stores. Tenants are seeded with real API keys. No secrets are ever logged.
 */
import { describe, it, expect } from "vitest";
import {
  generateProjectApiKey,
  createSessionService,
  createInMemoryRevocationStore,
} from "@vellum/authorization";
import {
  decryptPrivateKey,
  generateEd25519KeyPair,
  signEndUserAccessToken,
} from "@vellum/auth";
import { createVellumPlatform } from "../../apps/api/src/index.js";

type Platform = ReturnType<typeof createVellumPlatform>;

function jsonPost(url: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedTenant(platform: Platform) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const org = await platform.controlStore.createOrganization({
    name: "Realm Isolation Org",
    slug: `realm-iso-${suffix}`,
    billingEmail: `realm-iso-${suffix}@example.test`,
  });
  const { project } = await platform.controlStore.createProject({
    organizationId: org.id,
    name: "Realm Isolation Project",
    slug: `realm-iso-project-${suffix}`,
  });
  const generated = generateProjectApiKey({
    keyType: "server",
  });
  await platform.controlStore.registerApiKey({
    projectId: project.id,
    name: "Realm isolation key",
    keyType: "server",
    keyPrefix: generated.keyPrefix,
    secretHash: generated.secretHash,
  });
  return { org, project, apiKey: generated.fullKey };
}

/** Seed an Ed25519 auth config and mint a valid end-user access token. */
async function mintEndUserToken(platform: Platform, ctx: { projectId: string }) {
  const pair = generateEd25519KeyPair();
  await platform.controlStore.upsertAuthConfig({
    projectId: ctx.projectId,
    jwtKeyId: pair.keyId,
    jwtPublicKeyPem: pair.publicKeyPem,
    jwtPrivateKeyEncrypted: pair.privateKeyEncrypted,
  });
  const now = Math.floor(Date.now() / 1000);
  return signEndUserAccessToken(
    {
      iss: `https://api.vellum.dev/v1/projects/${ctx.projectId}/auth`,
      sub: "realm-iso-user",
      jti: "realm-iso-jti",
      aud: ctx.projectId,
      email: "realm-iso-user@example.test",
      email_verified: true,
      is_anonymous: false,
      claims: { role: "reader" },
      iat: now,
      exp: now + 3600,
      auth_time: now,
    },
    decryptPrivateKey(pair.privateKeyEncrypted),
    pair.keyId
  );
}

const PLATFORM_JWT_SECRET = "realm-iso-platform-jwt-secret-v1";

describe("three-realm isolation (hermetic)", () => {
  it("a customer-console token (even role=owner) cannot reach any super-admin route", async () => {
    const platform = createVellumPlatform();
    // A real user who is deliberately NOT a platform super administrator.
    const user = await platform.controlStore.createUser({
      email: "console-owner-not-super@example.test",
      name: "Console Owner",
      platformRole: "owner",
    });
    expect(platform.controlStore.isPlatformSuperAdmin(user.id)).toBe(false);

    const token = platform.consoleSessionService.signAccess({
      sub: user.id,
      uid: user.id,
      role: "owner",
      orgIds: [],
    });
    const headers = { authorization: `Bearer ${token}` };

    for (const path of ["/v1/admin/auth/overview", "/v1/admin/auth/projects", "/v1/admin/auth/settings", "/v1/admin/overview"]) {
      const res = await platform.fetch(new Request(`http://localhost${path}`, { headers }));
      expect([401, 403], `${path} must reject a customer_console token`).toContain(res.status);
    }
  });

  it("a valid project end-user JWT is rejected on console and admin surfaces", async () => {
    const platform = createVellumPlatform();
    const { project } = await seedTenant(platform);
    const token = await mintEndUserToken(platform, {
      projectId: project.id,
    });
    const headers = { authorization: `Bearer ${token}` };

    const consoleRes = await platform.fetch(
      new Request("http://localhost/v1/console/organizations", { headers })
    );
    expect(consoleRes.status).toBe(401);

    const adminRes = await platform.fetch(
      new Request("http://localhost/v1/admin/overview", { headers })
    );
    expect(adminRes.status).toBe(401);
  });

  it("console and raw HS256 tokens are rejected by resolveEndUserAuth on the document plane", async () => {
    const platform = createVellumPlatform({ jwtSecret: PLATFORM_JWT_SECRET });
    const { project, apiKey } = await seedTenant(platform);

    const consoleToken = platform.consoleSessionService.signAccess({
      sub: "console-user",
      uid: "console-user",
      role: "customer",
      orgIds: [],
    });
    // A plain HS256 token signed with the platform JWT secret (legacy shape).
    const legacyHs256Token = createSessionService({
      secret: PLATFORM_JWT_SECRET,
      revocationStore: createInMemoryRevocationStore(),
    }).signAccess({
      sub: "legacy-user",
      uid: "legacy-user",
      role: "customer",
      orgIds: [],
    });

    for (const bearer of [consoleToken, legacyHs256Token]) {
      const res = await platform.fetch(
        new Request(
          `http://localhost/v1/projects/${project.id}/documents/items/i1`,
          {
            headers: { "x-project-key": apiKey, authorization: `Bearer ${bearer}` },
          }
        )
      );
      expect(res.status, "despite a valid project API key, an HS256 token is never an end-user token").toBe(401);
    }
  });

  it("super-admin and console refresh tokens are rejected by the opposite realm", async () => {
    const platform = createVellumPlatform();

    const signUp = await platform.fetch(
      jsonPost("/v1/auth/sign-up/email", {
        email: "realm-console-refresh@example.test",
        name: "Console Refresh User",
        password: "Password123!",
      })
    );
    expect(signUp.status).toBe(201);
    const consoleSession = (await signUp.json()) as { refreshToken: string };

    const setup = await platform.fetch(
      jsonPost("/v1/admin/setup-owner", {
        name: "Realm Super Owner",
        email: "realm-super-owner@vellum.dev",
        password: "Password123!",
      })
    );
    expect(setup.status).toBe(201);
    const adminSession = (await setup.json()) as { refreshToken: string };

    const consoleRejectsAdmin = await platform.fetch(
      jsonPost("/v1/console/auth/refresh", { refreshToken: adminSession.refreshToken })
    );
    expect(consoleRejectsAdmin.status).toBe(401);

    const adminRejectsConsole = await platform.fetch(
      jsonPost("/v1/admin/auth/session/refresh", { refreshToken: consoleSession.refreshToken })
    );
    expect(adminRejectsConsole.status).toBe(401);
  });
});
