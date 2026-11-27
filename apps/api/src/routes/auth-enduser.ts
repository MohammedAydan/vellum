/**
 * @vellum/api - End-User Auth REST tier
 *
 * Mounted at `/v1/projects/:projectId/auth`. All routes except the
 * public JWKS document require a valid project API key bound to the requested
 * project. End-user identity is carried by the bearer JWT (or the
 * `x-vellum-user-token` alias) and resolved by the tenant-auth middleware.
 */

import { Hono, type Context } from "hono";
import { VellumError } from "@vellum/core";
import {
  createAuthSessionService,
  createMailer,
  decryptSecret,
  deriveRecoveryCodes,
  DocumentProjector,
  encryptSecret,
  exportPublicJwks,
  generateTotpSecret,
  hashPassword,
  hashRecoveryCodes,
  isCommonPassword,
  COMMON_PASSWORD_MESSAGE,
  verifyPassword,
  verifyRecoveryCode,
  verifyTotpCode,
} from "@vellum/auth";
import {
  EmailVerifyConfirmRequestSchema,
  EmailVerifyRequestSchema,
  MfaChallengeRequestSchema,
  MfaEnrollRequestSchema,
  MfaVerifyRequestSchema,
  PasswordConfirmRequestSchema,
  PasswordResetRequestSchema,
  SignInAnonymousRequestSchema,
  SignInEmailRequestSchema,
  SignInProviderRequestSchema,
  SignOutRequestSchema,
  SignUpEmailRequestSchema,
  TokenRefreshRequestSchema,
  UpdateProfileRequestSchema,
} from "@vellum/api-contract";
import { THROTTLE_SCOPES, type ProjectAuthConfig } from "@vellum/database-control";
import type { AuthUserRecord, UpdateAuthUserInput } from "@vellum/storage";
import {
  buildAuthorizeUrl,
  completeAuthorization,
  exchangeAppleNativeCode,
  getProvider,
  parseAppleUserField,
  randomUrlToken,
  revokeAppleToken,
  s256,
  verifyAppleIdToken,
  verifyGoogleIdToken,
} from "../auth/oauth/providers.js";
import {
  isRedirectAllowed,
  CONFIRM_MAX_ATTEMPTS,
  CONFIRM_TTL_MS,
  codesMatch,
  confirmationCode,
  hasWebCredentials,
  openJson,
  openState,
  POLL_DISABLED_MESSAGE,
  pollSignInAllowed,
  redirectAllowlist,
  resolveProviderCredentials,
  sealJson,
  sealState,
  type ConfirmTicket,
} from "../auth/oauth/config.js";
import type { VellumPlatformContext } from "../app.js";
import {
  actorMetadata,
  ensureAuthConfig,
  getAuthConfigOrThrow,
  masterKey,
  newOpaqueToken,
  optionalJsonBody,
  parseOrThrow,
  publicUser,
  requireEndUser,
  requireProjectApiKey,
  resolveAuthTenant,
  sha256,
  type AuthTenant,
} from "./auth-shared.js";

const TOKEN_TYPE_PASSWORD_RESET = "password_reset";
const TOKEN_TYPE_EMAIL_VERIFICATION = "email_verification";
const TOKEN_TYPE_MFA_CHALLENGE = "mfa_challenge";
const TOKEN_TYPE_OAUTH_EXCHANGE = "oauth_exchange";
/** Redirect-less mobile/desktop sign-in: the app polls with its PKCE verifier instead of receiving a deep link. */
const TOKEN_TYPE_OAUTH_POLL = "oauth_poll";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_CODE_TTL_MS = 2 * 60 * 1000;
const ACTION_TOKEN_TTL_MS = 60 * 60 * 1000;
const MFA_TICKET_TTL_MS = 5 * 60 * 1000;

/**
 * Durable, cross-instance counter for repeated bad MFA codes (PostgreSQL via
 * the control store's throttle repository). Keys are SHA-256 hashes of the
 * MFA ticket (challenge) or end-user id (enroll verify) — never raw tokens.
 * After `MFA_MAX_FAILURES` bad codes the ticket is consumed / sessions revoked
 * so a brute-forced ticket or access token cannot be replayed, and the
 * lockout holds on every instance until the counter expires.
 */
const MFA_FAILURE_TTL_MS = 15 * 60 * 1000;
const MFA_MAX_FAILURES = 5;

const MFA_TOTP_USED_TOKEN_TYPE = "mfa_totp_used";
// A TOTP code is valid for up to 90 seconds (30s step, one step of drift each way).
const MFA_TOTP_REPLAY_TTL_MS = 120_000;

/** Per-project hourly sign-up budget; slots live in PostgreSQL, shared by every instance. */
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

