import { describe, expect, it } from "vitest";
import { generateProjectApiKey } from "@vellum/authorization";
import { createVellumPlatform } from "../../index.js";

// D3: POST /upgrade-anonymous converts an anonymous account to email/password
// in one call. The uid survives, the current session keeps working and every
// other session is revoked.
async function fixture() {
  const platform = createVellumPlatform();
  const org = await platform.controlStore.createOrganization({ name: "O", slug: "upg-org", billingEmail: "o@example.com" });
  const { project } = await platform.controlStore.createProject({ organizationId: org.id, name: "P", slug: "upg-app" });
  const key = generateProjectApiKey({ keyType: "public" });
  await platform.controlStore.registerApiKey({ projectId: project.id, name: "pk", keyType: "public", keyPrefix: key.keyPrefix, secretHash: key.secretHash });
  const serverKey = generateProjectApiKey({ keyType: "server" });
  await platform.controlStore.registerApiKey({ projectId: project.id, name: "sk", keyType: "server", keyPrefix: serverKey.keyPrefix, secretHash: serverKey.secretHash });
  const base = `/v1/projects/${project.id}/auth`;
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
  const getUser = (bearer: string) =>
    platform.fetch(
      new Request(`http://localhost${base}/user`, {
        headers: { "x-vellum-api-key": key.fullKey, authorization: `Bearer ${bearer}` },
      })
    );
  const anon = async () => {
    const res = await call("/sign-in/anonymous", {});
    return (await res.json()) as { accessToken: string; refreshToken: string; user: { id: string; email: string | null; isAnonymous: boolean } };
  };
  return { platform, call, getUser, anon, projectId: project.id };
}

describe("anonymous account upgrade (D3)", () => {
  it("upgrades in one call: uid preserved, password sign-in works, current session stays valid", async () => {
    const f = await fixture();
    const a = await f.anon();
    expect(a.user.isAnonymous).toBe(true);

    const res = await f.call("/upgrade-anonymous", { email: "up@example.com", password: "correct-horse-9" }, a.accessToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; email: string | null; isAnonymous: boolean; emailVerified: boolean } };
    expect(body.user.id).toBe(a.user.id);
    expect(body.user.email).toBe("up@example.com");
    expect(body.user.isAnonymous).toBe(false);
    expect(body.user.emailVerified).toBe(false);

    // The session that performed the upgrade is still valid.
    const me = await f.getUser(a.accessToken);
    expect(me.status).toBe(200);

    // Password sign-in now works for the same uid.
    const signIn = await f.call("/sign-in/email", { email: "up@example.com", password: "correct-horse-9" });
    expect(signIn.status).toBe(200);
    const signed = (await signIn.json()) as { user: { id: string } };
    expect(signed.user.id).toBe(a.user.id);
  });

  it("revokes the account's OTHER sessions but keeps the upgrading one", async () => {
    const f = await fixture();
    const a = await f.anon();
    // A second session for the same user, created directly in the store.
    await f.platform.dataStore.createAuthSession(
      { projectId: f.projectId },
      {
        userId: a.user.id,
        refreshTokenHash: "other-session-hash",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }
    );
    const before = await f.platform.dataStore.listUserSessions({ projectId: f.projectId }, a.user.id);
    expect(before).toHaveLength(2);

    const res = await f.call("/upgrade-anonymous", { email: "up@example.com", password: "correct-horse-9" }, a.accessToken);
    expect(res.status).toBe(200);

    const after = await f.platform.dataStore.listUserSessions({ projectId: f.projectId }, a.user.id);
    const revoked = after.filter((s) => s.revoked);
    const active = after.filter((s) => !s.revoked);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.revokedReason).toBe("anonymous_upgrade");
    expect(active).toHaveLength(1);
    // The active session is the one whose token performed the upgrade.
    const me = await f.getUser(a.accessToken);
    expect(me.status).toBe(200);
  });

  it("rejects non-anonymous accounts and collisions like sign-up", async () => {
    const f = await fixture();
    // Existing email/password account.
    const su = await f.call("/sign-up/email", { email: "taken@example.com", password: "correct-horse-9" });
    expect(su.status).toBe(201);
    const taken = (await su.json()) as { accessToken: string };

    const a = await f.anon();
    const collision = await f.call("/upgrade-anonymous", { email: "taken@example.com", password: "correct-horse-9" }, a.accessToken);
    expect(collision.status).toBe(409);

    // A non-anonymous account cannot use the endpoint.
    const notAnon = await f.call("/upgrade-anonymous", { email: "new@example.com", password: "correct-horse-9" }, taken.accessToken);
    expect(notAnon.status).toBe(412);

    // A second upgrade of the same (now converted) account also fails.
    const b = await f.anon();
    await f.call("/upgrade-anonymous", { email: "b@example.com", password: "correct-horse-9" }, b.accessToken);
    const again = await f.call("/upgrade-anonymous", { email: "b2@example.com", password: "correct-horse-9" }, b.accessToken);
    expect(again.status).toBe(412);

    // No token at all.
    const noAuth = await f.call("/upgrade-anonymous", { email: "c@example.com", password: "correct-horse-9" });
    expect(noAuth.status).toBe(401);
  });
});
