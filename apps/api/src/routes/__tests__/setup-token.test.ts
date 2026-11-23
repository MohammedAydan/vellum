import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createVellumPlatform } from "../../index.js";
import { createVellumApp } from "../../app.js";
import { errorHandler } from "../../middleware/error-handler.js";
import { createAdminRoutes } from "../admin.js";

const SETUP_TOKEN = "super-secret-one-time-bootstrap-token-123456";

function setupApp() {
  const platform = createVellumPlatform();
  const admin = createAdminRoutes(
    platform.controlStore,
    platform.dataStore,
    platform.sessionService,
    platform.superAdminSessionService,
    { setupToken: SETUP_TOKEN, requireSetupToken: true }
  );
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/v1", admin);
  return { app, platform };
}

function ownerRequest(token?: string, email = "master@vellum.dev") {
  return new Request("http://localhost/v1/admin/setup-owner", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-setup-token": token } : {}),
    },
    body: JSON.stringify({ name: "Master Owner", email, password: "Password123!" }),
  });
}

describe("one-time Master Owner setup token", () => {
  it("advertises that a token is required without revealing it", async () => {
    const { app } = setupApp();
    const res = await app.request("/v1/admin/setup-status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["requiresSetup"]).toBe(true);
    expect(body["tokenRequired"]).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SETUP_TOKEN);
  });

  it("rejects setup without a token or with a wrong token", async () => {
    const { app } = setupApp();
    for (const token of [undefined, "wrong-token"]) {
      const res = await app.request(ownerRequest(token));
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(JSON.stringify(body)).toContain("INVALID_SETUP_TOKEN");
    }
  });

  it("allows x-setup-token in the CORS preflight for the admin console", async () => {
    const platform = createVellumPlatform({ corsOrigins: ["https://console.example.com"] });
    const app = createVellumApp(platform as unknown as Parameters<typeof createVellumApp>[0]);
    const res = await app.request("/v1/admin/setup-owner", {
      method: "OPTIONS",
      headers: {
        origin: "https://console.example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-setup-token",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-setup-token");
  });

  it("accepts the correct token exactly once, then permanently closes setup", async () => {
    const { app } = setupApp();
    const created = await app.request(ownerRequest(SETUP_TOKEN));
    expect(created.status).toBe(201);

    const status = await app.request("/v1/admin/setup-status");
    expect((await status.json()) as Record<string, unknown>).toMatchObject({
      initialized: true,
      requiresSetup: false,
      tokenRequired: false,
    });

    const replay = await app.request(ownerRequest(SETUP_TOKEN, "second@vellum.dev"));
    expect(replay.status).toBe(409);
  });
});
