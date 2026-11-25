import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { generateProjectApiKey } from "@vellum/authorization";
import { generateTotpCode } from "@vellum/auth";
import { createVellumPlatform } from "../../index.js";
import { clearOAuthKeyCache } from "../../auth/oauth/providers.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "k1", alg: "RS256", use: "sig" };
const REDIRECT = "https://app.example.com/auth/callback";

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function signIdToken(claims: Record<string, unknown>, kid = "k1"): string {
  const head = b64({ alg: "RS256", kid, typ: "JWT" });
  const body = b64(claims);
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

type Mock = { googleClaims: (nonce: string) => Record<string, unknown>; githubEmails: unknown[]; githubId: number };
const mock: Mock = { googleClaims: () => ({}), githubEmails: [], githubId: 7 };
let lastNonce = "";

function installFetch() {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://www.googleapis.com/oauth2/v3/certs")) return json({ keys: [jwk] });
    if (url === "https://oauth2.googleapis.com/token") {
      const params = new URLSearchParams(String(init?.body));
      if (params.get("code") !== "good-code" || !params.get("code_verifier")) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "at", id_token: signIdToken(mock.googleClaims(lastNonce)) });
    }
    if (url === "https://github.com/login/oauth/access_token") {
      const params = new URLSearchParams(String(init?.body));
      if (params.get("code") !== "good-code") return json({ error: "bad_verification_code" });
      return json({ access_token: "gh-at" });
    }
    if (url === "https://api.github.com/user") return json({ id: mock.githubId, login: "octo", name: "Octo", avatar_url: "https://a/x.png", email: "public@spoof.com" });
    if (url === "https://api.github.com/user/emails") return json(mock.githubEmails);
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function fixture() {
  const platform = createVellumPlatform();
  const org = await platform.controlStore.createOrganization({ name: "O", slug: "oauth-org", billingEmail: "o@example.com" });
  const { project } = await platform.controlStore.createProject({ organizationId: org.id, name: "P", slug: "oauth-app" });
  const mk = async (keyType: "public" | "server") => {
    const key = generateProjectApiKey({ keyType });
    await platform.controlStore.registerApiKey({ projectId: project.id, name: keyType, keyType, keyPrefix: key.keyPrefix, secretHash: key.secretHash });
    return key.fullKey;
  };
  const publicKeyStr = await mk("public");
  const serverKey = await mk("server");
  const base = `/v1/projects/${project.id}/auth`;
  const call = (method: string, url: string, key: string, body?: unknown) =>
    platform.fetch(new Request(`http://localhost${base}${url}`, {
      method,
      headers: { "content-type": "application/json", "x-vellum-api-key": key },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }));
  // Configure providers + allowlist through the customer admin config route is auth-gated;
  // write the config directly to the control store like the admin route does.
  const { mergeOAuthProviders } = await import("../../auth/oauth/config.js");
  const existing = await (await import("../auth-shared.js")).ensureAuthConfig(platform as never, project.id);
  await platform.controlStore.upsertAuthConfig({
    projectId: project.id,
    jwtKeyId: existing.jwtKeyId,
    jwtPublicKeyPem: existing.jwtPublicKeyPem,
    jwtPrivateKeyEncrypted: existing.jwtPrivateKeyEncrypted,
    oauthProviders: mergeOAuthProviders({}, {
      google: { enabled: true, clientId: "google-client", clientSecret: "gsecret" },
      github: { enabled: true, clientId: "gh-client", clientSecret: "ghsecret" },
      __settings: { redirectUris: [REDIRECT, "myapp://auth"] },
    }, process.env["MASTER_ENCRYPTION_KEY"]),
  });
  return { platform, project, call, publicKeyStr, serverKey, base };
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** What an app computes from its own PKCE challenge and shows to the user. */
function appCode(challenge: string): string {
  const d = createHash("sha256").update(`vellum-confirm:${challenge}`).digest();
  return Array.from({ length: 6 }, (_, i) => CODE_ALPHABET[(d[i] as number) & 31]).join("");
}

/** Submits the browser confirmation form like the user's browser would. */
async function submitConfirm(f: Awaited<ReturnType<typeof fixture>>, html: string, code: string) {
  const ticket = /name="ticket" value="([^"]+)"/.exec(html)?.[1] ?? "";
  expect(ticket).not.toBe("");
  return f.platform.fetch(
    new Request(`http://localhost${f.base}/oauth/confirm`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket, code }),
    })
  );
}

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function start(f: Awaited<ReturnType<typeof fixture>>, provider: string, challenge: string, redirectUri = REDIRECT) {
  return f.call("POST", `/oauth/${provider}/start`, f.publicKeyStr, { redirectUri, codeChallenge: challenge, state: "cs1" });
}

