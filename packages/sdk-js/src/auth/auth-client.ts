/**
 * @vellumdb/sdk-js - End-user authentication state machine.
 *
 * Owns the signed-in session, silent token refresh (single-flight), reactive
 * 60 s pre-flight expiry, listener notification, and pluggable session
 * persistence. HTTP concerns stay in the injected `request` function so this
 * class is fully unit-testable without a network.
 *
 * No token material is ever logged or serialized via `toJSON()` / `toString()`.
 */

import { sanitizeAndClone } from "../core/safe-json.js";
import type {
  ActionTokenResult,
  AuthState,
  VellumLinkedProvider,
  VellumSessionInfo,
  AuthStateListener,
  ConfirmEmailVerificationInput,
  ConfirmPasswordResetInput,
  ConfirmTotpMfaInput,
  VellumAuthUser,
  EmailVerifyConfirmResult,
  EnrollTotpMfaInput,
  MfaRequiredResult,
  SendEmailVerificationInput,
  SendPasswordResetEmailInput,
  SignInAnonymouslyInput,
  SignInWithEmailAndPasswordInput,
  SignInWithOAuthInput,
  SignUpWithEmailAndPasswordInput,
  SuccessResult,
  TotpEnrollmentResult,
  UpdateProfileInput,
  VerifyMfaChallengeInput,
} from "../types.js";
import { resolveAuthStorage, type AuthStorage } from "./auth-storage.js";
import {
  isTokenExpiringWithin,
  parseActionTokenResponse,
  parseAuthUser,
  parseEmailVerifyConfirmResponse,
  parseJwtExp,
  parseMfaRequiredResponse,
  parseSessionResponse,
  parseSuccessResponse,
  parseTotpEnrollmentResponse,
  requiredString,
} from "./jwt-utils.js";
import {
  cleanUrl,
  completeOAuthPopup,
  hasPending,
  openPopup,
  parseCallbackParams,
  prepareFlow,
  runPopup,
  savePending,
  takePending,
  type OAuthCallbackParams,
  type OAuthPopupOptions,
  type PreparedFlow,
  type OAuthRedirectOptions,
  confirmationCode,
  showDefaultConfirmationCode,
} from "./oauth-web.js";

/** The narrow HTTP surface the auth state machine needs from `createClient`. */
export type AuthRequest = <R = unknown>(
  method: string,
  relativePath: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
  includeAuth?: boolean
) => Promise<R>;

export interface SignOutOptions {
  /** Revoke every session of this end-user instead of only the current one. */
  allSessions?: boolean;
}

export interface VellumAuthClientOptions {
  request: AuthRequest;
  getAuthToken: (() => Promise<string | null> | string | null) | null;
  authStorage?: AuthStorage | null;
  /** Project API base (`<endpoint>/v1/projects/<id>`) and publishable key, used to start browser OAuth flows. */
  oauth?: { baseUrl: string; apiKey: string } | null;
  /** Silent proactive/reactive refresh. Defaults to true; set false to refresh only on explicit `getIdToken(true)`. */
  autoRefresh?: boolean;
  /** Fired synchronously on sign-in, sign-out and disposal. */
  onSessionChanged?: (() => void) | null;
  /** Fired whenever the effective bearer changes (sign-in or token rotation). */
  onTokenChanged?: ((previousToken: string | null, nextToken: string | null) => void) | null;
}

export type SignUpEmailOptions = Omit<SignUpWithEmailAndPasswordInput, "email" | "password">;
export type SignInOAuthPayload = Omit<SignInWithOAuthInput, "provider">;

const REFRESH_SKEW_MS = 60_000;

interface AuthClientInternalState {
  currentUserValue: AuthState | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  refreshInFlightPromise: Promise<AuthState> | null;
  lastNotifiedToken: string | null;
  sessionEpoch: number;
  disposed: boolean;
  /** Externally injected bearer (setCustomToken); wins over getAuthToken. */
  customToken: string | null;
}

