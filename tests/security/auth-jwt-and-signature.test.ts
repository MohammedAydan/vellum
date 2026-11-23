/**
 * tests/security/auth-jwt-and-signature
 *
 * Hermetic (no DB, no network) security checks for end-user auth primitives:
 *   1. A tampered Ed25519 access token is rejected.
 *   2. A token with the wrong audience (project) or issuer is rejected.
 *   3. An expired access token is rejected.
 *   4. An expired or already-consumed action token cannot be consumed again.
 *   5. Refresh-token replay is detected and revokes ALL sessions (memory adapter).
 *
 * Only node:crypto and in-memory structures are used. No secrets are logged.
 */
import { describe, expect, it } from "vitest";
import {
  createAuthSessionService,
  decryptPrivateKey,
  generateEd25519KeyPair,
  signEndUserAccessToken,
  verifyEndUserAccessToken,
  type EndUserJwtPayload,
} from "@vellum/auth";
import { DataPlaneStore } from "@vellum/storage/adapters";
import type { ProjectAuthConfig } from "@vellum/database-control";

const MASTER_KEY = "auth-jwt-security-test-master-key-0123456789abcdef";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ISSUER = `https://api.vellum.dev/v1/projects/${PROJECT_ID}/auth`;

function makePayload(overrides: Partial<EndUserJwtPayload> = {}): EndUserJwtPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    jti: "jwt-test-jti",
    sub: "usr-auth-jwt-test",
    aud: PROJECT_ID,
    email: "signer@example.com",
    email_verified: true,
    is_anonymous: false,
    claims: { role: "reader" },
    iat: now,
    exp: now + 3600,
    auth_time: now,
    ...overrides,
  };
}

function makeConfig(pair: ReturnType<typeof generateEd25519KeyPair>): ProjectAuthConfig {
  const now = new Date().toISOString();
  return {
    id: "33333333-3333-4333-8333-333333333333",
    projectId: PROJECT_ID,
    authServiceSuspended: false,
    suspensionReason: null,
    maxUsersQuota: 1000,
    maxSignupsPerHour: 1000,
    enableEmailPassword: true,
    requireEmailVerification: false,
    enableAnonymousAuth: false,
    enableTotpMfa: true,
    enableUserProjection: true,
    projectionCollectionPath: "users",
    passwordMinLength: 8,
    passwordRequireUppercase: false,
    passwordRequireNumber: true,
    passwordRequireSymbol: false,
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlDays: 30,
    jwtKeyId: pair.keyId,
    jwtPublicKeyPem: pair.publicKeyPem,
    jwtPrivateKeyEncrypted: pair.privateKeyEncrypted,
    oauthProviders: {},
    customSmtpConfigEncrypted: null,
    createdAt: now,
    updatedAt: now,
  };
}

function expectUnauthenticated(fn: () => unknown, label: string): void {
  let message = "";
  try {
    fn();
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message, `${label} must throw`).not.toBe("");
}

