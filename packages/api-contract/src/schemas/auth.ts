/**
 * @vellum/api-contract - End-User & Administrative Auth Request Schemas
 *
 * Runtime validation for every request body defined by
 * `docs/AUTH-FEATURE-CONTRACT.md` §5. Schemas are intentionally permissive
 * about unknown keys (forward compatibility with the JS/Flutter SDKs) but strict
 * about the shape, length, prototype-pollution safety, and type of every field.
 */

import { z } from "zod";
import { CONTROL_CHAR_REGEX, createSafeRecordSchema } from "./safety.js";

const ClaimsRecordSchema = createSafeRecordSchema({
  maxDepth: 10,
  maxKeys: 100,
  maxArrayLength: 100,
  maxBytes: 32_768,
});

const EmailSchema = z.string().trim().toLowerCase().email().max(320);
const PasswordSchema = z.string().min(8).max(1024);
const OpaqueTokenSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((val) => !CONTROL_CHAR_REGEX.test(val), "Token contains invalid control characters");
const SafePhotoUrlSchema = z
  .string()
  .max(2048)
  .refine(
    (val) => !CONTROL_CHAR_REGEX.test(val) && !/^\s*(?:javascript|vbscript):/i.test(val),
    "Invalid photoUrl scheme or control characters"
  );

/* -------------------------------------------------------------------------- */
/* End-user: sign-up / sign-in                                                 */
/* -------------------------------------------------------------------------- */

export const SignUpEmailRequestSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  displayName: z.string().trim().min(1).max(200).optional(),
  photoUrl: SafePhotoUrlSchema.nullable().optional(),
  phoneNumber: z.string().max(32).nullable().optional(),
  metadata: ClaimsRecordSchema.optional(),
  customClaims: ClaimsRecordSchema.optional(),
});
export type SignUpEmailRequest = z.infer<typeof SignUpEmailRequestSchema>;

export const SignInEmailRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(1024),
});
export type SignInEmailRequest = z.infer<typeof SignInEmailRequestSchema>;

export const SignInAnonymousRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  metadata: ClaimsRecordSchema.optional(),
});
export type SignInAnonymousRequest = z.infer<typeof SignInAnonymousRequestSchema>;

export const AuthProviderEnum = z.string().min(1).max(64);

export const SignInProviderRequestSchema = z
  .object({
    provider: AuthProviderEnum,
    idToken: OpaqueTokenSchema.optional(),
    accessToken: OpaqueTokenSchema.optional(),
    providerUserId: z.string().min(1).max(256).optional(),
    email: EmailSchema.optional(),
    emailVerified: z.boolean().optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    photoUrl: SafePhotoUrlSchema.nullable().optional(),
    metadata: ClaimsRecordSchema.optional(),
  })
  .refine(
    (body) => Boolean(body.providerUserId || body.idToken || body.accessToken),
    { message: "One of providerUserId, idToken or accessToken is required", path: ["providerUserId"] }
  );
export type SignInProviderRequest = z.infer<typeof SignInProviderRequestSchema>;

/* -------------------------------------------------------------------------- */
/* End-user: sessions & profile                                                */
/* -------------------------------------------------------------------------- */

export const TokenRefreshRequestSchema = z.object({
  refreshToken: OpaqueTokenSchema,
});
export type TokenRefreshRequest = z.infer<typeof TokenRefreshRequestSchema>;

export const SignOutRequestSchema = z.object({
  refreshToken: OpaqueTokenSchema.optional(),
});
export type SignOutRequest = z.infer<typeof SignOutRequestSchema>;

/**
 * Control-plane refresh endpoints accept the opaque token either in the JSON
 * body or in the `vellum_refresh_token` HttpOnly cookie, so the body field is
 * optional here.
 */
export const ControlSessionRefreshRequestSchema = z.object({
  refreshToken: OpaqueTokenSchema.optional(),
});
export type ControlSessionRefreshRequest = z.infer<typeof ControlSessionRefreshRequestSchema>;

export const UpdateProfileRequestSchema = z
  .object({
    email: EmailSchema.optional(),
    displayName: z.string().trim().min(1).max(200).nullable().optional(),
    photoUrl: SafePhotoUrlSchema.nullable().optional(),
    phoneNumber: z.string().max(32).nullable().optional(),
    phoneVerified: z.boolean().optional(),
    metadata: ClaimsRecordSchema.optional(),
    customClaims: ClaimsRecordSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one profile field must be provided",
  });
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;

/* -------------------------------------------------------------------------- */
/* End-user: password & email verification                                     */
/* -------------------------------------------------------------------------- */

export const PasswordResetRequestSchema = z.object({
  email: EmailSchema,
});
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

export const PasswordConfirmRequestSchema = z.object({
  token: OpaqueTokenSchema,
  newPassword: PasswordSchema,
});
export type PasswordConfirmRequest = z.infer<typeof PasswordConfirmRequestSchema>;

export const EmailVerifyRequestSchema = z.object({
  email: EmailSchema.optional(),
});
export type EmailVerifyRequest = z.infer<typeof EmailVerifyRequestSchema>;

export const EmailVerifyConfirmRequestSchema = z.object({
  token: OpaqueTokenSchema,
});
export type EmailVerifyConfirmRequest = z.infer<typeof EmailVerifyConfirmRequestSchema>;

/* -------------------------------------------------------------------------- */
/* End-user: MFA                                                               */
/* -------------------------------------------------------------------------- */

export const MfaEnrollRequestSchema = z.object({
  issuer: z.string().min(1).max(120).optional(),
});
export type MfaEnrollRequest = z.infer<typeof MfaEnrollRequestSchema>;

/** A TOTP code (6 digits) or one of the issued recovery codes. */
export const MfaCodeSchema = z.string().min(6).max(32).regex(/^[A-Za-z0-9]+$/, "Invalid verification code");

