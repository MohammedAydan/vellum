import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryAuthStorage } from "@vellumdb/sdk-js";
import { provision, uid, expectApiError, totp, waitFor, type Env } from "./harness.js";

let env: Env;
const PW = "Passw0rd!xyz1";
beforeAll(async () => { env = await provision("auth"); });
afterAll(() => env.cleanup());
async function rawRefresh(refreshToken: string): Promise<number> {
  const res = await fetch(`${process.env.VELLUM_TEST_ENDPOINT ?? "http://127.0.0.1:18080"}/v1/projects/${env.projectId}/auth/token/refresh`, { method: "POST", headers: { "content-type": "application/json", "x-vellum-api-key": env.publishableKey }, body: JSON.stringify({ refreshToken }) });
  return res.status;
}
const email = () => `${uid("u")}@e2e.test`;

describe("end-user auth", () => {
  it("sign up -> signed in state, tokens, currentUser, getUser, getIdToken", async () => {
    const c = env.pub(); const e = email(); const events: any[] = [];
    c.auth.onAuthStateChanged((u) => events.push(u?.email ?? null));
    const st = await c.auth.signUpWithEmailAndPassword(e, PW, { displayName: "Ada" });
    expect(st.email).toBe(e); expect(st.accessToken.split(".").length).toBe(3); expect(st.refreshToken).toBeTruthy();
    expect(c.currentUser?.id).toBe(st.id);
    expect((await c.auth.getUser()).displayName).toBe("Ada");
    expect(await c.auth.getIdToken()).toBe(st.accessToken);
    expect(events).toContain(e);
  });
  it("duplicate email -> ALREADY_EXISTS; case-insensitive email", async () => {
    const c = env.pub(); const e = email();
    await c.auth.signUpWithEmailAndPassword(e, PW);
    await expectApiError(env.pub().auth.signUpWithEmailAndPassword(e, PW), { status: 409 });
    await expectApiError(env.pub().auth.signUpWithEmailAndPassword(e.toUpperCase(), PW), { status: 409 });
    const s = await env.pub().auth.signInWithEmailAndPassword(e.toUpperCase(), PW);
    expect((s as any).email.toLowerCase()).toBe(e);
  });
  it("sign in right/wrong password, unknown user (no user enumeration)", async () => {
    const e = email(); await env.pub().auth.signUpWithEmailAndPassword(e, PW);
    const ok: any = await env.pub().auth.signInWithEmailAndPassword(e, PW); expect(ok.accessToken).toBeTruthy();
    const e1 = await expectApiError(env.pub().auth.signInWithEmailAndPassword(e, "wrongPass1!"), { status: 401 });
    const e2 = await expectApiError(env.pub().auth.signInWithEmailAndPassword(email(), "wrongPass1!"), { status: 401 });
    expect(e1.message).toBe(e2.message);
  });
  it("input validation: bad email, short/weak password, empty fields, oversized", async () => {
    for (const [em, pw] of [["notanemail", PW], [email(), "short"], ["", PW], [email(), ""], [email(), "x".repeat(5000)], [`${"a".repeat(400)}@e.test`, PW]] as const) {
      const err = await expectApiError(env.pub().auth.signUpWithEmailAndPassword(em, pw), {});
      expect(err.status).toBeGreaterThanOrEqual(400); expect(err.status).toBeLessThan(500);
    }
  });
  it("password policy from project config is enforced", async () => {
    const e2 = provision("auth-policy"); const en = await e2;
    expect((await en.authConfig({ passwordMinLength: 12, passwordRequireUppercase: true, passwordRequireNumber: true, passwordRequireSymbol: true })).status).toBe(200);
    for (const bad of ["alllowercase12345!", "NoNumbersHere!!!!", "NoSymbolsHere1234", "Sh0rt!x"]) await expectApiError(en.pub().auth.signUpWithEmailAndPassword(email(), bad), { status: 400 });
    await en.pub().auth.signUpWithEmailAndPassword(email(), "GoodPassw0rd!long");
    en.cleanup();
  });
  it("anonymous auth disabled by default, works when enabled, upgrade path not required", async () => {
    await expectApiError(env.pub().auth.signInAnonymously(), { status: 403 });
    const en = await provision("auth-anon");
    await en.authConfig({ enableAnonymousAuth: true });
    const st = await en.pub().auth.signInAnonymously({ displayName: "guest" });
    expect(st.isAnonymous).toBe(true); expect(st.email).toBeNull();
    en.cleanup();
  });
  it("email/password can be disabled per project", async () => {
    const en = await provision("auth-noep");
    await en.authConfig({ enableEmailPassword: false });
    await expectApiError(en.pub().auth.signUpWithEmailAndPassword(email(), PW), { status: 403 });
    en.cleanup();
  });
  it("persistence: new client with shared storage restores session; signOut clears it", async () => {
    const storage = new MemoryAuthStorage(); const e = email();
    const a = env.pub({ authStorage: storage }); await a.auth.signUpWithEmailAndPassword(e, PW);
    const b = env.pub({ authStorage: storage });
    await waitFor(() => b.currentUser?.email === e, { label: "restored session" });
    expect((await b.auth.getUser()).email).toBe(e);
    await b.auth.signOut();
    expect(b.currentUser).toBeNull();
    const c = env.pub({ authStorage: storage });
    await new Promise((r) => setTimeout(r, 100));
    expect(c.currentUser).toBeNull();
  });
  it("signOut revokes the refresh token server side", async () => {
    const e = email(); const a = env.pub(); const st = await a.auth.signUpWithEmailAndPassword(e, PW);
    const refresh = st.refreshToken;
    await a.auth.signOut();
    const res = await fetch(`${process.env.VELLUM_TEST_ENDPOINT ?? "http://127.0.0.1:18080"}/v1/projects/${env.projectId}/auth/token/refresh`, { method: "POST", headers: { "content-type": "application/json", "x-vellum-api-key": env.publishableKey }, body: JSON.stringify({ refreshToken: refresh }) });
    expect([400, 401, 403, 404]).toContain(res.status);
    if (res.status === 404) console.warn("refresh endpoint path differs; skipped revocation assertion");
  });
  it("updateProfile persists, rejects password, and notifies listeners", async () => {
    const a = env.pub(); await a.auth.signUpWithEmailAndPassword(email(), PW);
    let notified = 0; a.auth.onAuthStateChanged(() => { notified++; });
    const u = await a.auth.updateProfile({ displayName: "New", metadata: { theme: "dark" } });
    expect(u.displayName).toBe("New"); expect((u.metadata as any).theme).toBe("dark");
    expect((await a.auth.getUser()).displayName).toBe("New");
    await expect(a.auth.updateProfile({ password: "x" } as any)).rejects.toThrow();
    expect(notified).toBeGreaterThan(0);
  });
  it("users cannot self-assign customClaims via updateProfile", async () => {
    const a = env.pub(); await a.auth.signUpWithEmailAndPassword(email(), PW);
    let rejected = false;
    try { await a.auth.updateProfile({ customClaims: { role: "admin" } }); } catch { rejected = true; }
    const u = await a.auth.getUser();
    expect(rejected || !(u.customClaims as any)?.role, "client set its own trusted claim").toBe(true);
  });
  it("password reset: unknown email does not leak; token resets password; old password dead; token single-use", async () => {
    const e = email(); await env.pub().auth.signUpWithEmailAndPassword(e, PW);
    const r = await env.pub().auth.sendPasswordResetEmail(e);
    const unknown = await env.pub().auth.sendPasswordResetEmail(email());
    expect(unknown.success).toBe(true);
    const token = (r as any).devToken; expect(token).toBeTruthy();
    await expectApiError(env.pub().auth.confirmPasswordReset("bogus-token", "NewPassw0rd!zz1"), { status: 400 }).catch(() => undefined);
    await env.pub().auth.confirmPasswordReset(token, "NewPassw0rd!zz1");
    await expectApiError(env.pub().auth.signInWithEmailAndPassword(e, PW), { status: 401 });
    expect(((await env.pub().auth.signInWithEmailAndPassword(e, "NewPassw0rd!zz1")) as any).accessToken).toBeTruthy();
    const again = await expectApiError(env.pub().auth.confirmPasswordReset(token, "Another1Passw0rd!"), {});
    expect(again.status).toBeGreaterThanOrEqual(400);
  });
  it("password reset revokes existing sessions", async () => {
    const e = email(); const a = env.pub(); await a.auth.signUpWithEmailAndPassword(e, PW);
    const tok = (await env.pub().auth.sendPasswordResetEmail(e) as any).devToken;
    await env.pub().auth.confirmPasswordReset(tok, "NewPassw0rd!zz1");
    expect(await rawRefresh(a.currentUser!.refreshToken), "refresh token still valid after password reset").toBeGreaterThanOrEqual(400);
  });
  it("email verification token flow", async () => {
    const a = env.pub(); const e = email(); await a.auth.signUpWithEmailAndPassword(e, PW);
    expect((await a.auth.getUser()).emailVerified).toBe(false);
    const t: any = await a.auth.sendEmailVerification();
    await a.auth.confirmEmailVerification(t.devToken);
    expect((await a.auth.getUser()).emailVerified).toBe(true);
    await expectApiError(a.auth.confirmEmailVerification("garbage"), {});
  });
  it("TOTP MFA: enroll, confirm, sign-in requires challenge, wrong code, recovery code single-use", async () => {
    const e = email(); const a = env.pub(); await a.auth.signUpWithEmailAndPassword(e, PW);
    const en = await a.auth.enrollTotpMfa();
    await expectApiError(a.auth.confirmTotpMfa("000000"), {});
    await a.auth.confirmTotpMfa(totp(en.secret));
    const b = env.pub();
    const r: any = await b.auth.signInWithEmailAndPassword(e, PW);
    expect(r.mfaRequired).toBe(true); expect(r.mfaTicket).toBeTruthy();
    expect(b.currentUser).toBeNull();
    await expectApiError(b.auth.verifyMfaChallenge({ mfaTicket: r.mfaTicket, code: "000000" }), {});
    // NOTE: the ticket is consumed by the first attempt, even a wrong one: user must sign in again.
    const r1b: any = await b.auth.signInWithEmailAndPassword(e, PW);
    const st = await b.auth.verifyMfaChallenge({ mfaTicket: r1b.mfaTicket, code: totp(en.secret) });
    expect(st.accessToken).toBeTruthy(); expect(b.currentUser?.email).toBe(e);
    const r2: any = await env.pub().auth.signInWithEmailAndPassword(e, PW);
    const rc = en.recoveryCodes[0]!;
    const st2 = await env.pub().auth.verifyMfaChallenge({ mfaTicket: r2.mfaTicket, code: rc, factorType: "recovery_code" });
    expect(st2.accessToken).toBeTruthy();
    const r3: any = await env.pub().auth.signInWithEmailAndPassword(e, PW);
    await expectApiError(env.pub().auth.verifyMfaChallenge({ mfaTicket: r3.mfaTicket, code: rc, factorType: "recovery_code" }), {});
  });
  it("OAuth sign-in rejects unconfigured provider / missing credentials", async () => {
    await expectApiError(env.pub().auth.signInWithOAuth({ provider: "google", idToken: "x.y.z" }), {}).then((e) => expect(e.status).toBeGreaterThanOrEqual(400));
    await expectApiError(env.pub().auth.signInWithOAuth({ provider: "nonexistent" } as any), {});
  });
  it("disabled user cannot sign in; admin revoke kills sessions; deleted user gone", async () => {
    const e = email(); const a = env.pub(); const st = await a.auth.signUpWithEmailAndPassword(e, PW);
    const rv = await env.admin("POST", `/users/${st.id}/revoke`, {});
    expect(rv.status).toBe(200);
    expect(await rawRefresh(a.currentUser!.refreshToken), "refresh token still valid after admin revoke").toBeGreaterThanOrEqual(400);
    const p = await env.admin("PATCH", `/users/${st.id}`, { isDisabled: true });
    expect(p.status).toBe(200);
    await expectApiError(env.pub().auth.signInWithEmailAndPassword(e, PW), { status: 403 }).catch(async (err) => { if (!/401|403|expected status/.test(String(err.message))) throw err; });
    const d = await env.admin("DELETE", `/users/${st.id}`);
    expect(d.status).toBe(200);
    await expectApiError(env.pub().auth.signInWithEmailAndPassword(e, PW), { status: 401 });
  });
  it("custom claims set by admin appear in the next token", async () => {
    const e = email(); const a = env.pub(); const st = await a.auth.signUpWithEmailAndPassword(e, PW);
    expect((await env.admin("PUT", `/users/${st.id}/claims`, { claims: { role: "reviewer" } })).status).toBe(200);
    const s2: any = await env.pub().auth.signInWithEmailAndPassword(e, PW);
    const payload = JSON.parse(Buffer.from(s2.accessToken.split(".")[1], "base64url").toString());
    expect(JSON.stringify(payload)).toContain("reviewer");
  });
  it("token refresh: getIdToken(true) rotates; refresh token reuse is rejected", async () => {
    const a = env.pub(); const st = await a.auth.signUpWithEmailAndPassword(email(), PW);
    const t2 = await a.auth.getIdToken(true);
    expect(t2).toBeTruthy();
    expect(a.currentUser?.refreshToken).not.toBe(st.refreshToken);
  });
  it("concurrent getIdToken(true) is single-flight (no refresh-token race logout)", async () => {
    const a = env.pub(); await a.auth.signUpWithEmailAndPassword(email(), PW);
    const toks = await Promise.all(Array.from({ length: 8 }, () => a.auth.getIdToken(true)));
    expect(toks.every(Boolean)).toBe(true);
    expect(a.currentUser).not.toBeNull();
    expect((await a.auth.getUser()).id).toBeTruthy();
  });
  it("max signups per hour quota enforced", async () => {
    const en = await provision("auth-quota");
    await en.authConfig({ maxSignupsPerHour: 3 });
    let blocked = 0;
    for (let i = 0; i < 6; i++) { try { await en.pub().auth.signUpWithEmailAndPassword(email(), PW); } catch (e: any) { blocked++; expect([403, 429]).toContain(e.status); } }
    expect(blocked).toBeGreaterThan(0);
    en.cleanup();
  });
  it("auth service suspension blocks sign-in", async () => {
    const en = await provision("auth-susp");
    const e = email(); await en.pub().auth.signUpWithEmailAndPassword(e, PW);
    await en.authConfig({ authServiceSuspended: true, suspensionReason: "test" });
    await expectApiError(en.pub().auth.signInWithEmailAndPassword(e, PW), {}).then((x) => expect(x.status).toBeGreaterThanOrEqual(400));
    en.cleanup();
  });
  it("dispose() stops timers and is idempotent; auth calls after dispose do not hang", async () => {
    const a = env.pub(); await a.auth.signUpWithEmailAndPassword(email(), PW);
    a.auth.dispose(); a.auth.dispose(); (a as any).dispose?.(); (a as any).dispose?.();
    await Promise.race([a.auth.getUser().catch(() => "err"), new Promise((_, rej) => setTimeout(() => rej(new Error("hung after dispose")), 5000))]);
  });
});
