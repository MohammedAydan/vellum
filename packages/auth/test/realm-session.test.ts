import { describe, expect, it } from "vitest";
import {
  createInMemoryRevocationStore,
} from "@vellum/authorization";
import {
  createRealmSessionService,
  realmConfig,
  type AuthRealm,
} from "../src/index.js";

const revocationStore = createInMemoryRevocationStore();

function serviceFor(realm: AuthRealm, secret = `test-secret-for-${realm}-0123456789`) {
  return createRealmSessionService({ realm, secret, revocationStore });
}

const input = {
  sub: "user-1",
  uid: "user-1",
  role: "owner" as const,
  orgIds: ["org-1"],
};

describe("@vellum/auth / realm session service", () => {
  it("exposes the locked typ/iss/aud per realm", () => {
    expect(realmConfig("super_admin")).toEqual({
      realm: "super_admin",
      typ: "vellum+superadmin+jwt",
      issuer: "vellum:control-plane:super-admin",
      audience: "vellum-super-admin",
    });
    expect(realmConfig("customer_console")).toEqual({
      realm: "customer_console",
      typ: "vellum+console+jwt",
      issuer: "vellum:control-plane:console",
      audience: "vellum-customer-console",
    });
  });

  it("signs realm-bound HS256 access tokens and returns the realm claims", () => {
    const console = serviceFor("customer_console");
    const token = console.signAccess(input);
    const [headerB64] = token.split(".") as [string];
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    expect(header).toEqual({ alg: "HS256", typ: "vellum+console+jwt" });

    const claims = console.verifyAccess(token);
    expect(claims).toMatchObject({
      typ: "access",
      realm: "customer_console",
      iss: "vellum:control-plane:console",
      aud: "vellum-customer-console",
      sub: "user-1",
      uid: "user-1",
      role: "owner",
      orgIds: ["org-1"],
    });
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("rejects a token from the other realm even with the same secret", () => {
    const secret = "shared-test-secret-0123456789";
    const console = serviceFor("customer_console", secret);
    const admin = serviceFor("super_admin", secret);

    const consoleToken = console.signAccess(input);
    expect(() => admin.verifyAccess(consoleToken)).toThrow();

    const adminToken = admin.signAccess(input);
    expect(() => console.verifyAccess(adminToken)).toThrow();
  });

  it("rejects a wrong header typ, wrong token type, and expired tokens", () => {
    const console = serviceFor("customer_console");
    const token = console.signAccess(input);
    const [headerB64, payloadB64, sigB64] = token.split(".") as [string, string, string];

    const wrongHeader = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "vellum+superadmin+jwt" })
    ).toString("base64url");
    expect(() => console.verifyAccess(`${wrongHeader}.${payloadB64}.${sigB64}`)).toThrow();

    expect(() => console.verifyRefresh(token)).toThrow();

    const expired = console.signAccess(input, -1);
    expect(() => console.verifyAccess(expired)).toThrow();
  });

  it("round-trips refresh tokens with realm checks and mirrors revocation", async () => {
    const admin = serviceFor("super_admin");
    const refresh = admin.signRefresh("user-1");
    const claims = admin.verifyRefresh(refresh);
    expect(claims).toMatchObject({
      typ: "refresh",
      realm: "super_admin",
      sub: "user-1",
    });
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);

    const access = admin.signAccess(input);
    const accessClaims = admin.verifyAccess(access);
    await admin.revoke(accessClaims.jti, accessClaims.exp * 1000);
    expect(await admin.isRevoked(accessClaims.jti)).toBe(true);
    expect(() => admin.verifyAccess(access)).toThrow();
  });
});
