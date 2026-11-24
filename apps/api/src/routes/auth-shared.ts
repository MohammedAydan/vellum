/**
 * Shared helpers for the end-user auth REST tiers.
 *
 * These helpers only compose existing platform contracts; all domain logic
 * (password hashing, token signing, storage access) stays in `@vellum/auth`
 * and `@vellum/storage`.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { VellumError } from "@vellum/core";
import { generateEd25519KeyPair } from "@vellum/auth";
import { mergeOAuthProviders } from "../auth/oauth/config.js";
import { verifyApiKeyAsync, type ApiKeyRecord } from "@vellum/authorization";
import type {
  ProjectAuthConfig,
  ProjectRecord,
  UpsertAuthConfigInput,
} from "@vellum/database-control";
import type {
  AuthSessionRecord,
  AuthUserRecord,
  TenantContext,
} from "@vellum/storage";
import {
  getApiKeyHeader,
  resolveEndUserAuth,
  resolveIsAdminServer,
} from "../middleware/tenant-auth.js";
import type { VellumPlatformContext } from "../app.js";
import { loadProject, unwrapProject } from "../project-lookup.js";
import { extractClientIp } from "../middleware/security.js";

export interface AuthTenant {
  projectId: string;
  project: ProjectRecord;
  ctx: TenantContext;
}

/** Resolve and validate the projectId path parameter of an auth route. */
export async function resolveAuthTenant(c: Context, platform: VellumPlatformContext): Promise<AuthTenant> {
  const projectId = c.req.param("projectId");
  if (!projectId) {
    throw new VellumError("INVALID_ARGUMENT", "Missing projectId path parameter");
  }
  const project = await loadProject(platform.controlStore, projectId);
  const status = project.status.toLowerCase();
  if (status === "suspended") {
    throw new VellumError("PERMISSION_DENIED", `Project '${projectId}' has been suspended by platform administration`);
  }
  if (status === "throttled") {
    throw new VellumError("RATE_LIMITED", `Project '${projectId}' is currently throttled by platform administration`);
  }
  return {
    projectId,
    project,
    ctx: { projectId },
  };
}

/** Every non-JWKS auth endpoint requires a project key bound to the tenant. */
export async function requireProjectApiKey(
  c: Context,
  platform: VellumPlatformContext,
  tenant: AuthTenant,
  options: { serverOnly?: boolean } = {}
): Promise<ApiKeyRecord> {
  const rawKey = getApiKeyHeader(c);
  if (!rawKey) {
    throw new VellumError("UNAUTHENTICATED", "Missing X-Vellum-Api-Key (or legacy X-Project-Key) header");
  }
  const record = await verifyApiKeyAsync(rawKey, platform.controlStore, platform.apiKeyPepper);
  if (record.projectId !== tenant.projectId) {
    throw new VellumError(
      "PERMISSION_DENIED",
      "Provided API key does not belong to the requested project",
      { projectId: tenant.projectId }
    );
  }
  if (options.serverOnly && !resolveIsAdminServer(record)) {
    throw new VellumError("PERMISSION_DENIED", "A secret (sk_) server API key is required for this operation");
  }
  return record;
}

/** Read the master encryption key without ever logging it. */
export function masterKey(): string | undefined {
  return process.env["MASTER_ENCRYPTION_KEY"];
}

/** Read the already-initialized auth config, or fail closed. */
export async function getAuthConfigOrThrow(
  platform: VellumPlatformContext,
  projectId: string
): Promise<ProjectAuthConfig> {
  const config = await platform.controlStore.getAuthConfigAsync(projectId);
  if (!config) {
    throw new VellumError("SERVICE_UNAVAILABLE", "End-user auth is not configured for this project");
  }
  return config;
}

/**
 * Auto-initialize (or fetch) the project auth config. A fresh Ed25519
 * keypair is generated on first use; the private key is encrypted at rest.
 */
export async function ensureAuthConfig(
  platform: VellumPlatformContext,
  projectId: string
): Promise<ProjectAuthConfig> {
  const existing = await platform.controlStore.getAuthConfigAsync(projectId);
  if (existing) return existing;
  const pair = generateEd25519KeyPair(masterKey());
  return platform.controlStore.upsertAuthConfig({
    projectId,
    jwtKeyId: pair.keyId,
    jwtPublicKeyPem: pair.publicKeyPem,
    jwtPrivateKeyEncrypted: pair.privateKeyEncrypted,
  });
}

