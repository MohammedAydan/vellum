import { createClient, type VellumClient } from "@vellumdb/sdk-js";
import {
  clearStoredSession,
  getSessionEpoch,
  getStoredSession,
  getStoredSessionAllowExpired,
  isSessionTokenExpiringWithin,
  safeJsonParse,
  setStoredSession,
  stripPrototypePollution,
  type UserSession,
} from "./auth.js";

declare global {
  interface Window {
    /** Runtime override (injected by the host page before app boot). */
    __VELLUM_API_BASE_URL__?: string;
  }
}

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

const REFRESH_ENDPOINT = "/v1/console/auth/refresh";
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
const RETRIED = Symbol("vellum.dashboardRetried");

export interface ApiFetchOptions extends RequestInit {
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

type RetryableInit = ApiFetchOptions & { [RETRIED]?: boolean };

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
  const baseUrl = getApiBaseUrl();
  if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
    return endpoint;
  }
  if (!baseUrl) {
    return endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  }
  const cleanBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${cleanBase}${cleanEndpoint}`;
}

/** Sign-in/sign-up must never be intercepted by session-refresh logic. */
function isAuthenticationEndpoint(endpoint: string): boolean {
  const clean = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return (
    clean.includes("/auth/sign-in") ||
    clean.includes("/auth/sign-up") ||
    clean.includes("/auth/refresh")
  );
}

function isTokenAuthError(code: string | undefined, message: string | undefined): boolean {
  return (
    code === "TOKEN_EXPIRED" ||
    message === RAW_TOKEN_ERROR ||
    message === "TOKEN_EXPIRED"
  );
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
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
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

// Client cache per project
const clientCache = new Map<string, VellumClient>();

/** Clear cached SDK clients and in-flight refresh state during logout/teardown. */
export function resetApiClientState(): void {
  clientCache.clear();
  refreshInFlight = null;
}

function failSession(): never {
  resetApiClientState();
  clearStoredSession();
  if (typeof window !== "undefined") window.location.assign("/login");
  // Always throw the friendly message — never the raw server error.
  throw new Error(SESSION_EXPIRED_MESSAGE);
}

/** Persist a sliding-renewal token emitted by any response header if epoch still matches. */
function captureRefreshedHeader(res: Response, expectedEpoch: number): void {
  if (getSessionEpoch() !== expectedEpoch) return;
  const headers = res?.headers;
  const get = headers && typeof headers.get === "function" ? headers.get.bind(headers) : null;
  const refreshed = get ? get("x-refreshed-session-token") : null;
  if (!refreshed) return;
  const session = getStoredSessionAllowExpired();
  if (!session) return;
  setStoredSession({ ...session, token: refreshed });
}

function persistRefreshPayload(payload: Record<string, unknown>, expectedEpoch: number): string | null {
  if (getSessionEpoch() !== expectedEpoch) return null;
  const current = getStoredSessionAllowExpired();
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
  const next: UserSession = {
    ...current,
    token: nextToken,
    ...(typeof newRefreshToken === "string" && newRefreshToken ? { refreshToken: newRefreshToken } : {}),
    ...(typeof newExpiresAt === "string" ? { expiresAt: newExpiresAt } : {}),
    ...(newUser && typeof newUser === "object" ? { user: newUser as UserSession["user"] } : {}),
  };
  if (getSessionEpoch() !== expectedEpoch) return null;
  setStoredSession(next);
  return nextToken;
}

/**
 * Silent, single-flight console session refresh. Returns the new access token
 * or `null` when no refresh token exists / the refresh was rejected / logout
 * invalidated the session epoch while in flight.
 */
export function refreshSessionToken(): Promise<string | null> {
  const currentEpoch = getSessionEpoch();
  if (refreshInFlight && refreshInFlight.epoch === currentEpoch) {
    return refreshInFlight.promise;
  }
  const refreshToken = getStoredSessionAllowExpired()?.refreshToken;
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
      if (!res.ok || getSessionEpoch() !== currentEpoch) return null;
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
  const fallback = `Request failed with status ${res.status}`;
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

export function getVellumClient(projectId: string, apiKey: string): VellumClient {
  const baseUrl = getApiBaseUrl();
  const cacheKey = `${projectId}:${apiKey}:${baseUrl}`;
  const existing = clientCache.get(cacheKey);
  if (existing) return existing;

  const client = createClient({
    projectId,
    apiKey,
    endpoint: baseUrl || (typeof window !== "undefined" ? window.location.origin : "http://localhost:8080"),
    getAuthToken: async () => {
      const session = getStoredSession();
      return session?.token ?? null;
    },
  });

  clientCache.set(cacheKey, client);
  return client;
}


// Typed control plane REST client
export async function apiFetch<T>(
  endpoint: string,
  options: ApiFetchOptions = {}
): Promise<T> {
  const url = resolveEndpointUrl(endpoint);
  const isAuthEndpoint = isAuthenticationEndpoint(endpoint);
  const initialInit = options as RetryableInit;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_GET_RETRIES;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const allowTransientRetry = !isAuthEndpoint && isIdempotentGet(options.method);

  // ---- Pre-flight: renew an access token that expires within 45 s (or has
  // already expired) before sending the request, using the still-valid refresh
  // token. This is what prevents the "Invalid, expired, or revoked session
  // token" error from ever reaching the user in normal use.
  let session = getStoredSession();
  if (!isAuthEndpoint && session?.token && isSessionTokenExpiringWithin(session.token, PREFLIGHT_SKEW_MS)) {
    if (!(await refreshSessionToken())) failSession();
    session = getStoredSession();
  }

  const requestEpoch = getSessionEpoch();
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }
  const bearer = session?.token ?? getStoredSessionAllowExpired()?.token;
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

  // ---- Reactive 401: force one deduped refresh, then replay the exact
  // original request once with the new Bearer token.
  const canRefresh =
    !isAuthEndpoint &&
    getSessionEpoch() === requestEpoch &&
    Boolean(getStoredSessionAllowExpired()?.refreshToken);
  if (!res.ok && !initialInit[RETRIED] && canRefresh) {
    const details = await readErrorDetails(res);
    if (res.status === 401 || isTokenAuthError(details.code, details.message)) {
      const newToken = await refreshSessionToken();
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

  return parseResponseJson<T>(res);
}

/**
 * Session-authenticated Console API client.
 *
 * The public document plane (`/v1/projects/:id/...`) is API-key only
 * and can no longer be called with a Bearer session token. Every dashboard
 * data-plane call must go through `/v1/console/...`, which is guarded by the
 * session middleware and performs org-membership checks plus auditing.
 */
export function consoleFetch<T>(
  endpoint: string,
  options: ApiFetchOptions = {}
): Promise<T> {
  const clean = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return apiFetch<T>(`/v1/console${clean}`, options);
}

export function consoleProjectsBase(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

export interface CompileRulesResult {
  ok: boolean;
  status: number;
  ast?: unknown;
  diagnostics?: unknown;
  errorPayload?: unknown;
  errorMessage?: string;
}

function extractErrorDetailsFromPayload(
  payload: unknown,
  status: number
): ErrorDetails {
  const fallback = `Request failed with status ${status}`;
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error: unknown }).error;
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

/**
 * Compile and validate Security Rules DSL via the dashboard API client.
 * Surfaces both successful AST/diagnostics payloads and structured 4xx error
 * bodies (e.g. `line`, `column`, `snippet`) in a single authenticated request.
 */
export async function compileProjectRules(
  endpoint: string,
  source: string,
  options: Omit<ApiFetchOptions, "method" | "body"> = {}
): Promise<CompileRulesResult> {
  const url = resolveEndpointUrl(endpoint);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const body = JSON.stringify({ source });

  let session = getStoredSession();
  if (session?.token && isSessionTokenExpiringWithin(session.token, PREFLIGHT_SKEW_MS)) {
    if (!(await refreshSessionToken())) failSession();
    session = getStoredSession();
  }

  const requestEpoch = getSessionEpoch();
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const bearer = session?.token ?? getStoredSessionAllowExpired()?.token;
  if (bearer && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${bearer}`);
  }

  const fetchInit: RetryableInit = {
    ...options,
    method: "POST",
    credentials: options.credentials ?? "include",
    headers,
    body,
  };
  let res = await fetchWithTimeout(url, toFetchInit(fetchInit), timeoutMs);
  captureRefreshedHeader(res, requestEpoch);

  if (res.ok) {
    const data = await parseResponseJson<{ ast?: unknown; diagnostics?: unknown }>(res);
    return {
      ok: true,
      status: res.status,
      ast: data?.ast,
      diagnostics: data?.diagnostics,
    };
  }

  let errorPayload: unknown = null;
  try {
    errorPayload = await parseResponseJson<unknown>(res);
  } catch {
    errorPayload = null;
  }
  let details = extractErrorDetailsFromPayload(errorPayload, res.status);

  const canRefresh =
    getSessionEpoch() === requestEpoch &&
    Boolean(getStoredSessionAllowExpired()?.refreshToken);
  if (canRefresh && (res.status === 401 || isTokenAuthError(details.code, details.message))) {
    const newToken = await refreshSessionToken();
    if (!newToken) failSession();
    const retryHeaders = new Headers(headers);
    retryHeaders.set("Authorization", `Bearer ${newToken}`);
    const retryInit: RetryableInit = {
      ...fetchInit,
      [RETRIED]: true,
      headers: retryHeaders,
    };
    res = await fetchWithTimeout(url, toFetchInit(retryInit), timeoutMs);
    captureRefreshedHeader(res, requestEpoch);

    if (res.ok) {
      const data = await parseResponseJson<{ ast?: unknown; diagnostics?: unknown }>(res);
      return {
        ok: true,
        status: res.status,
        ast: data?.ast,
        diagnostics: data?.diagnostics,
      };
    }

    try {
      errorPayload = await parseResponseJson<unknown>(res);
    } catch {
      errorPayload = null;
    }
    details = extractErrorDetailsFromPayload(errorPayload, res.status);
  }

  if (isTokenAuthError(details.code, details.message)) failSession();

  return {
    ok: false,
    status: res.status,
    errorPayload,
    errorMessage: details.message,
  };
}

