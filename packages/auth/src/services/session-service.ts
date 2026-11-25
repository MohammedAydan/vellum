/**
 * End-user session service with refresh-token rotation and replay detection.
 *
 * Refresh tokens are opaque 32-byte values; only their SHA-256 hashes are stored
 * in data_db. A rotated token keeps its predecessor in
 * `previous_refresh_token_hash`. If that predecessor is presented again within
 * `REFRESH_GRACE_WINDOW_MS` of the rotation, it is treated as a concurrent tab
 * and a brand-new session is issued (no revocation). Outside that window it is
 * a replay: ALL sessions for that user are revoked and the caller gets
 * UNAUTHENTICATED.
 */

import crypto from "node:crypto";
import { VellumError } from "@vellum/core";
import type {
  AuthUserRecord,
  StorageAdapter,
  TenantContext,
} from "@vellum/storage";
import {
  decryptPrivateKey,
  signEndUserAccessToken,
  type EndUserJwtPayload,
} from "../crypto/jwt.js";
import type { ProjectAuthConfig } from "../config-types.js";

export interface AuthCryptoDeps {
  getConfig(projectId: string): ProjectAuthConfig | null | Promise<ProjectAuthConfig | null>;
  masterKey?: string | undefined;
  issuer?: string | undefined;
}

export interface IssueSessionInput {
  ctx: TenantContext;
  user: AuthUserRecord;
  userAgent?: string | null | undefined;
  ipAddress?: string | null | undefined;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  sessionId: string;
  tokenType: "Bearer";
}

export interface AuthSessionService {
  issue(input: IssueSessionInput): Promise<IssuedSession>;
  refresh(ctx: TenantContext, rawRefreshToken: string): Promise<IssuedSession>;
  revoke(ctx: TenantContext, rawRefreshToken: string): Promise<void>;
}

/** Concurrent refresh tabs may replay the previous token for this long after rotation. */
export const REFRESH_GRACE_WINDOW_MS = 15_000;

