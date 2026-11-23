/**
 * @vellum/api - Customer Authentication REST Routes (`apps/api/src/routes/auth-endpoints.ts`)
 * Provides real authentication backed by controlStore (PostgreSQL):
 *   - POST /v1/auth/sign-up/email
 *   - POST /v1/auth/sign-in/email
 *   - GET  /v1/auth/session
 *   - POST /v1/auth/sign-out
 */

import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { VellumError } from "@vellum/core";
import { getApiKeyHeader } from "../middleware/tenant-auth.js";
import { constantTimeEqual, extractClientIp } from "../middleware/security.js";
import { invalidateUserOrgMembershipsCache } from "../middleware/session.js";
import { getQueryPool } from "./usage.js";

function getOrganizationMembersMap(store: object): Map<string, unknown> | null {
  if ("organizationMembers" in store && store.organizationMembers instanceof Map) {
    return store.organizationMembers;
  }
  return null;
}
import {
  generateProjectApiKey,
  signEndUserJwt,
  verifyEndUserJwtSync,
  type Role,
  type SessionService,
} from "@vellum/authorization";
import type {
  ControlAuthRealm,
  ControlPlaneRepository,
  ControlRefreshSessionRecord,
  UserRecord,
} from "@vellum/database-control";

/**
 * Issue a token the rest of the platform actually accepts. The console/admin
 * middleware verifies `SessionClaims` (typ=access, jti, orgIds) via
 * `SessionService`, while the legacy `signEndUserJwt` shape is kept only for
 * callers that construct auth routes without a session service.
 */
function issueSessionToken(
  sessionService: SessionService | undefined,
  jwtSecret: string,
  input: { id: string; email: string; name: string; role: unknown; orgIds: string[] }
): string {
  const role: Role =
    input.role === "owner" || input.role === "admin" || input.role === "support_readonly"
      ? input.role
      : "customer";
  if (sessionService) {
    return sessionService.signAccess({
      sub: input.id,
      uid: input.id,
      role,
      orgIds: input.orgIds,
    });
  }
  return signEndUserJwt(
    {
      sub: input.id,
      uid: input.id,
      email: input.email,
      name: input.name,
      role,
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    },
    jwtSecret
  );
}

/* -------------------------------------------------------------------------- */
/* Control-plane refresh sessions (console + super-admin realms, contract §8)  */
/* -------------------------------------------------------------------------- */

/**
 * A control-plane realm's refresh-cookie identity. Each realm uses a distinct
 * name and a strict `Path`, so a cookie issued for one console can never be
 * read by the other even though both consoles share a browser origin.
 */
export interface RefreshCookieDescriptor {
  /** Cookie name for this realm. */
  name: string;
  /** Strict cookie Path for this realm. */
  path: string;
}

/** Customer Dashboard console refresh cookie. */
export const CONSOLE_REFRESH_COOKIE: Readonly<RefreshCookieDescriptor> = {
  name: "vellum_console_rt",
  path: "/v1/console/auth",
};

/** Platform Super Admin console refresh cookie. */
export const ADMIN_REFRESH_COOKIE: Readonly<RefreshCookieDescriptor> = {
  name: "vellum_admin_rt",
  path: "/v1/admin/auth",
};

/**
 * @deprecated Historical single-realm cookie name. Kept only for symbol
 * compatibility; all callers must pass an explicit `RefreshCookieDescriptor`.
 */
export const REFRESH_COOKIE_NAME = "vellum_refresh_token";
/** 30 days — matches the cookie `Max-Age` and the stored refresh expiry. */
export const CONTROL_REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const CONTROL_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Opaque, high-entropy refresh token. Only its SHA-256 hash is ever stored. */
export function newControlRefreshToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Coerce a stored `platformRole` string into the locked realm Role union. */
export function toControlRole(value: unknown): Role {
  return value === "owner" || value === "admin" || value === "support_readonly"
    ? value
    : "customer";
}

/** Read `exp` (seconds) from a compact JWT payload without verifying it. */
function parseJwtExpSeconds(token: string): number | null {
  try {
    const parts = token.split(".");
    const payloadPart = parts[1];
    if (!payloadPart) return null;
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}

export interface ControlSessionTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  cookie: string;
}

