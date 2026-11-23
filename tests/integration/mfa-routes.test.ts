/**
 * end-to-end MFA HTTP flow against a Hono app mounted exactly as
 * the orchestrator will mount it (`app.route("/v1", createMfaRoutes(...))`).
 *
 * Hermetic: in-memory control store + in-process MFA store + in-process
 * throttling. No Redis, no network, no credentials required.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ControlPlaneStore } from "@vellum/database-control/adapters";
import {
  createInMemoryRevocationStore,
  createSessionService,
  generateTotpCode,
  type SessionService,
} from "@vellum/authorization";
import { createMfaApp } from "../../apps/api/src/routes/mfa.js";

const SESSION_SECRET = "mfa-integration-session-secret-32-chars";
const UID = "usr-mfa-integration-1";

interface SetupResponse {
  secret: string;
  otpauthUri: string;
  recoveryCodes: string[];
}

function buildApp(sessionService: SessionService) {
  const controlStore = new ControlPlaneStore();
  const app = createMfaApp({
    controlStore,
    sessionService,
    apiKeyPepper: "mfa-test-pepper-32-characters-long",
    maxAttempts: 5,
    attemptWindowMs: 60_000,
  });
  return { app, controlStore };
}

describe("MFA REST endpoints", () => {
  let sessionService: SessionService;
  let app: ReturnType<typeof createMfaApp>;
  let controlStore: ControlPlaneStore;
  let token: string;

  beforeEach(() => {
    sessionService = createSessionService({
      secret: SESSION_SECRET,
      revocationStore: createInMemoryRevocationStore(),
    });
    ({ app, controlStore } = buildApp(sessionService));
    token = sessionService.signAccess({ sub: UID, uid: UID, role: "customer", orgIds: [] });
  });

  function call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    bearer: string | null = token
  ): Promise<Response> {
    return app.request(`/v1/auth/mfa${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(bearer !== null ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it("setup -> wrong code rejected -> correct code enables -> recovery code works once -> disable with code works", async () => {
    // 1. Initial status is disabled.
    const status0 = await call("GET", "/status");
    expect(status0.status).toBe(200);
    expect(await status0.json()).toEqual({ enabled: false });

    // 2. Setup returns the secret, an otpauth URI and recovery codes.
    const setupRes = await call("POST", "/setup");
    expect(setupRes.status).toBe(200);
    const setup = (await setupRes.json()) as SetupResponse;
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(setup.otpauthUri).toContain(setup.secret);
    expect(setup.otpauthUri).toContain("issuer=VELLUM");
    expect(setup.recoveryCodes).toHaveLength(8);
    expect(new Set(setup.recoveryCodes).size).toBe(8);

    // 3. Setup is idempotent while unverified (no destructive regeneration).
    const setupAgainRes = await call("POST", "/setup");
    expect(setupAgainRes.status).toBe(200);
    expect(await setupAgainRes.json()).toEqual(setup);
    expect((await (await call("GET", "/status")).json()) as { enabled: boolean }).toEqual({
      enabled: false,
    });

    // 4. A wrong TOTP code is rejected and does NOT enable MFA.
    const wrong = await call("POST", "/verify", { code: "000000" });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error.code).toBe("UNAUTHENTICATED");
    expect((await (await call("GET", "/status")).json()) as { enabled: boolean }).toEqual({
      enabled: false,
    });

    // 5. The correct code enables MFA.
    const correctCode = generateTotpCode(setup.secret);
    const verify = await call("POST", "/verify", { code: correctCode });
    expect(verify.status).toBe(200);
    expect(await verify.json()).toEqual({ enabled: true });
    expect((await (await call("GET", "/status")).json()) as { enabled: boolean }).toEqual({
      enabled: true,
    });

    // 6. Re-running setup after verification must not wipe the enrollment.
    const setupAfterEnable = await call("POST", "/setup");
    expect(setupAfterEnable.status).toBe(409);

    // 7. A recovery code disables MFA exactly once.
    const badDisable = await call("POST", "/disable", { code: "111111" });
    expect(badDisable.status).toBe(401);
    const disable = await call("POST", "/disable", { code: setup.recoveryCodes[0] });
    expect(disable.status).toBe(200);
    expect(await disable.json()).toEqual({ enabled: false });
    expect((await (await call("GET", "/status")).json()) as { enabled: boolean }).toEqual({
      enabled: false,
    });

    // 8. The consumed recovery code is worthless for a fresh enrollment.
    const reSetup = (await (await call("POST", "/setup")).json()) as SetupResponse;
    expect(reSetup.recoveryCodes).not.toContain(setup.recoveryCodes[0]);
    const reVerify = await call("POST", "/verify", { code: generateTotpCode(reSetup.secret) });
    expect(reVerify.status).toBe(200);
    const replayDisable = await call("POST", "/disable", { code: setup.recoveryCodes[0] });
    expect(replayDisable.status).toBe(401);
    expect((await (await call("GET", "/status")).json()) as { enabled: boolean }).toEqual({
      enabled: true,
    });

    // 9. A valid TOTP code still disables.
    const finalDisable = await call("POST", "/disable", { code: generateTotpCode(reSetup.secret) });
    expect(finalDisable.status).toBe(200);
    expect(await finalDisable.json()).toEqual({ enabled: false });

    // 10. Audit trail exists for setup / verify / disable; no secret leaked.
    const actions = controlStore.auditLogs.map((entry) => entry.action);
    expect(actions).toContain("mfa.setup");
    expect(actions).toContain("mfa.verify");
    expect(actions).toContain("mfa.disable");
    expect(JSON.stringify(controlStore.auditLogs)).not.toContain(reSetup.secret);
    expect(JSON.stringify(controlStore.auditLogs)).not.toContain(reSetup.recoveryCodes[0]!);
  });

  it("rate-limits verification attempts in-process (no Redis)", async () => {
    const setup = (await (await call("POST", "/setup")).json()) as SetupResponse;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await call("POST", "/verify", { code: attempt === 0 ? setup.recoveryCodes[0] : "000000" });
      expect(res.status).toBe(401);
    }
    const limited = await call("POST", "/verify", { code: generateTotpCode(setup.secret) });
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("RATE_LIMITED");
  });

  it("forged or missing sessions are rejected with 401 on every endpoint", async () => {
    const forgedService = createSessionService({
      secret: "a-completely-different-signing-secret-32",
      revocationStore: createInMemoryRevocationStore(),
    });
    const forged = forgedService.signAccess({ sub: UID, uid: UID, role: "customer", orgIds: [] });

    const requests: Array<[string, "GET" | "POST", string, unknown]> = [
      ["status", "GET", "/status", undefined],
      ["setup", "POST", "/setup", undefined],
      ["verify", "POST", "/verify", { code: "123456" }],
      ["disable", "POST", "/disable", { code: "123456" }],
    ];
    for (const [, method, path, body] of requests) {
      const forgedRes = await call(method, path, body, forged);
      expect(forgedRes.status, `forged session on ${path}`).toBe(401);
      const missingRes = await call(method, path, body, null);
      expect(missingRes.status, `missing session on ${path}`).toBe(401);
    }
  });
});
