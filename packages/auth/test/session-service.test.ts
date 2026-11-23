import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataPlaneStore } from "@vellum/storage/adapters";
import {
  generateEd25519KeyPair,
  createAuthSessionService,
  REFRESH_GRACE_WINDOW_MS,
  type ProjectAuthConfig,
} from "../src/index.js";
import { verifyEndUserAccessToken } from "../src/crypto/jwt.js";

const MASTER = "test-master-key-0123456789abcdef";
const ctx = {
  projectId: "11111111-1111-4111-8111-111111111111",
};

const CANONICAL_ISSUER = `https://api.vellum.dev/v1/projects/${ctx.projectId}/auth`;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function makeConfig(): ProjectAuthConfig {
  const keys = generateEd25519KeyPair(MASTER);
  return {
    id: "33333333-3333-4333-8333-333333333333",
    projectId: ctx.projectId,
    authServiceSuspended: false,
    suspensionReason: null,
    maxUsersQuota: 50000,
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
    jwtKeyId: keys.keyId,
    jwtPublicKeyPem: keys.publicKeyPem,
    jwtPrivateKeyEncrypted: keys.privateKeyEncrypted,
    oauthProviders: {},
    customSmtpConfigEncrypted: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeService() {
  const storage = new DataPlaneStore();
  const config = makeConfig();
  const service = createAuthSessionService(storage, {
    getConfig: () => config,
    masterKey: MASTER,
  });
  return { storage, config, service };
}

describe("@vellum/auth / session service", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues a verifiable access token with the canonical issuer and jti", async () => {
    const { storage, config, service } = makeService();
    const user = await storage.createAuthUser(ctx, { email: "user@example.com" });
    const issued = await service.issue({ ctx, user });

    const payload = verifyEndUserAccessToken(issued.accessToken, config.jwtPublicKeyPem, {
      projectId: ctx.projectId,
      issuer: CANONICAL_ISSUER,
    });
    expect(payload.sub).toBe(user.id);
    expect(payload.email).toBe("user@example.com");
    expect(payload.iss).toBe(CANONICAL_ISSUER);
    expect(payload.jti).toEqual(expect.any(String));
  });

  it("normal rotation stores the previous refresh-token hash", async () => {
    const { storage, service } = makeService();
    const user = await storage.createAuthUser(ctx, { email: "rotate@example.com" });
    const issued = await service.issue({ ctx, user });
    const rotated = await service.refresh(ctx, issued.refreshToken);

    expect(rotated.refreshToken).not.toBe(issued.refreshToken);
    expect(rotated.sessionId).toBe(issued.sessionId);
    const session = await storage.getAuthSessionByTokenHash(ctx, sha256(rotated.refreshToken));
    expect(session).not.toBeNull();
    expect(session?.refreshTokenHash).toBe(sha256(rotated.refreshToken));
    expect(session?.previousRefreshTokenHash).toBe(sha256(issued.refreshToken));
    expect(session?.rotatedAt).not.toBeNull();
  });

  it("replays a previous token WITHIN the grace window with a fresh session and no revocation", async () => {
    const { storage, service } = makeService();
    const user = await storage.createAuthUser(ctx, { email: "grace@example.com" });
    const first = await service.issue({ ctx, user });
    const rotated = await service.refresh(ctx, first.refreshToken);

    // Immediate replay is inside REFRESH_GRACE_WINDOW_MS — concurrent tabs.
    const fresh = await service.refresh(ctx, first.refreshToken);
    expect(fresh.refreshToken).not.toBe(first.refreshToken);
    expect(fresh.refreshToken).not.toBe(rotated.refreshToken);
    expect(fresh.sessionId).not.toBe(first.sessionId);

    const sessions = await storage.listUserSessions(ctx, user.id);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => !s.revoked)).toBe(true);
    // The still-current successor of the normal rotation remains usable.
    const rotatedCanary = await service.refresh(ctx, rotated.refreshToken);
    expect(rotatedCanary.accessToken).toEqual(expect.any(String));
  });

  it("revokes ALL sessions when a previous token is replayed OUTSIDE the grace window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { storage, service } = makeService();
    const user = await storage.createAuthUser(ctx, { email: "replay@example.com" });
    const first = await service.issue({ ctx, user });
    const second = await service.issue({ ctx, user });
    const rotated = await service.refresh(ctx, first.refreshToken);

    // Advance just beyond the grace window so the replay is treated as theft.
    vi.advanceTimersByTime(REFRESH_GRACE_WINDOW_MS + 1_000);

    await expect(service.refresh(ctx, first.refreshToken)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      message: expect.stringContaining("reuse detected"),
    });
    const sessions = await storage.listUserSessions(ctx, user.id);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.revoked)).toBe(true);
    expect(sessions.every((s) => s.revokedReason === "refresh_token_replay_detected")).toBe(true);
    // The still-fresh successor is revoked too, so it can no longer be used.
    await expect(service.refresh(ctx, rotated.refreshToken)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(service.refresh(ctx, second.refreshToken)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
});
