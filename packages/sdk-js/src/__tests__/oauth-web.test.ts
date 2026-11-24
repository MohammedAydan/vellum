import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryAuthStorage, createClient, completeOAuthPopup } from "../index.js";

function makeJwt(payload: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  return `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}
const TOKEN = makeJwt({ sub: "usr_1", exp: Math.floor(Date.now() / 1000) + 3600 });
const USER = {
  id: "usr_1", email: "a@example.com", emailVerified: true, displayName: "A", photoUrl: null, phoneNumber: null,
  phoneVerified: false, isDisabled: false, isAnonymous: false, customClaims: {}, metadata: {},
  createdAt: "2026-11-17T00:00:00.000Z", updatedAt: "2026-11-17T00:00:00.000Z", lastSignInAt: null,
};
const SESSION = { user: USER, accessToken: TOKEN, refreshToken: "r1", tokenType: "Bearer", sessionId: "s1", expiresAt: "2099-01-01T00:00:00.000Z" };

function mkClient() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const customFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify(SESSION), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const client = createClient({
    endpoint: "https://api.example.com", projectId: "prj_1", apiKey: "pk_test_abc",
    customFetch, authStorage: new MemoryAuthStorage(), autoRefresh: false,
  });
  return { client, calls };
}

function fakeStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("browser OAuth helpers", () => {
  const loc = { href: "https://app.example.com/login", origin: "https://app.example.com", pathname: "/login", assign: vi.fn() };
  const hist = { state: null, replaceState: vi.fn() };
  beforeEach(() => {
    loc.href = "https://app.example.com/login";
    loc.assign.mockReset();
    vi.stubGlobal("location", loc);
    vi.stubGlobal("history", hist);
    vi.stubGlobal("sessionStorage", fakeStorage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("popup: opens the start URL with PKCE, then exchanges the one-time code with the verifier", async () => {
    const { client, calls } = mkClient();
    const popup = { closed: false, close: vi.fn(), location: { href: "https://accounts.google.com/x" } };
    let opened = "";
    vi.stubGlobal("open", (url: string) => { opened = url; return popup; });
    const pending = client.signInWithPopup("google");
    await vi.waitFor(() => expect(opened).not.toBe(""));
    const start = new URL(opened);
    expect(start.pathname).toBe("/v1/projects/prj_1/auth/oauth/google/start");
    expect(start.searchParams.get("apiKey")).toBe("pk_test_abc");
    expect(start.searchParams.get("redirectUri")).toBe("https://app.example.com/login");
    const state = start.searchParams.get("state") ?? "";
    expect(start.searchParams.get("codeChallenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    popup.location.href = `https://app.example.com/login?vellum_code=one-time&state=${state}`;
    const user = await pending;
    expect((user as { email: string }).email).toBe("a@example.com");
    expect(calls[0]?.url).toContain("/auth/oauth/exchange");
    expect(calls[0]?.body["code"]).toBe("one-time");
    expect(String(calls[0]?.body["codeVerifier"]).length).toBeGreaterThanOrEqual(43);
    expect(popup.close).toHaveBeenCalled();
  });

  it("popup: ignores a result for a different state, rejects provider errors", async () => {
    const { client } = mkClient();
    const popup = { closed: false, close: vi.fn(), location: { href: "https://accounts.google.com/x" } };
    let opened = "";
    vi.stubGlobal("open", (url: string) => { opened = url; return popup; });
    const pending = client.signInWithPopup("github");
    pending.catch(() => undefined);
    await vi.waitFor(() => expect(opened).not.toBe(""));
    const state = new URL(opened).searchParams.get("state") ?? "";
    popup.location.href = "https://app.example.com/login?vellum_code=evil&state=other";
    await new Promise((r) => setTimeout(r, 400));
    popup.location.href = `https://app.example.com/login?error=access_denied&error_description=Denied&state=${state}`;
    await expect(pending).rejects.toThrow("Denied");
  });

  it("popup: reports a blocked popup", async () => {
    const { client } = mkClient();
    vi.stubGlobal("open", () => null);
    await expect(client.signInWithPopup("google")).rejects.toThrow(/blocked/);
  });

  it("redirect: stores the verifier, navigates, and completes with getRedirectResult", async () => {
    const { client, calls } = mkClient();
    await client.signInWithRedirect("github");
    const target = new URL(String(loc.assign.mock.calls[0]?.[0]));
    expect(target.pathname).toContain("/oauth/github/start");
    const state = target.searchParams.get("state") ?? "";
    expect(await client.getRedirectResult()).toBeNull(); // not on the return URL yet
    loc.href = `https://app.example.com/login?vellum_code=abc&state=${state}`;
    const user = await client.getRedirectResult();
    expect((user as { id: string }).id).toBe("usr_1");
    expect(calls).toHaveLength(1);
    expect(hist.replaceState).toHaveBeenCalled();
    expect(await client.getRedirectResult()).toBeNull(); // single use
  });

  it("redirect: refuses a result whose state does not match", async () => {
    const { client } = mkClient();
    await client.signInWithRedirect("google");
    loc.href = "https://app.example.com/login?vellum_code=abc&state=forged";
    await expect(client.getRedirectResult()).rejects.toThrow();
  });

  it("signInWithGoogleIdToken posts the token to the verifying endpoint", async () => {
    const { client, calls } = mkClient();
    await client.signInWithGoogleIdToken("id.token.value", { nonce: "n1" });
    expect(calls[0]?.url).toContain("/auth/oauth/google/id-token");
    expect(calls[0]?.body).toEqual({ idToken: "id.token.value", nonce: "n1" });
  });

  it("oauth with MFA: no session until the second factor (TOTP or recovery code) is verified", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const customFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (u.endsWith("/oauth/exchange")) {
        return new Response(JSON.stringify({ mfaRequired: true, mfaTicket: "t1", factors: ["totp"], expiresAt: "2099-01-01T00:00:00.000Z" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(SESSION), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = createClient({
      endpoint: "https://api.example.com", projectId: "prj_1", apiKey: "pk_test_abc",
      customFetch, authStorage: new MemoryAuthStorage(), autoRefresh: false,
    });
    await client.signInWithRedirect("google");
    const state = new URL(String(loc.assign.mock.calls[0]?.[0])).searchParams.get("state") ?? "";
    loc.href = `https://app.example.com/login?vellum_code=abc&state=${state}`;
    const result = await client.getRedirectResult();
    expect(result).toMatchObject({ mfaRequired: true, mfaTicket: "t1" });
    expect(await client.getIdToken()).toBeNull();
    const user = await client.verifyMfaChallenge("t1", "ABCD-EFGH", "recovery_code");
    expect(user.id).toBe("usr_1");
    const challenge = calls.find((c) => c.url.endsWith("/auth/mfa/challenge"));
    expect(challenge?.body).toEqual({ mfaTicket: "t1", code: "ABCD-EFGH", factorType: "recovery_code" });
    expect(await client.getIdToken()).toBe(TOKEN);
  });

  it("completeOAuthPopup does nothing on a page without a result", () => {
    expect(completeOAuthPopup("https://app.example.com/login")).toBe(false);
  });
});
