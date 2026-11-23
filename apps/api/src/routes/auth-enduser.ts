/**
 * @vellum/api - End-User Auth REST tier
 *
 * Mounted at `/v1/projects/:projectId/auth`. All routes except the
 * public JWKS document require a valid project API key bound to the requested
 * project. End-user identity is carried by the bearer JWT (or the
 * `x-vellum-user-token` alias) and resolved by the tenant-auth middleware.
 */

import { Hono, type Context } from "hono";
import { VellumError, type BoundedCachePolicy } from "@vellum/core";
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
import type { ProjectAuthConfig } from "@vellum/database-control";
import type { AuthUserRecord, UpdateAuthUserInput } from "@vellum/storage";
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
const ACTION_TOKEN_TTL_MS = 60 * 60 * 1000;
const MFA_TICKET_TTL_MS = 5 * 60 * 1000;

/**
 * Ephemeral, in-process counter for repeated bad MFA codes (Zero-Redis doctrine:
 * this is throttle state, not durable state). Keys are SHA-256 hashes of the
 * MFA ticket (challenge) or end-user id (enroll verify) — never raw tokens.
 * After `MFA_MAX_FAILURES` bad codes the ticket is consumed / sessions revoked
 * so a brute-forced ticket or access token cannot be replayed.
 */
export const MFA_FAILURE_CACHE_POLICY: BoundedCachePolicy = Object.freeze({
  name: "api.mfa-failure-counts",
  scope: "process",
  maxEntries: 50_000,
  ttlMs: 15 * 60 * 1000,
});

const mfaFailureCounts = new Map<string, { count: number; expiresAt: number }>();
const MFA_MAX_FAILURES = 5;

function recordMfaFailure(key: string): boolean {
  const now = Date.now();
  const existing = mfaFailureCounts.get(key);
  const count = existing && existing.expiresAt > now ? existing.count + 1 : 1;
  if (count >= MFA_MAX_FAILURES) {
    mfaFailureCounts.delete(key);
    return true;
  }
  if (!existing && mfaFailureCounts.size >= MFA_FAILURE_CACHE_POLICY.maxEntries) {
    for (const [candidate, entry] of mfaFailureCounts) {
      if (entry.expiresAt <= now) mfaFailureCounts.delete(candidate);
    }
    while (mfaFailureCounts.size >= MFA_FAILURE_CACHE_POLICY.maxEntries) {
      const oldestKey = mfaFailureCounts.keys().next().value;
      if (oldestKey === undefined) break;
      mfaFailureCounts.delete(oldestKey);
    }
  }
  mfaFailureCounts.set(key, { count, expiresAt: now + MFA_FAILURE_CACHE_POLICY.ttlMs });
  return false;
}

function clearMfaFailures(key: string): void {
  mfaFailureCounts.delete(key);
}

/**
 * Ephemeral per-project signup budget (Zero-Redis doctrine: throttle state, not
 * durable state; per process instance). Enforces `maxSignupsPerHour`, which was
 * previously stored and returned but never applied.
 */
export const SIGNUP_BUDGET_CACHE_POLICY: BoundedCachePolicy = Object.freeze({
  name: "api.signup-budget",
  scope: "process",
  maxEntries: 10_000,
  ttlMs: 60 * 60 * 1000,
});
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const signupEvents = new Map<string, number[]>();

function liveSignups(projectId: string, now: number): number[] {
  const events = (signupEvents.get(projectId) ?? []).filter((ts) => ts > now - SIGNUP_WINDOW_MS);
  if (events.length === 0) signupEvents.delete(projectId);
  else signupEvents.set(projectId, events);
  return events;
}

/**
 * Atomically check the hourly budget and reserve a slot (no await between the
 * check and the push), so parallel sign-ups cannot all pass one free slot. The
 * returned function releases the slot when the sign-up fails.
 */
function reserveSignupSlot(projectId: string, maxPerHour: number): () => void {
  const now = Date.now();
  const events = liveSignups(projectId, now);
  if (events.length >= maxPerHour) {
    throw new VellumError("TOO_MANY_REQUESTS", "The hourly sign-up limit for this project has been reached", {
      retryAfterSeconds: 300,
    });
  }
  events.push(now);
  if (!signupEvents.has(projectId) && signupEvents.size >= SIGNUP_BUDGET_CACHE_POLICY.maxEntries) {
    const oldest = signupEvents.keys().next().value;
    if (oldest !== undefined) signupEvents.delete(oldest);
  }
  signupEvents.set(projectId, events);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = signupEvents.get(projectId);
    const index = current?.indexOf(now) ?? -1;
    if (current && index !== -1) current.splice(index, 1);
  };
}

