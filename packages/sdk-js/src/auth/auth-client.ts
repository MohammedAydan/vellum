/**
 * @vellum/sdk-js - End-user authentication state machine.
 *
 * Owns the signed-in session, silent token refresh (single-flight), reactive
 * 45 s pre-flight expiry, listener notification, and pluggable session
 * persistence. HTTP concerns stay in the injected `request` function so this
 * class is fully unit-testable without a network.
 *
 * No token material is ever logged or serialized via `toJSON()` / `toString()`.
 */

import { sanitizeAndClone } from "../core/safe-json.js";
import type {
  ActionTokenResult,
  AuthState,
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
  /** Fired whenever the effective bearer changes (sign-in or token rotation). */
  onTokenChanged?: ((previousToken: string | null, nextToken: string) => void) | null;
}

export type SignUpEmailOptions = Omit<SignUpWithEmailAndPasswordInput, "email" | "password">;
export type SignInOAuthPayload = Omit<SignInWithOAuthInput, "provider">;

const REFRESH_SKEW_MS = 45_000;

interface AuthClientInternalState {
  currentUserValue: AuthState | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  refreshInFlightPromise: Promise<AuthState> | null;
  lastNotifiedToken: string | null;
  sessionEpoch: number;
  disposed: boolean;
}

export class VellumAuthClient {
  private readonly storage: AuthStorage;
  private readonly request: AuthRequest;
  private readonly getAuthToken: (() => Promise<string | null> | string | null) | null;
  private readonly onTokenChanged: ((previousToken: string | null, nextToken: string) => void) | null;
  private readonly listeners = new Set<AuthStateListener>();
  private readonly state: AuthClientInternalState;

  public constructor(options: VellumAuthClientOptions) {
    this.request = options.request;
    this.getAuthToken = options.getAuthToken;
    this.storage = resolveAuthStorage(options.authStorage);
    this.onTokenChanged = options.onTokenChanged ?? null;
    const restored = this.storage.load();
    this.state = {
      currentUserValue: restored ? sanitizeAndClone(restored) : null,
      refreshTimer: null,
      refreshInFlightPromise: null,
      lastNotifiedToken: restored?.accessToken ?? null,
      sessionEpoch: 0,
      disposed: false,
    };
    Object.freeze(this);
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

  /** Schedule a silent refresh 45 s before the access JWT's `exp`. */
  private scheduleRefresh(): void {
    this.clearRefreshTimer();
    if (this.state.disposed) return;
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
  private noteToken(token: string): void {
    if (token === this.state.lastNotifiedToken) return;
    const previous = this.state.lastNotifiedToken;
    this.state.lastNotifiedToken = token;
    if (this.onTokenChanged) this.onTokenChanged(previous, token);
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
    this.scheduleRefresh();
    if (emit) this.notifyAuthListeners(cloned);
    this.noteToken(cloned.accessToken);
  }

  /**
   * Resolve a token valid for at least another 45 s for HTTP/realtime use.
   * `notify = false` is used by the initial realtime handshake: it records the
   * baseline token without emitting a redundant re-auth for the very frame
   * that is being sent.
   */
  public async getValidAccessToken(notify = true): Promise<string | null> {
    let explicit: string | null = null;
    if (this.getAuthToken) {
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
    if (resolved !== null) {
      if (notify) this.noteToken(resolved);
      else this.state.lastNotifiedToken = resolved;
    }
    return resolved;
  }

  private async refreshAccessToken(): Promise<string> {
    if (this.state.refreshInFlightPromise) {
      return (await this.state.refreshInFlightPromise).accessToken;
    }
    const user = this.state.currentUserValue;
    if (this.state.disposed || !user || !user.refreshToken) {
      throw new Error("@vellum/sdk-js: cannot refresh without a signed-in user");
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
        throw new Error("@vellum/sdk-js: session changed while refreshing token");
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
    if (this.state.disposed) return null;
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

  public async getIdToken(forceRefresh = false): Promise<string | null> {
    const user = this.state.currentUserValue;
    if (!user) return null;
    if (!forceRefresh && !isTokenExpiringWithin(user.accessToken, REFRESH_SKEW_MS)) {
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
    const session = parseSessionResponse(
      await this.request("POST", "/auth/sign-up/email", input, {}, false)
    );
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
    const payload = await this.request<Record<string, unknown>>(
      "POST",
      "/auth/sign-in/email",
      input,
      {},
      false
    );
    if (payload["mfaRequired"] === true) {
      // No session was issued: deliberately leave the current session intact.
      return parseMfaRequiredResponse(payload);
    }
    const session = parseSessionResponse(payload);
    this.commitUser(session, true);
    return sanitizeAndClone(session);
  }

  public async signInAnonymously(input: SignInAnonymouslyInput = {}): Promise<AuthState> {
    const session = parseSessionResponse(
      await this.request("POST", "/auth/sign-in/anonymous", input, {}, false)
    );
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
    const session = parseSessionResponse(
      await this.request("POST", "/auth/sign-in/provider", input, {}, false)
    );
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
    const session = parseSessionResponse(
      await this.request("POST", "/auth/mfa/challenge", input, {}, false)
    );
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

  /* --------------------------------------------------------------------- */
  /* Profile / password / email                                             */
  /* --------------------------------------------------------------------- */

  /** Fetch the latest public user record and refresh the local snapshot. */
  public async getUser(): Promise<VellumAuthUser> {
    const payload = await this.request<Record<string, unknown>>("GET", "/auth/user");
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
      // The end-user API has no authenticated password-change endpoint:
      // PATCH /auth/user ignores unknown keys and the password reset flow is
      // the only supported way to change a password. Fail loudly rather than
      // silently dropping credential material.
      throw new Error(
        "@vellum/sdk-js: updateProfile cannot change a password; " +
          "use sendPasswordResetEmail() followed by confirmPasswordReset()"
      );
    }
    const payload = await this.request<Record<string, unknown>>("PATCH", "/auth/user", patch);
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
    try {
      if (options.allSessions === true) {
        // Omitting `refreshToken` makes the API revoke every session of the
        // authenticated end-user (it then requires the bearer identity).
        await this.request("POST", "/auth/sign-out", {}, {}, true);
      } else {
        await this.request(
          "POST",
          "/auth/sign-out",
          user?.refreshToken ? { refreshToken: user.refreshToken } : {},
          {},
          false
        );
      }
    } catch {
      // Local sign-out must succeed even if the server is unreachable.
    }
    this.state.sessionEpoch += 1;
    this.clearRefreshTimer();
    this.state.currentUserValue = null;
    this.state.refreshInFlightPromise = null;
    this.state.lastNotifiedToken = null;
    try {
      this.storage.clear();
    } catch {
      // Best effort: in-memory state is already cleared.
    }
    this.notifyAuthListeners(null);
    // Listeners stay registered so a subsequent sign-in is observed too.
  }

  /** Permanently clear timers, in-memory session state, and registered listeners. */
  public dispose(): void {
    this.state.disposed = true;
    this.state.sessionEpoch += 1;
    this.clearRefreshTimer();
    this.state.currentUserValue = null;
    this.state.refreshInFlightPromise = null;
    this.state.lastNotifiedToken = null;
    this.listeners.clear();
  }
}
