/**
 * @vellum/api - Platform Super-Admin Auth REST tier
 *
 * Mounted at `/v1/admin/auth`. Every route requires an `owner`/`admin`
 * operator session. Only tenant auth metadata (quotas, key ids, settings) is
 * exposed — customer document payloads are never read or rendered here.
 */

import { Hono } from "hono";
import { encryptSecret, generateEd25519KeyPair } from "@vellum/auth";
import { SuperAdminSettingsPatchSchema, AuthConfigPatchSchema } from "@vellum/api-contract";
import type { UpdatePlatformAuthSettingsInput } from "@vellum/database-control";
import type { VellumPlatformContext } from "../app.js";
import { getSession, getUserOrgIds } from "../middleware/session.js";
import { requireSuperAdminSession } from "../middleware/realm-session.js";
import { mapWithConcurrency } from "../middleware/security.js";
import { getApiKeyHeader } from "../middleware/tenant-auth.js";
import {
  applyAuthConfigPatch,
  ensureAuthConfig,
  masterKey,
  parseOrThrow,
  publicAuthConfig,
  requireProjectApiKey,
  resolveAuthTenant,
} from "./auth-shared.js";
import {
  ADMIN_REFRESH_COOKIE,
  readControlRefreshToken,
  refreshControlSession,
  setRefreshCookie,
  toControlRole,
} from "./auth-endpoints.js";

const SUPER_ADMIN_ROLES = ["owner", "admin"] as const;

function publicPlatformSettings(settings: ReturnType<VellumPlatformContext["controlStore"]["getPlatformAuthSettings"]>) {
  return {
    id: settings.id,
    globalSignupsEnabled: settings.globalSignupsEnabled,
    defaultMaxUsersPerFreeProject: settings.defaultMaxUsersPerFreeProject,
    defaultMaxUsersPerProProject: settings.defaultMaxUsersPerProProject,
    platformSmtpHost: settings.platformSmtpHost,
    platformSmtpPort: settings.platformSmtpPort,
    platformSmtpUser: settings.platformSmtpUser,
    platformSmtpFromEmail: settings.platformSmtpFromEmail,
    platformSmtpConfigured: settings.platformSmtpHost !== null,
    // `platformSmtpPassEncrypted` is deliberately omitted; expose presence only.
    hasSmtpConfigured:
      settings.platformSmtpPassEncrypted !== null && settings.platformSmtpPassEncrypted !== "",
    updatedAt: settings.updatedAt,
  };
}

