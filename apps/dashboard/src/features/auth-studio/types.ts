export type UnknownRecord = Record<string, unknown>;

export interface AuthUser {
  id: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoUrl: string | null;
  phoneNumber: string | null;
  phoneVerified: boolean;
  isDisabled: boolean;
  isAnonymous: boolean;
  customClaims: UnknownRecord;
  metadata: UnknownRecord;
  createdAt: string;
  updatedAt: string;
  lastSignInAt: string | null;
}

export interface AuthIdentity {
  id: string;
  provider: string;
  providerUserId: string;
  lastSignInAt: string;
  createdAt: string;
}

export interface AuthSession {
  id: string;
  userId: string;
  revoked: boolean;
  revokedReason: string | null;
  revokedAt: string | null;
  expiresAt: string;
  rotationCounter: number;
  createdAt: string;
  lastUsedAt: string;
}

export interface UserDetail {
  user: AuthUser;
  identities: AuthIdentity[];
  sessions: AuthSession[];
  mfa: { enabled: boolean; factorType: string | null; enrolledAt: string | null };
}

export interface AuthConfigView {
  id: string;
  projectId: string;
  authServiceSuspended: boolean;
  suspensionReason: string | null;
  maxUsersQuota: number;
  maxSignupsPerHour: number;
  enableEmailPassword: boolean;
  requireEmailVerification: boolean;
  enableAnonymousAuth: boolean;
  enableTotpMfa: boolean;
  enableUserProjection: boolean;
  projectionCollectionPath: string;
  passwordMinLength: number;
  passwordRequireUppercase: boolean;
  passwordRequireNumber: boolean;
  passwordRequireSymbol: boolean;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  jwtKeyId: string;
  jwtPublicKeyPem: string;
  oauthProviders: UnknownRecord;
  hasCustomSmtpConfig: boolean;
  createdAt: string;
  updatedAt: string;
}

export type UserFilter = "all" | "active" | "disabled" | "anonymous" | "unverified";

export interface OAuthDraft {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  /** A secret is already stored server-side (never returned). */
  hasSecret: boolean;
  /** Extra Google client IDs accepted for native ID tokens, one per line. */
  additionalClientIds: string;
}