/** Test helper: reset in-process signup budgets. */
export function clearSignupBudgetState(): void {
  signupEvents.clear();
}

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
   * Reserve an hourly sign-up slot and run the account creation. The slot is
   * taken synchronously before any await, and returned if creation fails.
   */
  async function createWithSignupSlot<T>(config: ProjectAuthConfig, tenant: AuthTenant, create: () => Promise<T>): Promise<T> {
    const release = reserveSignupSlot(tenant.projectId, config.maxSignupsPerHour);
    try {
      return await create();
    } catch (error) {
      release();
      throw error;
    }
  }

  function assertPasswordPolicy(password: string, config: ProjectAuthConfig): void {
    if (password.length < config.passwordMinLength) {
      throw new VellumError("INVALID_ARGUMENT", `Password must be at least ${config.passwordMinLength} characters`);
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

  // -------------------------------------------------------------------- SIGN-UP

  routes.post("/sign-up/email", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    requireProjectApiKey(c, platform, tenant);
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
    const tenant = resolveAuthTenant(c, platform);
    requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    checkAccessGuards(config);
    if (!config.enableEmailPassword) {
      throw new VellumError("PERMISSION_DENIED", "Email/password sign-in is disabled for this project");
    }

    const body = parseOrThrow(SignInEmailRequestSchema, await c.req.json());
    const user = await storage.getAuthUserByEmail(tenant.ctx, body.email);
    if (!user || !user.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
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
    const tenant = resolveAuthTenant(c, platform);
    requireProjectApiKey(c, platform, tenant);
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
    const tenant = resolveAuthTenant(c, platform);
    // The server never verifies provider ids or tokens itself: providerUserId,
    // email and emailVerified are claims made by the caller. Only a trusted
    // backend holding a secret (sk_) key may assert them. A publishable key in
    // a browser or app could otherwise sign in as any user by email.
    requireProjectApiKey(c, platform, tenant, { serverOnly: true });
    const config = await ensureAuthConfig(platform, tenant.projectId);
    checkAccessGuards(config);

    const body = parseOrThrow(SignInProviderRequestSchema, await c.req.json());
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
        user = { ...byEmail, lastSignInAt: now };
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
    // Provider sign-in must not bypass a verified second factor.
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
    await storage.updateAuthUser(tenant.ctx, user.id, { lastSignInAt: now });
    await storage.upsertAuthIdentity(tenant.ctx, {
      userId: user.id,
      provider: body.provider,
      providerUserId,
      identityData: { email: body.email ?? user.email, provider: body.provider },
      lastSignInAt: now,
    });
    return c.json(await issueSession(tenant, user, c));
  });

  // -------------------------------------------------------------------- TOKENS

  routes.post("/token/refresh", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    requireProjectApiKey(c, platform, tenant);
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
    const tenant = resolveAuthTenant(c, platform);
    requireProjectApiKey(c, platform, tenant);
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
    const tenant = resolveAuthTenant(c, platform);
    requireProjectApiKey(c, platform, tenant);
    await ensureAuthConfig(platform, tenant.projectId);
    const user = await requireEndUser(c, platform, tenant);
    return c.json({ user: publicUser(user) });
  });

  routes.patch("/user", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    const current = await requireEndUser(c, platform, tenant);
    const body = parseOrThrow(UpdateProfileRequestSchema, await c.req.json());
    rejectSelfAssignedPrivilege(body);
    const patch: UpdateAuthUserInput = {};
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

  // ------------------------------------------------------------------ PASSWORD

  routes.post("/password/reset", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    requireProjectApiKey(c, platform, tenant);
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
    const tenant = resolveAuthTenant(c, platform);
    requireProjectApiKey(c, platform, tenant);
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
    const tenant = resolveAuthTenant(c, platform);
    requireProjectApiKey(c, platform, tenant);
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
    const tenant = resolveAuthTenant(c, platform);
    requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    const body = parseOrThrow(EmailVerifyConfirmRequestSchema, await c.req.json());
    const record = await storage.consumeAuthToken(tenant.ctx, sha256(body.token), TOKEN_TYPE_EMAIL_VERIFICATION);
    const user = await storage.updateAuthUser(tenant.ctx, record.userId, { emailVerified: true });
    await projectIfEnabled(tenant, config, user);
    return c.json({ success: true, user: publicUser(user) });
  });

  // ----------------------------------------------------------------------- MFA

  routes.post("/mfa/enroll", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    requireProjectApiKey(c, platform, tenant);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    if (!config.enableTotpMfa) {
      throw new VellumError("PERMISSION_DENIED", "TOTP MFA is disabled for this project");
    }
    const user = await requireEndUser(c, platform, tenant);
    const body = parseOrThrow(MfaEnrollRequestSchema, await optionalJsonBody(c));
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
    const tenant = resolveAuthTenant(c, platform);
    requireProjectApiKey(c, platform, tenant);
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
    if (!verifyTotpCode(secret, body.code) && recoveryIndex === -1) {
      if (recordMfaFailure(failureKey)) {
        // Enrollment verify has no action token to consume, so after 5 bad
        // codes revoke the caller's sessions instead. (The challenge route
        // below consumes its MFA ticket on the 5th failure.)
        await storage.revokeAllUserSessions(tenant.ctx, user.id, "mfa_verify_brute_force");
      }
      throw new VellumError("UNAUTHENTICATED", "Invalid verification code");
    }
    clearMfaFailures(failureKey);
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
    const tenant = resolveAuthTenant(c, platform);
    requireProjectApiKey(c, platform, tenant);
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
      if (recordMfaFailure(failureKey)) {
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
    }
    clearMfaFailures(failureKey);
    // Consume atomically only after the code verified: a concurrent replay with
    // the same ticket fails here instead of issuing a second session.
    await storage.consumeAuthToken(tenant.ctx, ticketHash, TOKEN_TYPE_MFA_CHALLENGE);
    return c.json(await issueSession(tenant, user, c));
  });

  // --------------------------------------------------------------------- JWKS

  /** Public: clients and gateways fetch this without any API key. */
  routes.get("/.well-known/jwks.json", async (c) => {
    const tenant = resolveAuthTenant(c, platform);
    const config = await ensureAuthConfig(platform, tenant.projectId);
    return c.json(exportPublicJwks(config));
  });

  return routes;
}
