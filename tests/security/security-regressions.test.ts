/**
 *  security regression tests .
 *
 * Covers the exact defects called out in the delegation brief plus the shared
 * SessionService contract. No external services are required.
 */

import { describe, it, expect } from "vitest";
import {
  createInMemoryRevocationStore,
  createSessionService,
  generateProjectApiKey,
  signEndUserJwt,
  verifyEndUserJwtSync,
  type Role,
} from "@vellum/authorization";
import { createVellumPlatform } from "../../apps/api/src/index.js";
import { hashPassword, verifyPassword } from "../../apps/api/src/routes/auth-endpoints.js";

const SECRET = "unit-test-jwt-secret-at-least-16-chars";
const PEPPER = "unit-test-pepper-at-least-16-chars";
const USER_ID = "usr_security_test";

function newSessionService(secret: string = SECRET) {
  return createSessionService({ secret, revocationStore: createInMemoryRevocationStore() });
}

async function newPlatform() {
  // Realm-bound session services. Do NOT inject a legacy
  // generic sessionService: createVellumPlatform would treat it as the console
  // service, and the super-admin realm would mint incompatible tokens.
  const platform = createVellumPlatform({
    jwtSecret: SECRET,
    apiKeyPepper: PEPPER,
  });
  return {
    platform,
    sessionService: platform.consoleSessionService,
    consoleSessionService: platform.consoleSessionService,
    superAdminSessionService: platform.superAdminSessionService,
  };
}

async function seedTenant(platform: ReturnType<typeof createVellumPlatform>, slug: string) {
  const control = platform.controlStore;
  const org = await control.createOrganization({
    name: `Org ${slug}`,
    slug,
    billingEmail: `${slug}@example.com`,
    planId: "pro",
  });
  const { project } = await control.createProject({
    organizationId: org.id,
    name: `Project ${slug}`,
    slug: `${slug}-project`,
  });
  const generated = generateProjectApiKey({
    keyType: "server",
    pepper: PEPPER,
  });
  await control.registerApiKey({
    projectId: project.id,
    name: "Test key",
    keyType: "server",
    keyPrefix: generated.keyPrefix,
    secretHash: generated.secretHash,
  });

  const members = (control as unknown as {
    organizationMembers: Map<string, { organizationId: string; userId: string; role: string }>;
  }).organizationMembers;
  if (members) {
    members.set(`${org.id}:${USER_ID}`, {
      organizationId: org.id,
      userId: USER_ID,
      role: "owner",
      joinedAt: new Date().toISOString(),
    });
  }

  return { org, project, rawKey: generated.fullKey };
}

describe("shared SessionService (jose-compatible HS256)", () => {
  const input = {
    sub: USER_ID,
    uid: USER_ID,
    role: "customer" as Role,
    orgIds: ["org_1"],
  };

  it("signs and verifies access tokens, including expiry and jti claims", () => {
    const service = newSessionService();
    const token = service.signAccess(input);
    const claims = service.verifyAccess(token);
    expect(claims.sub).toBe(USER_ID);
    expect(claims.uid).toBe(USER_ID);
    expect(claims.role).toBe("customer");
    expect(claims.orgIds).toEqual(["org_1"]);
    expect(claims.jti).toBeTypeOf("string");
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // jose-compatible: standard HS256 compact JWS with three segments.
    expect(token.split(".")).toHaveLength(3);
    expect(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"))).toMatchObject({
      alg: "HS256",
      typ: "JWT",
    });
  });

  it("rejects expired tokens and revoked jti", async () => {
    const service = newSessionService();
    expect(() => service.verifyAccess(service.signAccess(input, -1))).toThrow();

    const token = service.signAccess(input);
    const claims = service.verifyAccess(token);
    await service.revoke(claims.jti, Date.now() + 60_000);
    await expect(service.verifyAccessChecked(token)).rejects.toThrow(/revoked/i);
    expect(await service.isRevoked(claims.jti)).toBe(true);
  });

  it("refresh tokens cannot be used as access tokens and vice versa", () => {
    const service = newSessionService();
    const refresh = service.signRefresh(USER_ID);
    const parsed = service.verifyRefresh(refresh);
    expect(parsed.sub).toBe(USER_ID);
    expect(() => service.verifyAccess(refresh)).toThrow();
    expect(() => service.verifyRefresh(service.signAccess(input))).toThrow();
  });

  it("a changed secret changes the signature and invalidates verification", () => {
    const payload = { sub: USER_ID, uid: USER_ID, exp: Math.floor(Date.now() / 1000) + 60 };
    const tokenA = signEndUserJwt(payload, "secret-alpha-0123456789");
    const tokenB = signEndUserJwt(payload, "secret-bravo-0123456789");
    expect(tokenA.split(".")[2]).not.toBe(tokenB.split(".")[2]);
    expect(() => verifyEndUserJwtSync(tokenA, "secret-bravo-0123456789")).toThrow();

    const serviceA = newSessionService("secret-alpha-0123456789");
    const serviceB = newSessionService("secret-bravo-0123456789");
    expect(() => serviceB.verifyAccess(serviceA.signAccess(input))).toThrow();
  });
});

