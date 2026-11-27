import { describe, it, expect } from "vitest";
import { generateProjectApiKey } from "@vellum/authorization";
import { generateTotpCode } from "@vellum/auth";
import { createVellumPlatform } from "../../index.js";

async function authFixture() {
  const platform = createVellumPlatform();
  const org = await platform.controlStore.createOrganization({
    name: "Auth Org",
    slug: "auth-org",
    billingEmail: "ops@example.com",
  });
  const { project } = await platform.controlStore.createProject({
    organizationId: org.id,
    name: "Auth App",
    slug: "auth-app",
  });
  const base = `/v1/projects/${project.id}/auth`;

  async function issueKey(keyType: "public" | "server"): Promise<string> {
    const key = generateProjectApiKey({ keyType });
    await platform.controlStore.registerApiKey({
      projectId: project.id,
      name: `${keyType} key`,
      keyType,
      keyPrefix: key.keyPrefix,
      secretHash: key.secretHash,
    });
    return key.fullKey;
  }

  return {
    platform,
    org,
    project,
    base,
    apiKey: await issueKey("public"),
    serverKey: await issueKey("server"),
  };
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("@vellum/api - End-User & Admin Auth REST tiers", () => {
  it("signs up, resolves the JWKS publicly, and reads the profile with the access token", async () => {
    const { platform, base, apiKey } = await authFixture();

    const signUp = await platform.fetch(
      jsonRequest(
        `${base}/sign-up/email`,
        { email: " USER@Example.COM ", password: "Password123!", displayName: "Ada" },
        { "x-vellum-api-key": apiKey }
      )
    );
    expect(signUp.status).toBe(201);
    const session = (await signUp.json()) as { accessToken: string; refreshToken: string; user: { email: string } };
    expect(session.accessToken).toBeDefined();
    expect(session.refreshToken).toBeDefined();
    expect(session.user.email).toBe("user@example.com");
    expect((session.user as Record<string, unknown>)["passwordHash"]).toBeUndefined();

    const profile = await platform.fetch(
      new Request(`http://localhost${base}/user`, {
        headers: {
          "x-vellum-api-key": apiKey,
          authorization: `Bearer ${session.accessToken}`,
        },
      })
    );
    expect(profile.status).toBe(200);
    const profileBody = (await profile.json()) as { user: { email: string } };
    expect(profileBody.user.email).toBe("user@example.com");

    const jwks = await platform.fetch(new Request(`http://localhost${base}/.well-known/jwks.json`));
    expect(jwks.status).toBe(200);
    const jwksBody = (await jwks.json()) as { keys: Array<Record<string, unknown>> };
    expect(jwksBody.keys).toHaveLength(1);
    expect(jwksBody.keys[0]?.["kty"]).toBe("OKP");

    const missingKey = await platform.fetch(jsonRequest(`${base}/sign-in/anonymous`, {}));
    expect(missingKey.status).toBe(401);
  });

  it("enrolls TOTP and answers an MFA challenge after password sign-in", async () => {
    const { platform, base, apiKey } = await authFixture();
    await platform.fetch(
      jsonRequest(`${base}/sign-up/email`, { email: "mfa@example.com", password: "Password123!" }, {
        "x-vellum-api-key": apiKey,
      })
    );
    const signIn = await platform.fetch(
      jsonRequest(`${base}/sign-in/email`, { email: "mfa@example.com", password: "Password123!" }, {
        "x-vellum-api-key": apiKey,
      })
    );
    const signedIn = (await signIn.json()) as { accessToken: string };

    const enroll = await platform.fetch(
      jsonRequest(`${base}/mfa/enroll`, {}, {
        "x-vellum-api-key": apiKey,
        authorization: `Bearer ${signedIn.accessToken}`,
      })
    );
    expect(enroll.status).toBe(200);
    const enrolled = (await enroll.json()) as { secret: string; recoveryCodes: string[] };
    const code = generateTotpCode(enrolled.secret);

    const verify = await platform.fetch(
      jsonRequest(`${base}/mfa/verify`, { code }, {
        "x-vellum-api-key": apiKey,
        authorization: `Bearer ${signedIn.accessToken}`,
      })
    );
    expect(verify.status).toBe(200);

    const secondSignIn = await platform.fetch(
      jsonRequest(`${base}/sign-in/email`, { email: "mfa@example.com", password: "Password123!" }, {
        "x-vellum-api-key": apiKey,
      })
    );
    const challenged = (await secondSignIn.json()) as {
      mfaRequired: boolean;
      mfaTicket: string;
      factors: string[];
    };
    expect(challenged.mfaRequired).toBe(true);
    expect(challenged.factors).toContain("totp");

    const answer = await platform.fetch(
      jsonRequest(
        `${base}/mfa/challenge`,
        // The enrollment code is single-use (S9); challenge with the next step's code.
        { mfaTicket: challenged.mfaTicket, code: generateTotpCode(enrolled.secret, Date.now() + 30_000) },
        { "x-vellum-api-key": apiKey }
      )
    );
    expect(answer.status).toBe(200);
    const answerBody = (await answer.json()) as { accessToken: string };
    expect(answerBody.accessToken).toBeDefined();
  });

  it("serves the customer admin tier with a server key and never leaks secrets", async () => {
    const { platform, base, apiKey, serverKey } = await authFixture();
    await platform.fetch(
      jsonRequest(`${base}/sign-up/email`, { email: "admin-user@example.com", password: "Password123!" }, {
        "x-vellum-api-key": apiKey,
      })
    );
    const auth = { "x-vellum-api-key": serverKey };

    const list = await platform.fetch(new Request(`http://localhost${base}/admin/users`, { headers: auth }));
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { users: Array<Record<string, unknown>> };
    expect(listBody.users.length).toBe(1);
    expect(listBody.users[0]?.["passwordHash"]).toBeUndefined();

    const config = await platform.fetch(new Request(`http://localhost${base}/admin/config`, { headers: auth }));
    expect(config.status).toBe(200);
    const configBody = (await config.json()) as Record<string, unknown>;
    expect(configBody["jwtKeyId"]).toBeDefined();
    expect(configBody["jwtPrivateKeyEncrypted"]).toBeUndefined();
    expect(configBody["customSmtpConfigEncrypted"]).toBeUndefined();

    const patch = await platform.fetch(
      new Request(`http://localhost${base}/admin/config`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ enableAnonymousAuth: true }),
      })
    );
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { enableAnonymousAuth: boolean };
    expect(patched.enableAnonymousAuth).toBe(true);

    const audienceKey = await platform.fetch(jsonRequest(`${base}/sign-in/anonymous`, {}, auth));
    expect(audienceKey.status).toBe(201);
  });

  it("serves the super-admin tier with an owner session and rotates signing keys", async () => {
    const { platform, org } = await authFixture();
    const owner = await platform.controlStore.createUser({
      email: "owner-1@vellum.dev",
      name: "Platform Owner",
      platformRole: "owner",
    });
    await platform.controlStore.setPlatformSuperAdmin(owner.id, true);
    const token = platform.superAdminSessionService.signAccess({
      sub: owner.id,
      uid: owner.id,
      role: "owner",
      orgIds: [org.id],
    });
    const headers = { authorization: `Bearer ${token}` };

    const overview = await platform.fetch(new Request("http://localhost/v1/admin/auth/overview", { headers }));
    expect(overview.status).toBe(200);
    expect(((await overview.json()) as { totalEndUsers: number }).totalEndUsers).toBe(0);

    const settings = await platform.fetch(new Request("http://localhost/v1/admin/auth/settings", { headers }));
    expect(settings.status).toBe(200);
    const settingsBody = (await settings.json()) as Record<string, unknown>;
    expect(settingsBody["platformSmtpPassEncrypted"]).toBeUndefined();

    const rotateUrl = `http://localhost/v1/admin/auth/projects/${platform.controlStore.projects.keys().next().value}/rotate-signing-key`;
    const rotated = await platform.fetch(new Request(rotateUrl, { method: "POST", headers }));
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as { jwtKeyId: string; jwtPublicKeyPem: string };
    expect(rotatedBody.jwtKeyId).toBeDefined();
    expect(rotatedBody.jwtPublicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect((rotatedBody as Record<string, unknown>)["jwtPrivateKeyEncrypted"]).toBeUndefined();

    const forbidden = await platform.fetch(new Request("http://localhost/v1/admin/auth/settings"));
    expect(forbidden.status).toBe(401);
  });

  it("console sign-up/login issue refresh tokens and the console refresh endpoint rotates them", async () => {
    const { platform } = await authFixture();
    const email = "console-refresh@example.com";
    const password = "Password123!";

    const signUp = await platform.fetch(
      jsonRequest("/v1/auth/sign-up/email", { email, name: "Console Refresh", password })
    );
    expect(signUp.status).toBe(201);
    const signedUp = (await signUp.json()) as Record<string, unknown>;
    expect(typeof signedUp["refreshToken"]).toBe("string");
    expect(signedUp["accessToken"]).toBe(signedUp["token"]);
    const setCookie = signUp.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("vellum_console_rt=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");

    const login = await platform.fetch(jsonRequest("/v1/auth/sign-in/email", { email, password }));
    expect(login.status).toBe(200);
    const loggedIn = (await login.json()) as Record<string, unknown>;
    expect(typeof loggedIn["refreshToken"]).toBe("string");

    // Body-based rotation.
    const refresh = await platform.fetch(
      jsonRequest("/v1/console/auth/refresh", { refreshToken: signedUp["refreshToken"] })
    );
    expect(refresh.status).toBe(200);
    const rotated = (await refresh.json()) as Record<string, unknown>;
    expect(typeof rotated["refreshToken"]).toBe("string");
    expect(rotated["refreshToken"]).not.toBe(signedUp["refreshToken"]);
    expect(rotated["accessToken"]).toBe(rotated["token"]);
    expect(((rotated["user"] as Record<string, unknown>) ?? {})["email"]).toBe(email);

    // Cookie-based rotation.
    const cookieRefresh = await platform.fetch(
      new Request("http://localhost/v1/console/auth/refresh", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `vellum_console_rt=${String(loggedIn["refreshToken"])}`,
        },
        body: "{}",
      })
    );
    expect(cookieRefresh.status).toBe(200);

    // A super-admin refresh token must be rejected by the console realm.
    const setup = await platform.fetch(
      jsonRequest("/v1/admin/setup-owner", {
        name: "Cross Realm Owner",
        email: "cross-realm-owner@vellum.dev",
        password: "Password123!",
      })
    );
    expect(setup.status).toBe(201);
    const adminSession = (await setup.json()) as Record<string, unknown>;
    expect(typeof adminSession["refreshToken"]).toBe("string");
    const crossRealm = await platform.fetch(
      jsonRequest("/v1/console/auth/refresh", { refreshToken: adminSession["refreshToken"] })
    );
    expect(crossRealm.status).toBe(401);
  });

  it("admin login issues a refresh token and the admin refresh endpoint rejects console tokens", async () => {
    const { platform } = await authFixture();

    const signUp = await platform.fetch(
      jsonRequest("/v1/auth/sign-up/email", {
        email: "admin-cross@example.com",
        name: "Admin Cross",
        password: "Password123!",
      })
    );
    expect(signUp.status).toBe(201);
    const consoleSession = (await signUp.json()) as Record<string, unknown>;

    const setup = await platform.fetch(
      jsonRequest("/v1/admin/setup-owner", {
        name: "Refresh Owner",
        email: "refresh-owner@vellum.dev",
        password: "Password123!",
      })
    );
    expect(setup.status).toBe(201);

    const login = await platform.fetch(
      jsonRequest("/v1/admin/login", { email: "refresh-owner@vellum.dev", password: "Password123!" })
    );
    expect(login.status).toBe(200);
    const adminLogin = (await login.json()) as Record<string, unknown>;
    expect(typeof adminLogin["refreshToken"]).toBe("string");
    expect(adminLogin["accessToken"]).toBe(adminLogin["token"]);

    const refresh = await platform.fetch(
      jsonRequest("/v1/admin/auth/session/refresh", { refreshToken: adminLogin["refreshToken"] })
    );
    expect(refresh.status).toBe(200);
    const rotated = (await refresh.json()) as Record<string, unknown>;
    expect(rotated["refreshToken"]).not.toBe(adminLogin["refreshToken"]);

    const crossRealm = await platform.fetch(
      jsonRequest("/v1/admin/auth/session/refresh", { refreshToken: consoleSession["refreshToken"] })
    );
    expect(crossRealm.status).toBe(401);
  });

  it("rotates a console refresh token safely under five truly simultaneous requests", async () => {
    const { platform } = await authFixture();
    const email = `parallel-refresh-${Date.now()}@vellum.dev`;
    const signUp = await platform.fetch(
      jsonRequest("/v1/auth/sign-up/email", { email, password: "Password123!", name: "Parallel Refresh" })
    );
    expect(signUp.status).toBe(201);
    const signedUp = (await signUp.json()) as Record<string, unknown>;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        platform.fetch(jsonRequest("/v1/console/auth/refresh", { refreshToken: signedUp["refreshToken"] }))
      )
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const bodies = (await Promise.all(results.map((r) => r.json()))) as Array<Record<string, unknown>>;
    expect(new Set(bodies.map((b) => b["refreshToken"])).size).toBe(5);
  });
});