const MAX_REFRESH_TOKEN_LENGTH = 512;
const PRIVATE_KEY_CACHE_MAX = 64;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function timingSafeHashEqual(a: string | null | undefined, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function newRefreshToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function createAuthSessionService(
  storage: StorageAdapter,
  deps: AuthCryptoDeps
): AuthSessionService {
  /** Bounded cache for decrypted Ed25519 signing keys per encrypted key blob. */
  const privateKeyCache = new Map<string, crypto.KeyObject>();

  async function configFor(ctx: TenantContext): Promise<ProjectAuthConfig> {
    const config = await deps.getConfig(ctx.projectId);
    if (!config) {
      throw new VellumError("SERVICE_UNAVAILABLE", "End-user auth is not configured for this project");
    }
    return config;
  }

  function privateKeyFor(config: ProjectAuthConfig): crypto.KeyObject {
    const cacheKey = `${config.jwtKeyId}:${config.jwtPrivateKeyEncrypted}`;
    const cached = privateKeyCache.get(cacheKey);
    if (cached !== undefined) {
      privateKeyCache.delete(cacheKey);
      privateKeyCache.set(cacheKey, cached);
      return cached;
    }
    const key = decryptPrivateKey(config.jwtPrivateKeyEncrypted, deps.masterKey);
    if (privateKeyCache.size >= PRIVATE_KEY_CACHE_MAX) {
      const oldest = privateKeyCache.keys().next();
      if (oldest.done !== true) privateKeyCache.delete(oldest.value);
    }
    privateKeyCache.set(cacheKey, key);
    return key;
  }

  async function mint(ctx: TenantContext, user: AuthUserRecord, config: ProjectAuthConfig, sessionId: string) {
    const now = Math.floor(Date.now() / 1000);
    const accessTtl =
      Number.isFinite(config.accessTokenTtlSeconds) && config.accessTokenTtlSeconds > 0
        ? Math.floor(config.accessTokenTtlSeconds)
        : 3600;
    const payload: EndUserJwtPayload = {
      iss:
        deps.issuer ??
        `https://api.vellum.dev/v1/projects/${ctx.projectId}/auth`,
      sub: user.id,
      jti: crypto.randomUUID(),
      aud: ctx.projectId,
      email: user.email,
      email_verified: user.emailVerified,
      is_anonymous: user.isAnonymous,
      claims: user.customClaims,
      iat: now,
      exp: now + accessTtl,
      auth_time: now,
      sid: sessionId,
    };
    return signEndUserAccessToken(payload, privateKeyFor(config), config.jwtKeyId);
  }

  async function issue(input: IssueSessionInput): Promise<IssuedSession> {
    const config = await configFor(input.ctx);
    const rawRefreshToken = newRefreshToken();
    const refreshHash = sha256(rawRefreshToken);
    const refreshDays =
      Number.isFinite(config.refreshTokenTtlDays) && config.refreshTokenTtlDays > 0
        ? config.refreshTokenTtlDays
        : 30;
    const refreshMs = refreshDays * 24 * 3600 * 1000;
    const expiresAt = new Date(Date.now() + refreshMs).toISOString();
    const session = await storage.createAuthSession(input.ctx, {
      userId: input.user.id,
      refreshTokenHash: refreshHash,
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
      expiresAt,
    });
    const accessToken = await mint(input.ctx, input.user, config, session.id);
    return {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresAt,
      sessionId: session.id,
      tokenType: "Bearer",
    };
  }

  /** Issue a brand-new session for a benign concurrent-tab refresh (no revocation). */
  async function issueConcurrentSession(
    ctx: TenantContext,
    session: Awaited<ReturnType<StorageAdapter["getAuthSessionByTokenHash"]>> & object
  ): Promise<IssuedSession> {
    const user = await storage.getAuthUserById(ctx, session.userId);
    if (!user || user.isDisabled) {
      throw new VellumError("UNAUTHENTICATED", "User is disabled or no longer exists");
    }
    return issue({
      ctx,
      user,
      userAgent: session.userAgent,
      ipAddress: session.ipAddress,
    });
  }

  async function refresh(ctx: TenantContext, rawRefreshToken: string): Promise<IssuedSession> {
    if (
      typeof rawRefreshToken !== "string" ||
      rawRefreshToken.length === 0 ||
      rawRefreshToken.length > MAX_REFRESH_TOKEN_LENGTH
    ) {
      throw new VellumError("UNAUTHENTICATED", "Unknown refresh token");
    }
    const hash = sha256(rawRefreshToken);
    const session = await storage.getAuthSessionByTokenHash(ctx, hash);
    if (!session) {
      throw new VellumError("UNAUTHENTICATED", "Unknown refresh token");
    }

    // Case B FIRST: the storage lookup matches either the current or the
    // previous hash. A previous hash inside the grace window is a concurrent
    // tab (not a replay) and gets a brand-new session without revocation.
    // Outside the window it is a replay and every session is revoked.
    if (timingSafeHashEqual(session.previousRefreshTokenHash, hash)) {
      // A revoked (signed-out, admin-revoked) or expired session must not be
      // resurrected through its previous token, even inside the grace window.
      const sessionExpiresMs = Date.parse(session.expiresAt);
      if (session.revoked || !Number.isFinite(sessionExpiresMs) || sessionExpiresMs <= Date.now()) {
        throw new VellumError("UNAUTHENTICATED", "Refresh token is revoked or expired");
      }
      const rotatedAtMs = session.rotatedAt ? Date.parse(session.rotatedAt) : Number.NaN;
      const elapsed = Date.now() - rotatedAtMs;
      const within = Number.isFinite(rotatedAtMs) && elapsed >= -5_000 && elapsed <= REFRESH_GRACE_WINDOW_MS;
      if (!within) {
        await storage.revokeAllUserSessions(ctx, session.userId, "refresh_token_replay_detected");
        throw new VellumError(
          "UNAUTHENTICATED",
          "Refresh token reuse detected. All sessions revoked."
        );
      }
      return issueConcurrentSession(ctx, session);
    }

    // Case A: the current token — normal single-use rotation.
    if (!timingSafeHashEqual(session.refreshTokenHash, hash)) {
      throw new VellumError("UNAUTHENTICATED", "Unknown refresh token");
    }
    const expiresAtMs = Date.parse(session.expiresAt);
    if (session.revoked || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new VellumError("UNAUTHENTICATED", "Refresh token is revoked or expired");
    }
    const user = await storage.getAuthUserById(ctx, session.userId);
    if (!user || user.isDisabled) {
      throw new VellumError("UNAUTHENTICATED", "User is disabled or no longer exists");
    }
    const config = await configFor(ctx);
    const newToken = newRefreshToken();
    const newHash = sha256(newToken);
    const refreshDays =
      Number.isFinite(config.refreshTokenTtlDays) && config.refreshTokenTtlDays > 0
        ? config.refreshTokenTtlDays
        : 30;
    const expiresAt = new Date(Date.now() + refreshDays * 24 * 3600 * 1000).toISOString();
    try {
      await storage.rotateAuthSession(ctx, session.id, hash, newHash, expiresAt);
    } catch {
      // A parallel tab may have rotated this exact token between our read and
      // our conditional write. Re-read inside the grace window: a token that is
      // now the previous hash is a benign concurrent refresh, not a replay.
      const raced = await storage.getAuthSessionByTokenHash(ctx, hash);
      if (raced && timingSafeHashEqual(raced.previousRefreshTokenHash, hash)) {
        const rotatedAtMs = raced.rotatedAt ? Date.parse(raced.rotatedAt) : Date.now();
        const elapsed = Date.now() - rotatedAtMs;
        if (Number.isFinite(rotatedAtMs) && elapsed >= -5_000 && elapsed <= REFRESH_GRACE_WINDOW_MS) {
          return issueConcurrentSession(ctx, raced);
        }
      }
      throw new VellumError("UNAUTHENTICATED", "Session rotation failed");
    }
    const accessToken = await mint(ctx, user, config, session.id);
    return {
      accessToken,
      refreshToken: newToken,
      expiresAt,
      sessionId: session.id,
      tokenType: "Bearer",
    };
  }

  async function revoke(ctx: TenantContext, rawRefreshToken: string): Promise<void> {
    if (
      typeof rawRefreshToken !== "string" ||
      rawRefreshToken.length === 0 ||
      rawRefreshToken.length > MAX_REFRESH_TOKEN_LENGTH
    ) {
      return;
    }
    const hash = sha256(rawRefreshToken);
    const session = await storage.getAuthSessionByTokenHash(ctx, hash);
    if (session) await storage.revokeAuthSession(ctx, session.id, "signed_out");
  }

  return { issue, refresh, revoke };
}