export type AuthConfigPatchInput = Partial<
  Omit<
    UpsertAuthConfigInput,
    "projectId" | "jwtKeyId" | "jwtPublicKeyPem" | "jwtPrivateKeyEncrypted"
  >
>;

/**
 * Merge a validated partial patch into a full upsert input while preserving the
 * signing key material (which is rotated only through the super-admin route).
 */
export function applyAuthConfigPatch(
  base: ProjectAuthConfig,
  patch: AuthConfigPatchInput
): UpsertAuthConfigInput {
  const input: UpsertAuthConfigInput = {
    projectId: base.projectId,
    jwtKeyId: base.jwtKeyId,
    jwtPublicKeyPem: base.jwtPublicKeyPem,
    jwtPrivateKeyEncrypted: base.jwtPrivateKeyEncrypted,
  };
  if (patch.authServiceSuspended !== undefined) input.authServiceSuspended = patch.authServiceSuspended;
  if (patch.suspensionReason !== undefined) input.suspensionReason = patch.suspensionReason;
  if (patch.maxUsersQuota !== undefined) input.maxUsersQuota = patch.maxUsersQuota;
  if (patch.maxSignupsPerHour !== undefined) input.maxSignupsPerHour = patch.maxSignupsPerHour;
  if (patch.enableEmailPassword !== undefined) input.enableEmailPassword = patch.enableEmailPassword;
  if (patch.requireEmailVerification !== undefined) input.requireEmailVerification = patch.requireEmailVerification;
  if (patch.enableAnonymousAuth !== undefined) input.enableAnonymousAuth = patch.enableAnonymousAuth;
  if (patch.enableTotpMfa !== undefined) input.enableTotpMfa = patch.enableTotpMfa;
  if (patch.enableUserProjection !== undefined) input.enableUserProjection = patch.enableUserProjection;
  if (patch.projectionCollectionPath !== undefined) input.projectionCollectionPath = patch.projectionCollectionPath;
  if (patch.passwordMinLength !== undefined) input.passwordMinLength = patch.passwordMinLength;
  if (patch.passwordRequireUppercase !== undefined) input.passwordRequireUppercase = patch.passwordRequireUppercase;
  if (patch.passwordRequireNumber !== undefined) input.passwordRequireNumber = patch.passwordRequireNumber;
  if (patch.passwordRequireSymbol !== undefined) input.passwordRequireSymbol = patch.passwordRequireSymbol;
  if (patch.accessTokenTtlSeconds !== undefined) input.accessTokenTtlSeconds = patch.accessTokenTtlSeconds;
  if (patch.refreshTokenTtlDays !== undefined) input.refreshTokenTtlDays = patch.refreshTokenTtlDays;
  if (patch.oauthProviders !== undefined) input.oauthProviders = mergeOAuthProviders(base.oauthProviders, patch.oauthProviders, masterKey());
  if (patch.customSmtpConfigEncrypted !== undefined) input.customSmtpConfigEncrypted = patch.customSmtpConfigEncrypted;
  return input;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newOpaqueToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

/** Structural schema shape shared by zod v3 (api-contract) and v4 (api app). */
export interface SafeParseSchema<T> {
  safeParse(
    data: unknown
  ): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } };
}

export function parseOrThrow<T>(schema: SafeParseSchema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const firstMessage = (result as Extract<typeof result, { success: false }>).error.issues[0]?.message ?? "Invalid request body";
  throw new VellumError("INVALID_ARGUMENT", firstMessage, {
    issues: (result as Extract<typeof result, { success: false }>).error.issues.map((issue) => issue.message),
  });
}

/** Best-effort JSON body parse: an empty body is `{}` for optional-body routes. */
export async function optionalJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

export interface ActorMetadata {
  userAgent: string | null;
  ipAddress: string | null;
}

export function actorMetadata(c: Context): ActorMetadata {
  return {
    userAgent: c.req.header("user-agent") ?? null,
    ipAddress: extractClientIp(c),
  };
}