describe("HTTP authentication gates", () => {
  it("admin route without token => 401", async () => {
    const { platform } = await newPlatform();
    const res = await platform.fetch(new Request("http://localhost:8080/v1/admin/overview"));
    expect(res.status).toBe(401);
  });

  it("admin route with forged token => 401", async () => {
    const { platform } = await newPlatform();
    const res = await platform.fetch(
      new Request("http://localhost:8080/v1/admin/overview", {
        headers: { Authorization: "Bearer forged.jwt.token" },
      })
    );
    expect(res.status).toBe(401);
  });

  it("admin route with a real owner session => 200", async () => {
    const { platform, superAdminSessionService } = await newPlatform();
    const operator = await platform.controlStore.createUser({
      email: "owner-security@example.com",
      name: "Platform Owner",
      platformRole: "owner",
    });
    await platform.controlStore.setPlatformSuperAdmin(operator.id, true);
    const token = superAdminSessionService.signAccess({
      sub: operator.id,
      uid: operator.id,
      role: "owner",
      orgIds: [],
    });
    const res = await platform.fetch(
      new Request("http://localhost:8080/v1/admin/overview", {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
    expect(res.status).toBe(200);
  });

  it("document request without x-project-key => 401 (no console fallback key)", async () => {
    const { platform } = await newPlatform();
    const { project } = await seedTenant(platform, "no-key-org");
    const res = await platform.fetch(
      new Request(`http://localhost:8080/v1/projects/${project.id}/documents/users/u1`)
    );
    expect(res.status).toBe(401);
  });

  it("invalid Bearer JWT on a document request => 401 (never anonymous)", async () => {
    const { platform } = await newPlatform();
    const { project, rawKey } = await seedTenant(platform, "bad-jwt-org");
    const res = await platform.fetch(
      new Request(`http://localhost:8080/v1/projects/${project.id}/documents/users/u1`, {
        headers: { "x-project-key": rawKey, Authorization: "Bearer forged.jwt.token" },
      })
    );
    expect(res.status).toBe(401);
  });

  it("operator-token prefix bypass is gone (adm_token_* => 401)", async () => {
    const { platform } = await newPlatform();
    const { project, rawKey } = await seedTenant(platform, "prefix-bypass-org");
    const res = await platform.fetch(
      new Request(`http://localhost:8080/v1/projects/${project.id}/documents/users/u1`, {
        headers: { "x-project-key": rawKey, Authorization: "Bearer adm_token_bypass" },
      })
    );
    expect(res.status).toBe(401);
  });

  it("console route without token => 401; non-member org => 403; member => 200", async () => {
    const { platform, consoleSessionService } = await newPlatform();
    const tenantA = await seedTenant(platform, "console-org-a");
    const tenantB = await seedTenant(platform, "console-org-b");

    const noToken = await platform.fetch(
      new Request(
        `http://localhost:8080/v1/console/projects/${tenantA.project.id}/documents/users`
      )
    );
    expect(noToken.status).toBe(401);

    const forbiddenToken = consoleSessionService.signAccess({
      sub: "stranger",
      uid: "stranger",
      role: "customer",
      orgIds: [tenantB.org.id],
    });
    const forbidden = await platform.fetch(
      new Request(
        `http://localhost:8080/v1/console/projects/${tenantA.project.id}/documents/users`,
        { headers: { Authorization: `Bearer ${forbiddenToken}` } }
      )
    );
    expect(forbidden.status).toBe(403);

    const memberToken = consoleSessionService.signAccess({
      sub: USER_ID,
      uid: USER_ID,
      role: "customer",
      orgIds: [tenantA.org.id],
    });
    const allowed = await platform.fetch(
      new Request(
        `http://localhost:8080/v1/console/projects/${tenantA.project.id}/documents/users`,
        { headers: { Authorization: `Bearer ${memberToken}` } }
      )
    );
    expect(allowed.status).toBe(200);
  });

  it("revoke API key for the wrong project => 403", async () => {
    const { platform } = await newPlatform();
    const tenantA = await seedTenant(platform, "revoke-a");
    const tenantB = await seedTenant(platform, "revoke-b");
    const keyB = Array.from(platform.controlStore.apiKeysById.values()).find(
      (k) => k.projectId === tenantB.project.id
    )!;

    const res = await platform.fetch(
      new Request(
        `http://localhost:8080/v1/projects/${tenantA.project.id}/api-keys/${keyB.id}`,
        { method: "DELETE" }
      )
    );
    expect(res.status).toBe(403);
  });
});

describe("password hashing & session verification", () => {
  it("hashPassword is async scrypt and verifyPassword round-trips", async () => {
    const pending = hashPassword("correct horse battery staple");
    expect(pending).toBeInstanceOf(Promise);
    const hash = await pending;
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("pbkdf2");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("sign-in with no stored hash fails (no password backdoor)", async () => {
    const { platform } = await newPlatform();
    await platform.controlStore.createUser({
      name: "No Password",
      email: "nopass@example.com",
      platformRole: "customer",
      emailVerified: true,
    });
    const res = await platform.fetch(
      new Request("http://localhost:8080/v1/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nopass@example.com", password: "anything-at-all" }),
      })
    );
    expect(res.status).toBe(401);
  });

  it("admin login with no stored hash fails (no password backdoor)", async () => {
    const { platform } = await newPlatform();
    await platform.controlStore.createUser({
      name: "No Password Operator",
      email: "nopass-op@example.com",
      platformRole: "admin",
      emailVerified: true,
    });
    const res = await platform.fetch(
      new Request("http://localhost:8080/v1/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nopass-op@example.com", password: "anything-at-all" }),
      })
    );
    expect(res.status).toBe(401);
  });

  it("/auth/session rejects forged tokens and accepts signed ones", async () => {
    const { platform, consoleSessionService } = await newPlatform();
    const forged = await platform.fetch(
      new Request("http://localhost:8080/v1/auth/session", {
        headers: { Authorization: "Bearer forged.jwt.token" },
      })
    );
    expect(forged.status).toBe(401);

    const anon = await platform.fetch(new Request("http://localhost:8080/v1/auth/session"));
    expect(anon.status).toBe(200);
    expect((await anon.json()).session).toBeNull();

    // /auth/session verifies realm-bound console tokens, not legacy end-user JWTs.
    const validToken = consoleSessionService.signAccess({
      sub: USER_ID,
      uid: USER_ID,
      role: "customer",
      orgIds: [],
    });
    const ok = await platform.fetch(
      new Request("http://localhost:8080/v1/auth/session", {
        headers: { Authorization: `Bearer ${validToken}` },
      })
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).session.valid).toBe(true);
  });
});

describe("HTTP transport hardening", () => {
  it("CORS is an explicit allowlist, never '*'", async () => {
    const { platform } = await newPlatform();
    const allowed = await platform.fetch(
      new Request("http://localhost:8080/v1/health", { headers: { Origin: "http://localhost:5173" } })
    );
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

    const denied = await platform.fetch(
      new Request("http://localhost:8080/v1/health", { headers: { Origin: "https://evil.example" } })
    );
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("oversized bodies are rejected with 413", async () => {
    const { platform } = await newPlatform();
    const res = await platform.fetch(
      new Request("http://localhost:8080/v1/organizations", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "6000000" },
        body: "{}",
      })
    );
    expect(res.status).toBe(413);
  });
});
