import crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import { Hono, type Context } from "hono";
import { VellumError } from "@vellum/core";
import { signEndUserAccessToken, type EndUserJwtPayload } from "@vellum/auth";
import {
  API_KEY_HEADERS,
  USER_TOKEN_HEADERS,
  getApiKeyHeader,
  getUserTokenHeader,
  resolveEndUserAuth,
  resolveIsAdminServer,
} from "../middleware/tenant-auth.js";
import type { VellumPlatformContext } from "../app.js";

type HeaderSnapshot = {
  apiKey: string | undefined;
  userToken: string | undefined;
};

async function probeHeaders(headers: Record<string, string>): Promise<HeaderSnapshot> {
  const app = new Hono();
  let snapshot: HeaderSnapshot = { apiKey: undefined, userToken: undefined };
  app.get("/probe/:projectId", (c: Context) => {
    snapshot = {
      apiKey: getApiKeyHeader(c),
      userToken: getUserTokenHeader(c),
    };
    return c.json({ ok: true });
  });
  await app.fetch(
    new Request("http://localhost/probe/proj_1", {
      headers,
    })
  );
  return snapshot;
}

describe("tenant-auth header helpers", () => {
  it("declares canonical and legacy header names in priority order", () => {
    expect(API_KEY_HEADERS).toEqual(["x-vellum-api-key", "x-project-key"]);
    expect(USER_TOKEN_HEADERS).toEqual(["authorization", "x-vellum-user-token"]);
  });

  it("returns the first non-empty API key header and strips Bearer", async () => {
    expect(await probeHeaders({ "x-vellum-api-key": "pk_abc", "x-project-key": "pk_old" })).toEqual({
      apiKey: "pk_abc",
      userToken: undefined,
    });
    expect(await probeHeaders({ "x-project-key": "pk_legacy" })).toEqual({
      apiKey: "pk_legacy",
      userToken: undefined,
    });
    expect(await probeHeaders({ "x-vellum-api-key": "Bearer pk_abc" })).toEqual({
      apiKey: "pk_abc",
      userToken: undefined,
    });
    expect(await probeHeaders({ "x-vellum-api-key": "", "x-project-key": "pk_fallback" })).toEqual({
      apiKey: "pk_fallback",
      userToken: undefined,
    });
    expect(await probeHeaders({})).toEqual({ apiKey: undefined, userToken: undefined });
  });

  it("reads the bearer JWT and the raw user-token alias", async () => {
    expect(await probeHeaders({ authorization: "Bearer eyJhbGciOi..." })).toEqual({
      apiKey: undefined,
      userToken: "eyJhbGciOi...",
    });
    expect(await probeHeaders({ "x-vellum-user-token": "raw.token.value" })).toEqual({
      apiKey: undefined,
      userToken: "raw.token.value",
    });
    expect(await probeHeaders({ authorization: "Bearer primary", "x-vellum-user-token": "secondary" })).toEqual({
      apiKey: undefined,
      userToken: "primary",
    });
  });

  it("resolves server-key admin status and anonymous contexts", async () => {
    expect(resolveIsAdminServer({ keyType: "server" })).toBe(true);
    expect(resolveIsAdminServer({ keyType: "public" })).toBe(false);
    expect(resolveIsAdminServer({})).toBe(false);

    const app = new Hono();
    let resolved: Awaited<ReturnType<typeof resolveEndUserAuth>> | undefined;
    app.get("/probe/:projectId", async (c: Context) => {
      resolved = await resolveEndUserAuth(c, {} as VellumPlatformContext);
      return c.json({ ok: true });
    });
    await app.fetch(new Request("http://localhost/probe/proj_1"));
    expect(resolved).toEqual({ uid: null, claims: {} });
  });

  describe("EdDSA-only end-user verification", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const config = {
      projectId: "proj_1",
      jwtKeyId: "kid_1",
      jwtPublicKeyPem: publicKeyPem,
      jwtPrivateKeyEncrypted: "encrypted",
    };
    const platform: VellumPlatformContext = Object.assign({} as VellumPlatformContext, {
      controlStore: Object.assign({} as VellumPlatformContext["controlStore"], {
        getAuthConfig: () => config,
        getAuthConfigAsync: async () => config,
        upsertAuthConfig: async () => config,
      }),
    });

    async function resolveWith(token: string): Promise<{
      result: Awaited<ReturnType<typeof resolveEndUserAuth>> | undefined;
      error: unknown;
    }> {
      const app = new Hono();
      let result: Awaited<ReturnType<typeof resolveEndUserAuth>> | undefined;
      let error: unknown;
      app.get("/probe/:projectId", async (c: Context) => {
        try {
          result = await resolveEndUserAuth(c, platform);
        } catch (err) {
          error = err;
        }
        return c.json({ ok: true });
      });
      await app.fetch(
        new Request("http://localhost/probe/proj_1", {
          headers: { authorization: `Bearer ${token}` },
        })
      );
      return { result, error };
    }

    function endUserPayload(): EndUserJwtPayload {
      const now = Math.floor(Date.now() / 1000);
      return {
        iss: "https://api.vellum.dev/v1/projects/proj_1/auth",
        sub: "user-1",
        aud: "proj_1",
        jti: "jti-1",
        email: "user@example.com",
        email_verified: true,
        is_anonymous: false,
        claims: { role: "editor" },
        iat: now,
        exp: now + 300,
        auth_time: now,
      };
    }

    it("verifies a valid EdDSA end-user token against the project config", async () => {
      const token = signEndUserAccessToken(endUserPayload(), privateKey, "kid_1");
      const { result, error } = await resolveWith(token);
      expect(error).toBeUndefined();
      expect(result?.uid).toBe("user-1");
      expect(result?.claims).toEqual({ role: "editor" });
    });

    it("rejects an HS256 console-shaped token with a generic message", async () => {
      const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const hsToken = [
        b64({ alg: "HS256", typ: "vellum+console+jwt" }),
        b64({ typ: "access", realm: "customer_console", sub: "owner-1", uid: "owner-1" }),
        "c2lnbmF0dXJl",
      ].join(".");
      const { result, error } = await resolveWith(hsToken);
      expect(result).toBeUndefined();
      expect(error).toBeInstanceOf(VellumError);
      const vellumError = error as VellumError;
      expect(vellumError.code).toBe("UNAUTHENTICATED");
      expect(vellumError.message).toBe("Invalid end-user access token");
      expect(vellumError.message).not.toContain(hsToken);
    });

    it("preserves TOKEN_EXPIRED so the client can refresh", async () => {
      const expired = signEndUserAccessToken(
        { ...endUserPayload(), exp: Math.floor(Date.now() / 1000) - 10 },
        privateKey,
        "kid_1"
      );
      const { error } = await resolveWith(expired);
      expect(error).toBeInstanceOf(VellumError);
      expect((error as VellumError).code).toBe("TOKEN_EXPIRED");
      expect((error as VellumError).details["retryableWithRefresh"]).toBe(true);
    });
  });
});
