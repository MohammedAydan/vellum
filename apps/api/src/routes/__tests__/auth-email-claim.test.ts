import { describe, expect, it } from "vitest";
import { generateProjectApiKey } from "@vellum/authorization";
import { createVellumPlatform } from "../../index.js";

async function fixture() {
  const platform = createVellumPlatform();
  const org = await platform.controlStore.createOrganization({ name: "O", slug: "claim-org", billingEmail: "o@example.com" });
  const { project } = await platform.controlStore.createProject({ organizationId: org.id, name: "P", slug: "claim-app" });
  const key = generateProjectApiKey({ keyType: "public" });
  await platform.controlStore.registerApiKey({ projectId: project.id, name: "pk", keyType: "public", keyPrefix: key.keyPrefix, secretHash: key.secretHash });
  const serverKey = generateProjectApiKey({ keyType: "server" });
  await platform.controlStore.registerApiKey({ projectId: project.id, name: "sk", keyType: "server", keyPrefix: serverKey.keyPrefix, secretHash: serverKey.secretHash });
  const base = `/v1/projects/${project.id}/auth`;
  // Enable anonymous auth through the admin config route (initializes the
  // project auth config with real signing material first).
  const cfgRes = await platform.fetch(
    new Request(`http://localhost${base}/admin/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-vellum-api-key": serverKey.fullKey },
      body: JSON.stringify({ enableAnonymousAuth: true }),
    })
  );
  if (cfgRes.status !== 200) throw new Error(`config patch failed: ${cfgRes.status}`);
  const call = (path: string, body: unknown, bearer?: string) =>
    platform.fetch(
      new Request(`http://localhost${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-vellum-api-key": key.fullKey, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
      })
    );
  const patchUser = (body: unknown, bearer: string) =>
    platform.fetch(
      new Request(`http://localhost${base}/user`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-vellum-api-key": key.fullKey, authorization: `Bearer ${bearer}` },
        body: JSON.stringify(body),
      })
    );
  const anon = async () => {
    const res = await call("/sign-in/anonymous", {});
    const body = (await res.json()) as { accessToken: string; user: { id: string; email: string | null } };
    return body;
  };
  return { platform, call, patchUser, anon };
}

describe("anonymous email claim (S8)", () => {
  it("attaches a free email only after mailbox confirmation", async () => {
    const f = await fixture();
    const a = await f.anon();
    expect(a.user.email).toBeNull();

    const claim = await f.patchUser({ email: "new@example.com" }, a.accessToken);
    expect(claim.status).toBe(200);
    const claimBody = (await claim.json()) as { user: { email: string | null }; emailClaim: string; devToken?: string };
    expect(claimBody.user.email).toBeNull();
    expect(claimBody.emailClaim).toBe("pending_verification");
    expect(claimBody.devToken).toBeTruthy();

    // The token binds the exact address it was issued for.
    const wrong = await f.call("/email/claim/confirm", { token: claimBody.devToken, email: "other@example.com" });
    expect(wrong.status).toBeGreaterThanOrEqual(400);

    const confirm = await f.call("/email/claim/confirm", { token: claimBody.devToken, email: "new@example.com" });
    expect(confirm.status).toBe(200);
    const confirmed = (await confirm.json()) as { success: boolean; user: { email: string | null; emailVerified: boolean } };
    expect(confirmed.success).toBe(true);
    expect(confirmed.user.email).toBe("new@example.com");
    expect(confirmed.user.emailVerified).toBe(true);
  });

  it("never reveals that the email belongs to another account (no ALREADY_EXISTS oracle)", async () => {
    const f = await fixture();
    await f.call("/sign-up/email", { email: "taken@example.com", password: "Password123!" });

    const a = await f.anon();
    const claim = await f.patchUser({ email: "taken@example.com" }, a.accessToken);
    expect(claim.status).toBe(200);
    const claimBody = (await claim.json()) as { emailClaim?: string; devToken?: string; error?: { code?: string } };
    expect(claimBody.error).toBeUndefined();
    expect(claimBody.emailClaim).toBe("pending_verification");

    // Confirmation is a no-op success: the existing account keeps the address
    // and the anonymous account stays email-less.
    const confirm = await f.call("/email/claim/confirm", { token: claimBody.devToken, email: "taken@example.com" });
    expect(confirm.status).toBe(200);
    const body = (await confirm.json()) as { success: boolean; user?: { email?: string | null } };
    expect(body.success).toBe(true);
    expect(body.user).toBeUndefined();

    const me = await f.patchUser({ displayName: "still anon" }, a.accessToken);
    const meBody = (await me.json()) as { user: { email: string | null } };
    expect(meBody.user.email).toBeNull();
  });

  it("a claim token is single-use", async () => {
    const f = await fixture();
    const a = await f.anon();
    const claimBody = (await (await f.patchUser({ email: "once@example.com" }, a.accessToken)).json()) as { devToken?: string };
    expect((await f.call("/email/claim/confirm", { token: claimBody.devToken, email: "once@example.com" })).status).toBe(200);
    const replay = await f.call("/email/claim/confirm", { token: claimBody.devToken, email: "once@example.com" });
    expect(replay.status).toBeGreaterThanOrEqual(400);
  });
});