/** Serialize the HttpOnly refresh cookie (Secure only in production). */
export function buildRefreshCookie(token: string, descriptor: RefreshCookieDescriptor): string {
  const secure = process.env["NODE_ENV"] === "production" ? "; Secure" : "";
  return `${descriptor.name}=${token}; Path=${descriptor.path}; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;
}

export function setRefreshCookie(
  c: Context,
  token: string,
  descriptor: RefreshCookieDescriptor
): void {
  c.header("Set-Cookie", buildRefreshCookie(token, descriptor));
}

/**
 * Read the refresh token from either the JSON body or this realm's own HttpOnly
 * cookie. The descriptor's cookie name is the only one ever consulted — the
 * other realm's cookie is deliberately invisible here.
 */
export function readControlRefreshToken(
  c: Context,
  body: Record<string, unknown>,
  descriptor: RefreshCookieDescriptor
): string | null {
  const fromBody = body["refreshToken"];
  return (
    (typeof fromBody === "string" ? fromBody : null) ??
    getCookie(c, descriptor.name) ??
    null
  );
}

/**
 * Build a fresh access/refresh pair for a control-plane realm. The access
 * expiry comes from the JWT `exp` claim when present, otherwise from a 15 min
 * fallback; the refresh expiry is always now + 30 days.
 */
export function issueControlTokens(
  accessToken: string,
  descriptor: RefreshCookieDescriptor,
  nowMs: number = Date.now()
): ControlSessionTokens {
  const refreshToken = newControlRefreshToken();
  const expSeconds = parseJwtExpSeconds(accessToken);
  const accessExpiresAt = new Date(
    expSeconds !== null ? expSeconds * 1000 : nowMs + CONTROL_ACCESS_TOKEN_TTL_MS
  ).toISOString();
  const refreshExpiresAt = new Date(nowMs + CONTROL_REFRESH_TOKEN_TTL_MS).toISOString();
  return {
    accessToken,
    refreshToken,
    accessTokenHash: sha256Hex(accessToken),
    refreshTokenHash: sha256Hex(refreshToken),
    accessExpiresAt,
    refreshExpiresAt,
    cookie: buildRefreshCookie(refreshToken, descriptor),
  };
}

/** Concurrent control-plane refresh tabs may replay the previous token this long after rotation. */
export const CONTROL_REFRESH_GRACE_WINDOW_MS = 15_000;

export interface RefreshControlSessionOptions {
  controlStore: ControlPlaneRepository;
  realm: ControlAuthRealm;
  /** Which realm's cookie name/path to read and rotate. */
  cookieDescriptor: RefreshCookieDescriptor;
  /** Raw refresh token from the JSON body or the HttpOnly cookie. */
  rawRefreshToken: string | null | undefined;
  /** Mint a realm-bound access token for the given user. */
  signAccess: (user: UserRecord) => string | Promise<string>;
  /** Super-admin refresh additionally requires platform super-admin privileges. */
  requireSuperAdmin?: boolean;
  nowMs?: number;
}

async function loadRefreshUser(
  controlStore: ControlPlaneRepository,
  userId: string,
  requireSuperAdmin: boolean
): Promise<UserRecord> {
  const user = controlStore.users.get(userId);
  if (!user || user.isSuspended) {
    throw new VellumError("UNAUTHENTICATED", "User is disabled or no longer exists");
  }
  if (requireSuperAdmin && !(await controlStore.isPlatformSuperAdmin(userId))) {
    throw new VellumError("PERMISSION_DENIED", "Platform Super Admin privileges required");
  }
  return user;
}

function assertRefreshRealm(realm: ControlAuthRealm, expected: ControlAuthRealm): void {
  if (realm !== expected) {
    throw new VellumError("UNAUTHENTICATED", "Refresh token realm mismatch");
  }
}

/** Issue a brand-new control session for a benign concurrent-tab refresh. */
async function issueConcurrentControlSession(
  opts: RefreshControlSessionOptions,
  session: ControlRefreshSessionRecord,
  nowMs: number
): Promise<RefreshedControlSession> {
  const user = await loadRefreshUser(opts.controlStore, session.userId, Boolean(opts.requireSuperAdmin));
  const accessToken = await opts.signAccess(user);
  const fresh = issueControlTokens(accessToken, opts.cookieDescriptor, nowMs);
  await opts.controlStore.createControlRefreshSession({
    userId: user.id,
    realm: opts.realm,
    accessTokenHash: fresh.accessTokenHash,
    refreshTokenHash: fresh.refreshTokenHash,
    accessExpiresAt: fresh.accessExpiresAt,
    refreshExpiresAt: fresh.refreshExpiresAt,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
  });
  return { ...fresh, user };
}

/**
 * Durable control-plane refresh rotation with a 15 s concurrency grace window
 * (SECURITY-HARDENING-CONTRACT §7/§8). A previous hash inside the window gets a
 * brand-new session without revocation; outside it the user's realm sessions
 * are revoked and the caller is rejected.
 */
export interface RefreshedControlSession extends ControlSessionTokens {
  user: UserRecord;
}

export async function refreshControlSession(
  opts: RefreshControlSessionOptions
): Promise<RefreshedControlSession> {
  const nowMs = opts.nowMs ?? Date.now();
  if (!opts.rawRefreshToken) {
    throw new VellumError("UNAUTHENTICATED", "Missing refresh token");
  }
  const hash = sha256Hex(opts.rawRefreshToken);

  // Case B FIRST — the previous hash may also be returned by the current-hash
  // lookup, so the replay outcome must be decided before normal rotation.
  const previous = await opts.controlStore.getControlRefreshSessionByPreviousHash(hash);
  if (previous && previous.previousRefreshTokenHash && constantTimeEqual(previous.previousRefreshTokenHash, hash)) {
    assertRefreshRealm(previous.realm, opts.realm);
    const rotatedAtMs = previous.rotatedAt ? Date.parse(previous.rotatedAt) : 0;
    const within = nowMs - rotatedAtMs <= CONTROL_REFRESH_GRACE_WINDOW_MS;
    if (!within) {
      await opts.controlStore.revokeControlRefreshSessionsForUser(
        previous.userId,
        "refresh_token_replay_detected",
        opts.realm
      );
      throw new VellumError(
        "UNAUTHENTICATED",
        "Refresh token reuse detected. All sessions revoked."
      );
    }
    return issueConcurrentControlSession(opts, previous, nowMs);
  }

  // Case A — the current token: single-use rotation.
  const session = await opts.controlStore.getControlRefreshSessionByHash(hash);
  if (!session || !constantTimeEqual(session.refreshTokenHash, hash)) {
    throw new VellumError("UNAUTHENTICATED", "Unknown refresh token");
  }
  assertRefreshRealm(session.realm, opts.realm);
  if (session.revoked || Date.parse(session.refreshExpiresAt) <= nowMs) {
    throw new VellumError("UNAUTHENTICATED", "Refresh token is revoked or expired");
  }
  const user = await loadRefreshUser(opts.controlStore, session.userId, Boolean(opts.requireSuperAdmin));
  const accessToken = await opts.signAccess(user);
  const rotated = issueControlTokens(accessToken, opts.cookieDescriptor, nowMs);
  try {
    await opts.controlStore.rotateControlRefreshSession(
      session.id,
      hash,
      rotated.accessTokenHash,
      rotated.refreshTokenHash,
      rotated.accessExpiresAt,
      rotated.refreshExpiresAt
    );
  } catch {
    // Another tab rotated this exact token between our read and our conditional
    // write. Within the grace window that is a benign parallel refresh, not a replay.
    const raced = await opts.controlStore.getControlRefreshSessionByPreviousHash(hash);
    if (raced && raced.previousRefreshTokenHash && constantTimeEqual(raced.previousRefreshTokenHash, hash)) {
      assertRefreshRealm(raced.realm, opts.realm);
      const rotatedAtMs = raced.rotatedAt ? Date.parse(raced.rotatedAt) : nowMs;
      if (nowMs - rotatedAtMs <= CONTROL_REFRESH_GRACE_WINDOW_MS) {
        return issueConcurrentControlSession(opts, raced, nowMs);
      }
    }
    throw new VellumError("UNAUTHENTICATED", "Session rotation failed");
  }
  return { ...rotated, user };
}

const SCRYPT_PREFIX = "scrypt";
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_COST = 16_384; // 2^14, r=8, p=1 (≈16 MiB)

/** Asynchronous scrypt with explicit N=2^14, r=8, p=1 parameters. */
function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      { N: SCRYPT_COST, r: 8, p: 1 },
      (err: NodeJS.ErrnoException | null, derived: Buffer) => {
        if (err) reject(err);
        else resolve(derived);
      }
    );
  });
}

const pbkdf2Async = promisify(crypto.pbkdf2);

/** In-memory fallback password store for testing / hermetic mode. */
const inMemoryPasswords = new Map<string, string>();

/**
 * password hashing is asynchronous scrypt (N=2^14, r=8, p=1).
 * Format: `scrypt$<saltHex>$<hashHex>`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt);
  return `${SCRYPT_PREFIX}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Verify a password against a stored hash. Supports the new scrypt format and
 * the legacy `<salt>:<pbkdf2Hash>` format (verified asynchronously) so existing
 * accounts can be migrated without a synchronous PBKDF2 code path.
 */
export async function verifyPassword(password: string, combinedHash: string): Promise<boolean> {
  try {
    if (typeof combinedHash !== "string") return false;

    if (combinedHash.startsWith(`${SCRYPT_PREFIX}$`)) {
      const [, saltHex, hashHex] = combinedHash.split("$");
      if (!saltHex || !hashHex) return false;
      const derived = await scrypt(password, Buffer.from(saltHex, "hex"));
      const expected = Buffer.from(hashHex, "hex");
      return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
    }

    // Legacy PBKDF2 migration path — kept asynchronous.
    if (/^[0-9a-f]+:[0-9a-f]+$/i.test(combinedHash)) {
      const [saltHex, hashHex] = combinedHash.split(":");
      if (!saltHex || !hashHex) return false;
      const derived = (await pbkdf2Async(password, saltHex, 100_000, 64, "sha512")) as Buffer;
      const expected = Buffer.from(hashHex, "hex");
      return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
    }

    return false;
  } catch {
    return false;
  }
}

export interface CustomerAuthRouteOptions {
  apiKeyPepper?: string;
  jwtSecret?: string;
  sessionService?: SessionService;
}

export function createCustomerAuthRoutes(
  controlStore: ControlPlaneRepository,
  options: CustomerAuthRouteOptions = {}
) {
  const routes = new Hono();
  const jwtSecret = options.jwtSecret ?? process.env["JWT_SECRET"] ?? "vellum_jwt_secret_v1";
  const sessionService = options.sessionService;

  // Helper to extract actor metadata for audit logs
  function getActorMetadata(c: Context) {
    return {
      ipAddress: extractClientIp(c),
      userAgent: c.req.header("user-agent") || "VellumClient/2.0",
    };
  }

  // 1. Sign Up
  routes.post("/auth/sign-up/email", async (c) => {
    const body = await c.req.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || !email.includes("@")) {
      throw new VellumError("INVALID_ARGUMENT", "Please enter a valid email address");
    }
    if (!name && (typeof body.displayName === "string" || getApiKeyHeader(c))) {
      // An end-user SDK request (displayName and/or a project API key) landed on
      // the Customer Console tier. Say so instead of a misleading name error.
      throw new VellumError(
        "INVALID_ARGUMENT",
        "This is the Customer Console sign-up endpoint, not the end-user one. End-user sign-up is POST /v1/projects/{projectId}/auth/sign-up/email. Check the SDK baseUrl/endpoint and projectId configuration.",
        { guardCode: "WRONG_AUTH_TIER" }
      );
    }
    if (!name || name.length < 2) {
      throw new VellumError("INVALID_ARGUMENT", "Name must be at least 2 characters");
    }
    if (!password || password.length < 6) {
      throw new VellumError("INVALID_ARGUMENT", "Password must be at least 6 characters");
    }

    // Check if user already exists
    const allUsers = Array.from(controlStore.users.values());
    const existing = allUsers.find((u) => u.email.toLowerCase() === email);
    if (existing) {
      throw new VellumError("ALREADY_EXISTS", "An account with this email address already exists");
    }

    // Create User Record
    const user = await controlStore.createUser({
      name,
      email,
      platformRole: "customer",
      emailVerified: true,
    });

    // Save Password Hash (async scrypt)
    const pwdHash = await hashPassword(password);
    inMemoryPasswords.set(user.id, pwdHash);
    const pgPool = getQueryPool(controlStore);
    if (pgPool) {
      await pgPool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [pwdHash, user.id]);
    }

    // Create Default Organization for User
    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").slice(0, 20) || "org";
    const orgSlug = `${baseSlug}-${Date.now().toString(36).slice(-5)}`;
    const org = await controlStore.createOrganization({
      name: `${name}'s Organization`,
      slug: orgSlug,
      billingEmail: email,
      planId: "free",
    });

    // Add User as Owner in Organization
    if (pgPool) {
      await pgPool.query(
        "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [org.id, user.id, "owner"]
      );
      invalidateUserOrgMembershipsCache(user.id);
    }
    const organizationMembers = getOrganizationMembersMap(controlStore);
    if (organizationMembers) {
      organizationMembers.set(`${org.id}:${user.id}`, {
        organizationId: org.id,
        userId: user.id,
        role: "owner",
        joinedAt: new Date().toISOString(),
      });
    }

    // Create the default project for the new organization.
    const { project } = await controlStore.createProject({
      organizationId: org.id,
      name: "Default Project",
      slug: "default",
    });

    // Register a default server key scoped to the project.
    const generated = generateProjectApiKey({
      keyType: "server",
      pepper: options.apiKeyPepper,
    });
    const apiKey = await controlStore.registerApiKey({
      projectId: project.id,
      name: "Default Server Key",
      keyType: "server",
      keyPrefix: generated.keyPrefix,
      secretHash: generated.secretHash,
    });

    const meta = getActorMetadata(c);
    await controlStore.recordAuditLog({
      action: "user.signed_up",
      targetId: user.id,
      actorType: "customer",
      actorUserId: user.id,
      organizationId: org.id,
      projectId: project.id,
      metadata: { email, name, organizationId: org.id, projectId: project.id },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    const token = issueSessionToken(sessionService, jwtSecret, {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.platformRole,
      orgIds: [org.id],
    });
    const tokens = issueControlTokens(token, CONSOLE_REFRESH_COOKIE);
    await controlStore.createControlRefreshSession({
      userId: user.id,
      realm: "customer_console",
      accessTokenHash: tokens.accessTokenHash,
      refreshTokenHash: tokens.refreshTokenHash,
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    setRefreshCookie(c, tokens.refreshToken, CONSOLE_REFRESH_COOKIE);
    return c.json(
      {
        success: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          platformRole: user.platformRole,
        },
        token,
        accessToken: token,
        refreshToken: tokens.refreshToken,
        organization: org,
        project,
        apiKey: apiKey ? { id: apiKey.id, keyPrefix: apiKey.keyPrefix } : null,
        expiresAt: tokens.accessExpiresAt,
      },
      201
    );
  });

  // 2. Sign In
  routes.post("/auth/sign-in/email", async (c) => {
    const body = await c.req.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || !password) {
      throw new VellumError("INVALID_ARGUMENT", "Email and password are required");
    }

    const pgPool = getQueryPool(controlStore);
    const allUsers = Array.from(controlStore.users.values());
    let user = allUsers.find((u) => u.email.toLowerCase() === email);

    // If not in cache, check database directly
    if (!user && pgPool) {
      const dbRes = await pgPool.query(
        `SELECT id, email, name, platform_role AS "platformRole", is_suspended AS "isSuspended"
         FROM users WHERE LOWER(email) = $1`,
        [email]
      );
      const row = dbRes.rows[0];
      if (row && typeof row["id"] === "string" && typeof row["email"] === "string") {
        user = {
          id: row["id"],
          email: row["email"],
          name: typeof row["name"] === "string" ? row["name"] : "",
          platformRole: typeof row["platformRole"] === "string" ? row["platformRole"] : "customer",
          isSuspended: Boolean(row["isSuspended"]),
        } as (typeof allUsers)[number];
      }
    }

    if (!user) {
      throw new VellumError("UNAUTHENTICATED", "Invalid email or password");
    }

    if (user.isSuspended) {
      throw new VellumError("PERMISSION_DENIED", "Your account has been suspended by administration");
    }

    // Verify Password — no hash means authentication fails; the
    // previous "first login sets the password" backdoor has been removed.
    let storedHash = inMemoryPasswords.get(user.id);
    if (!storedHash && pgPool) {
      const pwdRes = await pgPool.query("SELECT password_hash FROM users WHERE id = $1", [user.id]);
      const value = pwdRes.rows[0]?.["password_hash"];
      storedHash = typeof value === "string" ? value : undefined;
    }
    if (!storedHash || !(await verifyPassword(password, storedHash))) {
      throw new VellumError("UNAUTHENTICATED", "Invalid email or password");
    }

    // Ensure user has at least one organization
    const orgs = Array.from(controlStore.organizations.values());
    const organizationMembers = getOrganizationMembersMap(controlStore);
    let userOrg = organizationMembers
      ? orgs.find((o) => organizationMembers.has(`${o.id}:${user!.id}`))
      : null;

    if (!userOrg && pgPool) {
      const orgDbRes = await pgPool.query(
        `SELECT o.id, o.slug, o.name FROM organizations o
         JOIN organization_members m ON o.id = m.organization_id
         WHERE m.user_id = $1`,
        [user.id]
      );
      const row = orgDbRes.rows[0];
      if (row && typeof row["id"] === "string") {
        userOrg = {
          id: row["id"],
          slug: typeof row["slug"] === "string" ? row["slug"] : "",
          name: typeof row["name"] === "string" ? row["name"] : "",
        } as (typeof orgs)[number];
      }
    }

    if (!userOrg) {
      const baseSlug = user.name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").slice(0, 20) || "org";
      const orgSlug = `${baseSlug}-${Date.now().toString(36).slice(-5)}`;
      userOrg = await controlStore.createOrganization({
        name: `${user.name}'s Organization`,
        slug: orgSlug,
        billingEmail: user.email,
        planId: "free",
      });

      if (pgPool) {
        await pgPool.query(
          "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
          [userOrg.id, user.id, "owner"]
        );
        invalidateUserOrgMembershipsCache(user.id);
      }
      if (organizationMembers) {
        organizationMembers.set(`${userOrg.id}:${user.id}`, {
          organizationId: userOrg.id,
          userId: user.id,
          role: "owner",
          joinedAt: new Date().toISOString(),
        });
      }

      await controlStore.createProject({
        organizationId: userOrg.id,
        name: "Default Project",
        slug: "default",
      });
    }

    const token = issueSessionToken(sessionService, jwtSecret, {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.platformRole,
      orgIds: userOrg ? [userOrg.id] : [],
    });
    const meta = getActorMetadata(c);
    const tokens = issueControlTokens(token, CONSOLE_REFRESH_COOKIE);
    await controlStore.createControlRefreshSession({
      userId: user.id,
      realm: "customer_console",
      accessTokenHash: tokens.accessTokenHash,
      refreshTokenHash: tokens.refreshTokenHash,
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    setRefreshCookie(c, tokens.refreshToken, CONSOLE_REFRESH_COOKIE);
    return c.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        platformRole: user.platformRole,
      },
      token,
      accessToken: token,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.accessExpiresAt,
    });
  });

  // 3. Get Session — verify the presented token instead of always
  // reporting `valid: true` for any Bearer string.
  routes.get("/auth/session", (c) => {
    const authHeader = c.req.header("authorization");
    if (!authHeader) {
      return c.json({ session: null });
    }
    const raw = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();
    let verified: { uid: string | null; claims: Record<string, unknown> };
    if (sessionService) {
      // Console tokens are realm-bound HS256 JWTs signed by the console
      // session service — never verify them with the legacy end-user secret.
      try {
        const claims = sessionService.verifyAccess(raw);
        verified = {
          uid: claims.uid,
          claims: { ...claims },
        };
      } catch {
        throw new VellumError("UNAUTHENTICATED", "Invalid or expired session token");
      }
    } else {
      try {
        verified = verifyEndUserJwtSync(raw, jwtSecret);
      } catch {
        throw new VellumError("UNAUTHENTICATED", "Invalid or expired session token");
      }
    }
    const exp = verified.claims["exp"];
    return c.json({
      session: {
        valid: true,
        uid: verified.uid,
        claims: verified.claims,
        expiresAt:
          typeof exp === "number" ? new Date(exp * 1000).toISOString() : new Date().toISOString(),
      },
    });
  });

  // 4. Sign Out — revoke a session refresh jti when one is presented.
  routes.post("/auth/sign-out", async (c) => {
    const authHeader = c.req.header("authorization");
    if (sessionService && authHeader) {
      const raw = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();
      try {
        const refresh = sessionService.verifyRefresh(raw);
        await sessionService.revoke(refresh.jti, refresh.exp * 1000);
      } catch {
        // End-user JWTs are stateless; a missing refresh token is a no-op.
      }
    }
    return c.json({ success: true, message: "Signed out successfully" });
  });

  return routes;
}
