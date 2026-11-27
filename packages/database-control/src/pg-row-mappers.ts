/** PostgreSQL row normalization. Internal to the control-plane store. */
import type { ControlRefreshSessionRecord, PlatformAuthGlobalSettings, ProjectAuthConfig } from "./types.js";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

export function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return iso(value);
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 16 || value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  const clean: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    clean[key] = sanitizeValue(entry, depth + 1);
  }
  return clean;
}

export function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return sanitizeValue(value) as Record<string, unknown>;
  }
  return {};
}


/** Normalizes a `project_auth_configs` row into the public record shape. */
export function mapAuthConfigRow(row: Record<string, unknown>): ProjectAuthConfig {
  return {
    id: String(row["id"]),
    projectId: String(row["projectId"]),
    authServiceSuspended: Boolean(row["authServiceSuspended"]),
    suspensionReason: typeof row["suspensionReason"] === "string" ? row["suspensionReason"] : null,
    maxUsersQuota: Number(row["maxUsersQuota"]),
    maxSignupsPerHour: Number(row["maxSignupsPerHour"]),
    signupPerIpLimit: Number(row["signupPerIpLimit"]),
    enableEmailPassword: Boolean(row["enableEmailPassword"]),
    requireEmailVerification: Boolean(row["requireEmailVerification"]),
    enableAnonymousAuth: Boolean(row["enableAnonymousAuth"]),
    enableTotpMfa: Boolean(row["enableTotpMfa"]),
    enableUserProjection: Boolean(row["enableUserProjection"]),
    projectionCollectionPath: String(row["projectionCollectionPath"]),
    passwordMinLength: Number(row["passwordMinLength"]),
    passwordRequireUppercase: Boolean(row["passwordRequireUppercase"]),
    passwordRequireNumber: Boolean(row["passwordRequireNumber"]),
    passwordRequireSymbol: Boolean(row["passwordRequireSymbol"]),
    accessTokenTtlSeconds: Number(row["accessTokenTtlSeconds"]),
    refreshTokenTtlDays: Number(row["refreshTokenTtlDays"]),
    jwtKeyId: String(row["jwtKeyId"]),
    jwtPublicKeyPem: String(row["jwtPublicKeyPem"]),
    jwtPrivateKeyEncrypted: String(row["jwtPrivateKeyEncrypted"]),
    oauthProviders: asObject(row["oauthProviders"]),
    customSmtpConfigEncrypted:
      typeof row["customSmtpConfigEncrypted"] === "string" ? row["customSmtpConfigEncrypted"] : null,
    createdAt: iso(row["createdAt"]),
    updatedAt: iso(row["updatedAt"]),
  };
}


/** Normalizes a `control_plane_refresh_sessions` row into the public record shape. */
export function mapControlRefreshSession(row: Record<string, unknown>): ControlRefreshSessionRecord {
  return {
    id: String(row["id"]),
    userId: String(row["userId"]),
    realm: row["realm"] === "super_admin" ? "super_admin" : "customer_console",
    accessTokenHash: String(row["accessTokenHash"]),
    refreshTokenHash: String(row["refreshTokenHash"]),
    previousRefreshTokenHash:
      typeof row["previousRefreshTokenHash"] === "string" ? row["previousRefreshTokenHash"] : null,
    rotatedAt: isoOrNull(row["rotatedAt"]),
    rotationCounter: Number(row["rotationCounter"]),
    ipAddress: typeof row["ipAddress"] === "string" ? row["ipAddress"] : null,
    userAgent: typeof row["userAgent"] === "string" ? row["userAgent"] : null,
    revoked: Boolean(row["revoked"]),
    revokedReason: typeof row["revokedReason"] === "string" ? row["revokedReason"] : null,
    accessExpiresAt: iso(row["accessExpiresAt"]),
    refreshExpiresAt: iso(row["refreshExpiresAt"]),
    createdAt: iso(row["createdAt"]),
    lastUsedAt: iso(row["lastUsedAt"]),
  };
}

export function mapPlatformAuthSettings(row: Record<string, unknown>): PlatformAuthGlobalSettings {
  return {
    id: Number(row["id"]),
    globalSignupsEnabled: Boolean(row["globalSignupsEnabled"]),
    consoleSignupAutoVerifyEmail: row["consoleSignupAutoVerifyEmail"] === undefined ? true : Boolean(row["consoleSignupAutoVerifyEmail"]),
    defaultMaxUsersPerFreeProject: Number(row["defaultMaxUsersPerFreeProject"]),
    defaultMaxUsersPerProProject: Number(row["defaultMaxUsersPerProProject"]),
    platformSmtpHost: typeof row["platformSmtpHost"] === "string" ? row["platformSmtpHost"] : null,
    platformSmtpPort: row["platformSmtpPort"] === null || row["platformSmtpPort"] === undefined
      ? null
      : Number(row["platformSmtpPort"]),
    platformSmtpUser: typeof row["platformSmtpUser"] === "string" ? row["platformSmtpUser"] : null,
    platformSmtpPassEncrypted:
      typeof row["platformSmtpPassEncrypted"] === "string" ? row["platformSmtpPassEncrypted"] : null,
    platformSmtpFromEmail: String(row["platformSmtpFromEmail"]),
    updatedAt: iso(row["updatedAt"]),
  };
}