export class VellumAuthClient {
  private readonly storage: AuthStorage;
  private readonly oauthConfig: { baseUrl: string; apiKey: string } | null;
  private readonly autoRefresh: boolean;
  private readonly request: AuthRequest;
  private readonly getAuthToken: (() => Promise<string | null> | string | null) | null;
  private readonly onTokenChanged: ((previousToken: string | null, nextToken: string | null) => void) | null;
  private readonly onSessionChanged: (() => void) | null;
  private readonly listeners = new Set<AuthStateListener>();
  private readonly state: AuthClientInternalState;

  public constructor(options: VellumAuthClientOptions) {
    this.request = options.request;
    this.getAuthToken = options.getAuthToken;
    this.autoRefresh = options.autoRefresh !== false;
    this.storage = resolveAuthStorage(options.authStorage);
    this.oauthConfig = options.oauth ?? null;
    this.onSessionChanged = options.onSessionChanged ?? null;
    this.onTokenChanged = options.onTokenChanged ?? null;
    let restored: AuthState | null = null;
    try { restored = this.storage.load(); } catch { /* unavailable persistence */ }
    this.state = {
      currentUserValue: restored ? sanitizeAndClone(restored) : null,
      refreshTimer: null,
      refreshInFlightPromise: null,
      lastNotifiedToken: restored?.accessToken ?? null,
      sessionEpoch: 0,
      disposed: false,
      customToken: null,
    };
    Object.freeze(this);
    // A page that carries a sign-in result but did not start a redirect sign-in is the return page of
    // a popup. Browsers that cut the popup/opener link (Google's Cross-Origin-Opener-Policy) need it
    // forwarded explicitly, so it happens here without any code in the app.
    try {
      if (!hasPending()) completeOAuthPopup();
    } catch { /* not a browser */ }
    // A restored session is hydration, not a sign-in event: no listener emit.
    if (restored) this.scheduleRefresh();
  }

  /** Snapshot of the signed-in session, including token material (defensive copy). */
  public get currentUser(): AuthState | null {
    return this.state.currentUserValue ? sanitizeAndClone(this.state.currentUserValue) : null;
  }

  /** Safe JSON representation that never exposes token material if serialized accidentally. */
  public toJSON(): { signedIn: boolean; userId: string | null } {
    return {
      signedIn: this.state.currentUserValue !== null,
      userId: this.state.currentUserValue?.id ?? null,
    };
  }

  /** Safe string representation that never exposes token material. */
  public toString(): string {
    const userId = this.state.currentUserValue?.id ?? "null";
    return `VellumAuthClient(signedIn=${String(this.state.currentUserValue !== null)}, userId=${userId})`;
  }

  /* --------------------------------------------------------------------- */
  /* Token lifecycle                                                        */
  /* --------------------------------------------------------------------- */

  /** Schedule a silent refresh 60 s before the access JWT's `exp`. */
  private scheduleRefresh(): void {
    this.clearRefreshTimer();
    if (this.state.disposed || !this.autoRefresh) return;
    const user = this.state.currentUserValue;
    if (!user) return;
    const exp = parseJwtExp(user.accessToken);
    if (exp === null) return;
    const delayMs = Math.max(0, exp * 1000 - REFRESH_SKEW_MS - Date.now());
    this.state.refreshTimer = setTimeout(() => {
      this.state.refreshTimer = null;
      if (this.state.disposed) return;
      void this.refreshAccessToken().catch(() => undefined);
    }, delayMs);
    this.state.refreshTimer.unref?.();
  }

  private clearRefreshTimer(): void {
    if (this.state.refreshTimer !== null) {
      clearTimeout(this.state.refreshTimer);
      this.state.refreshTimer = null;
    }
  }

