/**
 * @vellumdb/sdk-js - Hardened HTTP Transport
 *
 * Encapsulates:
 * - Per-request `AbortController` timeout composed with caller `AbortSignal`
 * - Full-jitter + `Retry-After` retry policy restricted to idempotent requests
 * - Single-flight reactive 401 token refresh & single replay
 * - Prototype-pollution-safe JSON response parsing
 * - Bounded index-advisor header inspection
 * - Secret redaction (`private readonly` API key + safe `toJSON()`/`toString()`)
 */

import { normalizeEndpoint, validateProjectConfig } from "./config.js";
import type { IndexSuggestionEvent } from "../types.js";
import { computeReconnectBackoffMs, createAbortError, parseRetryAfterMs, sleepWithSignal } from "./backoff.js";
import { encodePathSegment, safeJsonParse, sanitizeAndClone } from "./safe-json.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 10_000;
const MAX_INDEX_FINGERPRINTS = 512;

/** Deterministic, dependency-free fallback fingerprint (FNV-1a, 32-bit). */
function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getResponseHeader(res: Response, name: string): string | null {
  try {
    const headers: unknown = res?.headers;
    if (!isPlainRecord(headers) || typeof headers["get"] !== "function") return null;
    const get = (headers["get"] as (headerName: string) => string | null).bind(headers);
    const val = get(name);
    return typeof val === "string" ? val : null;
  } catch {
    return null;
  }
}

