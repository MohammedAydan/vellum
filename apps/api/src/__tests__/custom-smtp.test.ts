import { describe, expect, it } from "vitest";
import { decryptSecret } from "@vellum/auth";
import type { ProjectAuthConfig } from "@vellum/database-control";
import { applyAuthConfigPatch, publicAuthConfig } from "../routes/auth-shared.js";

function base(over: Partial<ProjectAuthConfig> = {}): ProjectAuthConfig {
  return {
    id: "c1", projectId: "p1", jwtKeyId: "k", jwtPublicKeyPem: "pem", jwtPrivateKeyEncrypted: "enc",
    oauthProviders: {}, customSmtpConfigEncrypted: null, requireEmailVerification: false,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...over,
  } as unknown as ProjectAuthConfig;
}

describe("per-project mail server settings", () => {
  it("stores the settings encrypted and never returns the password", () => {
    const input = applyAuthConfigPatch(base(), {
      customSmtp: { host: "smtp.example.com", port: 465, user: "mailer", pass: "s3cret-pass", from: "no-reply@example.com" },
    });
    const stored = input.customSmtpConfigEncrypted as string;
    expect(stored).not.toContain("s3cret-pass");
    expect(JSON.parse(decryptSecret(stored))).toMatchObject({ host: "smtp.example.com", port: 465, pass: "s3cret-pass" });
    const view = publicAuthConfig(base({ customSmtpConfigEncrypted: stored }));
    expect(JSON.stringify(view)).not.toContain("s3cret-pass");
    expect(view["customSmtp"]).toMatchObject({ host: "smtp.example.com", port: 465, user: "mailer", hasPassword: true });
  });

  it("keeps the stored password when a later save omits it, and removes everything with null", () => {
    const first = applyAuthConfigPatch(base(), { customSmtp: { host: "smtp.example.com", pass: "keep-me" } });
    const second = applyAuthConfigPatch(base({ customSmtpConfigEncrypted: first.customSmtpConfigEncrypted ?? null }), {
      customSmtp: { host: "smtp2.example.com" },
    });
    expect(JSON.parse(decryptSecret(second.customSmtpConfigEncrypted as string))).toMatchObject({ host: "smtp2.example.com", pass: "keep-me" });
    const cleared = applyAuthConfigPatch(base({ customSmtpConfigEncrypted: second.customSmtpConfigEncrypted ?? null }), { customSmtp: null });
    expect(cleared.customSmtpConfigEncrypted).toBeNull();
  });
});