  private notifyAuthListeners(user: AuthState | null): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(user ? sanitizeAndClone(user) : null);
      } catch {
        // A misbehaving listener must not break an auth state transition.
      }
    }
  }

  /** Notify the realtime layer exactly once per effective bearer change. */
  private noteToken(token: string | null): void {
    if (token === this.state.lastNotifiedToken) return;
    const previous = this.state.lastNotifiedToken;
    this.state.lastNotifiedToken = token;
    if (this.onTokenChanged) this.onTokenChanged(previous, token);
  }

  private assertSession(epoch: number): void {
    if (this.state.disposed || this.state.sessionEpoch !== epoch) {
      throw Object.assign(new Error("Authentication session changed while request was pending"), { code: "SESSION_CHANGED" });
    }
  }

  private commitUser(next: AuthState, emit: boolean, advanceEpoch = true): void {
    if (this.state.disposed) return;
    if (advanceEpoch) this.state.sessionEpoch += 1;
    const cloned = sanitizeAndClone(next);
    this.state.currentUserValue = cloned;
    try {
      this.storage.save(cloned);
    } catch {
      // Persistence is best effort; the in-memory session remains authoritative.
    }
    if (advanceEpoch) this.onSessionChanged?.();
    this.scheduleRefresh();
    if (emit) this.notifyAuthListeners(cloned);
    this.noteToken(cloned.accessToken);
  }

  /**
   * Resolve a token valid for at least another 60 s for HTTP/realtime use.
   * `notify = false` is used by the initial realtime handshake: it records the
   * baseline token without emitting a redundant re-auth for the very frame
   * that is being sent.
   */
  public async getValidAccessToken(notify = true): Promise<string | null> {
    let explicit: string | null = this.state.customToken;
    if (explicit === null && this.getAuthToken) {
      try {
        explicit = await this.getAuthToken();
      } catch {
        explicit = null;
      }
    }
    let resolved: string | null = null;
    if (explicit && !isTokenExpiringWithin(explicit, REFRESH_SKEW_MS)) {
      resolved = explicit;
    } else {
      const user = this.state.currentUserValue;
      if (user) {
        const sdkToken = await this.getIdToken(false);
        if (sdkToken) resolved = sdkToken;
      }
      if (resolved === null && explicit) resolved = explicit;
    }
    if (notify) this.noteToken(resolved);
    else this.state.lastNotifiedToken = resolved;
    return resolved;
  }

  private async refreshAccessToken(): Promise<string> {
    if (this.state.refreshInFlightPromise) {
      return (await this.state.refreshInFlightPromise).accessToken;
    }
    const user = this.state.currentUserValue;
    if (this.state.disposed || !user || !user.refreshToken) {
      throw new Error("@vellumdb/sdk-js: cannot refresh without a signed-in user");
    }
    const epochAtStart = this.state.sessionEpoch;
    const task = (async (): Promise<AuthState> => {
      // Never attach the expiring bearer to the refresh call: that would
      // recurse back into getIdToken through `request`.
      const payload = await this.request<Record<string, unknown>>(
        "POST",
        "/auth/token/refresh",
        { refreshToken: user.refreshToken },
        {},
        false
      );
      if (this.state.disposed || this.state.sessionEpoch !== epochAtStart) {
        throw new Error("@vellumdb/sdk-js: session changed while refreshing token");
      }
      const latestUser = this.state.currentUserValue ?? user;
      const next: AuthState = {
        ...latestUser,
        accessToken: requiredString(payload["accessToken"], "accessToken"),
        refreshToken: requiredString(payload["refreshToken"], "refreshToken"),
        tokenType: typeof payload["tokenType"] === "string" ? payload["tokenType"] : "Bearer",
        sessionId: typeof payload["sessionId"] === "string" ? payload["sessionId"] : latestUser.sessionId,
        expiresAt: typeof payload["expiresAt"] === "string" ? payload["expiresAt"] : latestUser.expiresAt,
      };
      // Rotation does not change identity: update state without emitting.
      this.commitUser(next, false, false);
      return next;
    })();
    this.state.refreshInFlightPromise = task;
    try {
      return (await task).accessToken;
    } finally {
      if (this.state.refreshInFlightPromise === task) this.state.refreshInFlightPromise = null;
    }
  }

  /**
   * Single-flight 401 refresh coalescer: if another concurrent 401 already
   * rotated away from `staleAccessToken`, returns the fresh token immediately
   * without triggering a redundant `/auth/token/refresh` request.
   */
  public async refreshIfMatching(staleAccessToken: string | null): Promise<string | null> {
    if (this.state.disposed || !this.autoRefresh) return null;
    if (this.state.refreshInFlightPromise) {
      try {
        return (await this.state.refreshInFlightPromise).accessToken;
      } catch {
        return null;
      }
    }
    const user = this.state.currentUserValue;
    if (!user) return null;
    if (staleAccessToken !== null && user.accessToken !== staleAccessToken) {
      return user.accessToken;
    }
    try {
      return await this.refreshAccessToken();
    } catch {
      return null;
    }
  }

  /**
   * Inject an externally issued bearer (e.g. from your own auth backend). It
   * takes precedence over `getAuthToken` and the SDK session; pass `null` to
   * remove it. The realtime connection re-authenticates with the new token.
   */
  public setCustomToken(token: string | null): void {
    const previous = this.state.customToken;
    this.state.customToken = token === null || token === "" ? null : token;
    if (previous !== this.state.customToken) {
      void this.getValidAccessToken(true).catch(() => undefined);
    }
  }

  public async getIdToken(forceRefresh = false): Promise<string | null> {
    const user = this.state.currentUserValue;
    if (!user) return null;
    if (!forceRefresh && (!this.autoRefresh || !isTokenExpiringWithin(user.accessToken, REFRESH_SKEW_MS))) {
      return user.accessToken;
    }
    try {
      return await this.refreshAccessToken();
    } catch {
      return null;
    }
  }

  public onAuthStateChanged(listener: AuthStateListener): () => void {
    this.listeners.add(listener);
    // Like Firebase: the listener gets the current state right away (null when signed out), then every change.
    // Delivered on a microtask so `const stop = onAuthStateChanged(...)` has returned first, and skipped when
    // a sign-in / sign-out already delivered a newer state in between.
    const startedAt = this.state.sessionEpoch;
    queueMicrotask(() => {
      if (!this.listeners.has(listener) || this.state.disposed) return;
      if (this.state.sessionEpoch !== startedAt) return;
      try {
        listener(this.currentUser);
      } catch {
        // A misbehaving listener must not break the SDK.
      }
    });
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* --------------------------------------------------------------------- */
  /* Sign-in / sign-up                                                      */
  /* --------------------------------------------------------------------- */

  public signUpWithEmailAndPassword(input: SignUpWithEmailAndPasswordInput): Promise<AuthState>;
  public signUpWithEmailAndPassword(
    email: string,
    password: string,
    options?: SignUpEmailOptions
  ): Promise<AuthState>;
  public async signUpWithEmailAndPassword(
    inputOrEmail: SignUpWithEmailAndPasswordInput | string,
    password?: string,
    options: SignUpEmailOptions = {}
  ): Promise<AuthState> {
    const input: SignUpWithEmailAndPasswordInput =
      typeof inputOrEmail === "string"
        ? { ...options, email: inputOrEmail, password: password ?? "" }
        : inputOrEmail;
    const epoch = this.state.sessionEpoch;
    const session = parseSessionResponse(
      await this.request("POST", "/auth/sign-up/email", input, {}, false)
    );
    this.assertSession(epoch);
    this.commitUser(session, true);
    return sanitizeAndClone(session);
  }

  public signInWithEmailAndPassword(
    input: SignInWithEmailAndPasswordInput
  ): Promise<AuthState | MfaRequiredResult>;
  public signInWithEmailAndPassword(
    email: string,
    password: string
  ): Promise<AuthState | MfaRequiredResult>;
  public async signInWithEmailAndPassword(
    inputOrEmail: SignInWithEmailAndPasswordInput | string,
    password?: string
  ): Promise<AuthState | MfaRequiredResult> {
    const input: SignInWithEmailAndPasswordInput =
      typeof inputOrEmail === "string" ? { email: inputOrEmail, password: password ?? "" } : inputOrEmail;
    const epoch = this.state.sessionEpoch;
    const payload = await this.request<Record<string, unknown>>(
      "POST",
      "/auth/sign-in/email",
      input,
      {},
      false
    );
    this.assertSession(epoch);
    if (payload["mfaRequired"] === true) {
      // No session was issued: deliberately leave the current session intact.
      return parseMfaRequiredResponse(payload);
    }
    const session = parseSessionResponse(payload);
    this.commitUser(session, true);
    return sanitizeAndClone(session);
  }

  public async signInAnonymously(input: SignInAnonymouslyInput = {}): Promise<AuthState> {
    const epoch = this.state.sessionEpoch;
    const session = parseSessionResponse(
      await this.request("POST", "/auth/sign-in/anonymous", input, {}, false)
    );
    this.assertSession(epoch);
    this.commitUser(session, true);
    return sanitizeAndClone(session);
  }

  public signInWithOAuth(input: SignInWithOAuthInput): Promise<AuthState>;
  public signInWithOAuth(provider: string, payload?: SignInOAuthPayload): Promise<AuthState>;
  public async signInWithOAuth(
    providerOrInput: string | SignInWithOAuthInput,
    payload: SignInOAuthPayload = {}
  ): Promise<AuthState> {
    const input: SignInWithOAuthInput =
      typeof providerOrInput === "string" ? { ...payload, provider: providerOrInput } : providerOrInput;
    const epoch = this.state.sessionEpoch;
    const session = parseSessionResponse(
      await this.request("POST", "/auth/sign-in/provider", input, {}, false)
    );
    this.assertSession(epoch);
    this.commitUser(session, true);
    return sanitizeAndClone(session);
  }

  /* --------------------------------------------------------------------- */
  /* Google / GitHub sign-in (server-side OAuth)                            */
  /* --------------------------------------------------------------------- */

  private requireOAuth(): { baseUrl: string; apiKey: string } {
    if (!this.oauthConfig) throw new Error("Browser OAuth is not configured on this client");
    return this.oauthConfig;
  }

  private async finishOAuth(
    params: OAuthCallbackParams,
    expectedState: string,
    verifier: string
  ): Promise<AuthState | MfaRequiredResult> {
    if (params.error) {
      throw new Error(params.errorDescription ?? `Sign-in failed (${params.error})`);
    }
    if (!params.code || params.state !== expectedState) {
      throw new Error("Sign-in response did not match the request. Please try again.");
    }
    const epoch = this.state.sessionEpoch;
    const payload = await this.request<Record<string, unknown>>(
      "POST",
      "/auth/oauth/exchange",
      { code: params.code, codeVerifier: verifier },
      {},
      false
    );
    this.assertSession(epoch);
    if (payload["mfaRequired"] === true) return parseMfaRequiredResponse(payload);
    const session = parseSessionResponse(payload);
    this.commitUser(session, true);
    return sanitizeAndClone(session);
  }

  /**
   * Sign in with `"google"`, `"github"` or `"apple"` in a popup. Call it from a click
   * handler. Resolves to `MfaRequiredResult` when a second factor is needed.
   */
  public signInWithPopup(provider: string, options: OAuthPopupOptions = {}): Promise<AuthState | MfaRequiredResult> {
    return this.popupFlow(provider, options, false);
  }

  /**
   * Add a Google or GitHub sign-in to the signed-in user's account (any email). Call it from a
   * click handler. Fails if that provider account already belongs to another user.
   */
  public async linkWithPopup(provider: string, options: OAuthPopupOptions = {}): Promise<AuthState | MfaRequiredResult> {
    if (!this.state.currentUserValue) throw new Error("Sign in before linking a provider");
    return this.popupFlow(provider, options, true);
  }

  private async popupFlow(provider: string, options: OAuthPopupOptions, link: boolean): Promise<AuthState | MfaRequiredResult> {
    this.requireOAuth();
    const popup = openPopup(options);
    let flow: PreparedFlow;
    try {
      flow = await prepareFlow(this.request, provider, options.redirectUri, link, options.currentPassword);
      popup.location.href = flow.startUrl;
    } catch (error) {
      try { popup.close(); } catch { /* already closed */ }
      throw error;
    }
    // Linking is approved by typing a code into the provider page, so a link someone else sent you cannot attach
    // your account to theirs. Show the code while the popup is open.
    let hideCode: void | (() => void) = undefined;
    if (link) {
      const code = await confirmationCode(flow.challenge);
      hideCode = (options.onConfirmationCode ?? showDefaultConfirmationCode)(code);
    }
    try {
      const params = await runPopup(popup, flow, options);
      return await this.finishOAuth(params, flow.state, flow.verifier);
    } finally {
      if (typeof hideCode === "function") hideCode();
    }
  }

  /** Full-page redirect sign-in (best on mobile browsers). Finish with `getRedirectResult()` on return. */
  public async signInWithRedirect(provider: string, options: OAuthRedirectOptions = {}): Promise<void> {
    this.requireOAuth();
    const flow = await prepareFlow(this.request, provider, options.redirectUri);
    savePending({ provider, state: flow.state, verifier: flow.verifier, redirectUri: flow.redirectUri });
    (globalThis as { location: Location }).location.assign(flow.startUrl);
  }

  /**
   * Call once when your app loads. Returns `null` when the page is not the
   * return from a redirect sign-in, otherwise the session (or MFA challenge).
   */
  public async getRedirectResult(): Promise<AuthState | MfaRequiredResult | null> {
    const href = (globalThis as { location?: Location }).location?.href;
    if (!href || !hasPending()) return null;
    const params = parseCallbackParams(href);
    if (!params) return null;
    const pending = takePending();
    cleanUrl();
    if (!pending) return null;
    return this.finishOAuth(params, pending.state, pending.verifier);
  }

  /**
   * Sign in with a Google ID token you already hold (Google Identity Services
   * One Tap / button, or the `google_sign_in` Flutter package). The server
   * verifies the token against Google's keys and your configured client IDs.
   */
  public async signInWithGoogleIdToken(idToken: string, options: { nonce?: string } = {}): Promise<AuthState | MfaRequiredResult> {
    const epoch = this.state.sessionEpoch;
    const payload = await this.request<Record<string, unknown>>(
      "POST",
      "/auth/oauth/google/id-token",
      { idToken, ...(options.nonce !== undefined ? { nonce: options.nonce } : {}) },
      {},
      false
    );
    this.assertSession(epoch);
    if (payload["mfaRequired"] === true) return parseMfaRequiredResponse(payload);
    const session = parseSessionResponse(payload);
    this.commitUser(session, true);
    return sanitizeAndClone(session);
  }

  public async signInWithAppleIdToken(
    idToken: string,
    options: { nonce?: string; authorizationCode?: string; givenName?: string; familyName?: string } = {}
  ): Promise<AuthState | MfaRequiredResult> {
    const epoch = this.state.sessionEpoch;
    const payload = await this.request<Record<string, unknown>>(
      "POST",
      "/auth/oauth/apple/id-token",
      {
        idToken,
        ...(options.nonce !== undefined ? { nonce: options.nonce } : {}),
        ...(options.authorizationCode !== undefined ? { authorizationCode: options.authorizationCode } : {}),
        ...(options.givenName !== undefined ? { givenName: options.givenName } : {}),
        ...(options.familyName !== undefined ? { familyName: options.familyName } : {}),
      },
      {},
      false
    );
    this.assertSession(epoch);
    if (payload["mfaRequired"] === true) return parseMfaRequiredResponse(payload);
    const session = parseSessionResponse(payload);
    this.commitUser(session, true);
    return sanitizeAndClone(session);
  }

  /* --------------------------------------------------------------------- */
  /* MFA                                                                    */
  /* --------------------------------------------------------------------- */

  public verifyMfaChallenge(input: VerifyMfaChallengeInput): Promise<AuthState>;
  public verifyMfaChallenge(
    mfaTicket: string,
    code: string,
    factorType?: "totp" | "recovery_code"
  ): Promise<AuthState>;
  public async verifyMfaChallenge(
    ticketOrInput: string | VerifyMfaChallengeInput,
    code?: string,
    factorType?: "totp" | "recovery_code"
  ): Promise<AuthState> {
    const input: VerifyMfaChallengeInput =
      typeof ticketOrInput === "string"
        ? {
            mfaTicket: ticketOrInput,
            code: code ?? "",
            ...(factorType !== undefined ? { factorType } : {}),
          }
        : ticketOrInput;
    const epoch = this.state.sessionEpoch;
    const session = parseSessionResponse(
      await this.request("POST", "/auth/mfa/challenge", input, {}, false)
    );
    this.assertSession(epoch);
    this.commitUser(session, true);
    return sanitizeAndClone(session);
  }

  public async enrollTotpMfa(input: EnrollTotpMfaInput = {}): Promise<TotpEnrollmentResult> {
    return parseTotpEnrollmentResponse(await this.request("POST", "/auth/mfa/enroll", input));
  }

  public confirmTotpMfa(input: ConfirmTotpMfaInput): Promise<SuccessResult>;
  public confirmTotpMfa(code: string): Promise<SuccessResult>;
  public async confirmTotpMfa(codeOrInput: string | ConfirmTotpMfaInput): Promise<SuccessResult> {
    const input: ConfirmTotpMfaInput =
      typeof codeOrInput === "string" ? { code: codeOrInput } : codeOrInput;
    return parseSuccessResponse(await this.request("POST", "/auth/mfa/verify", input));
  }

  public async disableMfa(code: string): Promise<void> {
    await this.request("POST", "/auth/mfa/disable", { code });
  }

  /* --------------------------------------------------------------------- */
  /* Profile / password / email                                             */
  /* --------------------------------------------------------------------- */

  /** Fetch the latest public user record and refresh the local snapshot. */
  public async getUser(): Promise<VellumAuthUser> {
    const epoch = this.state.sessionEpoch;
    const payload = await this.request<Record<string, unknown>>("GET", "/auth/user");
    this.assertSession(epoch);
    const user = parseAuthUser(payload["user"]);
    if (this.state.currentUserValue && !this.state.disposed) {
      const merged: AuthState = sanitizeAndClone({ ...this.state.currentUserValue, ...user });
      this.state.currentUserValue = merged;
      try {
        this.storage.save(merged);
      } catch {
        // Persistence is best effort.
      }
    }
    return sanitizeAndClone(user);
  }

  public updateProfile(patch: UpdateProfileInput): Promise<VellumAuthUser>;
  public async updateProfile(patch: UpdateProfileInput): Promise<VellumAuthUser> {
    if (patch["password"] !== undefined) {
      // PATCH /auth/user ignores unknown keys. Fail loudly rather than
      // silently dropping credential material.
      throw new Error(
        "@vellumdb/sdk-js: updateProfile cannot change a password; use changePassword(currentPassword, newPassword)"
      );
    }
    const epoch = this.state.sessionEpoch;
    const payload = await this.request<Record<string, unknown>>("PATCH", "/auth/user", patch);
    this.assertSession(epoch);
    const user = parseAuthUser(payload["user"]);
    if (this.state.currentUserValue) this.commitUser({ ...this.state.currentUserValue, ...user }, true, false);
    return sanitizeAndClone(user);
  }

  public sendPasswordResetEmail(input: SendPasswordResetEmailInput): Promise<ActionTokenResult>;
  public sendPasswordResetEmail(email: string): Promise<ActionTokenResult>;
  public async sendPasswordResetEmail(
    emailOrInput: string | SendPasswordResetEmailInput
  ): Promise<ActionTokenResult> {
    const input: SendPasswordResetEmailInput =
      typeof emailOrInput === "string" ? { email: emailOrInput } : emailOrInput;
    return parseActionTokenResponse(
      await this.request("POST", "/auth/password/reset", input, {}, false)
    );
  }

  public confirmPasswordReset(input: ConfirmPasswordResetInput): Promise<SuccessResult>;
  public confirmPasswordReset(token: string, newPassword: string): Promise<SuccessResult>;
  public async confirmPasswordReset(
    tokenOrInput: string | ConfirmPasswordResetInput,
    newPassword?: string
  ): Promise<SuccessResult> {
    const input: ConfirmPasswordResetInput =
      typeof tokenOrInput === "string" ? { token: tokenOrInput, newPassword: newPassword ?? "" } : tokenOrInput;
    return parseSuccessResponse(
      await this.request("POST", "/auth/password/confirm", input, {}, false)
    );
  }

  public async listSessions(): Promise<VellumSessionInfo[]> {
    const payload = await this.request<Record<string, unknown>>("GET", "/auth/sessions");
    const list = Array.isArray(payload["sessions"]) ? (payload["sessions"] as VellumSessionInfo[]) : [];
    return sanitizeAndClone(list);
  }

  public async revokeSession(sessionId: string): Promise<void> {
    await this.request("DELETE", `/auth/sessions/${encodeURIComponent(sessionId)}`);
  }

  public async listLinkedProviders(): Promise<{ providers: VellumLinkedProvider[]; hasPassword: boolean }> {
    const payload = await this.request<Record<string, unknown>>("GET", "/auth/identities");
    const providers = Array.isArray(payload["identities"]) ? (payload["identities"] as VellumLinkedProvider[]) : [];
    return sanitizeAndClone({ providers, hasPassword: payload["hasPassword"] === true });
  }

  public async unlinkProvider(provider: string, options: { currentPassword?: string } = {}): Promise<void> {
    await this.request(
      "DELETE",
      `/auth/identities/${encodeURIComponent(provider)}`,
      options.currentPassword !== undefined ? { currentPassword: options.currentPassword } : {}
    );
  }

  /**
   * Change the signed-in user's password. Needs the current password, ends every
   * other session and keeps this one signed in with a fresh session.
   */
  public async changePassword(currentPassword: string, newPassword: string): Promise<AuthState> {
    const epoch = this.state.sessionEpoch;
    const payload = await this.request<Record<string, unknown>>("POST", "/auth/password/change", { currentPassword, newPassword });
    this.assertSession(epoch);
    const session = parseSessionResponse(payload);
    this.commitUser(session, true);
    return sanitizeAndClone(session);
  }

  /**
   * Permanently delete the signed-in account and sign out locally. Password
   * accounts must pass their `password`; accounts created with Google or GitHub need nothing extra.
   */
  public async deleteAccount(options: { password?: string } = {}): Promise<void> {
    await this.request("DELETE", "/auth/user", options.password !== undefined ? { password: options.password } : {});
    await this.signOut();
  }

  public async sendEmailVerification(input: SendEmailVerificationInput = {}): Promise<ActionTokenResult> {
    return parseActionTokenResponse(await this.request("POST", "/auth/email/verify/request", input));
  }

  public confirmEmailVerification(
    input: ConfirmEmailVerificationInput
  ): Promise<EmailVerifyConfirmResult>;
  public confirmEmailVerification(token: string): Promise<EmailVerifyConfirmResult>;
  public async confirmEmailVerification(
    tokenOrInput: string | ConfirmEmailVerificationInput
  ): Promise<EmailVerifyConfirmResult> {
    const input: ConfirmEmailVerificationInput =
      typeof tokenOrInput === "string" ? { token: tokenOrInput } : tokenOrInput;
    return parseEmailVerifyConfirmResponse(
      await this.request("POST", "/auth/email/verify/confirm", input, {}, false)
    );
  }

  /* --------------------------------------------------------------------- */
  /* Sign-out & Disposal                                                    */
  /* --------------------------------------------------------------------- */

  public async signOut(options: SignOutOptions = {}): Promise<void> {
    const user = this.state.currentUserValue;
    this.state.sessionEpoch += 1;
    this.clearRefreshTimer();
    this.state.currentUserValue = null;
    this.state.refreshInFlightPromise = null;
    this.state.lastNotifiedToken = null;
    try { this.storage.clear(); } catch { /* local state is authoritative */ }
    this.onSessionChanged?.();
    this.notifyAuthListeners(null);
    try {
      await this.request(
        "POST", "/auth/sign-out",
        options.allSessions ? {} : user?.refreshToken ? { refreshToken: user.refreshToken } : {},
        options.allSessions && user ? { authorization: `Bearer ${user.accessToken}` } : {},
        false
      );
    } catch { /* Local sign-out succeeds while offline. */ }
  }

  /** Permanently clear timers, in-memory session state, and registered listeners. */
  public dispose(): void {
    this.state.disposed = true;
    this.state.sessionEpoch += 1;
    this.clearRefreshTimer();
    this.state.currentUserValue = null;
    this.state.refreshInFlightPromise = null;
    this.state.lastNotifiedToken = null;
    this.onSessionChanged?.();
    this.listeners.clear();
  }
}