/** Never expose password hashes or internal tenant columns in a response. */
export function publicUser(user: AuthUserRecord): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    displayName: user.displayName,
    photoUrl: user.photoUrl,
    phoneNumber: user.phoneNumber,
    phoneVerified: user.phoneVerified,
    isDisabled: user.isDisabled,
    isAnonymous: user.isAnonymous,
    customClaims: user.customClaims,
    metadata: user.metadata,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastSignInAt: user.lastSignInAt,
  };
}

/** Session rows carry refresh-token hashes: strip them before serialization. */
export function publicSession(session: AuthSessionRecord): Record<string, unknown> {
  return {
    id: session.id,
    userId: session.userId,
    revoked: session.revoked,
    revokedReason: session.revokedReason,
    revokedAt: session.revokedAt,
    expiresAt: session.expiresAt,
    rotationCounter: session.rotationCounter,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
  };
}

/** OAuth provider fields that may carry a client secret and must never be serialized. */
const OAUTH_SECRET_KEYS: ReadonlySet<string> = new Set([
  "clientSecret",
  "client_secret",
  "clientSecretEncrypted",
  "client_secret_encrypted",
  "secret",
  "secretEncrypted",
  "apiKeySecretHash",
]);

/** Strip OAuth client secrets from the provider map; expose presence only. */
function publicOAuthProviders(providers: Record<string, unknown>): {
  providers: Record<string, unknown>;
  hasClientSecret: boolean;
} {
  const safe: Record<string, unknown> = {};
  let hasClientSecret = false;
  for (const [provider, value] of Object.entries(providers)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      safe[provider] = value;
      continue;
    }
    const providerConfig: Record<string, unknown> = {};
    let providerHasSecret = false;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (OAUTH_SECRET_KEYS.has(key)) {
        if (child !== null && child !== undefined && child !== "") {
          hasClientSecret = true;
          providerHasSecret = true;
        }
        continue;
      }
      providerConfig[key] = child;
    }
    if (providerHasSecret) providerConfig["hasClientSecret"] = true;
    safe[provider] = providerConfig;
  }
  return { providers: safe, hasClientSecret };
}

/** Never return signing private keys, OAuth secrets or encrypted SMTP credentials. */
export function publicAuthConfig(config: ProjectAuthConfig): Record<string, unknown> {
  const oauth = publicOAuthProviders(config.oauthProviders);
  return {
    id: config.id,
    projectId: config.projectId,
    authServiceSuspended: config.authServiceSuspended,
    suspensionReason: config.suspensionReason,
    maxUsersQuota: config.maxUsersQuota,
    maxSignupsPerHour: config.maxSignupsPerHour,
    enableEmailPassword: config.enableEmailPassword,
    requireEmailVerification: config.requireEmailVerification,
    enableAnonymousAuth: config.enableAnonymousAuth,
    enableTotpMfa: config.enableTotpMfa,
    enableUserProjection: config.enableUserProjection,
    projectionCollectionPath: config.projectionCollectionPath,
    passwordMinLength: config.passwordMinLength,
    passwordRequireUppercase: config.passwordRequireUppercase,
    passwordRequireNumber: config.passwordRequireNumber,
    passwordRequireSymbol: config.passwordRequireSymbol,
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
    refreshTokenTtlDays: config.refreshTokenTtlDays,
    jwtKeyId: config.jwtKeyId,
    jwtPublicKeyPem: config.jwtPublicKeyPem,
    oauthProviders: oauth.providers,
    hasClientSecret: oauth.hasClientSecret,
    hasCustomSmtpConfig: config.customSmtpConfigEncrypted !== null,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

/** Resolve the end-user identified by the bearer / x-vellum-user-token header. */
export async function requireEndUser(
  c: Context,
  platform: VellumPlatformContext,
  tenant: AuthTenant
): Promise<AuthUserRecord> {
  const authContext = await resolveEndUserAuth(c, platform);
  if (!authContext.uid) {
    throw new VellumError("UNAUTHENTICATED", "A valid end-user access token is required");
  }
  const user = await platform.dataStore.getAuthUserById(tenant.ctx, authContext.uid);
  if (!user) {
    throw new VellumError("UNAUTHENTICATED", "The end-user no longer exists");
  }
  return user;
}
