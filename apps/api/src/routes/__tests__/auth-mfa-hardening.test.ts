import { describe, expect, it } from "vitest";
import { generateProjectApiKey } from "@vellum/authorization";
import { generateTotpCode } from "@vellum/auth";
import { createVellumPlatform } from "../../index.js";

async function fixture() {
  const platform = createVellumPlatform();
  const org = await platform.controlStore.createOrganization({ name: "O", slug: "mfa-org", billingEmail: "o@example.com" });
  const { project } = await platform.controlStore.createProject({ organizationId: org.id, name: "P", slug: "mfa-app" });
  const key = generateProjectApiKey({ keyType: "public" });
  await platform.controlStore.registerApiKey({ projectId: project.id, name: "pk", keyType: "public", keyPrefix: key.keyPrefix, secretHash: key.secretHash });
  const base = `/v1/projects/${project.id}/auth`;
  const call = (path: string, body: unknown, bearer?: string) =>
    platform.fetch(new Request(`http://localhost${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vellum-api-key": key.fullKey, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    }));
  const signUp = await call("/sign-up/email", { email: "m@example.com", password: "Password123!" });
  const { accessToken } = (await signUp.json()) as { accessToken: string };
  const enrolled = (await (await call("/mfa/enroll", {}, accessToken)).json()) as { secret: string; recoveryCodes: string[] };
  const enrollCode = generateTotpCode(enrolled.secret);
  expect((await call("/mfa/verify", { code: enrollCode }, accessToken)).status).toBe(200);
  // A used code stays burned for its whole validity window: mint fresh codes
  // one step out (still inside the +/-1 step drift allowance).
  const freshCode = () => generateTotpCode(enrolled.secret, Date.now() + 30_000);
  const signIn = async () => (await (await call("/sign-in/email", { email: "m@example.com", password: "Password123!" })).json()) as Record<string, unknown>;
  return { call, accessToken, secret: enrolled.secret, enrollCode, freshCode, recoveryCodes: enrolled.recoveryCodes, signIn };
}

describe("TOTP MFA hardening", () => {
  it("validates the code on /mfa/verify even when MFA is already enabled", async () => {
    const f = await fixture();
    // Arbitrary wrong code: 401 (was a cosmetic 200 { verified: true }).
    expect((await f.call("/mfa/verify", { code: "000000" }, f.accessToken)).status).toBe(401);
    // A fresh valid code still verifies (and is burned: replaying it fails).
    const code = f.freshCode();
    expect((await f.call("/mfa/verify", { code }, f.accessToken)).status).toBe(200);
    expect((await f.call("/mfa/verify", { code }, f.accessToken)).status).toBe(401);
  });

  it("does not let a session re-enroll and thereby switch MFA off", async () => {
    const f = await fixture();
    const again = await f.call("/mfa/enroll", {}, f.accessToken);
    expect(again.status).toBe(412);
    const next = await f.signIn();
    expect(next["mfaRequired"]).toBe(true);
    expect(next["accessToken"]).toBeUndefined();
  });

  it("rejects a TOTP code that was already used", async () => {
    const f = await fixture();
    const code = f.freshCode();
    const t1 = String((await f.signIn())["mfaTicket"]);
    const t2 = String((await f.signIn())["mfaTicket"]);
    expect((await f.call("/mfa/challenge", { mfaTicket: t1, code })).status).toBe(200);
    expect((await f.call("/mfa/challenge", { mfaTicket: t2, code })).status).toBe(401);
  });

  it("rejects the enrollment-verify code replayed at the challenge route (S9)", async () => {
    const f = await fixture();
    const ticket = String((await f.signIn())["mfaTicket"]);
    expect((await f.call("/mfa/challenge", { mfaTicket: ticket, code: f.enrollCode })).status).toBe(401);
  });

  it("rejects the enrollment-verify code replayed at the disable route (S9)", async () => {
    const f = await fixture();
    expect((await f.call("/mfa/disable", { code: f.enrollCode }, f.accessToken)).status).toBe(401);
  });

  it("burns the ticket after repeated wrong codes", async () => {
    const f = await fixture();
    const ticket = String((await f.signIn())["mfaTicket"]);
    for (let i = 0; i < 5; i += 1) {
      expect((await f.call("/mfa/challenge", { mfaTicket: ticket, code: "000000" })).status).toBe(401);
    }
    // Either the ticket is gone (401) or the endpoint rate limit already answered (429). Never a session.
    expect([401, 429]).toContain((await f.call("/mfa/challenge", { mfaTicket: ticket, code: generateTotpCode(f.secret) })).status);
  });

  it("a recovery code works once", async () => {
    const f = await fixture();
    const rc = f.recoveryCodes[0] ?? "";
    const t1 = String((await f.signIn())["mfaTicket"]);
    const t2 = String((await f.signIn())["mfaTicket"]);
    expect((await f.call("/mfa/challenge", { mfaTicket: t1, code: rc, factorType: "recovery_code" })).status).toBe(200);
    expect((await f.call("/mfa/challenge", { mfaTicket: t2, code: rc, factorType: "recovery_code" })).status).toBe(401);
  });

  it("disabling needs a current code, then re-enrolling works", async () => {
    const f = await fixture();
    expect((await f.call("/mfa/disable", { code: "000000" }, f.accessToken)).status).toBe(401);
    expect((await f.call("/mfa/disable", { code: f.freshCode() }, f.accessToken)).status).toBe(200);
    const next = await f.signIn();
    expect(next["mfaRequired"]).toBeUndefined();
    expect(next["accessToken"]).toBeTruthy();
    const enroll = await f.call("/mfa/enroll", {}, String(next["accessToken"]));
    expect(enroll.status).toBe(200);
  });

  it("disable is refused without a session", async () => {
    const f = await fixture();
    expect((await f.call("/mfa/disable", { code: generateTotpCode(f.secret) })).status).toBe(401);
  });
});