async function runFlow(f: Awaited<ReturnType<typeof fixture>>, provider: string) {
  const { verifier, challenge } = pkce();
  const res = await start(f, provider, challenge);
  expect(res.status).toBe(200);
  const authorize = new URL(((await res.json()) as { authorizeUrl: string }).authorizeUrl);
  lastNonce = authorize.searchParams.get("nonce") ?? "";
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  const cb = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  cb.searchParams.set("code", "good-code");
  cb.searchParams.set("state", authorize.searchParams.get("state") ?? "");
  const back = await f.platform.fetch(new Request(`http://localhost${cb.pathname}${cb.search}`, { redirect: "manual" }));
  return { back, verifier, authorize };
}

describe("OAuth sign-in (mock Google and GitHub)", () => {
  beforeEach(() => {
    clearOAuthKeyCache();
    installFetch();
    mock.githubEmails = [{ email: "Dev@Example.com", primary: true, verified: true }];
    mock.githubId = 7;
    mock.googleClaims = (nonce) => ({
      iss: "https://accounts.google.com", aud: "google-client", sub: "g-1", exp: Math.floor(Date.now() / 1000) + 600,
      email: "alice@example.com", email_verified: true, name: "Alice", nonce,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("google: start -> callback -> exchange yields a session; code is single use", async () => {
    const f = await fixture();
    const { back, verifier } = await runFlow(f, "google");
    expect(back.status).toBe(302);
    const target = new URL(back.headers.get("location") ?? "");
    expect(target.origin + target.pathname).toBe(REDIRECT);
    expect(target.searchParams.get("state")).toBe("cs1");
    const code = target.searchParams.get("vellum_code") ?? "";
    expect(code).not.toBe("");
    const bad = await f.call("POST", "/oauth/exchange", f.publicKeyStr, { code, codeVerifier: pkce().verifier });
    expect(bad.status).toBe(401);
    const ok = await f.call("POST", "/oauth/exchange", f.publicKeyStr, { code, codeVerifier: verifier });
    expect(ok.status).toBe(200);
    const session = (await ok.json()) as { accessToken: string; user: { email: string } };
    expect(session.user.email).toBe("alice@example.com");
    expect(session.accessToken).toBeTruthy();
    const again = await f.call("POST", "/oauth/exchange", f.publicKeyStr, { code, codeVerifier: verifier });
    expect(again.status).toBe(401);
  });

  it("google: rejects a wrong nonce, wrong audience and unverified email", async () => {
    for (const patch of [{ nonce: "other" }, { aud: "someone-else" }, { email_verified: false }]) {
      const f = await fixture();
      mock.googleClaims = (nonce) => ({
        iss: "https://accounts.google.com", aud: "google-client", sub: "g-2", exp: Math.floor(Date.now() / 1000) + 600,
        email: "bob@example.com", email_verified: true, nonce, ...patch,
      });
      const { back } = await runFlow(f, "google");
      const target = new URL(back.headers.get("location") ?? "");
      expect(target.searchParams.get("vellum_code")).toBeNull();
      expect(target.searchParams.get("error")).toBeTruthy();
    }
  });

  it("github: uses the primary verified email, not the public profile email", async () => {
    const f = await fixture();
    const { back, verifier } = await runFlow(f, "github");
    const code = new URL(back.headers.get("location") ?? "").searchParams.get("vellum_code") ?? "";
    const ok = await f.call("POST", "/oauth/exchange", f.publicKeyStr, { code, codeVerifier: verifier });
    expect(((await ok.json()) as { user: { email: string } }).user.email).toBe("dev@example.com");
  });

  it("github: refuses when no verified primary email exists", async () => {
    const f = await fixture();
    mock.githubEmails = [{ email: "x@example.com", primary: true, verified: false }];
    const { back } = await runFlow(f, "github");
    const target = new URL(back.headers.get("location") ?? "");
    expect(target.searchParams.get("error")).toBe("access_denied");
  });

  it("links to an existing password account only through a verified email", async () => {
    const f = await fixture();
    const signup = await f.call("POST", "/sign-up/email", f.publicKeyStr, { email: "alice@example.com", password: "Password123!", displayName: "A" });
    expect(signup.status).toBe(201);
    const { back, verifier } = await runFlow(f, "google");
    const code = new URL(back.headers.get("location") ?? "").searchParams.get("vellum_code") ?? "";
    const ok = await f.call("POST", "/oauth/exchange", f.publicKeyStr, { code, codeVerifier: verifier });
    expect(ok.status).toBe(200);
  });

  it("oauth sign-in does not bypass TOTP: returns a ticket, the code completes it", async () => {
    for (const provider of ["google", "github"]) {
      const f = await fixture();
      mock.githubEmails = [{ email: "alice@example.com", primary: true, verified: true }];
      const signup = await f.call("POST", "/sign-up/email", f.publicKeyStr, { email: "alice@example.com", password: "Password123!", displayName: "A" });
      const { accessToken } = (await signup.json()) as { accessToken: string };
      const authed = (path: string, body: unknown) => f.platform.fetch(new Request(`http://localhost${f.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-vellum-api-key": f.publicKeyStr, authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(body),
      }));
      const enrolled = (await (await authed("/mfa/enroll", {})).json()) as { secret: string };
      expect((await authed("/mfa/verify", { code: generateTotpCode(enrolled.secret) })).status).toBe(200);

      const { back, verifier } = await runFlow(f, provider);
      const code = new URL(back.headers.get("location") ?? "").searchParams.get("vellum_code") ?? "";
      const ex = await f.call("POST", "/oauth/exchange", f.publicKeyStr, { code, codeVerifier: verifier });
      expect(ex.status).toBe(200);
      const body = (await ex.json()) as Record<string, unknown>;
      expect(body["mfaRequired"]).toBe(true);
      expect(body["accessToken"]).toBeUndefined();
      expect(body["refreshToken"]).toBeUndefined();
      const ticket = String(body["mfaTicket"]);

      const wrong = await f.call("POST", "/mfa/challenge", f.publicKeyStr, { mfaTicket: ticket, code: "000000" });
      expect(wrong.status).toBe(401);
      const done = await f.call("POST", "/mfa/challenge", f.publicKeyStr, { mfaTicket: ticket, code: generateTotpCode(enrolled.secret) });
      expect(done.status).toBe(200);
      expect(((await done.json()) as { accessToken?: string }).accessToken).toBeTruthy();
      // The one-time exchange code and the ticket are both spent.
      expect((await f.call("POST", "/oauth/exchange", f.publicKeyStr, { code, codeVerifier: verifier })).status).toBe(401);
      expect((await f.call("POST", "/mfa/challenge", f.publicKeyStr, { mfaTicket: ticket, code: generateTotpCode(enrolled.secret) })).status).toBe(401);
    }
  });

  it("refuses redirect URIs outside the allowlist and bad PKCE input", async () => {
    const f = await fixture();
    const { challenge } = pkce();
    const evil = await start(f, "google", challenge, "https://evil.example/cb");
    expect(evil.status).toBe(400);
    const noPkce = await start(f, "google", "short");
    expect(noPkce.status).toBe(400);
    const noKey = await f.call("POST", "/oauth/google/start", "", { redirectUri: REDIRECT, codeChallenge: challenge });
    expect(noKey.status).toBe(401);
    // Native loopback redirects are accepted on any port without being listed.
    const loop = await start(f, "google", challenge, "http://127.0.0.1:4455/callback");
    expect(loop.status).toBe(200);
    // The old GET start URL (API key in the query string) is refused.
    const legacy = await f.platform.fetch(new Request(
      `http://localhost${f.base}/oauth/google/start?apiKey=${f.publicKeyStr}&redirectUri=${encodeURIComponent(REDIRECT)}&codeChallenge=${challenge}`,
      { redirect: "manual" }
    ));
    expect(legacy.status).toBe(400);
  });

  it("rejects a tampered state", async () => {
    const f = await fixture();
    const res = await f.platform.fetch(new Request(`http://localhost${f.base}/oauth/google/callback?code=good-code&state=forged`, { redirect: "manual" }));
    expect(res.status).toBe(401);
  });

  it("id-token endpoint verifies a native Google ID token", async () => {
    const f = await fixture();
    const token = signIdToken({
      iss: "accounts.google.com", aud: "google-client", sub: "g-9", exp: Math.floor(Date.now() / 1000) + 600,
      email: "native@example.com", email_verified: true,
    });
    const ok = await f.call("POST", "/oauth/google/id-token", f.publicKeyStr, { idToken: token });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { user: { email: string } }).user.email).toBe("native@example.com");
    const forged = token.slice(0, -4) + "AAAA";
    const bad = await f.call("POST", "/oauth/google/id-token", f.publicKeyStr, { idToken: forged });
    expect(bad.status).toBe(401);
  });

  it("never exposes the client secret in the config view", async () => {
    const f = await fixture();
    const { publicAuthConfig, ensureAuthConfig } = await import("../auth-shared.js");
    const view = JSON.stringify(publicAuthConfig(await ensureAuthConfig(f.platform as never, f.project.id)));
    expect(view).not.toContain("gsecret");
    expect(view).not.toContain("clientSecretEncrypted");
  });

  it("keeps the stored secret when a patch omits it, and flags presence per provider", async () => {
    const { mergeOAuthProviders } = await import("../../auth/oauth/config.js");
    const { publicAuthConfig } = await import("../auth-shared.js");
    const key = "test-master-key-for-merge";
    const first = mergeOAuthProviders({}, { github: { enabled: true, clientId: "id1", clientSecret: "s1" } }, key);
    const second = mergeOAuthProviders(first, { github: { enabled: false, clientId: "id2", hasClientSecret: true } }, key);
    const gh = second["github"] as Record<string, unknown>;
    expect(gh["clientSecretEncrypted"]).toBe((first["github"] as Record<string, unknown>)["clientSecretEncrypted"]);
    expect(gh["clientId"]).toBe("id2");
    expect(gh).not.toHaveProperty("hasClientSecret");
    expect(gh).not.toHaveProperty("clientSecret");
    const view = publicAuthConfig({ oauthProviders: second } as never) as { oauthProviders: Record<string, Record<string, unknown>> };
    expect(view.oauthProviders["github"]?.["hasClientSecret"]).toBe(true);
    expect(JSON.stringify(view)).not.toContain("clientSecretEncrypted");
    const other = mergeOAuthProviders(second, { google: { enabled: true, clientId: "g" } }, key);
    expect(other).toHaveProperty("github");
  });

  it("rejects unsafe redirect URIs in the allowlist", async () => {
    const { mergeOAuthProviders } = await import("../../auth/oauth/config.js");
    for (const bad of ["javascript:alert(1)", "http://evil.example/cb", "https://a.example/cb#frag", "not a url"]) {
      expect(() => mergeOAuthProviders({}, { __settings: { redirectUris: [bad] } }, undefined)).toThrow();
    }
  });

  it("poll delivery: no redirect URI, no deep link; the verifier holder collects the session once", async () => {
    const f = await fixture();
    const { verifier, challenge } = pkce();
    const res = await f.call("POST", "/oauth/google/start", f.publicKeyStr, { delivery: "poll", codeChallenge: challenge });
    expect(res.status).toBe(200);
    const authorize = new URL(((await res.json()) as { authorizeUrl: string }).authorizeUrl);
    lastNonce = authorize.searchParams.get("nonce") ?? "";
    mock.googleClaims = (nonce) => ({ iss: "https://accounts.google.com", aud: "google-client", sub: "g-poll", email: "poll@example.com", email_verified: true, name: "P", exp: Math.floor(Date.now() / 1000) + 600, nonce });
    const pending = await f.call("POST", "/oauth/poll", f.publicKeyStr, { codeVerifier: verifier });
    expect(pending.status).toBe(202);
    expect(((await pending.json()) as { status: string }).status).toBe("pending");
    const cb = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    cb.searchParams.set("code", "good-code");
    cb.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    const back = await f.platform.fetch(new Request(`http://localhost${cb.pathname}${cb.search}`, { redirect: "manual" }));
    expect(back.status).toBe(200);
    expect(back.headers.get("content-type")).toContain("text/html");
    const html = await back.text();
    expect(html).not.toContain("vellum_code");
    // Not released yet: the browser page asks for the code shown in the app and names the project.
    expect(html).toContain("confirmation code");
    expect(html).toContain("<b>P</b>");
    const early = await f.call("POST", "/oauth/poll", f.publicKeyStr, { codeVerifier: verifier });
    expect(early.status).toBe(202);
    const miss = await submitConfirm(f, html, "AAAAAA");
    expect(await miss.text()).toContain("does not match");
    const done = await submitConfirm(f, html, appCode(challenge).toLowerCase().replace(/(...)(...)/, "$1-$2"));
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("signed in");
    const wrong = await f.call("POST", "/oauth/poll", f.publicKeyStr, { codeVerifier: pkce().verifier });
    expect(wrong.status).toBe(202);
    const ok = await f.call("POST", "/oauth/poll", f.publicKeyStr, { codeVerifier: verifier });
    expect(ok.status).toBe(200);
    const session = (await ok.json()) as { accessToken?: string; user?: { email?: string } };
    expect(session.accessToken).toBeTruthy();
    expect(session.user?.email).toBe("poll@example.com");
    const again = await f.call("POST", "/oauth/poll", f.publicKeyStr, { codeVerifier: verifier });
    expect(again.status).toBe(202);
    const short = await f.call("POST", "/oauth/poll", f.publicKeyStr, { codeVerifier: "short" });
    expect(short.status).toBe(400);
  });

  it("password change and account deletion need the current password", async () => {
    const f = await fixture();
    const reg = await f.call("POST", "/sign-up/email", f.publicKeyStr, { email: "me@example.com", password: "First-pass-1234!" });
    const s1 = (await reg.json()) as { accessToken: string; refreshToken: string };
    const authed = (method: string, url: string, body?: unknown, token = s1.accessToken) =>
      f.platform.fetch(new Request(`http://localhost${f.base}${url}`, {
        method,
        headers: { "content-type": "application/json", "x-vellum-api-key": f.publicKeyStr, authorization: `Bearer ${token}` },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }));
    const bad = await authed("POST", "/password/change", { currentPassword: "nope", newPassword: "Second-pass-1234!" });
    expect(bad.status).toBe(401);
    const good = await authed("POST", "/password/change", { currentPassword: "First-pass-1234!", newPassword: "Second-pass-1234!" });
    expect(good.status).toBe(200);
    const s2 = (await good.json()) as { accessToken: string; refreshToken: string };
    expect((await f.call("POST", "/token/refresh", f.publicKeyStr, { refreshToken: s1.refreshToken })).status).toBeGreaterThanOrEqual(400);
    expect((await f.call("POST", "/sign-in/email", f.publicKeyStr, { email: "me@example.com", password: "Second-pass-1234!" })).status).toBe(200);
    expect((await authed("DELETE", "/user", {}, s2.accessToken)).status).toBe(401);
    expect((await authed("DELETE", "/user", { password: "Second-pass-1234!" }, s2.accessToken)).status).toBe(200);
    expect((await f.call("POST", "/sign-in/email", f.publicKeyStr, { email: "me@example.com", password: "Second-pass-1234!" })).status).toBeGreaterThanOrEqual(400);
  });

  it("lists and revokes own sessions, lists linked sign-in methods and refuses to remove the last one", async () => {
    const f = await fixture();
    const reg = await f.call("POST", "/sign-up/email", f.publicKeyStr, { email: "sess@example.com", password: "First-pass-1234!" });
    const s1 = (await reg.json()) as { accessToken: string; refreshToken: string };
    const second = await f.call("POST", "/sign-in/email", f.publicKeyStr, { email: "sess@example.com", password: "First-pass-1234!" });
    const s2 = (await second.json()) as { refreshToken: string };
    const authed = (method: string, url: string, body?: unknown) =>
      f.platform.fetch(new Request(`http://localhost${f.base}${url}`, {
        method,
        headers: { "content-type": "application/json", "x-vellum-api-key": f.publicKeyStr, authorization: `Bearer ${s1.accessToken}` },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }));
    const list = (await (await authed("GET", "/sessions")).json()) as { sessions: { id: string }[] };
    expect(list.sessions.length).toBe(2);
    expect(JSON.stringify(list)).not.toContain("refresh");
    expect((await authed("DELETE", `/sessions/${list.sessions[0]!.id}`)).status).toBe(200);
    expect(((await (await authed("GET", "/sessions")).json()) as { sessions: unknown[] }).sessions.length).toBe(1);
    expect((await authed("DELETE", "/sessions/00000000-0000-0000-0000-000000000000")).status).toBe(404);
    expect(s2.refreshToken).toBeTruthy();
    const ids = (await (await authed("GET", "/identities")).json()) as { identities: { provider: string }[]; hasPassword: boolean };
    expect(ids.identities.map((i) => i.provider)).toEqual(["password"]);
    expect(ids.hasPassword).toBe(true);
    expect((await authed("DELETE", "/identities/password")).status).toBe(401);
    expect((await authed("DELETE", "/identities/password", { currentPassword: "First-pass-1234!" })).status).toBe(412);
    expect((await authed("DELETE", "/identities/github", { currentPassword: "First-pass-1234!" })).status).toBe(404);
  });

  it("link: a signed-in user adds Google to their account (any email), another user cannot take the same Google account", async () => {
    const f = await fixture();
    const mk = async (email: string) => (await (await f.call("POST", "/sign-up/email", f.publicKeyStr, { email, password: "First-pass-1234!" })).json()) as { accessToken: string };
    const a = await mk("a-link@example.com");
    const b = await mk("b-link@example.com");
    mock.googleClaims = (nonce) => ({ iss: "https://accounts.google.com", aud: "google-client", sub: "g-link", email: "other-mailbox@example.com", email_verified: true, name: "L", exp: Math.floor(Date.now() / 1000) + 600, nonce });
    const authed = (method: string, url: string, token: string, body?: unknown) =>
      f.platform.fetch(new Request(`http://localhost${f.base}${url}`, {
        method,
        headers: { "content-type": "application/json", "x-vellum-api-key": f.publicKeyStr, authorization: `Bearer ${token}` },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }));
    const runLink = async (token: string) => {
      const { verifier, challenge } = pkce();
      const res = await authed("POST", "/oauth/google/start", token, { redirectUri: REDIRECT, codeChallenge: challenge, state: "cs1", link: true, currentPassword: "First-pass-1234!" });
      expect(res.status).toBe(200);
      const authorize = new URL(((await res.json()) as { authorizeUrl: string }).authorizeUrl);
      lastNonce = authorize.searchParams.get("nonce") ?? "";
      const cb = new URL(authorize.searchParams.get("redirect_uri") ?? "");
      cb.searchParams.set("code", "good-code");
      cb.searchParams.set("state", authorize.searchParams.get("state") ?? "");
      const back = await f.platform.fetch(new Request(`http://localhost${cb.pathname}${cb.search}`, { redirect: "manual" }));
      const html = await back.text();
      // Linking waits for the code shown in the app.
      const done = await submitConfirm(f, html, appCode(challenge));
      return { loc: new URL(done.headers.get("location") ?? "http://none.invalid/"), verifier, html };
    };
    const noAuth = await f.call("POST", "/oauth/google/start", f.publicKeyStr, { redirectUri: REDIRECT, codeChallenge: pkce().challenge, link: true });
    expect(noAuth.status).toBe(401);
    const first = await runLink(a.accessToken);
    expect(first.loc.searchParams.get("vellum_code")).toBeTruthy();
    const ids = (await (await authed("GET", "/identities", a.accessToken)).json()) as { identities: { provider: string }[] };
    expect(ids.identities.map((i) => i.provider).sort()).toEqual(["google", "password"]);
    const second = await runLink(b.accessToken);
    expect(second.loc.searchParams.get("error")).toBe("access_denied");
    const bIds = (await (await authed("GET", "/identities", b.accessToken)).json()) as { identities: { provider: string }[] };
    expect(bIds.identities.map((i) => i.provider)).toEqual(["password"]);
  });

  it("attack: device-code phishing. A victim who signs in through the attacker's link cannot release the session without the attacker's code", async () => {
    const f = await fixture();
    const attacker = pkce();
    const res = await f.call("POST", "/oauth/google/start", f.publicKeyStr, { delivery: "poll", codeChallenge: attacker.challenge });
    const authorize = new URL(((await res.json()) as { authorizeUrl: string }).authorizeUrl);
    lastNonce = authorize.searchParams.get("nonce") ?? "";
    mock.googleClaims = (nonce) => ({ iss: "https://accounts.google.com", aud: "google-client", sub: "g-victim", email: "victim@example.com", email_verified: true, name: "V", exp: Math.floor(Date.now() / 1000) + 600, nonce });
    const cb = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    cb.searchParams.set("code", "good-code");
    cb.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    const html = await (await f.platform.fetch(new Request(`http://localhost${cb.pathname}${cb.search}`))).text();
    expect(html).toContain("Only continue if you started this just now");
    // The victim has no code to type, so every guess fails and the attempt locks after five.
    let last = html;
    for (let i = 0; i < 5; i++) last = await (await submitConfirm(f, last, `GUESS${i}`)).text();
    expect(last).toContain("Too many wrong codes");
    const poll = await f.call("POST", "/oauth/poll", f.publicKeyStr, { codeVerifier: attacker.verifier });
    expect(poll.status).toBe(202);
    // No account was created for the victim either.
    const victim = await f.platform.fetch(new Request(`http://localhost${f.base}/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", "x-vellum-api-key": f.publicKeyStr }, body: JSON.stringify({ email: "victim@example.com", password: "x" }) }));
    expect(victim.status).toBeGreaterThanOrEqual(400);
  });

  it("attack: link CSRF. A victim's Google account is not attached to the attacker's account unless the code is entered", async () => {
    const f = await fixture();
    const signUp = (await (await f.call("POST", "/sign-up/email", f.publicKeyStr, { email: "attacker@example.com", password: "First-pass-1234!" })).json()) as { accessToken: string };
    const authed = (method: string, url: string, body?: unknown) =>
      f.platform.fetch(new Request(`http://localhost${f.base}${url}`, {
        method,
        headers: { "content-type": "application/json", "x-vellum-api-key": f.publicKeyStr, authorization: `Bearer ${signUp.accessToken}` },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }));
    const { challenge } = pkce();
    const res = await authed("POST", "/oauth/google/start", { delivery: "poll", codeChallenge: challenge, link: true, currentPassword: "First-pass-1234!" });
    const authorize = new URL(((await res.json()) as { authorizeUrl: string }).authorizeUrl);
    lastNonce = authorize.searchParams.get("nonce") ?? "";
    mock.googleClaims = (nonce) => ({ iss: "https://accounts.google.com", aud: "google-client", sub: "g-victim-2", email: "victim2@example.com", email_verified: true, name: "V", exp: Math.floor(Date.now() / 1000) + 600, nonce });
    const cb = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    cb.searchParams.set("code", "good-code");
    cb.searchParams.set("state", authorize.searchParams.get("state") ?? "");
    const html = await (await f.platform.fetch(new Request(`http://localhost${cb.pathname}${cb.search}`))).text();
    expect(html).toContain("Link your google account");
    await submitConfirm(f, html, "WRONG1");
    const ids = (await (await authed("GET", "/identities")).json()) as { identities: { provider: string }[] };
    expect(ids.identities.map((i) => i.provider)).toEqual(["password"]);
  });

  it("confirmation code: stable, 6 symbols, tolerant of case and dashes, and a tampered ticket is refused", async () => {
    const { confirmationCode, codesMatch } = await import("../../auth/oauth/config.js");
    const code = confirmationCode("c".repeat(43));
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(confirmationCode("c".repeat(43))).toBe(code);
    expect(code).toBe("C9F58F"); // shared test vector with vellum_flutter
    expect(confirmationCode("d".repeat(43))).not.toBe(code);
    expect(codesMatch(` ${code.slice(0, 3).toLowerCase()}-${code.slice(3)} `, code)).toBe(true);
    expect(codesMatch(code + "A", code)).toBe(false);
    expect(codesMatch("", code)).toBe(false);
    const f = await fixture();
    const bad = await f.platform.fetch(new Request(`http://localhost${f.base}/oauth/confirm`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ticket: "AAAA", code }) }));
    expect(await bad.text()).toContain("expired");
  });
});
