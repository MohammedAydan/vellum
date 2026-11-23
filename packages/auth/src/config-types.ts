/**
 * Structural view of the control-plane end-user auth configuration used by
 * `@vellum/auth`. Defined locally so this package does not depend on the
 * control-plane record name or on any tenant dimension other than `projectId`.
 */
export interface ProjectAuthConfig {
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
  jwtPrivateKeyEncrypted: string;
  oauthProviders: Record<string, unknown>;
  customSmtpConfigEncrypted: string | null;
  createdAt: string;
  updatedAt: string;
}
