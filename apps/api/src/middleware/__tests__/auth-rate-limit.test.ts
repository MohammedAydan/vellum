import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { generateProjectApiKey } from "@vellum/authorization";
import { createVellumPlatform } from "../../index.js";
import { sanitizeAdminPayload } from "../../routes/admin.js";
import { errorHandler } from "../error-handler.js";
import { MemoryThrottleRepository } from "@vellum/database-control";
import { authRateLimit } from "../auth-rate-limit.js";

/** Documentation-range address only — never a real user IP or email. */
const TEST_IP_HEADERS = { "x-forwarded-for": "203.0.113.7" };

function loginApp(): { app: Hono; throttle: MemoryThrottleRepository } {
  const throttle = new MemoryThrottleRepository();
  const app = new Hono();
  app.onError(errorHandler);
  app.use("/login", authRateLimit({ max: 10, windowMs: 15 * 60 * 1000, scope: "test-login" }, throttle));
  app.post("/login", async (c) => {
    const body = (await c.req.json()) as { password?: string };
    if (body.password === "correct-horse") return c.json({ ok: true });
    return c.json({ ok: false }, 401);
  });
  return { app, throttle };
}

function postLogin(app: Hono, email: string, password: string): Promise<Response> {
  return Promise.resolve(app.request("http://localhost/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...TEST_IP_HEADERS },
    body: JSON.stringify({ email, password }),
  }));
}

function verifyApp(): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.use(
    "/verify",
    authRateLimit(
      { max: 1, windowMs: 15 * 60 * 1000, scope: "test-verify", countAll: true },
      new MemoryThrottleRepository()
    )
  );
  app.post("/verify", (c) => c.json({ sent: true }));
  return app;
}

function postVerify(app: Hono, token: string): Promise<Response> {
  return Promise.resolve(app.request("http://localhost/verify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...TEST_IP_HEADERS,
      authorization: `Bearer ${token}`,
    },
    // Mirrors sendEmailVerification(): an empty JSON object and a bearer token.
    body: JSON.stringify({}),
  }));
}

async function endUserFixture() {
  const platform = createVellumPlatform();
  const org = await platform.controlStore.createOrganization({
    name: "Throttle Org",
    slug: "throttle-org",
    billingEmail: "ops@example.com",
  });
  const { project } = await platform.controlStore.createProject({
    organizationId: org.id,
    name: "Throttle App",
    slug: "throttle-app",
  });
  const generated = generateProjectApiKey({ keyType: "public" });
  await platform.controlStore.registerApiKey({
    projectId: project.id,
    name: "public key",
    keyType: "public",
    keyPrefix: generated.keyPrefix,
    secretHash: generated.secretHash,
  });
  return {
    platform,
    base: `/v1/projects/${project.id}/auth`,
    apiKey: generated.fullKey,
  };
}

function collectKeys(value: unknown, acc: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
    return acc;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      acc.add(key);
      collectKeys(child, acc);
    }
  }
  return acc;
}