export function createAuthEndUserRoutes(platform: VellumPlatformContext): Hono {
  const routes = new Hono();
  const storage = platform.dataStore;
  const mailer = createMailer();
  const projector = new DocumentProjector(platform.documentEngine);
  const sessionService = createAuthSessionService(storage, {
    getConfig: (projectId) => getAuthConfigOrThrow(platform, projectId),
    masterKey: masterKey(),
  });

  /**
   * Gate for every path that lets an EXISTING identity in (sign-in, refresh
   * through a provider link, ...). Only an administrative suspension blocks it.
   * Account-creation limits (global switch, user quota, signup budget) must not
   * lock out users who already have an account.
   */
  function checkAccessGuards(config: ProjectAuthConfig): void {
    if (config.authServiceSuspended) {
      throw new VellumError("PERMISSION_DENIED", config.suspensionReason ?? "End-user auth is suspended for this project");
    }
  }

  /** Gate for every path that CREATES an end-user (sign-up, anonymous, first provider login). */
  async function checkRegistrationGuards(tenant: AuthTenant, config: ProjectAuthConfig) {
    checkAccessGuards(config);
    if (!platform.controlStore.getPlatformAuthSettings().globalSignupsEnabled) {
      throw new VellumError("PERMISSION_DENIED", "Global sign-ups are disabled by platform administration");
    }
    if ((await storage.countAuthUsers(tenant.ctx)) >= config.maxUsersQuota) {
      throw new VellumError("QUOTA_EXCEEDED", "The end-user quota for this project has been reached");
    }
  }

  /**
   * Reserve an hourly sign-up slot in PostgreSQL (shared by every API
   * instance, atomic under concurrency) and run the account creation. The
   * slot is returned when creation fails.
   */
  async function createWithSignupSlot<T>(config: ProjectAuthConfig, tenant: AuthTenant, create: () => Promise<T>): Promise<T> {
    const slot = await platform.controlStore.throttle.acquireThrottleSlot(
      THROTTLE_SCOPES.signupBudget,
      tenant.projectId,
      SIGNUP_WINDOW_MS,
      config.maxSignupsPerHour
    );
    if (!slot.acquired) {
      throw new VellumError("TOO_MANY_REQUESTS", "The hourly sign-up limit for this project has been reached", {
        retryAfterSeconds: 300,
      });
    }
    try {
      return await create();
    } catch (error) {
      if (slot.eventId !== null) {
        await platform.controlStore.throttle.releaseThrottleSlot(slot.eventId).catch(() => undefined);
      }
      throw error;
    }
  }

  function assertPasswordPolicy(password: string, config: ProjectAuthConfig): void {
    if (password.length < config.passwordMinLength) {
      throw new VellumError("INVALID_ARGUMENT", `Password must be at least ${config.passwordMinLength} characters`);
    }
    // A platform floor every project inherits: known-common passwords are
    // rejected no matter how lax the project's own policy is.
    if (isCommonPassword(password)) {
      throw new VellumError("INVALID_ARGUMENT", COMMON_PASSWORD_MESSAGE);
    }
    if (config.passwordRequireUppercase && !/[A-Z]/.test(password)) {
      throw new VellumError("INVALID_ARGUMENT", "Password must contain an uppercase letter");
    }
    if (config.passwordRequireNumber && !/\d/.test(password)) {
      throw new VellumError("INVALID_ARGUMENT", "Password must contain a number");
    }
    if (config.passwordRequireSymbol && !/[^A-Za-z0-9]/.test(password)) {
      throw new VellumError("INVALID_ARGUMENT", "Password must contain a symbol");
    }
  }

  async function persistActionToken(
    tenant: AuthTenant,
    userId: string,
    tokenType: string,
    ttlMs = ACTION_TOKEN_TTL_MS
  ): Promise<{ token: string; expiresAt: string }> {
    const token = newOpaqueToken();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await storage.saveAuthToken(tenant.ctx, {
      userId,
      tokenHash: sha256(token),
      tokenType,
      expiresAt,
    });
    return { token, expiresAt };
  }

  /**
   * Durable bad-code lockout for second factors, shared by every API instance
   * (migration 0015). Subjects are `${projectId}:${sha256(...)}` — never raw
   * tickets, tokens or user ids. Once the counter reaches MFA_MAX_FAILURES it
   * stays at the cap until it expires, so the lockout holds everywhere.
   */
  async function mfaLockedOut(tenant: AuthTenant, failureKey: string): Promise<boolean> {
    const count = await platform.controlStore.throttle.getFailureCounter(
      THROTTLE_SCOPES.mfaFailures,
      `${tenant.projectId}:${failureKey}`
    );
    return count >= MFA_MAX_FAILURES;
  }

  /** Returns true once the limit is reached. */
  async function recordMfaFailure(tenant: AuthTenant, failureKey: string): Promise<boolean> {
    const count = await platform.controlStore.throttle.incrementFailureCounter(
      THROTTLE_SCOPES.mfaFailures,
      `${tenant.projectId}:${failureKey}`,
      MFA_FAILURE_TTL_MS,
      MFA_MAX_FAILURES
    );
    return count >= MFA_MAX_FAILURES;
  }

  async function clearMfaFailures(tenant: AuthTenant, failureKey: string): Promise<void> {
    await platform.controlStore.throttle.clearFailureCounter(
      THROTTLE_SCOPES.mfaFailures,
      `${tenant.projectId}:${failureKey}`
    );
  }

  /** Fresh sign-in window for accounts that have no password to confirm with. */
  const REAUTH_WINDOW_MS = 10 * 60 * 1000;

  /**
   * Proves the caller holds the account, not just a stolen access token, before a change that
   * would let an attacker keep access. Password accounts confirm the password (with a per-user
   * failure lockout); accounts without a password must have signed in within the last 10 minutes.
   */
  async function confirmAccountOwner(tenant: AuthTenant, current: AuthUserRecord, password: unknown): Promise<void> {
    if (current.passwordHash) {
      const failureKey = sha256(`reauth:${current.id}`);
      if (await mfaLockedOut(tenant, failureKey)) {
        throw new VellumError("TOO_MANY_REQUESTS", "Too many invalid attempts. Try again later.");
      }
      if (typeof password !== "string" || !(await verifyPassword(password, current.passwordHash))) {
        await recordMfaFailure(tenant, failureKey);
        throw new VellumError("UNAUTHENTICATED", "currentPassword is required and must be correct for this change");
      }
      await clearMfaFailures(tenant, failureKey);
      return;
    }
    const last = current.lastSignInAt ? Date.parse(current.lastSignInAt) : 0;
    if (!(Date.now() - last < REAUTH_WINDOW_MS)) {
      throw new VellumError("UNAUTHENTICATED", "Sign in again to make this change");
    }
  }

  /** A TOTP code must not work twice: remember the codes that were accepted for a short time. */
  async function totpCodeWasUsed(tenant: AuthTenant, userId: string, code: string): Promise<boolean> {
    return storage
      .peekAuthToken(tenant.ctx, sha256(`mfa-totp-used:${userId}:${code}`), MFA_TOTP_USED_TOKEN_TYPE)
      .then(() => true, () => false);
  }

  async function markTotpCodeUsed(tenant: AuthTenant, userId: string, code: string): Promise<void> {
    await storage.saveAuthToken(tenant.ctx, {
      userId,
      tokenHash: sha256(`mfa-totp-used:${userId}:${code}`),
      tokenType: MFA_TOTP_USED_TOKEN_TYPE,
      expiresAt: new Date(Date.now() + MFA_TOTP_REPLAY_TTL_MS).toISOString(),
    });
  }

  /** Send a token email; in dev mode the token is returned to the caller. */
  async function deliverToken(
    tenant: AuthTenant,
    config: ProjectAuthConfig,
    input: { to: string; token: string; tokenType: string; expiresAt: string }
  ): Promise<Record<string, unknown>> {
    const result = await mailer.sendTokenEmail({
      to: input.to,
      token: input.token,
      tokenType: input.tokenType,
      expiresAt: input.expiresAt,
      projectId: tenant.projectId,
      config,
      settings: platform.controlStore.getPlatformAuthSettings(),
    });
    if (result.delivered) return {};
    return { devToken: result.devToken, expiresAt: result.expiresAt ?? input.expiresAt };
  }

  async function issueSession(tenant: AuthTenant, user: AuthUserRecord, c: Context) {
    const actor = actorMetadata(c);
    const issued = await sessionService.issue({
      ctx: tenant.ctx,
      user,
      userAgent: actor.userAgent,
      ipAddress: actor.ipAddress,
    });
    return {
      user: publicUser(user),
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      tokenType: issued.tokenType,
      sessionId: issued.sessionId,
      expiresAt: issued.expiresAt,
    };
  }

  async function projectIfEnabled(tenant: AuthTenant, config: ProjectAuthConfig, user: AuthUserRecord) {
    if (config.enableUserProjection) {
      await projector.project(tenant.ctx, user, config.projectionCollectionPath);
    }
  }

  /**
   * Non-enumerating reply for token-delivery endpoints. Unknown emails and
   * delivery failures both produce this exact shape so a caller cannot infer
   * whether an account exists.
   */
  function sentResponse() {
    return { success: true, sent: true };
  }

  /** Redacted warning: never include the email, token or raw delivery error. */
  function warnDeliveryFailure(tokenType: string): void {
    platform.logger.warn("Auth token email delivery failed", { tokenType });
  }

  /**
   * Custom claims feed Security Rules (`auth.claims.*`) and `phoneVerified` is a
   * trust signal. Both are server-controlled: an end user must never be able to
   * assign them to themselves (privilege escalation). Admins set claims through
   * `PUT /auth/admin/users/:uid/claims` with a secret key.
   */
  function rejectSelfAssignedPrivilege(body: { customClaims?: unknown; phoneVerified?: unknown }): void {
    if (body.customClaims !== undefined || body.phoneVerified !== undefined) {
      throw new VellumError(
        "PERMISSION_DENIED",
        "customClaims and phoneVerified cannot be set by end users; use the admin API with a secret key"
      );
    }
  }

  interface ProviderSignInInput {
    provider: string;
    providerUserId?: string | undefined;
    idToken?: string | undefined;
    accessToken?: string | undefined;
    email?: string | undefined;
    emailVerified?: boolean | undefined;
    displayName?: string | undefined;
    photoUrl?: string | null | undefined;
    metadata?: Record<string, unknown> | undefined;
    /** Apple: refresh token (and the client ID it belongs to) kept so the grant can be revoked on deletion. */
    appleRefreshToken?: string | undefined;
    appleClientId?: string | undefined;
  }

  /**
   * Identity row data. For Apple it also carries the encrypted refresh token, so deleting the account (or unlinking
   * Apple) can revoke the grant with Apple as App Store rule 5.1.1(v) requires. An existing token is kept when a
   * sign-in does not bring a new one.
   */
  async function identityDataWithApple(
    tenant: AuthTenant,
    userId: string,
    provider: string,
    email: string | null,
    refreshToken: string | undefined,
    clientId: string | undefined
  ): Promise<Record<string, unknown>> {
    const data: Record<string, unknown> = { email, provider };
    if (provider !== "apple") return data;
    if (refreshToken) {
      data["appleRefreshTokenEncrypted"] = encryptSecret(refreshToken, masterKey());
      if (clientId) data["appleClientId"] = clientId;
      return data;
    }
    const previous = (await storage.listUserIdentities(tenant.ctx, userId)).find((i) => i.provider === "apple");
    for (const key of ["appleRefreshTokenEncrypted", "appleClientId"]) {
      const value = previous?.identityData[key];
      if (typeof value === "string") data[key] = value;
    }
    return data;
  }

  /** Best effort: ask Apple to revoke the stored grant. Never blocks deleting the account. */
  async function revokeAppleGrant(tenant: AuthTenant, config: ProjectAuthConfig, userId: string): Promise<void> {
    try {
      const identity = (await storage.listUserIdentities(tenant.ctx, userId)).find((i) => i.provider === "apple");
      const encrypted = identity?.identityData["appleRefreshTokenEncrypted"];
      if (typeof encrypted !== "string") return;
      const creds = resolveProviderCredentials(config.oauthProviders, "apple", masterKey());
      if (!hasWebCredentials("apple", creds)) return;
      const storedClient = identity?.identityData["appleClientId"];
      await revokeAppleToken(
        { clientId: creds.clientId, clientSecret: creds.clientSecret, teamId: creds.teamId, keyId: creds.keyId },
        decryptSecret(encrypted, masterKey()),
        typeof storedClient === "string" ? storedClient : creds.clientId
      );
    } catch {
      platform.logger.warn("Apple token revocation failed", { projectId: tenant.projectId });
    }
  }

  let decoyHash: Promise<string> | null = null;
  function timingDecoyHash(): Promise<string> {
    decoyHash ??= hashPassword(`decoy-${Math.random().toString(36)}-${Date.now()}`);
    return decoyHash;
  }

  /** Shared by the server-key endpoint and the verified OAuth flows. */
  async function resolveProviderUser(
    tenant: AuthTenant,
    config: ProjectAuthConfig,
    body: ProviderSignInInput
  ): Promise<{ user: AuthUserRecord; providerUserId: string }> {
    const configured = config.oauthProviders[body.provider];
    if (configured && typeof configured === "object" && (configured as Record<string, unknown>)["enabled"] === false) {
      throw new VellumError("PERMISSION_DENIED", `Identity provider '${body.provider}' is disabled`);
    }
    const providerUserId =
      body.providerUserId ?? sha256(body.idToken ?? body.accessToken ?? "").slice(0, 64);
    const existingIdentity = await storage.getAuthIdentityByProvider(tenant.ctx, body.provider, providerUserId);
    const now = new Date().toISOString();
    let user: AuthUserRecord;
    if (existingIdentity) {
      const found = await storage.getAuthUserById(tenant.ctx, existingIdentity.userId);
      if (!found) throw new VellumError("UNAUTHENTICATED", "The linked end-user no longer exists");
      if (found.isDisabled) throw new VellumError("PERMISSION_DENIED", "This end-user account is disabled");
      user = { ...found, lastSignInAt: now };
    } else {
      if (!body.email) {
        throw new VellumError("INVALID_ARGUMENT", "An email is required when registering via an identity provider");
      }
      const byEmail = await storage.getAuthUserByEmail(tenant.ctx, body.email);
      if (byEmail) {
        // Never link a new provider identity to an existing account on an
        // unverified email claim.
        if (body.emailVerified !== true) {
          throw new VellumError(
            "ALREADY_EXISTS",
            "An account with this email exists; the provider must assert a verified email to link it"
          );
        }
        if (byEmail.isDisabled) throw new VellumError("PERMISSION_DENIED", "This end-user account is disabled");
        if (!byEmail.emailVerified) {
          // Pre-hijacking defence: the password account was created with an email
          // nobody proved they own. The provider has now proven it, so the proven
          // owner takes over: drop the squatter's password and every open session.
          await storage.updateAuthUser(tenant.ctx, byEmail.id, { emailVerified: true, passwordHash: null });
          await storage.revokeAllUserSessions(tenant.ctx, byEmail.id, "email_ownership_proven_by_provider");
          user = { ...byEmail, emailVerified: true, passwordHash: null, lastSignInAt: now };
        } else {
          user = { ...byEmail, lastSignInAt: now };
        }
      } else {
        await checkRegistrationGuards(tenant, config);
        const email = body.email;
        user = await createWithSignupSlot(config, tenant, () =>
          storage.createAuthUser(tenant.ctx, {
            email,
            emailVerified: body.emailVerified ?? false,
            displayName: body.displayName ?? null,
            photoUrl: body.photoUrl ?? null,
            ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
          })
        );
        await projectIfEnabled(tenant, config, user);
      }
    }
    return { user, providerUserId };
  }

  async function finishProviderSignIn(
    tenant: AuthTenant,
    config: ProjectAuthConfig,
    c: Context,
    user: AuthUserRecord,
    body: ProviderSignInInput,
    providerUserId: string
  ): Promise<Record<string, unknown>> {
    const now = new Date().toISOString();
    // Provider sign-in must not bypass a verified second factor.
    const mfa = config.enableTotpMfa ? await storage.getAuthMfa(tenant.ctx, user.id) : null;
    if (mfa?.verified) {
      const { token, expiresAt } = await persistActionToken(
        tenant,
        user.id,
        TOKEN_TYPE_MFA_CHALLENGE,
        MFA_TICKET_TTL_MS
      );
      return ({ mfaRequired: true, mfaTicket: token, factors: ["totp"], expiresAt });
    }
    await storage.updateAuthUser(tenant.ctx, user.id, { lastSignInAt: now });
    await storage.upsertAuthIdentity(tenant.ctx, {
      userId: user.id,
      provider: body.provider,
      providerUserId,
      identityData: await identityDataWithApple(
        tenant,
        user.id,
        body.provider,
        body.email ?? user.email,
        body.appleRefreshToken,
        body.appleClientId
      ),
      lastSignInAt: now,
    });
    return await issueSession(tenant, user, c);
  }

  async function signInWithProviderIdentity(
    tenant: AuthTenant,
    config: ProjectAuthConfig,
    c: Context,
    body: ProviderSignInInput
  ): Promise<Record<string, unknown>> {
    const { user, providerUserId } = await resolveProviderUser(tenant, config, body);
    return finishProviderSignIn(tenant, config, c, user, body, providerUserId);
  }

  // -------------------------------------------------------------------- SIGN-UP

  routes.post("/sign-up/email", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    await checkRegistrationGuards(tenant, config);
    if (!config.enableEmailPassword) {
      throw new VellumError("PERMISSION_DENIED", "Email/password sign-up is disabled for this project");
    }

    const body = parseOrThrow(SignUpEmailRequestSchema, await c.req.json());
    rejectSelfAssignedPrivilege(body);
    assertPasswordPolicy(body.password, config);
    if (await storage.getAuthUserByEmail(tenant.ctx, body.email)) {
      throw new VellumError("ALREADY_EXISTS", "An end-user with this email already exists");
    }

    const user = await createWithSignupSlot(config, tenant, async () =>
      storage.createAuthUser(tenant.ctx, {
        email: body.email,
        emailVerified: false,
        passwordHash: await hashPassword(body.password),
        displayName: body.displayName ?? null,
        photoUrl: body.photoUrl ?? null,
        phoneNumber: body.phoneNumber ?? null,
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      })
    );
    const now = new Date().toISOString();
    await storage.upsertAuthIdentity(tenant.ctx, {
      userId: user.id,
      provider: "password",
      providerUserId: user.id,
      identityData: { email: user.email },
      lastSignInAt: now,
    });
    await storage.updateAuthUser(tenant.ctx, user.id, { lastSignInAt: now });
    await projectIfEnabled(tenant, config, user);
    return c.json(await issueSession(tenant, user, c), 201);
  });

  // --------------------------------------------------------------------- SIGN-IN

  routes.post("/sign-in/email", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    checkAccessGuards(config);
    if (!config.enableEmailPassword) {
      throw new VellumError("PERMISSION_DENIED", "Email/password sign-in is disabled for this project");
    }

    const body = parseOrThrow(SignInEmailRequestSchema, await c.req.json());
    const user = await storage.getAuthUserByEmail(tenant.ctx, body.email);
    // Always run one scrypt verification so response time does not reveal whether the email exists.
    const hashToCheck = user?.passwordHash ?? (await timingDecoyHash());
    const passwordOk = await verifyPassword(body.password, hashToCheck);
    if (!user || !user.passwordHash || !passwordOk) {
      throw new VellumError("UNAUTHENTICATED", "Invalid email or password");
    }
    if (user.isDisabled) {
      throw new VellumError("PERMISSION_DENIED", "This end-user account is disabled");
    }

    const mfa = config.enableTotpMfa ? await storage.getAuthMfa(tenant.ctx, user.id) : null;
    if (mfa?.verified) {
      const { token, expiresAt } = await persistActionToken(
        tenant,
        user.id,
        TOKEN_TYPE_MFA_CHALLENGE,
        MFA_TICKET_TTL_MS
      );
      return c.json({ mfaRequired: true, mfaTicket: token, factors: ["totp"], expiresAt });
    }

    const now = new Date().toISOString();
    await storage.updateAuthUser(tenant.ctx, user.id, { lastSignInAt: now });
    await storage.upsertAuthIdentity(tenant.ctx, {
      userId: user.id,
      provider: "password",
      providerUserId: user.id,
      identityData: { email: user.email },
      lastSignInAt: now,
    });
    const signedIn = { ...user, lastSignInAt: now };
    return c.json(await issueSession(tenant, signedIn, c));
  });

  routes.post("/sign-in/anonymous", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    await checkRegistrationGuards(tenant, config);
    if (!config.enableAnonymousAuth) {
      throw new VellumError("PERMISSION_DENIED", "Anonymous sign-in is disabled for this project");
    }
    const body = parseOrThrow(SignInAnonymousRequestSchema, await optionalJsonBody(c));
    const user = await createWithSignupSlot(config, tenant, () =>
      storage.createAuthUser(tenant.ctx, {
        email: null,
        emailVerified: false,
        isAnonymous: true,
        displayName: body.displayName ?? null,
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      })
    );
    return c.json(await issueSession(tenant, user, c), 201);
  });

  routes.post("/sign-in/provider", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    // The server never verifies provider ids or tokens itself: providerUserId,
    // email and emailVerified are claims made by the caller. Only a trusted
    // backend holding a secret (sk_) key may assert them. A publishable key in
    // a browser or app could otherwise sign in as any user by email.
    await requireProjectApiKey(c, platform, tenant, { serverOnly: true });
    const config = await ensureAuthConfig(platform, tenant.projectId);
    checkAccessGuards(config);

    const body = parseOrThrow(SignInProviderRequestSchema, await c.req.json());
    return c.json(await signInWithProviderIdentity(tenant, config, c, body));
  });

  // ---------------------------------------------------------------- OAUTH (Google, GitHub)

  function publicBaseUrl(c: Context): string {
    const fixed = process.env["VELLUM_PUBLIC_URL"];
    if (fixed) return fixed.replace(/\/+$/, "");
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
    const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
    return host ? `${proto}://${host}` : new URL(c.req.url).origin;
  }

  function callbackUrlFor(c: Context, projectId: string, provider: string): string {
    return `${publicBaseUrl(c)}/v1/projects/${projectId}/auth/oauth/${provider}/callback`;
  }

  function redirectWith(target: string, params: Record<string, string | null>): Response {
    const url = new URL(target);
    for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { location: url.toString(), "cache-control": "no-store" } });
  }

  /** Static page shown after a redirect-less sign-in. It carries no token and no user data. */
  function returnToAppPage(ok: boolean, description: string): Response {
    const safe = description.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    const message = ok ? "You are signed in. You can close this tab and return to the app." : `Sign-in did not complete. ${safe}`;
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? "Signed in" : "Sign-in failed"}</title><body style="font-family:system-ui,sans-serif;text-align:center;margin:20vh 1.5rem 0"><p>${message}</p></body></html>`,
      {
        status: ok ? 200 : 400,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
        },
      }
    );
  }

  // The publishable key travels in the X-Vellum-Api-Key header of a POST and never in a URL,
  // so it cannot leak through browser history, logs or Referer headers. The response is the
  // provider's authorize URL (it carries only the sealed, short-lived flow state).
  routes.post("/oauth/:provider/start", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    const providerId = c.req.param("provider") ?? "";
    const provider = getProvider(providerId);
    await requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    checkAccessGuards(config);
    const creds = resolveProviderCredentials(config.oauthProviders, providerId, masterKey());
    if (!creds.enabled || !hasWebCredentials(providerId, creds)) {
      throw new VellumError("PERMISSION_DENIED", `Sign-in with ${providerId} is not enabled for this project`);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      redirectUri?: unknown;
      codeChallenge?: unknown;
      state?: unknown;
      delivery?: unknown;
      link?: unknown;
      currentPassword?: unknown;
    };
    // "link": a signed-in user adds this provider to their own account instead of signing in with it.
    let linkUserId: string | undefined;
    if (body.link === true) {
      const owner = await requireEndUser(c, platform, tenant);
      await confirmAccountOwner(tenant, owner, body.currentPassword);
      linkUserId = owner.id;
    }
    // delivery "poll": no redirect URI and no deep link. The provider returns to this server, which shows a
    // "return to the app" page, and the app collects the result by polling with its PKCE verifier.
    const pollDelivery = body.delivery === "poll";
    if (pollDelivery && !pollSignInAllowed(config.oauthProviders)) {
      throw new VellumError("PERMISSION_DENIED", POLL_DISABLED_MESSAGE);
    }
    const redirectUri = pollDelivery ? "" : typeof body.redirectUri === "string" ? body.redirectUri : "";
    if (!pollDelivery && !isRedirectAllowed(redirectAllowlist(config.oauthProviders), redirectUri)) {
      throw new VellumError("INVALID_ARGUMENT", "redirectUri is not in this project's allowed redirect list");
    }
    const challenge = typeof body.codeChallenge === "string" ? body.codeChallenge : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      throw new VellumError("INVALID_ARGUMENT", "codeChallenge must be a base64url SHA-256 (S256) challenge");
    }
    const clientState = typeof body.state === "string" ? body.state : null;
    if (clientState !== null && clientState.length > 512) {
      throw new VellumError("INVALID_ARGUMENT", "state is too long");
    }
    const verifier = randomUrlToken(48);
    const nonce = randomUrlToken(16);
    const state = sealState(
      {
        p: tenant.projectId,
        provider: providerId,
        redirectUri,
        clientChallenge: challenge,
        clientState,
        verifier,
        nonce,
        ...(linkUserId !== undefined ? { linkUserId } : {}),
        exp: Date.now() + OAUTH_STATE_TTL_MS,
      },
      masterKey()
    );
    const authorizeUrl = buildAuthorizeUrl(provider, {
      clientId: creds.clientId,
      callbackUrl: callbackUrlFor(c, tenant.projectId, providerId),
      state,
      codeChallenge: s256(verifier),
      nonce,
    });
    c.header("cache-control", "no-store");
    return c.json({ authorizeUrl });
  });

  // Old SDKs sent the key in the query string. That is no longer accepted.
  routes.get("/oauth/:provider/start", () => {
    throw new VellumError(
      "INVALID_ARGUMENT",
      "This sign-in start URL is no longer supported because it put the API key in the URL. Update your Vellum SDK."
    );
  });

  // Providers that return the result in the URL (Google, GitHub) use GET. Apple posts it as a form
  // (response_mode=form_post), so the code never appears in a URL, a log or a Referer header.
  routes.get("/oauth/:provider/callback", (c) => {
    if (getProvider(c.req.param("provider") ?? "").formPost) {
      throw new VellumError("INVALID_ARGUMENT", "This provider returns its result with a POST request");
    }
    return handleOAuthCallback(c, {
      state: c.req.query("state") ?? "",
      code: c.req.query("code"),
      error: c.req.query("error"),
    });
  });

  routes.post("/oauth/:provider/callback", async (c) => {
    if (!getProvider(c.req.param("provider") ?? "").formPost) {
      throw new VellumError("INVALID_ARGUMENT", "This provider returns its result with a GET request");
    }
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, string | File>);
    const text = (key: string): string | undefined => (typeof form[key] === "string" ? (form[key] as string) : undefined);
    return handleOAuthCallback(c, {
      state: text("state") ?? "",
      code: text("code"),
      error: text("error"),
      user: text("user"),
    });
  });

  async function handleOAuthCallback(
    c: Context,
    params: { state: string; code: string | undefined; error: string | undefined; user?: string | undefined }
  ): Promise<Response> {
    const tenant = await resolveAuthTenant(c, platform);
    const providerId = c.req.param("provider") ?? "";
    const provider = getProvider(providerId);
    const flow = openState(params.state, masterKey());
    if (flow.p !== tenant.projectId || flow.provider !== providerId) {
      throw new VellumError("UNAUTHENTICATED", "Sign-in session expired or invalid. Please try again.");
    }
    const config = await ensureAuthConfig(platform, tenant.projectId);
    // The allowlist is re-checked: it may have changed since the flow began.
    const pollFlow = flow.redirectUri === "";
    if (pollFlow && !pollSignInAllowed(config.oauthProviders)) return returnToAppPage(false, POLL_DISABLED_MESSAGE);
    if (!pollFlow && !isRedirectAllowed(redirectAllowlist(config.oauthProviders), flow.redirectUri)) {
      throw new VellumError("INVALID_ARGUMENT", "redirectUri is no longer allowed for this project");
    }
    const fail = (error: string, description: string) =>
      pollFlow
        ? returnToAppPage(false, description)
        : redirectWith(flow.redirectUri, { error, error_description: description, state: flow.clientState });
    const providerError = params.error;
    if (providerError) return fail("access_denied", "The sign-in was cancelled or denied");
    const code = params.code;
    if (!code) return fail("invalid_request", "Missing authorization code");
    try {
      checkAccessGuards(config);
      const creds = resolveProviderCredentials(config.oauthProviders, providerId, masterKey());
      if (!creds.enabled || !hasWebCredentials(providerId, creds)) {
        return fail("access_denied", `Sign-in with ${providerId} is not enabled`);
      }
      const profile = await completeAuthorization(provider, creds, {
        code,
        callbackUrl: callbackUrlFor(c, tenant.projectId, providerId),
        codeVerifier: flow.verifier,
        nonce: flow.nonce,
        audiences: creds.audiences,
      });
      if (!profile.email || !profile.emailVerified) {
        return fail("access_denied", `${providerId} did not return a verified email address`);
      }
      // Apple sends the name only once, as a form field next to the code.
      if (providerId === "apple" && !profile.displayName) {
        profile.displayName = parseAppleUserField(params.user);
      }
      // Poll sign-in and account linking are completed only after the person at the browser types the
      // confirmation code shown inside the app. Without it, a phishing link could hand the victim's session
      // to an attacker's app (poll) or attach the victim's identity to the attacker's account (link).
      if (pollFlow || flow.linkUserId !== undefined) {
        const ticket = sealJson(
          {
            kind: "oauth-confirm",
            p: tenant.projectId,
            provider: providerId,
            redirectUri: flow.redirectUri,
            clientChallenge: flow.clientChallenge,
            clientState: flow.clientState,
            ...(flow.linkUserId !== undefined ? { linkUserId: flow.linkUserId } : {}),
            profile,
            attempts: 0,
            exp: Date.now() + CONFIRM_TTL_MS,
          } satisfies ConfirmTicket,
          masterKey()
        );
        return confirmPage(c, tenant, ticket, providerId, profile.email, flow.linkUserId !== undefined, null);
      }
      return await finalizeOAuth(c, tenant, config, flowOf(flow), profile);
    } catch (error) {
      return oauthFailure(flow, error);
    }
  }

  interface FlowOf {
    provider: string;
    redirectUri: string;
    clientChallenge: string;
    clientState: string | null;
    linkUserId?: string | undefined;
  }

  function flowOf(flow: FlowOf): FlowOf {
    return {
      provider: flow.provider,
      redirectUri: flow.redirectUri,
      clientChallenge: flow.clientChallenge,
      clientState: flow.clientState,
      ...(flow.linkUserId !== undefined ? { linkUserId: flow.linkUserId } : {}),
    };
  }

  function oauthFailure(flow: FlowOf, error: unknown): Response {
    const pollFlow = flow.redirectUri === "";
    const fail = (code: string, description: string) =>
      pollFlow
        ? returnToAppPage(false, description)
        : redirectWith(flow.redirectUri, { error: code, error_description: description, state: flow.clientState });
    if (error instanceof VellumError) {
      const denied = error.code === "PERMISSION_DENIED" || error.code === "ALREADY_EXISTS" || error.code === "QUOTA_EXCEEDED";
      return fail(denied ? "access_denied" : "server_error", error.message);
    }
    platform.logger.warn("OAuth callback failed", { provider: flow.provider });
    return fail("server_error", "Sign-in failed. Please try again.");
  }

  /** Creates or finds the user, records the identity and hands the result back to the app. */
  async function finalizeOAuth(
    c: Context,
    tenant: AuthTenant,
    config: ProjectAuthConfig,
    flow: FlowOf,
    profile: { providerUserId: string; email: string | null; displayName: string | null; photoUrl: string | null; refreshToken?: string | undefined; audience?: string | undefined }
  ): Promise<Response> {
    const providerId = flow.provider;
    const pollFlow = flow.redirectUri === "";
    const input: ProviderSignInInput = {
      provider: providerId,
      providerUserId: profile.providerUserId,
      email: profile.email ?? undefined,
      emailVerified: true,
      displayName: profile.displayName ?? undefined,
      photoUrl: profile.photoUrl,
    };
    let user: AuthUserRecord;
    let providerUserId: string;
    if (flow.linkUserId !== undefined) {
      const owner = await storage.getAuthUserById(tenant.ctx, flow.linkUserId);
      if (!owner || owner.isDisabled) {
        throw new VellumError("PERMISSION_DENIED", "The account to link is no longer available");
      }
      const taken = await storage.getAuthIdentityByProvider(tenant.ctx, providerId, profile.providerUserId);
      if (taken && taken.userId !== owner.id) {
        throw new VellumError("PERMISSION_DENIED", `This ${providerId} account is already linked to another user`);
      }
      user = owner;
      providerUserId = profile.providerUserId;
    } else {
      ({ user, providerUserId } = await resolveProviderUser(tenant, config, input));
    }
    const now = new Date().toISOString();
    await storage.upsertAuthIdentity(tenant.ctx, {
      userId: user.id,
      provider: providerId,
      providerUserId,
      identityData: await identityDataWithApple(tenant, user.id, providerId, profile.email, profile.refreshToken, profile.audience),
      lastSignInAt: now,
    });
    // One-time code, bound to the client's PKCE challenge: useless without the verifier.
    const oneTime = newOpaqueToken();
    await storage.saveAuthToken(tenant.ctx, {
      userId: user.id,
      tokenHash: sha256(`${oneTime}:${flow.clientChallenge}`),
      tokenType: TOKEN_TYPE_OAUTH_EXCHANGE,
      expiresAt: new Date(Date.now() + OAUTH_CODE_TTL_MS).toISOString(),
    });
    if (pollFlow) {
      await storage.saveAuthToken(tenant.ctx, {
        userId: user.id,
        tokenHash: sha256(`poll:${flow.clientChallenge}`),
        tokenType: TOKEN_TYPE_OAUTH_POLL,
        expiresAt: new Date(Date.now() + OAUTH_CODE_TTL_MS).toISOString(),
      });
      return returnToAppPage(true, "");
    }
    return redirectWith(flow.redirectUri, { vellum_code: oneTime, state: flow.clientState });
  }

  function confirmPage(
    c: Context,
    tenant: AuthTenant,
    ticket: string,
    provider: string,
    email: string | null,
    linking: boolean,
    error: string | null
  ): Response {
    const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    const project = esc(tenant.project.name);
    const names: Record<string, string> = { google: "Google", github: "GitHub", apple: "Apple" };
    const providerName = esc(names[provider] ?? provider);
    const who = email ? `<span class="who">${esc(email)}</span>` : "";
    const action = linking
      ? `Link your ${providerName} account to <b>${project}</b>`
      : `Sign in to <b>${project}</b> with ${providerName}`;
    const css =
      "*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.25rem;background:#f4f4f5;color:#18181b;font:16px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
      "main{width:100%;max-width:24rem;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:1.75rem}" +
      "h1{margin:0 0 .25rem;font-size:1.15rem;font-weight:600}.who{display:block;margin-top:.15rem;font-size:.9rem;font-weight:400;color:#71717a}" +
      "p{margin:.9rem 0 0;color:#52525b;font-size:.95rem}.note{padding:.7rem .85rem;background:#f4f4f5;border-left:3px solid #3b5bdb;border-radius:4px;color:#27272a}" +
      "input{display:block;width:100%;margin-top:1.1rem;padding:.65rem .75rem;border:1px solid #d4d4d8;border-radius:8px;background:#fff;color:#18181b;font:600 1.4rem ui-monospace,Menlo,Consolas,monospace;letter-spacing:.25em;text-align:center;text-transform:uppercase}" +
      "input:focus{outline:2px solid #3b5bdb;outline-offset:1px;border-color:#3b5bdb}" +
      "button{width:100%;margin-top:.9rem;padding:.7rem 1rem;border:0;border-radius:8px;background:#3b5bdb;color:#fff;font:600 1rem system-ui,sans-serif;cursor:pointer}button:hover{background:#364fc7}" +
      ".err{color:#18181b;font-weight:600}" +
      "@media(prefers-color-scheme:dark){body{background:#18181b;color:#f4f4f5}main{background:#27272a;border-color:#3f3f46}p{color:#a1a1aa}.note{background:#18181b;color:#e4e4e7}.who{color:#a1a1aa}input{background:#18181b;border-color:#52525b;color:#f4f4f5}.err{color:#f4f4f5}}";
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Confirm sign-in</title><style>${css}</style><body><main><h1>${action}${who}</h1><p>Enter the confirmation code shown in the app you are using.</p><p class="note"><b>Only continue if you started this just now in that app.</b> If someone sent you this link, or the app shows no code, close this page: it is an attempt to access your account.</p>${error ? `<p class="err">${esc(error)}</p>` : ""}<form method="post" action="${esc(`${publicBaseUrl(c)}/v1/projects/${tenant.projectId}/auth/oauth/confirm`)}"><input type="hidden" name="ticket" value="${esc(ticket)}"><input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" required autofocus aria-label="Confirmation code"><button type="submit">Confirm</button></form></main></body></html>`;
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      },
    });
  }

  // The person at the browser submits the code they read in the app. Five wrong tries end the attempt.
  routes.post("/oauth/confirm", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, string | File>);
    const rawTicket = typeof form["ticket"] === "string" ? (form["ticket"] as string) : "";
    const typed = typeof form["code"] === "string" ? (form["code"] as string) : "";
    let ticket: ConfirmTicket;
    try {
      ticket = openJson<ConfirmTicket>(rawTicket, masterKey());
    } catch {
      return returnToAppPage(false, "This confirmation expired. Start again from the app.");
    }
    if (ticket.kind !== "oauth-confirm" || ticket.p !== tenant.projectId) {
      return returnToAppPage(false, "This confirmation is not valid. Start again from the app.");
    }
    const flow = flowOf(ticket);
    if (!codesMatch(typed, confirmationCode(ticket.clientChallenge))) {
      if (ticket.attempts + 1 >= CONFIRM_MAX_ATTEMPTS) {
        return returnToAppPage(false, "Too many wrong codes. Start again from the app.");
      }
      const next = sealJson({ ...ticket, attempts: ticket.attempts + 1 }, masterKey());
      return confirmPage(c, tenant, next, ticket.provider, ticket.profile.email, ticket.linkUserId !== undefined, "That code does not match.");
    }
    try {
      const config = await ensureAuthConfig(platform, tenant.projectId);
      checkAccessGuards(config);
      if (ticket.redirectUri === "" && !pollSignInAllowed(config.oauthProviders)) {
        throw new VellumError("PERMISSION_DENIED", POLL_DISABLED_MESSAGE);
      }
      if (ticket.redirectUri !== "" && !isRedirectAllowed(redirectAllowlist(config.oauthProviders), ticket.redirectUri)) {
        throw new VellumError("INVALID_ARGUMENT", "redirectUri is no longer allowed for this project");
      }
      const response = await finalizeOAuth(c, tenant, config, flow, ticket.profile);
      // A 302 would replay the POST; 303 makes the browser GET the app's redirect URI.
      return response.status === 302 ? new Response(null, { status: 303, headers: response.headers }) : response;
    } catch (error) {
      return oauthFailure(flow, error);
    }
  });

  async function finishOAuthSession(c: Context, tenant: Awaited<ReturnType<typeof resolveAuthTenant>>, config: Awaited<ReturnType<typeof ensureAuthConfig>>, userId: string) {
    const user = await storage.getAuthUserById(tenant.ctx, userId);
    if (!user) throw new VellumError("UNAUTHENTICATED", "The linked end-user no longer exists");
    if (user.isDisabled) throw new VellumError("PERMISSION_DENIED", "This end-user account is disabled");
    const now = new Date().toISOString();
    const mfa = config.enableTotpMfa ? await storage.getAuthMfa(tenant.ctx, user.id) : null;
    if (mfa?.verified) {
      const { token, expiresAt } = await persistActionToken(tenant, user.id, TOKEN_TYPE_MFA_CHALLENGE, MFA_TICKET_TTL_MS);
      return c.json({ mfaRequired: true, mfaTicket: token, factors: ["totp"], expiresAt });
    }
    await storage.updateAuthUser(tenant.ctx, user.id, { lastSignInAt: now });
    return c.json(await issueSession(tenant, { ...user, lastSignInAt: now }, c));
  }

  routes.post("/oauth/exchange", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    checkAccessGuards(config);
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown; codeVerifier?: unknown };
    if (typeof body.code !== "string" || typeof body.codeVerifier !== "string" || body.codeVerifier.length < 43) {
      throw new VellumError("INVALID_ARGUMENT", "code and codeVerifier are required");
    }
    const record = await storage.consumeAuthToken(
      tenant.ctx,
      sha256(`${body.code}:${s256(body.codeVerifier)}`),
      TOKEN_TYPE_OAUTH_EXCHANGE
    );
    c.header("cache-control", "no-store");
    return finishOAuthSession(c, tenant, config, record.userId);
  });

  // Redirect-less sign-in: the app polls until the browser step finished. Returns 202 {status:"pending"}
  // while waiting, otherwise the same body as /oauth/exchange. Only the holder of the PKCE verifier can collect it.
  routes.post("/oauth/poll", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    checkAccessGuards(config);
    if (!pollSignInAllowed(config.oauthProviders)) throw new VellumError("PERMISSION_DENIED", POLL_DISABLED_MESSAGE);
    const body = (await c.req.json().catch(() => ({}))) as { codeVerifier?: unknown };
    if (typeof body.codeVerifier !== "string" || body.codeVerifier.length < 43 || body.codeVerifier.length > 128) {
      throw new VellumError("INVALID_ARGUMENT", "codeVerifier is required");
    }
    let userId: string;
    try {
      const record = await storage.consumeAuthToken(tenant.ctx, sha256(`poll:${s256(body.codeVerifier)}`), TOKEN_TYPE_OAUTH_POLL);
      userId = record.userId;
    } catch (error) {
      if (error instanceof VellumError && error.code === "UNAUTHENTICATED") {
        c.header("cache-control", "no-store");
        return c.json({ status: "pending" }, 202);
      }
      throw error;
    }
    c.header("cache-control", "no-store");
    return finishOAuthSession(c, tenant, config, userId);
  });

  /** Native Google (google_sign_in, Google Identity Services): the app sends a Google ID token. */
  routes.post("/oauth/google/id-token", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    checkAccessGuards(config);
    const creds = resolveProviderCredentials(config.oauthProviders, "google", masterKey());
    if (!creds.enabled || creds.audiences.length === 0) {
      throw new VellumError("PERMISSION_DENIED", "Sign-in with google is not enabled for this project");
    }
    const body = (await c.req.json().catch(() => ({}))) as { idToken?: unknown; nonce?: unknown };
    if (typeof body.idToken !== "string" || body.idToken.length === 0) {
      throw new VellumError("INVALID_ARGUMENT", "idToken is required");
    }
    const profile = await verifyGoogleIdToken(body.idToken, {
      audiences: creds.audiences,
      ...(typeof body.nonce === "string" ? { nonce: body.nonce } : {}),
    });
    if (!profile.email || !profile.emailVerified) {
      throw new VellumError("PERMISSION_DENIED", "google did not return a verified email address");
    }
    return c.json(
      await signInWithProviderIdentity(tenant, config, c, {
        provider: "google",
        providerUserId: profile.providerUserId,
        email: profile.email,
        emailVerified: true,
        displayName: profile.displayName ?? undefined,
        photoUrl: profile.photoUrl,
      })
    );
  });

  /**
   * Native Sign in with Apple (iOS, macOS, Android via the system sheet or web view of sign_in_with_apple): the app
   * sends the identityToken. `nonce` is the raw nonce the app used (the token carries it or its SHA-256).
   * Apple gives the name only on the first authorization, in the app, so the app passes it as givenName/familyName.
   * Pass the authorizationCode too so the grant can be revoked when the account is deleted.
   */
  routes.post("/oauth/apple/id-token", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    checkAccessGuards(config);
    const creds = resolveProviderCredentials(config.oauthProviders, "apple", masterKey());
    if (!creds.enabled || creds.audiences.length === 0) {
      throw new VellumError("PERMISSION_DENIED", "Sign-in with apple is not enabled for this project");
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      idToken?: unknown;
      nonce?: unknown;
      authorizationCode?: unknown;
      givenName?: unknown;
      familyName?: unknown;
    };
    if (typeof body.idToken !== "string" || body.idToken.length === 0) {
      throw new VellumError("INVALID_ARGUMENT", "idToken is required");
    }
    const profile = await verifyAppleIdToken(body.idToken, {
      audiences: creds.audiences,
      ...(typeof body.nonce === "string" && body.nonce.length > 0 ? { nonce: body.nonce } : {}),
    });
    if (!profile.email || !profile.emailVerified) {
      throw new VellumError("PERMISSION_DENIED", "apple did not return a verified email address");
    }
    const name = [body.givenName, body.familyName]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .join(" ")
      .trim()
      .slice(0, 200);
    let appleRefreshToken: string | undefined;
    if (typeof body.authorizationCode === "string" && body.authorizationCode.length > 0 && hasWebCredentials("apple", creds)) {
      const token = await exchangeAppleNativeCode(
        { clientId: creds.clientId, clientSecret: creds.clientSecret, teamId: creds.teamId, keyId: creds.keyId },
        { authorizationCode: body.authorizationCode, clientId: profile.audience ?? creds.clientId, expectedSub: profile.providerUserId }
      );
      if (token) appleRefreshToken = token;
    }
    return c.json(
      await signInWithProviderIdentity(tenant, config, c, {
        provider: "apple",
        providerUserId: profile.providerUserId,
        email: profile.email,
        emailVerified: true,
        displayName: name || undefined,
        photoUrl: null,
        appleRefreshToken,
        appleClientId: profile.audience,
      })
    );
  });

  // -------------------------------------------------------------------- TOKENS

  routes.post("/token/refresh", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    await ensureAuthConfig(platform, tenant.projectId);
    const body = parseOrThrow(TokenRefreshRequestSchema, await c.req.json());
    const issued = await sessionService.refresh(tenant.ctx, body.refreshToken);
    return c.json({
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      tokenType: issued.tokenType,
      sessionId: issued.sessionId,
      expiresAt: issued.expiresAt,
    });
  });

  routes.post("/sign-out", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    await ensureAuthConfig(platform, tenant.projectId);
    const body = parseOrThrow(SignOutRequestSchema, await optionalJsonBody(c));
    if (body.refreshToken) {
      await sessionService.revoke(tenant.ctx, body.refreshToken);
    } else {
      const user = await requireEndUser(c, platform, tenant);
      await storage.revokeAllUserSessions(tenant.ctx, user.id, "signed_out");
    }
    return c.json({ success: true });
  });

  // -------------------------------------------------------------------- PROFILE

  routes.get("/user", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    await ensureAuthConfig(platform, tenant.projectId);
    const user = await requireEndUser(c, platform, tenant);
    return c.json({ user: publicUser(user) });
  });

  routes.patch("/user", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    const current = await requireEndUser(c, platform, tenant);
    const body = parseOrThrow(UpdateProfileRequestSchema, await c.req.json());
    rejectSelfAssignedPrivilege(body);
    const patch: UpdateAuthUserInput = {};
    if (body.email !== undefined && body.email.toLowerCase() !== (current.email ?? "").toLowerCase()) {
      // Changing the email moves the password-reset address, so a stolen access token must not be
      // enough. An account with a password has to prove it; an account without one can only
      // attach a first email (anonymous upgrade), never replace one.
      if (current.email !== null) {
        if (!current.passwordHash) {
          throw new VellumError(
            "PERMISSION_DENIED",
            "This account has no password. Its email can only be changed with a server key."
          );
        }
        const failureKey = sha256(`email-change:${current.id}`);
        if (await mfaLockedOut(tenant, failureKey)) {
          throw new VellumError("TOO_MANY_REQUESTS", "Too many invalid attempts. Try again later.");
        }
        if (typeof body.currentPassword !== "string" || !(await verifyPassword(body.currentPassword, current.passwordHash))) {
          await recordMfaFailure(tenant, failureKey);
          throw new VellumError("UNAUTHENTICATED", "currentPassword is required and must be correct to change the email");
        }
        await clearMfaFailures(tenant, failureKey);
      }
    }
    if (body.email !== undefined) {
      const email = body.email;
      const collision = await storage.getAuthUserByEmail(tenant.ctx, email);
      if (collision && collision.id !== current.id) {
        throw new VellumError("ALREADY_EXISTS", "An end-user with this email already exists");
      }
      patch.email = email;
      patch.emailVerified = false;
    }
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.photoUrl !== undefined) patch.photoUrl = body.photoUrl;
    if (body.phoneNumber !== undefined) patch.phoneNumber = body.phoneNumber;
    if (body.metadata !== undefined) patch.metadata = body.metadata;
    const updated = await storage.updateAuthUser(tenant.ctx, current.id, patch);
    // The projected `users/{uid}` document mirrors the auth record. Re-project
    // after every profile mutation (merge semantics preserve developer fields).
    await projectIfEnabled(tenant, config, updated);
    return c.json({ user: publicUser(updated) });
  });

  // ------------------------------------------------------------ SESSIONS AND LINKED SIGN-IN METHODS

  routes.get("/sessions", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    await ensureAuthConfig(platform, tenant.projectId);
    const current = await requireEndUser(c, platform, tenant);
    const now = Date.now();
    const sessions = (await storage.listUserSessions(tenant.ctx, current.id))
      .filter((s) => !s.revoked && Date.parse(s.expiresAt) > now)
      .map((s) => ({
        id: s.id,
        userAgent: s.userAgent,
        ipAddress: s.ipAddress,
        createdAt: s.createdAt,
        lastRefreshedAt: s.rotatedAt,
        expiresAt: s.expiresAt,
      }));
    c.header("cache-control", "no-store");
    return c.json({ sessions });
  });

  routes.delete("/sessions/:sessionId", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    await ensureAuthConfig(platform, tenant.projectId);
    const current = await requireEndUser(c, platform, tenant);
    const id = c.req.param("sessionId");
    const owned = (await storage.listUserSessions(tenant.ctx, current.id)).find((s) => s.id === id);
    if (!owned) throw new VellumError("NOT_FOUND", "Session not found");
    await storage.revokeAuthSession(tenant.ctx, owned.id, "revoked_by_user");
    return c.json({ success: true });
  });

  routes.get("/identities", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    await ensureAuthConfig(platform, tenant.projectId);
    const current = await requireEndUser(c, platform, tenant);
    const identities = (await storage.listUserIdentities(tenant.ctx, current.id)).map((i) => ({
      provider: i.provider,
      email: typeof i.identityData["email"] === "string" ? i.identityData["email"] : null,
      lastSignInAt: i.lastSignInAt,
      createdAt: i.createdAt,
    }));
    return c.json({ identities, hasPassword: current.passwordHash !== null });
  });

  // Unlinking is refused when it would leave the account with no way to sign in.
  routes.delete("/identities/:provider", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    await ensureAuthConfig(platform, tenant.projectId);
    const current = await requireEndUser(c, platform, tenant);
    const provider = c.req.param("provider") ?? "";
    const unlinkBody = (await c.req.json().catch(() => ({}))) as { currentPassword?: unknown };
    await confirmAccountOwner(tenant, current, unlinkBody.currentPassword);
    const identities = await storage.listUserIdentities(tenant.ctx, current.id);
    const target = identities.find((i) => i.provider === provider);
    if (!target) throw new VellumError("NOT_FOUND", "That sign-in method is not linked to this account");
    const remaining = identities.filter((i) => i.provider !== provider && i.provider !== "password").length;
    if (provider === "password") {
      if (remaining === 0) throw new VellumError("FAILED_PRECONDITION", "Link another sign-in method before removing the password");
      await storage.updateAuthUser(tenant.ctx, current.id, { passwordHash: null });
    } else if (remaining === 0 && current.passwordHash === null) {
      throw new VellumError("FAILED_PRECONDITION", "This is the only way to sign in to the account; add a password or another provider first");
    }
    if (provider === "apple") await revokeAppleGrant(tenant, await ensureAuthConfig(platform, tenant.projectId), current.id);
    await storage.deleteAuthIdentity(tenant.ctx, current.id, provider);
    return c.json({ success: true });
  });

  // ------------------------------------------------------------------ PASSWORD

  // Signed-in password change: needs the current password, ends every other session and returns a fresh one.
  routes.post("/password/change", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    const current = await requireEndUser(c, platform, tenant);
    const body = (await c.req.json().catch(() => ({}))) as { currentPassword?: unknown; newPassword?: unknown };
    if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string") {
      throw new VellumError("INVALID_ARGUMENT", "currentPassword and newPassword are required");
    }
    if (!current.passwordHash) throw new VellumError("UNAUTHENTICATED", "The current password is incorrect");
    await confirmAccountOwner(tenant, current, body.currentPassword);
    assertPasswordPolicy(body.newPassword, config);
    const updated = await storage.updateAuthUser(tenant.ctx, current.id, { passwordHash: await hashPassword(body.newPassword) });
    await storage.revokeAllUserSessions(tenant.ctx, current.id, "password_changed");
    c.header("cache-control", "no-store");
    return c.json(await issueSession(tenant, updated, c));
  });

  // Self-service account deletion. Password accounts must confirm with their password.
  routes.delete("/user", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    await ensureAuthConfig(platform, tenant.projectId);
    const current = await requireEndUser(c, platform, tenant);
    const deleteBody = (await c.req.json().catch(() => ({}))) as { password?: unknown };
    await confirmAccountOwner(tenant, current, deleteBody.password);
    await revokeAppleGrant(tenant, await ensureAuthConfig(platform, tenant.projectId), current.id);
    await storage.revokeAllUserSessions(tenant.ctx, current.id, "account_deleted");
    await storage.deleteAuthUser(tenant.ctx, current.id);
    return c.json({ deleted: true });
  });

  routes.post("/password/reset", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    const body = parseOrThrow(PasswordResetRequestSchema, await c.req.json());
    const user = await storage.getAuthUserByEmail(tenant.ctx, body.email);
    // Always answer success: never disclose whether an email is registered.
    // A single no-op await keeps the async timing shape without adding delays.
    if (!user) {
      await Promise.resolve();
      return c.json(sentResponse());
    }
    try {
      const { token, expiresAt } = await persistActionToken(tenant, user.id, TOKEN_TYPE_PASSWORD_RESET);
      const delivery = await deliverToken(tenant, config, {
        to: body.email,
        token,
        tokenType: TOKEN_TYPE_PASSWORD_RESET,
        expiresAt,
      });
      return c.json({ ...sentResponse(), ...delivery });
    } catch {
      // Production without SMTP throws 503 from the mailer. Swallow it so the
      // response never reveals that this email has an account.
      warnDeliveryFailure(TOKEN_TYPE_PASSWORD_RESET);
      return c.json(sentResponse());
    }
  });

  routes.post("/password/confirm", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    const body = parseOrThrow(PasswordConfirmRequestSchema, await c.req.json());
    assertPasswordPolicy(body.newPassword, config);
    const record = await storage.consumeAuthToken(tenant.ctx, sha256(body.token), TOKEN_TYPE_PASSWORD_RESET);
    await storage.updateAuthUser(tenant.ctx, record.userId, { passwordHash: await hashPassword(body.newPassword) });
    await storage.revokeAllUserSessions(tenant.ctx, record.userId, "password_changed");
    return c.json({ success: true });
  });

  // ---------------------------------------------------------- EMAIL VERIFICATION

  routes.post("/email/verify/request", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    const body = parseOrThrow(EmailVerifyRequestSchema, await optionalJsonBody(c));
    const user = body.email
      ? await storage.getAuthUserByEmail(tenant.ctx, body.email)
      : await requireEndUser(c, platform, tenant);
    if (!user || !user.email) {
      await Promise.resolve();
      return c.json(sentResponse());
    }
    try {
      const { token, expiresAt } = await persistActionToken(tenant, user.id, TOKEN_TYPE_EMAIL_VERIFICATION);
      const delivery = await deliverToken(tenant, config, {
        to: user.email,
        token,
        tokenType: TOKEN_TYPE_EMAIL_VERIFICATION,
        expiresAt,
      });
      return c.json({ ...sentResponse(), ...delivery });
    } catch {
      // Production without SMTP throws 503 from the mailer. Swallow it so the
      // response never reveals that this email has an account.
      warnDeliveryFailure(TOKEN_TYPE_EMAIL_VERIFICATION);
      return c.json(sentResponse());
    }
  });

  routes.post("/email/verify/confirm", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    const body = parseOrThrow(EmailVerifyConfirmRequestSchema, await c.req.json());
    const record = await storage.consumeAuthToken(tenant.ctx, sha256(body.token), TOKEN_TYPE_EMAIL_VERIFICATION);
    const user = await storage.updateAuthUser(tenant.ctx, record.userId, { emailVerified: true });
    await projectIfEnabled(tenant, config, user);
    return c.json({ success: true, user: publicUser(user) });
  });

  // ----------------------------------------------------------------------- MFA

  routes.post("/mfa/enroll", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    if (!config.enableTotpMfa) {
      throw new VellumError("PERMISSION_DENIED", "TOTP MFA is disabled for this project");
    }
    const user = await requireEndUser(c, platform, tenant);
    const body = parseOrThrow(MfaEnrollRequestSchema, await optionalJsonBody(c));
    // Enrolling again would replace the secret and switch the second factor off until it is confirmed,
    // so anyone holding a session could strip MFA. It has to be disabled with a current code first.
    const existingMfa = await storage.getAuthMfa(tenant.ctx, user.id);
    if (existingMfa?.verified) {
      throw new VellumError("FAILED_PRECONDITION", "TOTP MFA is already enabled. Disable it with a current code before enrolling again.");
    }
    const secret = generateTotpSecret();
    const recoveryCodes = deriveRecoveryCodes();
    await storage.upsertAuthMfa(tenant.ctx, {
      userId: user.id,
      factorType: "totp",
      secretEncrypted: encryptSecret(secret, masterKey()),
      verified: false,
      recoveryCodesHashed: hashRecoveryCodes(recoveryCodes),
    });
    const issuer = body.issuer ?? "Vellum";
    const label = encodeURIComponent(`${issuer}:${user.email ?? user.id}`);
    const otpauthUri =
      `otpauth://totp/${label}?secret=${secret}` +
      `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    return c.json({ secret, otpauthUri, recoveryCodes });
  });

  routes.post("/mfa/verify", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    await ensureAuthConfig(platform, tenant.projectId);
    const user = await requireEndUser(c, platform, tenant);
    const body = parseOrThrow(MfaVerifyRequestSchema, await c.req.json());
    const mfa = await storage.getAuthMfa(tenant.ctx, user.id);
    if (!mfa) throw new VellumError("FAILED_PRECONDITION", "TOTP enrollment has not been started");
    if (mfa.verified) return c.json({ verified: true });
    const secret = decryptSecret(mfa.secretEncrypted, masterKey());
    const recoveryIndex = /^[A-Z2-7]{10}$/.test(body.code)
      ? verifyRecoveryCode(body.code, mfa.recoveryCodesHashed)
      : -1;
    const failureKey = sha256(`mfa-verify:${user.id}`);
    if (await mfaLockedOut(tenant, failureKey)) {
      throw new VellumError("UNAUTHENTICATED", "Too many invalid codes. Try again later.");
    }
    if (!verifyTotpCode(secret, body.code) && recoveryIndex === -1) {
      if (await recordMfaFailure(tenant, failureKey)) {
        // Enrollment verify has no action token to consume, so after 5 bad
        // codes revoke the caller's sessions instead. (The challenge route
        // below consumes its MFA ticket on the 5th failure.)
        await storage.revokeAllUserSessions(tenant.ctx, user.id, "mfa_verify_brute_force");
      }
      throw new VellumError("UNAUTHENTICATED", "Invalid verification code");
    }
    // A TOTP code is single-use across every MFA route: a code observed during
    // enrollment must not be replayed at /mfa/challenge or /mfa/disable inside
    // its validity window. Recovery codes are already consumed atomically.
    if (recoveryIndex === -1) {
      if (await totpCodeWasUsed(tenant, user.id, body.code)) {
        throw new VellumError("UNAUTHENTICATED", "Invalid verification code");
      }
      await markTotpCodeUsed(tenant, user.id, body.code);
    }
    await clearMfaFailures(tenant, failureKey);
    await storage.upsertAuthMfa(tenant.ctx, {
      userId: user.id,
      factorType: mfa.factorType,
      secretEncrypted: mfa.secretEncrypted,
      verified: true,
      recoveryCodesHashed: mfa.recoveryCodesHashed,
      verifiedAt: new Date().toISOString(),
    });
    return c.json({ verified: true });
  });

  routes.post("/mfa/challenge", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    await ensureAuthConfig(platform, tenant.projectId);
    const body = parseOrThrow(MfaChallengeRequestSchema, await c.req.json());
    const ticketHash = sha256(body.mfaTicket);
    const failureKey = `mfa-challenge:${ticketHash}`;
    // Bounded retries: the ticket survives a wrong code (peek, not consume) so a
    // typo does not force a full re-login. After 5 bad codes the ticket is
    // consumed (invalidated) and the user must sign in again. On success the
    // ticket is consumed atomically before the session is issued. Keys are
    // hashes, never raw tickets.
    const badCode = async (message: string): Promise<never> => {
      if (await recordMfaFailure(tenant, failureKey)) {
        try {
          await storage.consumeAuthToken(tenant.ctx, ticketHash, TOKEN_TYPE_MFA_CHALLENGE);
        } catch {
          // Already consumed — the ticket is invalid, which is the goal.
        }
      }
      throw new VellumError("UNAUTHENTICATED", message);
    };
    const challenge = await storage.peekAuthToken(
      tenant.ctx,
      ticketHash,
      TOKEN_TYPE_MFA_CHALLENGE
    );
    if (await mfaLockedOut(tenant, failureKey)) {
      throw new VellumError("UNAUTHENTICATED", "Too many invalid codes. Sign in again.");
    }
    const mfa = await storage.getAuthMfa(tenant.ctx, challenge.userId);
    if (!mfa?.verified) throw new VellumError("FAILED_PRECONDITION", "TOTP MFA is not enrolled for this user");
    const user = await storage.getAuthUserById(tenant.ctx, challenge.userId);
    if (!user || user.isDisabled) throw new VellumError("UNAUTHENTICATED", "The end-user is disabled or missing");

    const isRecovery = body.factorType === "recovery_code" || !/^\d{6}$/.test(body.code);
    if (isRecovery) {
      const usedIndex = verifyRecoveryCode(body.code, mfa.recoveryCodesHashed);
      if (usedIndex === -1) {
        await badCode("Invalid recovery code");
      } else {
        // Recovery codes are single-use: burn the one that just worked.
        await storage.upsertAuthMfa(tenant.ctx, {
          userId: mfa.userId,
          factorType: mfa.factorType,
          secretEncrypted: mfa.secretEncrypted,
          verified: true,
          recoveryCodesHashed: mfa.recoveryCodesHashed.filter((_, index) => index !== usedIndex),
          verifiedAt: mfa.verifiedAt ?? new Date().toISOString(),
        });
      }
    } else if (!verifyTotpCode(decryptSecret(mfa.secretEncrypted, masterKey()), body.code)) {
      await badCode("Invalid TOTP code");
    } else {
      if (await totpCodeWasUsed(tenant, mfa.userId, body.code)) await badCode("Invalid TOTP code");
      await markTotpCodeUsed(tenant, mfa.userId, body.code);
    }
    await clearMfaFailures(tenant, failureKey);
    // Consume atomically only after the code verified: a concurrent replay with
    // the same ticket fails here instead of issuing a second session.
    await storage.consumeAuthToken(tenant.ctx, ticketHash, TOKEN_TYPE_MFA_CHALLENGE);
    return c.json(await issueSession(tenant, user, c));
  });

  /** Turn the second factor off. Needs a signed-in user and a current code, never just a session. */
  routes.post("/mfa/disable", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    await requireProjectApiKey(c, platform, tenant);
    await ensureAuthConfig(platform, tenant.projectId);
    const user = await requireEndUser(c, platform, tenant);
    const body = parseOrThrow(MfaVerifyRequestSchema, await c.req.json());
    const mfa = await storage.getAuthMfa(tenant.ctx, user.id);
    if (!mfa?.verified) throw new VellumError("FAILED_PRECONDITION", "TOTP MFA is not enabled");
    const failureKey = sha256(`mfa-disable:${user.id}`);
    if (await mfaLockedOut(tenant, failureKey)) {
      throw new VellumError("UNAUTHENTICATED", "Too many invalid codes. Try again later.");
    }
    const fail = async (message: string): Promise<never> => {
      await recordMfaFailure(tenant, failureKey);
      throw new VellumError("UNAUTHENTICATED", message);
    };
    if (!/^\d{6}$/.test(body.code)) {
      if (verifyRecoveryCode(body.code, mfa.recoveryCodesHashed) === -1) await fail("Invalid recovery code");
    } else {
      if (!verifyTotpCode(decryptSecret(mfa.secretEncrypted, masterKey()), body.code)) await fail("Invalid TOTP code");
      if (await totpCodeWasUsed(tenant, user.id, body.code)) await fail("Invalid TOTP code");
      await markTotpCodeUsed(tenant, user.id, body.code);
    }
    await clearMfaFailures(tenant, failureKey);
    await storage.deleteAuthMfa(tenant.ctx, user.id);
    return c.json({ disabled: true });
  });

  // --------------------------------------------------------------------- JWKS

  /** Public: clients and gateways fetch this without any API key. */
  routes.get("/.well-known/jwks.json", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    return c.json(exportPublicJwks(config));
  });

  return routes;
}