export function createAuthSuperAdminRoutes(platform: VellumPlatformContext): Hono {
  const routes = new Hono();
  // The refresh endpoint is public: it validates the opaque refresh token and
  // the platform super-admin flag itself, so the global guard must not run.
  routes.use(
    "*",
    requireSuperAdminSession(platform, SUPER_ADMIN_ROLES, [
      "/v1/admin/auth/session/refresh",
      "/session/refresh",
    ])
  );

  // ------------------------------------------------------------ SESSION REFRESH

  routes.post("/session/refresh", async (c) => {
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const rawRefreshToken = readControlRefreshToken(c, body, ADMIN_REFRESH_COOKIE);

    const refreshed = await refreshControlSession({
      controlStore: platform.controlStore,
      realm: "super_admin",
      cookieDescriptor: ADMIN_REFRESH_COOKIE,
      rawRefreshToken,
      requireSuperAdmin: true,
      signAccess: async (user) =>
        platform.superAdminSessionService.signAccess({
          sub: user.id,
          uid: user.id,
          role: toControlRole(user.platformRole),
          orgIds: await getUserOrgIds(platform.controlStore, user.id),
        }),
    });
    setRefreshCookie(c, refreshed.refreshToken, ADMIN_REFRESH_COOKIE);
    return c.json({
      token: refreshed.accessToken,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.accessExpiresAt,
      user: {
        id: refreshed.user.id,
        name: refreshed.user.name,
        email: refreshed.user.email,
        platformRole: refreshed.user.platformRole,
      },
    });
  });


  function audit(action: string, c: Parameters<typeof getSession>[0], targetId: string | null, metadata: Record<string, unknown>) {
    const claims = getSession(c);
    return platform.controlStore.recordAuditLog({
      action,
      targetId,
      actorType: "operator",
      actorUserId: claims?.uid ?? null,
      metadata,
    });
  }

  // ------------------------------------------------------------------ OVERVIEW

  routes.get("/overview", async (c) => {
    const configs = platform.controlStore.listAuthConfigs();
    const userCounts = await mapWithConcurrency(configs, 10, (config) =>
      platform.dataStore.countAuthUsers({ projectId: config.projectId })
    );
    const settings = platform.controlStore.getPlatformAuthSettings();
    return c.json({
      projectsWithAuth: configs.length,
      suspendedProjects: configs.filter((config) => config.authServiceSuspended).length,
      totalEndUsers: userCounts.reduce((sum, count) => sum + count, 0),
      globalSignupsEnabled: settings.globalSignupsEnabled,
      generatedAt: new Date().toISOString(),
    });
  });

  routes.get("/projects", async (c) => {
    const configs = platform.controlStore.listAuthConfigs();
    const projects = configs.map((config) => {
      const project = platform.controlStore.projects.get(config.projectId);
      return {
        projectId: config.projectId,
        projectName: project?.name ?? null,
        projectSlug: project?.slug ?? null,
        organizationId: project?.organizationId ?? null,
        projectStatus: project?.status ?? null,
        auth: publicAuthConfig(config),
      };
    });
    return c.json({ projects });
  });

  // ---------------------------------------------------------- PROJECT CONTROL

  routes.patch("/projects/:projectId/control", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    // Super admins act by session; a server key is accepted only when it is
    // bound to the exact same project.
    if (getApiKeyHeader(c)) requireProjectApiKey(c, platform, tenant, { serverOnly: true });
    const existing = await ensureAuthConfig(platform, tenant.projectId);
    const body = parseOrThrow(AuthConfigPatchSchema, await c.req.json());
    const updated = await platform.controlStore.upsertAuthConfig(
      applyAuthConfigPatch(existing, body)
    );
    await audit("auth_config.updated_by_admin", c, tenant.projectId, {
      projectId: tenant.projectId,
      fields: Object.keys(body),
    });
    return c.json(publicAuthConfig(updated));
  });

  routes.post("/projects/:projectId/rotate-signing-key", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    if (getApiKeyHeader(c)) requireProjectApiKey(c, platform, tenant, { serverOnly: true });
    const existing = await ensureAuthConfig(platform, tenant.projectId);
    const pair = generateEd25519KeyPair(masterKey());
    const rotated = await platform.controlStore.upsertAuthConfig({
      ...applyAuthConfigPatch(existing, {}),
      jwtKeyId: pair.keyId,
      jwtPublicKeyPem: pair.publicKeyPem,
      jwtPrivateKeyEncrypted: pair.privateKeyEncrypted,
    });
    await audit("auth_signing_key.rotated", c, tenant.projectId, {
      projectId: tenant.projectId,
    });
    // The encrypted private key is deliberately never returned.
    return c.json({
      projectId: tenant.projectId,
      jwtKeyId: rotated.jwtKeyId,
      jwtPublicKeyPem: rotated.jwtPublicKeyPem,
      rotatedAt: rotated.updatedAt,
    });
  });

  // -------------------------------------------------------------------- SETTINGS

  routes.get("/settings", (c) => {
    return c.json(publicPlatformSettings(platform.controlStore.getPlatformAuthSettings()));
  });

  routes.patch("/settings", async (c) => {
    const body = parseOrThrow(SuperAdminSettingsPatchSchema, await c.req.json());
    const input: UpdatePlatformAuthSettingsInput = {};
    if (body.globalSignupsEnabled !== undefined) input.globalSignupsEnabled = body.globalSignupsEnabled;
    if (body.defaultMaxUsersPerFreeProject !== undefined) {
      input.defaultMaxUsersPerFreeProject = body.defaultMaxUsersPerFreeProject;
    }
    if (body.defaultMaxUsersPerProProject !== undefined) {
      input.defaultMaxUsersPerProProject = body.defaultMaxUsersPerProProject;
    }
    if (body.platformSmtpHost !== undefined) input.platformSmtpHost = body.platformSmtpHost;
    if (body.platformSmtpPort !== undefined) input.platformSmtpPort = body.platformSmtpPort;
    if (body.platformSmtpUser !== undefined) input.platformSmtpUser = body.platformSmtpUser;
    if (body.platformSmtpFromEmail !== undefined) input.platformSmtpFromEmail = body.platformSmtpFromEmail;
    if (body.platformSmtpPass !== undefined) {
      input.platformSmtpPassEncrypted =
        body.platformSmtpPass === null ? null : encryptSecret(body.platformSmtpPass, masterKey());
    }
    const updated = await platform.controlStore.updatePlatformAuthSettings(input);
    await audit("platform_auth_settings.updated", c, null, { fields: Object.keys(body) });
    return c.json(publicPlatformSettings(updated));
  });

  return routes;
}