function hasIdempotencyKey(headers: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if ((lower === "idempotency-key" || lower === "x-idempotency-key") && value.trim().length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Determine whether an HTTP request is safe to automatically retry on transient
 * network/429/5xx failures. Non-idempotent writes are NEVER retried unless an
 * explicit `Idempotency-Key` / `X-Idempotency-Key` header is supplied.
 */
export function isRetriableRequest(method: string, relativePath: string, headers: Record<string, string>): boolean {
  const upper = method.toUpperCase();
  const pathOnly = relativePath.split("?")[0] ?? relativePath;
  if (upper === "GET" || upper === "HEAD" || upper === "OPTIONS") return true;
  if (upper === "POST" && (pathOnly === "/query" || pathOnly === "/documents:aggregate")) {
    return true;
  }
  return hasIdempotencyKey(headers);
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function parseResponsePayload(res: Response): Promise<unknown> {
  if (typeof res.text === "function") {
    const rawText = await res.text();
    if (!rawText || rawText.trim().length === 0) return {};
    try {
      return safeJsonParse(rawText);
    } catch {
      // A 2xx with an unparseable body must not be treated as a successful
      // empty payload (that would silently turn a corrupt response into an
      // empty query result). Error responses keep the {} fallback so the
      // status-derived error below still fires.
      if (res.ok) {
        throw Object.assign(new Error("@vellumdb/sdk-js: malformed JSON in successful response"), {
          code: "MALFORMED_RESPONSE",
          status: res.status,
        });
      }
      return {};
    }
  }
  if (typeof res.json === "function") {
    try {
      return sanitizeAndClone(await res.json());
    } catch {
      return {};
    }
  }
  return {};
}

export interface HttpAuthHooks {
  getSessionEpoch?(): number;
  getValidAccessToken(): Promise<string | null>;
  hasRefreshToken(): boolean;
  refreshIfMatching(staleAccessToken: string | null): Promise<string | null>;
}

export interface HttpTransportOptions {
  projectId: string;
  apiKey: string;
  endpoint?: string;
  customFetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryRandomFn?: (() => number) | null;
  warnOnMissingIndexes?: boolean;
  onIndexSuggestion?: ((event: IndexSuggestionEvent) => void) | null;
}

export class HttpTransport {
  private readonly projectId: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly baseUrl: string;
  private readonly customFetch: typeof globalThis.fetch;
  private readonly effectiveTimeoutMs: number;
  private readonly effectiveMaxRetries: number;
  private readonly effectiveRetryBaseMs: number;
  private readonly effectiveRetryMaxMs: number;
  private readonly retryRandom: () => number;
  private readonly warnOnMissingIndexes: boolean;
  private readonly onIndexSuggestion: ((event: IndexSuggestionEvent) => void) | null;
  private readonly authState: { hooks: HttpAuthHooks | null } = { hooks: null };
  private readonly seenIndexFingerprints = new Set<string>();

  public constructor(options: HttpTransportOptions) {
    validateProjectConfig(options.projectId, options.apiKey);
    this.projectId = options.projectId;
    this.apiKey = options.apiKey;
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.baseUrl = `${this.endpoint}/v1/projects/${encodePathSegment(options.projectId, "projectId")}`;
    this.customFetch = options.customFetch ?? globalThis.fetch;

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS;
    const retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_MS;

    this.effectiveTimeoutMs = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 0;
    this.effectiveMaxRetries =
      typeof maxRetries === "number" && Number.isFinite(maxRetries) && maxRetries >= 0 ? Math.floor(maxRetries) : DEFAULT_MAX_RETRIES;
    this.effectiveRetryBaseMs =
      typeof retryBaseDelayMs === "number" && retryBaseDelayMs > 0 ? retryBaseDelayMs : DEFAULT_RETRY_BASE_MS;
    this.effectiveRetryMaxMs =
      typeof retryMaxDelayMs === "number" && retryMaxDelayMs >= this.effectiveRetryBaseMs
        ? retryMaxDelayMs
        : DEFAULT_RETRY_MAX_MS;
    this.retryRandom = options.retryRandomFn ?? Math.random;
    this.warnOnMissingIndexes = options.warnOnMissingIndexes ?? true;
    this.onIndexSuggestion = options.onIndexSuggestion ?? null;
    Object.freeze(this);
  }

  /** Attach the auth state machine hooks once constructed. */
  public setAuthHooks(hooks: HttpAuthHooks): void {
    this.authState.hooks = hooks;
  }

  /** Safe JSON representation that never exposes API keys or tokens. */
  public toJSON(): { projectId: string; endpoint: string } {
    return {
      projectId: this.projectId,
      endpoint: this.endpoint,
    };
  }

  /** Safe string representation that never exposes API keys or tokens. */
  public toString(): string {
    return `HttpTransport(projectId=${this.projectId}, endpoint=${this.endpoint})`;
  }

  /**
   * Instance-scoped bounded dedupe set (max 512 entries) for index-advisor
   * suggestions, preventing unbounded growth without module-level mutable state.
   */
  private rememberIndexFingerprint(fingerprint: string): boolean {
    if (this.seenIndexFingerprints.has(fingerprint)) return false;
    if (this.seenIndexFingerprints.size >= MAX_INDEX_FINGERPRINTS) {
      const oldest = this.seenIndexFingerprints.values().next().value;
      if (typeof oldest === "string") this.seenIndexFingerprints.delete(oldest);
    }
    this.seenIndexFingerprints.add(fingerprint);
    return true;
  }

  /**
   * Read the index-advisor response headers on EVERY HTTP response, before the
   * JSON body is consumed. Advisory only: failures here never affect the call.
   */
  private inspectIndexHeaders(res: Response): void {
    try {
      const urlHeader = getResponseHeader(res, "x-vellum-index-url");
      const url = typeof urlHeader === "string" ? urlHeader : "";
      const suggestionHeader = getResponseHeader(res, "x-vellum-index-suggestion");
      if (!url && !suggestionHeader) return;

      let suggestion: unknown = null;
      if (suggestionHeader) {
        try {
          suggestion = safeJsonParse<unknown>(suggestionHeader);
        } catch {
          suggestion = null;
        }
      }

      if (this.onIndexSuggestion) {
        try {
          this.onIndexSuggestion({ url, suggestion });
        } catch {
          // A throwing hook must never break the underlying request.
        }
      }

      if (!this.warnOnMissingIndexes) return;

      const suggestionRecord = isPlainRecord(suggestion) ? suggestion : null;
      const fingerprint =
        suggestionRecord && typeof suggestionRecord["fingerprint"] === "string" && suggestionRecord["fingerprint"]
          ? suggestionRecord["fingerprint"]
          : hashString(url || suggestionHeader || "");
      if (!this.rememberIndexFingerprint(fingerprint)) return;

      const collectionPath =
        suggestionRecord && typeof suggestionRecord["collectionPath"] === "string"
          ? suggestionRecord["collectionPath"]
          : "unknown collection";
      const reason =
        suggestionRecord && typeof suggestionRecord["reason"] === "string"
          ? suggestionRecord["reason"]
          : "Composite index needed for this query.";
      // Only server-generated advisor fields are printed — never headers in
      // bulk, request bodies, API keys or bearer tokens.
      console.warn(
        [
          `[VELLUM Index Advisor] Slow/unindexed query detected on "${collectionPath}".`,
          `Reason: ${reason}`,
          `Create this index in 1 click: ${url}`,
        ].join("\n")
      );
    } catch {
      // Index suggestions are advisory; they must never break a request.
    }
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    callerSignal?: AbortSignal
  ): Promise<Response> {
    if (callerSignal?.aborted) {
      throw createAbortError(callerSignal);
    }

    if (this.effectiveTimeoutMs <= 0 || typeof AbortController !== "function") {
      if (!callerSignal) {
        return this.customFetch(url, init);
      }
      try {
        return await this.customFetch(url, { ...init, signal: callerSignal });
      } catch (err: unknown) {
        if (callerSignal.aborted) {
          throw createAbortError(callerSignal);
        }
        throw err;
      }
    }

    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;

    const onCallerAbort = (): void => {
      callerAborted = true;
      controller.abort();
    };
    if (callerSignal) {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.effectiveTimeoutMs);
    timer.unref?.();

    try {
      return await this.customFetch(url, { ...init, signal: controller.signal });
    } catch (err: unknown) {
      if (callerAborted || callerSignal?.aborted) {
        throw createAbortError(callerSignal);
      }
      if (timedOut) {
        const timeoutErr = new Error(
          `@vellumdb/sdk-js: request timed out after ${this.effectiveTimeoutMs}ms`
        ) as Error & { code?: string; status?: number };
        timeoutErr.code = "REQUEST_TIMEOUT";
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (callerSignal) {
        callerSignal.removeEventListener("abort", onCallerAbort);
      }
    }
  }

  public async request<R = unknown>(
    method: string,
    relativePath: string,
    body: unknown = undefined,
    extraHeaders: Record<string, string> = {},
    includeAuth = true,
    signal?: AbortSignal
  ): Promise<R> {
    if (signal?.aborted) {
      throw createAbortError(signal);
    }

    const headers: Record<string, string> = {
      // Canonical alias plus the legacy header; both are always sent.
      "x-vellum-api-key": this.apiKey,
      "x-project-key": this.apiKey,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
    };

    const authHooks = this.authState.hooks;
    if (includeAuth && authHooks) {
      const token = await authHooks.getValidAccessToken();
      if (signal?.aborted) {
        throw createAbortError(signal);
      }
      if (token) headers["authorization"] = `Bearer ${token}`;
    }

    const sessionEpoch = includeAuth ? authHooks?.getSessionEpoch?.() : undefined;
    const assertCurrentSession = (): void => {
      if (includeAuth && sessionEpoch !== authHooks?.getSessionEpoch?.()) {
        throw Object.assign(new Error("Authentication session changed while request was pending"), { code: "SESSION_CHANGED" });
      }
    };

    const reqInit: RequestInit = {
      method,
      headers,
    };
    if (body !== undefined) {
      reqInit.body = JSON.stringify(body);
    }

    const url = `${this.baseUrl}${relativePath}`;
    const canRetryTransient = isRetriableRequest(method, relativePath, headers);
    let currentHeaders = headers;
    let authRetried = false;
    let res: Response | null = null;

    for (let attempt = 0; attempt <= this.effectiveMaxRetries; attempt += 1) {
      assertCurrentSession();
      if (signal?.aborted) {
        throw createAbortError(signal);
      }
      try {
        res = await this.fetchWithTimeout(url, { ...reqInit, headers: currentHeaders }, signal);
      } catch (err: unknown) {
        const errCode = (err as { code?: string } | null | undefined)?.code;
        if (signal?.aborted || errCode === "REQUEST_ABORTED") {
          throw err;
        }
        if (canRetryTransient && attempt < this.effectiveMaxRetries) {
          const delayMs = computeReconnectBackoffMs(
            attempt,
            this.effectiveRetryBaseMs,
            this.effectiveRetryMaxMs,
            this.retryRandom
          );
          if (delayMs > 0) await sleepWithSignal(delayMs, signal);
          continue;
        }
        throw err;
      }

      assertCurrentSession();
      this.inspectIndexHeaders(res);

      // Reactive 401: coalesce concurrent 401s into a single refresh and replay once
      // with the new bearer. The refresh endpoint itself is never retried.
      if (
        res.status === 401 &&
        includeAuth &&
        relativePath !== "/auth/token/refresh" &&
        !authRetried &&
        authHooks &&
        authHooks.hasRefreshToken()
      ) {
        const sentAuth = currentHeaders["authorization"];
        const staleToken = typeof sentAuth === "string" && sentAuth.startsWith("Bearer ") ? sentAuth.slice(7) : null;
        const refreshedToken = await authHooks.refreshIfMatching(staleToken);
        assertCurrentSession();
        if (signal?.aborted) {
          throw createAbortError(signal);
        }
        if (refreshedToken && `Bearer ${refreshedToken}` !== sentAuth) {
          authRetried = true;
          currentHeaders = { ...currentHeaders, authorization: `Bearer ${refreshedToken}` };
          res = await this.fetchWithTimeout(url, { ...reqInit, headers: currentHeaders }, signal);
          this.inspectIndexHeaders(res);
        }
      }

      if (canRetryTransient && isTransientStatus(res.status) && attempt < this.effectiveMaxRetries) {
        const retryAfterMs = parseRetryAfterMs(getResponseHeader(res, "retry-after"));
        const delayMs =
          retryAfterMs !== null
            ? retryAfterMs
            : computeReconnectBackoffMs(
                attempt,
                this.effectiveRetryBaseMs,
                this.effectiveRetryMaxMs,
                this.retryRandom
              );
        if (delayMs > 0) await sleepWithSignal(delayMs, signal);
        continue;
      }

      break;
    }

    if (!res) {
      throw new Error("@vellumdb/sdk-js: request failed without a response");
    }

    const payload = (await parseResponsePayload(res)) as {
      error?: { message?: string; code?: string; details?: Record<string, unknown>; requestId?: string };
    };

    assertCurrentSession();
    if (!res.ok) {
      const err = new Error(payload?.error?.message ?? `HTTP ${res.status}`) as Error & {
        code?: string | undefined;
        status?: number | undefined;
        details?: unknown;
        requestId?: string | undefined;
      };
      err.code = payload?.error?.code ?? "UNKNOWN_ERROR";
      err.status = res.status;
      err.details = payload?.error?.details ?? {};
      if (payload?.error?.requestId) {
        err.requestId = payload.error.requestId;
      }
      throw err;
    }

    return payload as R;
  }
}
