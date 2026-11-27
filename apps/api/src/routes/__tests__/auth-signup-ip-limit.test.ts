import { describe, expect, it } from "vitest";
import { AuthConfigPatchSchema, CreateApiKeyRequestSchema } from "@vellum/api-contract";
import { generateProjectApiKey } from "@vellum/authorization";
import { createVellumPlatform } from "../../index.js";

async function fixture() {
  const platform = createVellumPlatform();
  const org = await platform.controlStore.createOrganization({
    name: "Limit Org",
    slug: "limit-org",
    billingEmail: "ops@example.com",
  });
  const { project } = await platform.controlStore.createProject({
    organizationId: org.id,
    name: "Limit App",
    slug: "limit-app",
  });
  const key = generateProjectApiKey({ keyType: "public" });
  await platform.controlStore.registerApiKey({
    projectId: project.id,
    name: "public key",
    keyType: "public",
    keyPrefix: key.keyPrefix,
    secretHash: key.secretHash,
  });
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    platform.fetch(
      new Request(`http://localhost${url}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      })
    );
  // Every attempt counts (countAll), so malformed bodies spend the bucket too.
  const attempt = () =>
    post(`/v1/projects/${project.id}/auth/sign-up/email`, { email: "not-an-email" }, { "x-vellum-api-key": key.fullKey });
  const patchConfig = (patch: { signupPerIpLimit?: number }) => {
    const cfg = platform.controlStore.getAuthConfig(project.id)!;
    return platform.controlStore.upsertAuthConfig({
      projectId: project.id,
      jwtKeyId: cfg.jwtKeyId,
      jwtPublicKeyPem: cfg.jwtPublicKeyPem,
      jwtPrivateKeyEncrypted: cfg.jwtPrivateKeyEncrypted,
      ...patch,
    });
  };
  return { platform, project, post, attempt, patchConfig };
}

describe("per-project per-IP sign-up limit (P1-3)", () => {
  it("defaults to 30 attempts per 15 minutes per (project, ip)", async () => {
    const f = await fixture();
    for (let i = 0; i < 30; i++) {
      expect((await f.attempt()).status).toBe(400);
    }
    const blocked = await f.attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("900");
  });

  it("honors the per-project override", async () => {
    const f = await fixture();
    // The first request initializes the project auth config.
    expect((await f.attempt()).status).toBe(400);
    await f.patchConfig({ signupPerIpLimit: 3 });
    expect((await f.attempt()).status).toBe(400);
    expect((await f.attempt()).status).toBe(400);
    expect((await f.attempt()).status).toBe(429);
  });

  it("bounds the override to 1..10,000 in the contract schema", () => {
    expect(AuthConfigPatchSchema.safeParse({ signupPerIpLimit: 0 }).success).toBe(false);
    expect(AuthConfigPatchSchema.safeParse({ signupPerIpLimit: 10_001 }).success).toBe(false);
    expect(AuthConfigPatchSchema.safeParse({ signupPerIpLimit: 250 }).success).toBe(true);
  });

  it("accepts isDev on key creation requests, publishable shape only", () => {
    expect(CreateApiKeyRequestSchema.safeParse({ name: "k", keyType: "publishable", isDev: true }).success).toBe(true);
    expect(CreateApiKeyRequestSchema.safeParse({ name: "k", keyType: "secret", isDev: true }).success).toBe(true);
    // The publishable-only restriction is enforced by the route, not the schema.
  });
});
