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
import { verifyApiKeyAsync } from "@vellum/authorization";
import { THROTTLE_SCOPES, type ProjectAuthConfig } from "@vellum/database-control";
import type { AuthUserRecord, UpdateAuthUserInput } from "@vellum/storage";
import {
  buildAuthorizeUrl,
  completeAuthorization,
  getProvider,
  randomUrlToken,
  s256,
  verifyGoogleIdToken,
} from "../auth/oauth/providers.js";
import {
  isRedirectAllowed,
  openState,
  redirectAllowlist,
  resolveProviderCredentials,
  sealState,
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
      identityData: { email: body.email ?? user.email, provider: body.provider },
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
    if (!creds.enabled || !creds.clientId || !creds.clientSecret) {
      throw new VellumError("PERMISSION_DENIED", `Sign-in with ${providerId} is not enabled for this project`);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      redirectUri?: unknown;
      codeChallenge?: unknown;
      state?: unknown;
    };
    const redirectUri = typeof body.redirectUri === "string" ? body.redirectUri : "";
    if (!isRedirectAllowed(redirectAllowlist(config.oauthProviders), redirectUri)) {
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

  routes.get("/oauth/:provider/callback", async (c) => {
    const tenant = await resolveAuthTenant(c, platform);
    const providerId = c.req.param("provider") ?? "";
    const provider = getProvider(providerId);
    const flow = openState(c.req.query("state") ?? "", masterKey());
    if (flow.p !== tenant.projectId || flow.provider !== providerId) {
      throw new VellumError("UNAUTHENTICATED", "Sign-in session expired or invalid. Please try again.");
    }
    const config = await ensureAuthConfig(platform, tenant.projectId);
    // The allowlist is re-checked: it may have changed since the flow began.
    if (!isRedirectAllowed(redirectAllowlist(config.oauthProviders), flow.redirectUri)) {
      throw new VellumError("INVALID_ARGUMENT", "redirectUri is no longer allowed for this project");
    }
    const fail = (error: string, description: string) =>
      redirectWith(flow.redirectUri, { error, error_description: description, state: flow.clientState });
    const providerError = c.req.query("error");
    if (providerError) return fail("access_denied", "The sign-in was cancelled or denied");
    const code = c.req.query("code");
    if (!code) return fail("invalid_request", "Missing authorization code");
    try {
      checkAccessGuards(config);
      const creds = resolveProviderCredentials(config.oauthProviders, providerId, masterKey());
      if (!creds.enabled || !creds.clientId || !creds.clientSecret) {
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
      const input: ProviderSignInInput = {
        provider: providerId,
        providerUserId: profile.providerUserId,
        email: profile.email,
        emailVerified: true,
        displayName: profile.displayName ?? undefined,
        photoUrl: profile.photoUrl,
      };
      const { user, providerUserId } = await resolveProviderUser(tenant, config, input);
      const now = new Date().toISOString();
      await storage.upsertAuthIdentity(tenant.ctx, {
        userId: user.id,
        provider: providerId,
        providerUserId,
        identityData: { email: profile.email, provider: providerId },
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
      return redirectWith(flow.redirectUri, { vellum_code: oneTime, state: flow.clientState });
    } catch (error) {
      if (error instanceof VellumError) {
        const denied = error.code === "PERMISSION_DENIED" || error.code === "ALREADY_EXISTS" || error.code === "QUOTA_EXCEEDED";
        return fail(denied ? "access_denied" : "server_error", error.message);
      }
      platform.logger.warn("OAuth callback failed", { provider: providerId });
      return fail("server_error", "Sign-in failed. Please try again.");
    }
  });

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
    const user = await storage.getAuthUserById(tenant.ctx, record.userId);
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
