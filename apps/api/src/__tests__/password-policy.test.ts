import { describe, expect, it } from "vitest";
import { generateProjectApiKey } from "@vellum/authorization";
import { createVellumPlatform } from "../index.js";

/**
 * Common-password denylist: every self-service password choice (console
 * sign-up, end-user sign-up, end-user password change) refuses passwords
 * from the well-known top lists, case-insensitively.
 */

async function endUserFixture() {
  const platform = createVellumPlatform();
  const org = await platform.controlStore.createOrganization({
    name: "Pw Org",
    slug: "pw-org",
    billingEmail: "ops@example.com",
  });
  const { project } = await platform.controlStore.createProject({
    organizationId: org.id,
    name: "Pw App",
    slug: "pw-app",
  });
  const generated = generateProjectApiKey({ keyType: "public" });
  await platform.controlStore.registerApiKey({
    projectId: project.id,
    name: "public key",
    keyType: "public",
    keyPrefix: generated.keyPrefix,
    secretHash: generated.secretHash,
  });
  return { platform, base: `/v1/projects/${project.id}/auth`, apiKey: generated.fullKey };
}

describe("password policy", () => {
  it("console sign-up rejects common passwords and accepts a strong one", async () => {
    const platform = createVellumPlatform();
    const post = (email: string, password: string) =>
      platform.fetch(
        new Request("http://localhost/v1/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Policy Tester", email, password }),
        })
      );

    for (const weak of ["12345678", "password", "PASSWORD", "Qwerty123", "iloveyou"]) {
      const res = await post(`weak-${weak}@example.invalid`, weak);
      expect(res.status, weak).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INVALID_ARGUMENT");
      expect(body.error.message).toContain("too common");
    }

    expect((await post("strong@example.invalid", "S0me-Unique-Phrase!")).status).toBe(201);
  });

  it("end-user sign-up and password change reject common passwords", async () => {
    const { platform, base, apiKey } = await endUserFixture();
    const post = (path: string, body: unknown, token?: string) =>
      platform.fetch(
        new Request(`http://localhost${base}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-vellum-api-key": apiKey,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        })
      );

    const weak = await post("/sign-up/email", { email: "weak@example.com", password: "12345678" });
    expect(weak.status).toBe(400);
    expect(((await weak.json()) as { error: { message: string } }).error.message).toContain("too common");

    const ok = await post("/sign-up/email", { email: "real@example.com", password: "S0me-Unique-Phrase!" });
    expect(ok.status).toBe(201);
    const { accessToken } = (await ok.json()) as { accessToken: string };

    const change = await post(
      "/password/change",
      { currentPassword: "S0me-Unique-Phrase!", newPassword: "qwerty123" },
      accessToken
    );
    expect(change.status).toBe(400);
    expect(((await change.json()) as { error: { message: string } }).error.message).toContain("too common");
  });
});
