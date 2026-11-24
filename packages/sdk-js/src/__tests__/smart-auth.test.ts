import { describe, expect, it } from "vitest";
import { createClient } from "../index.js";

function makeJwt(payload: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  return `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}
const exp = (secs: number): number => Math.floor(Date.now() / 1000) + secs;
const USER = { id: "usr_1", email: "a@example.com", emailVerified: true, createdAt: "2026-11-01T00:00:00.000Z" };
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const session = (access: string, refresh: string) => ({
  user: USER, accessToken: access, refreshToken: refresh, tokenType: "Bearer", sessionId: "s", expiresAt: "2026-11-24T00:00:00.000Z",
});

describe("smart auth", () => {
  it("5 parallel requests with an expired token trigger exactly one refresh and all succeed", async () => {
    // Valid-looking token the server rejects (revoked/rotated): only the 401 path can detect it.
    const stale = makeJwt({ sub: "usr_1", exp: exp(3600) });
    const fresh = makeJwt({ sub: "usr_1", exp: exp(7200) });
    let refreshCalls = 0;
    const seen: string[] = [];
    const db = createClient({
      projectId: "p",
      apiKey: "pk_test",
      maxRetries: 0,
      customFetch: (async (input, init) => {
        const url = String(input);
        if (url.endsWith("/auth/sign-up/email")) return json(session(stale, "r1"));
        if (url.endsWith("/auth/token/refresh")) {
          refreshCalls += 1;
          await new Promise((r) => setTimeout(r, 20));
          return json(session(fresh, "r2"));
        }
        const auth = (init?.headers as Record<string, string>)["authorization"] ?? "";
        seen.push(auth);
        if (auth !== `Bearer ${fresh}`) return json({ error: { code: "UNAUTHENTICATED", message: "expired" } }, 401);
        const id = url.split("/documents/")[1]?.split("?")[0] ?? "";
        return json({ path: decodeURIComponent(id), documentId: id.split("%2F").pop(), version: 1, data: { ok: true } });
      }) as typeof fetch,
    });
    await db.signUpWithEmailAndPassword({ email: "a@example.com", password: "password123" });
    const snaps = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => db.collection("posts").doc(`p${n}`).get({ bypassCache: true })),
    );
    expect(refreshCalls).toBe(1);
    expect(snaps.every((s) => s.exists)).toBe(true);
    expect(seen.filter((a) => a === `Bearer ${fresh}`)).toHaveLength(5);
  });

  it("setCustomToken overrides the session bearer and null removes it", async () => {
    const custom = makeJwt({ sub: "ext", exp: exp(3600) });
    const sent: string[] = [];
    const db = createClient({
      projectId: "p",
      apiKey: "pk_test",
      customFetch: (async (_i, init) => {
        sent.push((init?.headers as Record<string, string>)["authorization"] ?? "");
        return json({ path: "posts/a", documentId: "a", version: 1, data: {} });
      }) as typeof fetch,
    });
    db.setCustomToken(custom);
    await db.collection("posts").doc("a").get({ bypassCache: true });
    expect(sent.at(-1)).toBe(`Bearer ${custom}`);
    db.setCustomToken(null);
    await db.collection("posts").doc("a").get({ bypassCache: true });
    expect(sent.at(-1)).not.toBe(`Bearer ${custom}`);
  });

  it("autoRefresh:false skips silent refresh but explicit getIdToken(true) still refreshes", async () => {
    const soon = makeJwt({ sub: "usr_1", exp: exp(20) });
    const fresh = makeJwt({ sub: "usr_1", exp: exp(7200) });
    let refreshCalls = 0;
    const db = createClient({
      projectId: "p",
      apiKey: "pk_test",
      autoRefresh: false,
      customFetch: (async (input) => {
        const url = String(input);
        if (url.endsWith("/auth/sign-up/email")) return json(session(soon, "r1"));
        if (url.endsWith("/auth/token/refresh")) {
          refreshCalls += 1;
          return json(session(fresh, "r2"));
        }
        return json({});
      }) as typeof fetch,
    });
    await db.signUpWithEmailAndPassword({ email: "a@example.com", password: "password123" });
    expect(await db.getIdToken()).toBe(soon);
    expect(refreshCalls).toBe(0);
    expect(await db.getIdToken(true)).toBe(fresh);
    expect(refreshCalls).toBe(1);
  });
});
