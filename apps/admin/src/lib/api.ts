import {
  clearStoredAdminSession,
  getAdminSessionEpoch,
  getStoredAdminSession,
  getStoredAdminSessionAllowExpired,
  isAdminTokenExpiringWithin,
  safeJsonParse,
  setStoredAdminSession,
  stripPrototypePollution,
  type AdminSession,
} from "./auth.js";

declare global {
  interface Window {
    /** Runtime override (injected by the host page before app boot). */
    __VELLUM_API_BASE_URL__?: string;
  }
}

/**
 * Resolve the backend base URL at request time so a host-page runtime override
 * is honored. Precedence: runtime VELLUM global -> legacy VELLUM global ->
 * build-time VITE_API_BASE_URL -> current origin (or localhost fallback off-window).
 */
export function getApiBaseUrl(): string {
  if (typeof window !== "undefined") {
    if (window.__VELLUM_API_BASE_URL__ !== undefined) {
      return window.__VELLUM_API_BASE_URL__;
    }
    const configuredBaseUrl = import.meta.env["VITE_API_BASE_URL"];
    if (configuredBaseUrl !== undefined && configuredBaseUrl !== null && configuredBaseUrl !== "") {
      return configuredBaseUrl;
    }
    return window.location.origin;
  }
  return import.meta.env["VITE_API_BASE_URL"] || "http://localhost:8080";
}

/**
 * Strict Privacy Assertion: Platform administrators must NEVER fetch or render customer documents.data.
 * This assertion validates that no endpoint requests document payloads, and no returned JSON payload
 * contains raw customer document contents or fields.
 */
export function assertPrivacySafeEndpoint(endpoint: string): void {
  const normalized = endpoint.toLowerCase();
  if (
    (normalized.includes("/documents") && !normalized.includes("/metadata") && !normalized.includes("/count")) ||
    normalized.includes("/query") ||
    normalized.includes("/documents.data")
  ) {
    throw new Error(
      "[Vellum Admin Privacy Invariant] Platform operator UI is strictly forbidden from requesting customer documents.data"
    );
  }
}

export function assertNoCustomerPayload(obj: unknown, depth = 0): void {
  if (depth > 6 || obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      assertNoCustomerPayload(item, depth + 1);
    }
    return;
  }
  const record = obj as Record<string, unknown>;
  // Forbid document body payloads
  if ("data" in record && typeof record["data"] === "object" && record["data"] !== null && "id" in record && "version" in record) {
    throw new Error(
      "[Vellum Admin Privacy Invariant] Runtime assertion violated: customer document payload detected in response data"
    );
  }
  for (const value of Object.values(record)) {
    assertNoCustomerPayload(value, depth + 1);
  }
}

const REFRESH_ENDPOINT = "/v1/admin/auth/session/refresh";
const PREFLIGHT_SKEW_MS = 45_000;
const SESSION_EXPIRED_MESSAGE = "Session expired, please sign in again";
const RAW_TOKEN_ERROR = "Invalid, expired, or revoked session token";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const TRANSIENT_RETRY_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_MAX_GET_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;
const MAX_ERROR_MESSAGE_LENGTH = 300;