export interface ConsoleQueryResponse<TDoc = Record<string, unknown>> {
  documents: TDoc[];
  nextCursor: string | null;
  meta: {
    count: number;
    indexUsed: string;
    executionTimeMs: number;
    compiledSql: string;
  };
}

export interface ConsoleDocument {
  id: string;
  path?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  data: Record<string, unknown>;
}

export interface ConsoleIndex {
  id: string;
  collectionPath?: string;
  collection?: string;
  fields: Array<{ path: string; dir: "asc" | "desc" }>;
  status?: "BUILDING" | "READY" | "FAILED" | "building" | "ready" | "failed";
  entriesCount?: number;
  createdAt?: string;
}

export interface ConsoleApiKey {
  id: string;
  name: string;
  keyType: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  scopes?: string[];
}

export interface ConsoleRuleset {
  id?: string;
  version: number;
  rulesAst: { version: number; rules: unknown[] } | null;
  projectId?: string;
}

export type RelationRuleOnDelete = "cascade" | "set_null" | "restrict";

export interface ConsoleRelationRule {
  collection: string;
  field: string;
  targetCollection?: string | null;
  onDelete: RelationRuleOnDelete;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface RelationRulesResponse {
  projectId: string;
  version: number;
  rules: ConsoleRelationRule[];
}

export interface ReplaceRelationRulesBody {
  rules: Array<{
    collection: string;
    field: string;
    targetCollection?: string | null;
    onDelete: RelationRuleOnDelete;
  }>;
  expectedVersion?: number | null;
}

export function relationRulesEndpoint(projectId: string): string {
  return `/v1/projects/${encodeURIComponent(projectId)}/relation-rules`;
}

/** Session-authenticated read of a project's referential-integrity rules. */
export function fetchRelationRules(projectId: string): Promise<RelationRulesResponse> {
  return apiFetch<RelationRulesResponse>(relationRulesEndpoint(projectId));
}

/**
 * Full-replacement write guarded by optimistic concurrency: the server rejects
 * the write with 409 when `expectedVersion` no longer matches.
 */
export function replaceRelationRules(
  projectId: string,
  body: ReplaceRelationRulesBody
): Promise<RelationRulesResponse> {
  const options: ApiFetchOptions = {
    method: "PUT",
    body: JSON.stringify(body),
  };
  if (body.expectedVersion !== undefined && body.expectedVersion !== null) {
    options.headers = { "If-Match": String(body.expectedVersion) };
  }
  return apiFetch<RelationRulesResponse>(relationRulesEndpoint(projectId), options);
}