export const MfaVerifyRequestSchema = z.object({
  code: MfaCodeSchema,
});
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequestSchema>;

export const MfaChallengeRequestSchema = z.object({
  mfaTicket: OpaqueTokenSchema,
  code: MfaCodeSchema,
  factorType: z.enum(["totp", "recovery_code"]).optional(),
});
export type MfaChallengeRequest = z.infer<typeof MfaChallengeRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Customer admin: users directory                                             */
/* -------------------------------------------------------------------------- */

const BooleanQuerySchema = z.union([
  z.boolean(),
  z.enum(["true", "false", "1", "0"]).transform((value) => value === "true" || value === "1"),
]);

export const AdminListUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().max(4096).optional(),
  search: z.string().max(200).optional(),
  isDisabled: BooleanQuerySchema.optional(),
  isAnonymous: BooleanQuerySchema.optional(),
  emailVerified: BooleanQuerySchema.optional(),
});
export type AdminListUsersQuery = z.infer<typeof AdminListUsersQuerySchema>;

export const AdminCreateUserRequestSchema = z.object({
  email: EmailSchema.nullable().optional(),
  password: z.string().min(8).max(1024).optional(),
  displayName: z.string().trim().min(1).max(200).nullable().optional(),
  photoUrl: SafePhotoUrlSchema.nullable().optional(),
  phoneNumber: z.string().max(32).nullable().optional(),
  emailVerified: z.boolean().optional(),
  phoneVerified: z.boolean().optional(),
  isDisabled: z.boolean().optional(),
  isAnonymous: z.boolean().optional(),
  customClaims: ClaimsRecordSchema.optional(),
  metadata: ClaimsRecordSchema.optional(),
});
export type AdminCreateUserRequest = z.infer<typeof AdminCreateUserRequestSchema>;

export const AdminPatchUserRequestSchema = AdminCreateUserRequestSchema.partial().extend({
  lastSignInAt: z.string().max(64).nullable().optional(),
});
export type AdminPatchUserRequest = z.infer<typeof AdminPatchUserRequestSchema>;

/** Locked quota: serialized custom claims must not exceed 1000 bytes. */
export const MAX_CUSTOM_CLAIMS_BYTES = 1000;

export const AdminSetClaimsRequestSchema = z
  .object({
    claims: ClaimsRecordSchema,
  })
  .refine(
    (body) => {
      try {
        return Buffer.byteLength(JSON.stringify(body.claims), "utf8") <= MAX_CUSTOM_CLAIMS_BYTES;
      } catch {
        return false;
      }
    },
    { message: `Custom claims must not exceed ${MAX_CUSTOM_CLAIMS_BYTES} bytes`, path: ["claims"] }
  );
export type AdminSetClaimsRequest = z.infer<typeof AdminSetClaimsRequestSchema>;

export const AdminRevokeSessionsRequestSchema = z.object({
  reason: z.string().min(1).max(200).optional(),
});
export type AdminRevokeSessionsRequest = z.infer<typeof AdminRevokeSessionsRequestSchema>;

export const AdminImportUsersRequestSchema = z.object({
  users: z.array(AdminCreateUserRequestSchema).min(1).max(100),
});
export type AdminImportUsersRequest = z.infer<typeof AdminImportUsersRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Auth configuration (customer admin + super admin control)                   */
/* -------------------------------------------------------------------------- */

export const AuthConfigPatchSchema = z
  .object({
    authServiceSuspended: z.boolean().optional(),
    suspensionReason: z.string().max(1000).nullable().optional(),
    maxUsersQuota: z.number().int().min(1).max(10_000_000).optional(),
    maxSignupsPerHour: z.number().int().min(1).max(1_000_000).optional(),
    enableEmailPassword: z.boolean().optional(),
    requireEmailVerification: z.boolean().optional(),
    enableAnonymousAuth: z.boolean().optional(),
    enableTotpMfa: z.boolean().optional(),
    enableUserProjection: z.boolean().optional(),
    projectionCollectionPath: z.string().min(1).max(500).optional(),
    passwordMinLength: z.number().int().min(6).max(128).optional(),
    passwordRequireUppercase: z.boolean().optional(),
    passwordRequireNumber: z.boolean().optional(),
    passwordRequireSymbol: z.boolean().optional(),
    accessTokenTtlSeconds: z.number().int().min(60).max(86_400).optional(),
    refreshTokenTtlDays: z.number().int().min(1).max(365).optional(),
    oauthProviders: ClaimsRecordSchema.optional(),
    customSmtpConfigEncrypted: z.string().max(16_384).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one auth configuration field must be provided",
  });
export type AuthConfigPatch = z.infer<typeof AuthConfigPatchSchema>;

/* -------------------------------------------------------------------------- */
/* Platform super admin settings                                               */
/* -------------------------------------------------------------------------- */

export const SuperAdminSettingsPatchSchema = z
  .object({
    globalSignupsEnabled: z.boolean().optional(),
    defaultMaxUsersPerFreeProject: z.number().int().min(1).max(10_000_000).optional(),
    defaultMaxUsersPerProProject: z.number().int().min(1).max(10_000_000).optional(),
    platformSmtpHost: z.string().min(1).max(255).nullable().optional(),
    platformSmtpPort: z.number().int().min(1).max(65_535).nullable().optional(),
    platformSmtpUser: z.string().max(255).nullable().optional(),
    /** Plaintext on input only; encrypted at rest by the route layer. */
    platformSmtpPass: z.string().max(1024).nullable().optional(),
    platformSmtpFromEmail: EmailSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one platform auth setting must be provided",
  });
export type SuperAdminSettingsPatch = z.infer<typeof SuperAdminSettingsPatchSchema>;