const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const JWT_TOKEN_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;
const SECRET_PARAM_RE = /\b(access_?token|refresh_?token|session_?token|api_?key|authorization|secret)\s*[:=]\s*[^\s,;'"`]+/gi;

/** Redact bearer tokens, JWTs, and secret parameters from any error message. */
export function sanitizeErrorMessage(message: string): string {
  const cleaned = message
    .replace(BEARER_TOKEN_RE, "Bearer [REDACTED]")
    .replace(JWT_TOKEN_RE, "[REDACTED_TOKEN]")
    .replace(SECRET_PARAM_RE, "$1=[REDACTED]")
    .trim();
  if (cleaned.length > MAX_ERROR_MESSAGE_LENGTH) {
    return `${cleaned.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...`;
  }
  return cleaned;
}

/** One shared refresh promise + epoch so concurrent 401s coalesce and logout cancels persistence. */
let refreshInFlight: { promise: Promise<string | null>; epoch: number } | null = null;
const RETRIED = Symbol("vellum.adminRetried");

export interface AdminFetchOptions extends RequestInit {
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

type RetryableInit = AdminFetchOptions & { [RETRIED]?: boolean };

/** Strip internal markers/tuning fields before handing the init object to `fetch`. */
function toFetchInit(init: RetryableInit): RequestInit {
  const {
    timeoutMs: _timeoutMs,
    maxRetries: _maxRetries,
    retryBaseDelayMs: _retryBaseDelayMs,
    ...rest
  } = init;
  const clean: RequestInit & { [RETRIED]?: boolean } = { ...rest };
  delete clean[RETRIED];
  return clean;
}

function resolveEndpointUrl(endpoint: string): string {
  return endpoint.startsWith("http") ? endpoint : `${getApiBaseUrl()}${endpoint}`;
}

/** Sign-in / setup / refresh must never be intercepted by session-refresh logic. */
function isAuthenticationEndpoint(endpoint: string): boolean {
  const clean = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return (
    clean.includes("/admin/login") ||
    clean.includes("/admin/setup-owner") ||
    clean.includes("/admin/setup-status") ||
    clean.includes("/admin/session/refresh") ||
    clean.includes("/admin/auth/session/refresh")
  );
}

function isTokenAuthError(code: string | undefined, message: string | undefined): boolean {
  return code === "TOKEN_EXPIRED" || message === RAW_TOKEN_ERROR || message === "TOKEN_EXPIRED";
}

function isIdempotentGet(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}

function parseRetryAfterMs(res: Response): number | null {
  const headers = res?.headers;
  const raw = headers && typeof headers.get === "function" ? headers.get("retry-after") : null;
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_DELAY_MS);
  }
  return null;
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Request aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof AbortController === "undefined") {
    return fetch(url, init);
  }
  const controller = new AbortController();
  const externalSignal = init.signal;
  if (externalSignal?.aborted) {
    controller.abort(externalSignal.reason);
  }
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  const timer = setTimeout(() => {
    controller.abort(new Error(`Admin request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

async function fetchWithTransientRetry(
  url: string,
  init: RequestInit,
  options: {
    timeoutMs: number;
    allowRetry: boolean;
    maxRetries: number;
    retryBaseDelayMs: number;
  }
): Promise<Response> {
  const attempts = options.allowRetry ? Math.max(0, options.maxRetries) : 0;
  let attempt = 0;

  while (true) {
    const res = await fetchWithTimeout(url, init, options.timeoutMs);
    if (!options.allowRetry || attempt >= attempts || !TRANSIENT_RETRY_STATUSES.has(res.status)) {
      return res;
    }
    const retryAfterMs = parseRetryAfterMs(res);
    const backoffMs = Math.min(options.retryBaseDelayMs * 2 ** attempt, MAX_RETRY_DELAY_MS);
    const delayMs = retryAfterMs !== null ? retryAfterMs : backoffMs;
    attempt += 1;
    await sleep(delayMs, init.signal);
  }
}

async function parseResponseJson<T>(res: Response): Promise<T> {
  if (typeof res.text === "function") {
    const raw = await res.text();
    if (!raw) return undefined as T;
    return safeJsonParse<T>(raw);
  }
  return stripPrototypePollution((await res.json()) as T);
}

/** Clear in-flight admin refresh state during logout/teardown. */
export function resetAdminApiClientState(): void {
  refreshInFlight = null;
}

function failSession(): never {
  resetAdminApiClientState();
  clearStoredAdminSession();
  // Raw browser navigation is NOT basepath-aware: use the full /admin prefix so
  // a session expiry cannot land on the Customer Dashboard at `/`.
  if (typeof window !== "undefined") window.location.assign("/admin/login");
  // Always throw the friendly message — never the raw server error.
  throw new Error(SESSION_EXPIRED_MESSAGE);
}

/** Persist a sliding-renewal token emitted by any response header if epoch still matches. */
function captureRefreshedHeader(res: Response, expectedEpoch: number): void {
  if (getAdminSessionEpoch() !== expectedEpoch) return;
  const headers = res?.headers;
  const get = headers && typeof headers.get === "function" ? headers.get.bind(headers) : null;
  const refreshed = get ? get("x-refreshed-session-token") : null;
  if (!refreshed) return;
  const session = getStoredAdminSessionAllowExpired();
  if (!session) return;
  setStoredAdminSession({ ...session, token: refreshed });
}

function persistRefreshPayload(payload: Record<string, unknown>, expectedEpoch: number): string | null {
  if (getAdminSessionEpoch() !== expectedEpoch) return null;
  const current = getStoredAdminSessionAllowExpired();
  if (!current) return null;
  const cleanPayload = stripPrototypePollution(payload);
  const accessToken = cleanPayload["accessToken"];
  const legacyToken = cleanPayload["token"];
  const nextToken =
    typeof accessToken === "string" && accessToken
      ? accessToken
      : typeof legacyToken === "string" && legacyToken
        ? legacyToken
        : null;
  if (!nextToken) return null;
  const newRefreshToken = cleanPayload["refreshToken"];
  const newExpiresAt = cleanPayload["expiresAt"];
  const newUser = cleanPayload["user"];
  const next: AdminSession = {
    ...current,
    token: nextToken,
    ...(typeof newRefreshToken === "string" && newRefreshToken ? { refreshToken: newRefreshToken } : {}),
    ...(typeof newExpiresAt === "string" ? { expiresAt: newExpiresAt } : {}),
    ...(newUser && typeof newUser === "object" ? { user: newUser as AdminSession["user"] } : {}),
  };
  if (getAdminSessionEpoch() !== expectedEpoch) return null;
  setStoredAdminSession(next);
  return nextToken;
}

/**
 * Silent, single-flight super-admin session refresh. Returns the new access
 * token or `null` when no refresh token exists / the refresh was rejected /
 * logout invalidated the session epoch while in flight.
 */
export function refreshAdminSessionToken(): Promise<string | null> {
  const currentEpoch = getAdminSessionEpoch();
  if (refreshInFlight && refreshInFlight.epoch === currentEpoch) {
    return refreshInFlight.promise;
  }
  const refreshToken = getStoredAdminSessionAllowExpired()?.refreshToken;
  if (!refreshToken) return Promise.resolve(null);

  const task = (async (): Promise<string | null> => {
    try {
      const res = await fetchWithTimeout(
        resolveEndpointUrl(REFRESH_ENDPOINT),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        },
        DEFAULT_REQUEST_TIMEOUT_MS
      );
      if (!res.ok || getAdminSessionEpoch() !== currentEpoch) return null;
      const body = await parseResponseJson<Record<string, unknown>>(res);
      if (!body || typeof body !== "object") return null;
      return persistRefreshPayload(body, currentEpoch);
    } catch {
      return null;
    }
  })();

  const entry = { promise: task, epoch: currentEpoch };
  refreshInFlight = entry;
  void task
    .finally(() => {
      if (refreshInFlight === entry) refreshInFlight = null;
    })
    .catch(() => undefined);
  return task;
}

interface ErrorDetails {
  message: string;
  code?: string;
}

async function readErrorDetails(res: Response): Promise<ErrorDetails> {
  const fallback = `Admin request failed with status ${res.status}`;
  let details: unknown = null;
  try {
    details = await parseResponseJson<unknown>(res);
  } catch {
    details = null;
  }
  if (typeof details === "object" && details !== null && "error" in details) {
    const error = (details as { error: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const record = error as { message?: unknown; code?: unknown };
      return {
        message: typeof record.message === "string" ? sanitizeErrorMessage(record.message) : fallback,
        ...(typeof record.code === "string" ? { code: record.code } : {}),
      };
    }
  }
  return { message: fallback };
}

export async function adminFetch<T>(
  endpoint: string,
  options: AdminFetchOptions = {}
): Promise<T> {
  assertPrivacySafeEndpoint(endpoint);

  const url = resolveEndpointUrl(endpoint);
  const isAuthEndpoint = isAuthenticationEndpoint(endpoint);
  const initialInit = options as RetryableInit;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_GET_RETRIES;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const allowTransientRetry = !isAuthEndpoint && isIdempotentGet(options.method);

  // ---- Pre-flight: renew an access token expiring within 45 s (or expired).
  let session = getStoredAdminSession();
  if (!isAuthEndpoint && session?.token && isAdminTokenExpiringWithin(session.token, PREFLIGHT_SKEW_MS)) {
    if (!(await refreshAdminSessionToken())) failSession();
    session = getStoredAdminSession();
  }

  const requestEpoch = getAdminSessionEpoch();
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }
  const bearer = session?.token ?? getStoredAdminSessionAllowExpired()?.token;
  if (bearer && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${bearer}`);
  }

  const fetchInit: RetryableInit = { ...options, headers };
  let res = await fetchWithTransientRetry(url, toFetchInit(fetchInit), {
    timeoutMs,
    allowRetry: allowTransientRetry,
    maxRetries,
    retryBaseDelayMs,
  });
  captureRefreshedHeader(res, requestEpoch);

  // ---- Reactive 401: force one deduped refresh, then replay exactly once.
  const canRefresh =
    !isAuthEndpoint &&
    getAdminSessionEpoch() === requestEpoch &&
    Boolean(getStoredAdminSessionAllowExpired()?.refreshToken);
  if (!res.ok && !initialInit[RETRIED] && canRefresh) {
    const details = await readErrorDetails(res);
    if (res.status === 401 || isTokenAuthError(details.code, details.message)) {
      const newToken = await refreshAdminSessionToken();
      if (!newToken) failSession();
      const retryHeaders = new Headers(headers);
      retryHeaders.set("Authorization", `Bearer ${newToken}`);
      const retryInit: RetryableInit = {
        ...options,
        [RETRIED]: true,
        headers: retryHeaders,
      };
      res = await fetchWithTransientRetry(url, toFetchInit(retryInit), {
        timeoutMs,
        allowRetry: allowTransientRetry,
        maxRetries,
        retryBaseDelayMs,
      });
      captureRefreshedHeader(res, requestEpoch);
    } else {
      throw new Error(details.message);
    }
  }

  if (!res.ok) {
    const details = await readErrorDetails(res);
    if (isTokenAuthError(details.code, details.message)) failSession();
    throw new Error(details.message);
  }

  const data = await parseResponseJson<T>(res);
  assertNoCustomerPayload(data);
  return data;
}
