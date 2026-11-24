/**
 * @vellum/api - Customer Admin Auth REST tier
 *
 * Mounted at `/v1/projects/:projectId/auth/admin`.
 * Access requires either a customer/operator session with project access or a
 * valid secret (`sk_`) server API key. No password hash, token hash, encrypted
 * secret, or customer document payload is ever serialized by these routes.
 */

import { Hono, type Context } from "hono";
import { VellumError } from "@vellum/core";
import { DocumentProjector, hashPassword } from "@vellum/auth";
import {
  AdminCreateUserRequestSchema,
  AdminImportUsersRequestSchema,
  AdminListUsersQuerySchema,
  AdminPatchUserRequestSchema,
  AdminRevokeSessionsRequestSchema,
  AdminSetClaimsRequestSchema,
  AuthConfigPatchSchema,
} from "@vellum/api-contract";
import { verifyApiKeyAsync } from "@vellum/authorization";
import type { ListAuthUsersOptions, UpdateAuthUserInput } from "@vellum/storage";
import type { Role } from "@vellum/authorization";
import type { VellumPlatformContext } from "../app.js";
import { assertProjectAccess, extractBearerToken } from "../middleware/session.js";
import { getApiKeyHeader, resolveIsAdminServer } from "../middleware/tenant-auth.js";
import {
  applyAuthConfigPatch,
  ensureAuthConfig,
  optionalJsonBody,
  parseOrThrow,
  publicAuthConfig,
  publicSession,
  publicUser,
  requireProjectApiKey,
  resolveAuthTenant,
  type AuthTenant,
} from "./auth-shared.js";

const CUSTOMER_ADMIN_ROLES: readonly Role[] = ["customer", "owner", "admin", "support_readonly"];