describe("tests/security/auth-jwt-and-signature", () => {
  const pair = generateEd25519KeyPair(MASTER_KEY);
  const privateKey = decryptPrivateKey(pair.privateKeyEncrypted, MASTER_KEY);
  const expected = { projectId: PROJECT_ID, issuer: ISSUER };

  it("accepts a correctly signed Ed25519 access token", () => {
    const token = signEndUserAccessToken(makePayload(), privateKey, pair.keyId);
    const verified = verifyEndUserAccessToken(token, pair.publicKeyPem, expected);
    expect(verified.sub).toBe("usr-auth-jwt-test");
    expect(verified.claims).toMatchObject({ role: "reader" });
  });

  it("rejects a tampered signature and a tampered payload", () => {
    const token = signEndUserAccessToken(makePayload(), privateKey, pair.keyId);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);

    // Flip a byte in the signature segment — verification must fail.
    const sig = parts[2] ?? "";
    const flippedChar = sig[0] === "A" ? "B" : "A";
    const badSig = `${flippedChar}${sig.slice(1)}`;
    expectUnauthenticated(
      () => verifyEndUserAccessToken([parts[0], parts[1], badSig].join("."), pair.publicKeyPem, expected),
      "tampered signature"
    );

    // Keep the signature but change the subject in the payload segment.
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as EndUserJwtPayload;
    const forgedPayload = Buffer.from(JSON.stringify({ ...payload, sub: "attacker" })).toString("base64url");
    expectUnauthenticated(
      () => verifyEndUserAccessToken([parts[0], forgedPayload, parts[2]].join("."), pair.publicKeyPem, expected),
      "tampered payload"
    );
  });

  it("rejects tokens with the wrong audience/project", () => {
    const token = signEndUserAccessToken(makePayload(), privateKey, pair.keyId);
    let msg = "";
    try {
      verifyEndUserAccessToken(token, pair.publicKeyPem, {
        projectId: "99999999-9999-4999-8999-999999999999",
        issuer: ISSUER,
      });
    } catch (error: unknown) {
      msg = error instanceof Error ? error.message : String(error);
    }
    expect(msg).toMatch(/mismatch/i);
  });

  it("rejects an expired access token and a token with a mismatched issuer", () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = signEndUserAccessToken(
      makePayload({ exp: now - 10, iat: now - 3700, auth_time: now - 3700 }),
      privateKey,
      pair.keyId
    );
    let msg = "";
    try {
      verifyEndUserAccessToken(expired, pair.publicKeyPem, expected);
    } catch (error: unknown) {
      msg = error instanceof Error ? error.message : String(error);
    }
    expect(msg).toMatch(/expired/i);

    const wrongIssuer = signEndUserAccessToken(
      makePayload({ iss: "https://evil.example.com/issuer" }),
      privateKey,
      pair.keyId
    );
    msg = "";
    try {
      verifyEndUserAccessToken(wrongIssuer, pair.publicKeyPem, expected);
    } catch (error: unknown) {
      msg = error instanceof Error ? error.message : String(error);
    }
    expect(msg).toMatch(/issuer/i);
  });

  it("refuses to consume expired or already-consumed action tokens", async () => {
    const storage = new DataPlaneStore();
    const ctx = { projectId: PROJECT_ID };
    const user = await storage.createAuthUser(ctx, { email: `${MASTER_KEY.slice(0, 6)}@example.com` });

    await storage.saveAuthToken(ctx, {
      userId: user.id,
      tokenHash: "hash-expired",
      tokenType: "password_reset",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await expect(storage.consumeAuthToken(ctx, "hash-expired", "password_reset")).rejects.toThrow(/expired/i);

    await storage.saveAuthToken(ctx, {
      userId: user.id,
      tokenHash: "hash-single-use",
      tokenType: "email_verification",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const consumed = await storage.consumeAuthToken(ctx, "hash-single-use", "email_verification");
    expect(consumed.consumedAt).toBeTruthy();
    await expect(storage.consumeAuthToken(ctx, "hash-single-use", "email_verification")).rejects.toThrow(
      /invalid or expired/i
    );

    // A token of the wrong type must never satisfy a different token type.
    await expect(storage.consumeAuthToken(ctx, "hash-single-use", "password_reset")).rejects.toThrow();
  });

  it("detects refresh-token replay and revokes every session for the user", async () => {
    const storage = new DataPlaneStore();
    const ctx = { projectId: PROJECT_ID };
    const config = makeConfig(pair);
    const service = createAuthSessionService(storage, {
      getConfig: () => config,
      masterKey: MASTER_KEY,
    });
    const user = await storage.createAuthUser(ctx, { email: `${MASTER_KEY.slice(6, 12)}@example.com` });

    const session1 = await service.issue({ ctx, user });
    const session2 = await service.issue({ ctx, user });
    expect(await storage.listUserSessions(ctx, user.id)).toHaveLength(2);

    // Rotation succeeds and keeps the same session id, but changes the token.
    const rotated = await service.refresh(ctx, session1.refreshToken);
    expect(rotated.refreshToken).not.toBe(session1.refreshToken);
    expect(rotated.sessionId).toBe(session1.sessionId);

    // The 15s grace window treats an immediate previous-token reuse as a
    // concurrent tab. Move `rotatedAt` outside that window so this is a true
    // replay and must revoke every session for the user.
    // The memory store keys sessions by `<project>:<id>`, not by raw id.
    const rotatedSession = Array.from(storage.authMemory.sessions.values()).find(
      (s) => s.id === session1.sessionId
    );
    expect(rotatedSession).toBeDefined();
    if (rotatedSession) {
      rotatedSession.rotatedAt = new Date(Date.now() - 60_000).toISOString();
    }

    // Replaying the consumed (previous) refresh token is rejected.
    let replayMessage = "";
    try {
      await service.refresh(ctx, session1.refreshToken);
    } catch (error: unknown) {
      replayMessage = error instanceof Error ? error.message : String(error);
    }
    // Actual message: "Refresh token reuse detected. All sessions revoked."
    expect(replayMessage).toMatch(/reuse|replay/i);

    const sessions = await storage.listUserSessions(ctx, user.id);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.revoked)).toBe(true);
    expect(sessions.every((s) => s.revokedReason === "refresh_token_replay_detected")).toBe(true);

    // The freshly rotated token is now revoked too — a second refresh fails.
    await expect(service.refresh(ctx, rotated.refreshToken)).rejects.toThrow();
  });
});