describe("@vellum/api - auth rate limiting & secret serialization", () => {

  it("returns 429 with Retry-After on the 11th failed login inside 15 minutes", async () => {
    const { app } = loginApp();
    for (let i = 0; i < 10; i += 1) {
      expect((await postLogin(app, "BRUTE@Example.COM", "wrong")).status).toBe(401);
    }

    const blocked = await postLogin(app, "brute@example.com", "wrong");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("900");
    const body = (await blocked.json()) as {
      error: { code: string; details?: { retryAfterSeconds?: number } };
    };
    expect(body.error.code).toBe("TOO_MANY_REQUESTS");
    expect(body.error.details?.retryAfterSeconds).toBe(900);
  });

  it("caps parallel attempts at the window size (counted while in flight)", async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.use("/slow", authRateLimit({ max: 3, windowMs: 60_000, scope: "test-parallel", countAll: true }, new MemoryThrottleRepository()));
    app.post("/slow", async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return c.json({ ok: true });
    });
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        Promise.resolve(app.request("http://localhost/slow", { method: "POST", headers: TEST_IP_HEADERS }))
      )
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(3);
    expect(statuses.filter((status) => status === 429)).toHaveLength(7);
  });

  it("does not let parallel wrong guesses exceed the failure budget", async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.use("/slow-login", authRateLimit({ max: 2, windowMs: 60_000, scope: "test-parallel-fail", keyFrom: () => "k" }, new MemoryThrottleRepository()));
    app.post("/slow-login", async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return c.json({ ok: false }, 401);
    });
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        Promise.resolve(app.request("http://localhost/slow-login", { method: "POST", headers: TEST_IP_HEADERS }))
      )
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(2);
    expect(statuses.filter((status) => status === 429)).toHaveLength(4);
  });

  it("does not count successful logins toward the failure budget", async () => {
    const { app } = loginApp();
    for (let i = 0; i < 12; i += 1) {
      expect((await postLogin(app, "ok@example.com", "correct-horse")).status).toBe(200);
    }
    // Ten failures are still fully allowed: the 12 successes never entered
    // the window. If they had, at least one of these would already be a 429.
    for (let i = 0; i < 10; i += 1) {
      expect((await postLogin(app, "ok@example.com", "wrong")).status).toBe(401);
    }
    // The 11th failure is the first blocked request.
    expect((await postLogin(app, "ok@example.com", "wrong")).status).toBe(429);
  });

  it("keeps email-less authenticated requests in distinct per-token buckets", async () => {
    const app = verifyApp();
    // Two different signed-in sessions from the same IP must not share a
    // throttle bucket just because their request bodies carry no email.
    expect((await postVerify(app, "session-alpha-jwt")).status).toBe(200);
    expect((await postVerify(app, "session-beta-jwt")).status).toBe(200);
    // Reusing the same session still enforces 5-style per-identity budgets
    // (max: 1 in this focused test).
    expect((await postVerify(app, "session-alpha-jwt")).status).toBe(429);
  });

  it("keeps distinct body emails in distinct buckets on the same IP", async () => {
    const app = verifyApp();
    const post = (email: string): Promise<Response> =>
      Promise.resolve(app.request("http://localhost/verify", {
        method: "POST",
        headers: { "content-type": "application/json", ...TEST_IP_HEADERS },
        body: JSON.stringify({ email }),
      }));
    expect((await post("first@example.com")).status).toBe(200);
    expect((await post("second@example.com")).status).toBe(200);
    expect((await post("first@example.com")).status).toBe(429);
  });

  it("resets all windows when the throttle state is cleared", async () => {
    const { app, throttle } = loginApp();
    for (let i = 0; i < 11; i += 1) {
      await postLogin(app, "reset@example.com", "wrong");
    }
    expect((await postLogin(app, "reset@example.com", "wrong")).status).toBe(429);

    throttle.clearAll();
    expect((await postLogin(app, "reset@example.com", "wrong")).status).toBe(401);
  });

  it("always answers sent:true for unknown emails on enumeration endpoints", async () => {
    const { platform, base, apiKey } = await endUserFixture();
    const headers = { "content-type": "application/json", "x-vellum-api-key": apiKey };

    const reset = await platform.fetch(
      new Request(`http://localhost${base}/password/reset`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email: "unknown-1@example.com" }),
      })
    );
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ success: true, sent: true });

    const verify = await platform.fetch(
      new Request(`http://localhost${base}/email/verify/request`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email: "unknown-2@example.com" }),
      })
    );
    expect(verify.status).toBe(200);
    expect(await verify.json()).toEqual({ success: true, sent: true });
  });

  it("sets hardening headers on admin/auth responses", async () => {
    const platform = createVellumPlatform();
    const response = await platform.fetch(new Request("http://localhost/v1/admin/setup-status"));
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("sanitizeAdminPayload strips every forbidden secret key", () => {
    const input = {
      passwordHash: "redacted-value",
      jwtPrivateKeyEncrypted: "redacted-value",
      secretEncrypted: "redacted-value",
      refreshTokenHash: "redacted-value",
      previousRefreshTokenHash: "redacted-value",
      clientSecretEncrypted: "redacted-value",
      platformSmtpPassEncrypted: "redacted-value",
      apiKeySecretHash: "redacted-value",
      nested: { passwordHash: "redacted-value", ok: 1 },
      list: [{ secretEncrypted: "redacted-value", ok: 2 }],
      path: "users/u1",
      data: { secret: "must-not-appear" },
    };

    const clean = sanitizeAdminPayload(input) as Record<string, unknown>;
    const keys = collectKeys(clean);
    for (const key of [
      "passwordHash",
      "jwtPrivateKeyEncrypted",
      "secretEncrypted",
      "refreshTokenHash",
      "previousRefreshTokenHash",
      "clientSecretEncrypted",
      "platformSmtpPassEncrypted",
      "apiKeySecretHash",
    ]) {
      expect(keys.has(key)).toBe(false);
    }
    expect(clean["hasClientSecret"]).toBe(true);
    expect(clean["hasPrivateKey"]).toBe(true);
    expect(JSON.stringify(clean)).not.toContain("must-not-appear");
    expect((clean["nested"] as Record<string, unknown>)["passwordHash"]).toBeUndefined();
    expect(((clean["list"] as Array<Record<string, unknown>>)[0])?.["secretEncrypted"]).toBeUndefined();
  });
});