export function createAuthCustomerAdminRoutes(platform: VellumPlatformContext): Hono {
  const routes = new Hono();
  const storage = platform.dataStore;
  const projector = new DocumentProjector(platform.documentEngine);

  // A valid `sk_` key OR a session is required before any handler runs.
  routes.use("*", async (c, next) => {
    const rawKey = getApiKeyHeader(c);
    if (rawKey) {
      const record = await verifyApiKeyAsync(rawKey, platform.controlStore, platform.apiKeyPepper);
      if (!resolveIsAdminServer(record)) {
        throw new VellumError("PERMISSION_DENIED", "A secret (sk_) server API key is required for admin access");
      }
      await next();
      return;
    }
    // The Super Admin Auth Control Center reads end-user counts through this
    // tier. Accept either console or super-admin realm sessions; both are
    // operator-level and neither exposes customer document payloads.
    const token = extractBearerToken(c.req.header("authorization"));
    if (!token) {
      throw new VellumError("UNAUTHENTICATED", "Missing session Bearer token");
    }
    let claims;
    try {
      claims = platform.consoleSessionService.verifyAccess(token);
    } catch {
      try {
        claims = platform.superAdminSessionService.verifyAccess(token);
      } catch {
        throw new VellumError("UNAUTHENTICATED", "Invalid, expired, or revoked session token");
      }
    }
    if (!CUSTOMER_ADMIN_ROLES.includes(claims.role)) {
      throw new VellumError("PERMISSION_DENIED", "Your session role is not permitted for this operation");
    }
    c.set("session", claims);
    await next();
  });

  /** Project binding + org membership for session callers. */
  async function authorize(c: Context, tenant: AuthTenant, write: boolean): Promise<void> {
    if (getApiKeyHeader(c)) {
      await requireProjectApiKey(c, platform, tenant, { serverOnly: true });
      return;
    }
    const claims = c.get("session");
    if (!claims) {
      throw new VellumError("UNAUTHENTICATED", "Missing session credentials");
    }
    await assertProjectAccess(platform.controlStore, claims, tenant.projectId, { write });
  }

  async function projectNewUser(tenant: AuthTenant, userId: string): Promise<void> {
    const config = await ensureAuthConfig(platform, tenant.projectId);
    if (!config.enableUserProjection) return;
    const user = await storage.getAuthUserById(tenant.ctx, userId);
    if (user) await projector.project(tenant.ctx, user, config.projectionCollectionPath);
  }

  // ------------------------------------------------------------------ DIRECTORY

  routes.get("/users", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    await authorize(c, tenant, false);
    const query = parseOrThrow(AdminListUsersQuerySchema, c.req.query());
    const options: ListAuthUsersOptions = {
      limit: query.limit,
      cursor: query.cursor,
      search: query.search,
      isDisabled: query.isDisabled,
      isAnonymous: query.isAnonymous,
      emailVerified: query.emailVerified,
    };
    const page = await storage.listAuthUsers(tenant.ctx, options);
    return c.json({ ...page, users: page.users.map(publicUser) });
  });

  routes.post("/users", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    await authorize(c, tenant, true);
    const body = parseOrThrow(AdminCreateUserRequestSchema, await c.req.json());
    if (body.email) {
      const collision = await storage.getAuthUserByEmail(tenant.ctx, body.email);
      if (collision) {
        throw new VellumError("ALREADY_EXISTS", "An end-user with this email already exists");
      }
    }
    const user = await storage.createAuthUser(tenant.ctx, {
      email: body.email ?? null,
      emailVerified: body.emailVerified ?? false,
      passwordHash: body.password ? await hashPassword(body.password) : null,
      displayName: body.displayName ?? null,
      photoUrl: body.photoUrl ?? null,
      phoneNumber: body.phoneNumber ?? null,
      phoneVerified: body.phoneVerified ?? false,
      isDisabled: body.isDisabled ?? false,
      isAnonymous: body.isAnonymous ?? false,
      customClaims: body.customClaims ?? {},
      metadata: body.metadata ?? {},
    });
    await projectNewUser(tenant, user.id);
    return c.json({ user: publicUser(user) }, 201);
  });

  routes.get("/users/:uid", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    await authorize(c, tenant, false);
    const uid = c.req.param("uid");
    const user = await storage.getAuthUserById(tenant.ctx, uid);
    if (!user) throw new VellumError("NOT_FOUND", "End-user not found");
    const [identities, sessions, mfa] = await Promise.all([
      storage.listUserIdentities(tenant.ctx, uid),
      storage.listUserSessions(tenant.ctx, uid),
      storage.getAuthMfa(tenant.ctx, uid),
    ]);
    return c.json({
      user: publicUser(user),
      identities: identities.map((identity) => ({
        id: identity.id,
        provider: identity.provider,
        providerUserId: identity.providerUserId,
        lastSignInAt: identity.lastSignInAt,
        createdAt: identity.createdAt,
      })),
      sessions: sessions.map(publicSession),
      mfa: {
        enabled: mfa?.verified ?? false,
        factorType: mfa?.factorType ?? null,
        enrolledAt: mfa?.createdAt ?? null,
      },
    });
  });

  routes.patch("/users/:uid", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    await authorize(c, tenant, true);
    const uid = c.req.param("uid");
    const body = parseOrThrow(AdminPatchUserRequestSchema, await c.req.json());
    const patch: UpdateAuthUserInput = {};
    if (body.email !== undefined) patch.email = body.email;
    if (body.emailVerified !== undefined) patch.emailVerified = body.emailVerified;
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.photoUrl !== undefined) patch.photoUrl = body.photoUrl;
    if (body.phoneNumber !== undefined) patch.phoneNumber = body.phoneNumber;
    if (body.phoneVerified !== undefined) patch.phoneVerified = body.phoneVerified;
    if (body.isDisabled !== undefined) patch.isDisabled = body.isDisabled;
    if (body.isAnonymous !== undefined) patch.isAnonymous = body.isAnonymous;
    if (body.customClaims !== undefined) patch.customClaims = body.customClaims;
    if (body.metadata !== undefined) patch.metadata = body.metadata;
    if (body.lastSignInAt !== undefined) patch.lastSignInAt = body.lastSignInAt;
    if (body.password !== undefined) patch.passwordHash = await hashPassword(body.password);
    const updated = await storage.updateAuthUser(tenant.ctx, uid, patch);
    // Keep the projected `users/{uid}` document in sync with every admin edit.
    await projectNewUser(tenant, uid);
    return c.json({ user: publicUser(updated) });
  });

  routes.delete("/users/:uid", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    await authorize(c, tenant, true);
    const deleted = await storage.deleteAuthUser(tenant.ctx, c.req.param("uid"));
    if (!deleted) throw new VellumError("NOT_FOUND", "End-user not found");
    return c.json({ deleted: true });
  });

  routes.put("/users/:uid/claims", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    await authorize(c, tenant, true);
    const body = parseOrThrow(AdminSetClaimsRequestSchema, await c.req.json());
    if (Buffer.byteLength(JSON.stringify(body.claims), "utf8") > 1000) {
      throw new VellumError("INVALID_ARGUMENT", "Custom claims must not exceed 1000 bytes");
    }
    const uid = c.req.param("uid");
    const updated = await storage.updateAuthUser(tenant.ctx, uid, {
      customClaims: body.claims,
    });
    // Claim grants must be visible in the projected user document as well as
    // in freshly minted JWTs — merge preserves developer-authored fields.
    await projectNewUser(tenant, uid);
    return c.json({ user: publicUser(updated) });
  });

  routes.post("/users/:uid/revoke", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    await authorize(c, tenant, true);
    const body = parseOrThrow(AdminRevokeSessionsRequestSchema, await optionalJsonBody(c));
    const revoked = await storage.revokeAllUserSessions(
      tenant.ctx,
      c.req.param("uid"),
      body.reason ?? "admin_revocation"
    );
    return c.json({ revoked });
  });

  routes.post("/users:import", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    await authorize(c, tenant, true);
    const body = parseOrThrow(AdminImportUsersRequestSchema, await c.req.json());
    const created = [];
    for (const input of body.users) {
      const user = await storage.createAuthUser(tenant.ctx, {
        email: input.email ?? null,
        emailVerified: input.emailVerified ?? false,
        passwordHash: input.password ? await hashPassword(input.password) : null,
        displayName: input.displayName ?? null,
        photoUrl: input.photoUrl ?? null,
        phoneNumber: input.phoneNumber ?? null,
        phoneVerified: input.phoneVerified ?? false,
        isDisabled: input.isDisabled ?? false,
        isAnonymous: input.isAnonymous ?? false,
        customClaims: input.customClaims ?? {},
        metadata: input.metadata ?? {},
      });
      await projectNewUser(tenant, user.id);
      created.push(publicUser(user));
    }
    return c.json({ count: created.length, users: created }, 201);
  });

  // --------------------------------------------------------------------- CONFIG

  routes.get("/config", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    await authorize(c, tenant, false);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    return c.json(publicAuthConfig(config));
  });

  routes.patch("/config", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    await authorize(c, tenant, true);
    const body = parseOrThrow(AuthConfigPatchSchema, await c.req.json());
    const existing = await ensureAuthConfig(platform, tenant.projectId);
    const updated = await platform.controlStore.upsertAuthConfig(
      applyAuthConfigPatch(existing, body)
    );
    return c.json(publicAuthConfig(updated));
  });

  return routes;
}
