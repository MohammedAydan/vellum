/**
 * Customer Console session storage.
 *
 * The dashboard and the super-admin console now share a single browser origin,
 * so each realm owns three discrete localStorage keys (never a shared JSON
 * blob). This module reads and writes ONLY the `vellum_console_*` prefix.
 */
export interface UserSession {
  user: {
    id: string;
    email: string;
    name: string;
    platformRole?: string;
  };
  token: string;
  /** Opaque 30-day refresh token used for silent session renewal. */
  refreshToken?: string;
  expiresAt: string;
  /** Transient marker: true when `expiresAt` is in the past. Never persisted. */
  expired?: boolean;
}

const ACCESS_TOKEN_KEY = "vellum_console_access_token";
const REFRESH_TOKEN_KEY = "vellum_console_refresh_token";
/** Stores `{ user, expiresAt }` as JSON; tokens live in their own keys above. */
const USER_KEY = "vellum_console_user";

interface StoredUserBlob {
  user: UserSession["user"];
  expiresAt: string;
}

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const AUTH_LOOP_PATHS = new Set(["/login", "/signup"]);

/**
 * Monotonic session epoch incremented on logout and account switches.
 * Prevents an in-flight silent refresh from resurrecting a logged-out session
 * or overwriting a newly signed-in user's tokens.
 */
let sessionEpoch = 0;

export function getSessionEpoch(): number {
  return sessionEpoch;
}

export function bumpSessionEpoch(): number {
  sessionEpoch += 1;
  return sessionEpoch;
}

/** Recursively strip prototype-pollution keys from parsed JSON values. */
export function stripPrototypePollution<T>(value: T, depth = 0): T {
  if (depth > 32 || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      value[i] = stripPrototypePollution(value[i], depth + 1);
    }
    return value;
  }
  const source = value as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_JSON_KEYS.has(key)) continue;
    clean[key] = stripPrototypePollution(source[key], depth + 1);
  }
  return clean as T;
}

/** Prototype-pollution safe `JSON.parse` wrapper. */
export function safeJsonParse<T = unknown>(raw: string): T {
  const parsed = JSON.parse(raw, (key, value) => {
    if (FORBIDDEN_JSON_KEYS.has(key)) return undefined;
    return value;
  });
  return stripPrototypePollution(parsed as T);
}

/**
 * Validate a post-auth redirect target so only safe, relative same-origin paths
 * are permitted (rejects `//evil.com`, `https://...`, `javascript:`, backslashes,
 * control chars, and auth-loop paths like `/login`).
 */
export function sanitizeRedirectPath(raw: unknown, fallback = "/app"): string {
  if (typeof raw !== "string") return fallback;
  const candidate = raw.trim();
  if (!candidate || candidate.length > 2048) return fallback;
  if (CONTROL_CHAR_RE.test(candidate) || candidate.includes("\\")) return fallback;
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return fallback;

  try {
    const decoded = decodeURIComponent(candidate);
    if (CONTROL_CHAR_RE.test(decoded) || decoded.includes("\\") || decoded.startsWith("//")) {
      return fallback;
    }
  } catch {
    return fallback;
  }

  try {
    const parsed = new URL(candidate, "https://vellum.local");
    if (parsed.origin !== "https://vellum.local") return fallback;
    if (!parsed.pathname.startsWith("/") || parsed.pathname.startsWith("//")) return fallback;
    const normalizedPath = parsed.pathname.toLowerCase();
    if (
      AUTH_LOOP_PATHS.has(normalizedPath) ||
      normalizedPath.startsWith("/login/") ||
      normalizedPath.startsWith("/signup/")
    ) {
      return fallback;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

/** Read and validate `?redirect=` or `?returnTo=` from a query string. */
export function getSafeRedirectFromSearch(search?: string, fallback = "/app"): string {
  const queryString =
    search !== undefined
      ? search
      : typeof window !== "undefined"
        ? window.location.search
        : "";
  if (!queryString) return fallback;
  try {
    const params = new URLSearchParams(queryString);
    const raw = params.get("redirect") ?? params.get("returnTo");
    return sanitizeRedirectPath(raw, fallback);
  } catch {
    return fallback;
  }
}

/** Decode a base64url JWT segment without relying on platform globals. */
function decodeBase64Url(input: string): string {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of input) {
    const index = B64URL_ALPHABET.indexOf(char);
    if (index < 0) continue;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return String.fromCharCode(...bytes);
}

/** Read the JWT `exp` claim in milliseconds, or `null` for a non-JWT token. */
export function getTokenExpiryMs(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    if (!payload) return null;
    const parsed = safeJsonParse<{ exp?: unknown }>(decodeBase64Url(payload));
    return parsed && typeof parsed.exp === "number" && Number.isFinite(parsed.exp)
      ? parsed.exp * 1000
      : null;
  } catch {
    return null;
  }
}

/** True when the access JWT expires within `skewMs` (or has already expired). */
export function isSessionTokenExpiringWithin(token: string, skewMs: number): boolean {
  const exp = getTokenExpiryMs(token);
  // An unparseable exp must not trigger an endless refresh loop.
  if (exp === null) return false;
  return exp - skewMs <= Date.now();
}

function isValidUserRecord(value: unknown): value is UserSession["user"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const user = value as Record<string, unknown>;
  return (
    typeof user["id"] === "string" &&
    typeof user["email"] === "string" &&
    typeof user["name"] === "string" &&
    (user["platformRole"] === undefined || typeof user["platformRole"] === "string")
  );
}

function readStoredSession(): UserSession | null {
  try {
    const token = localStorage.getItem(ACCESS_TOKEN_KEY);
    const rawUser = localStorage.getItem(USER_KEY);
    if (!token || !rawUser) return null;
    const blob = safeJsonParse<Partial<StoredUserBlob>>(rawUser);
    if (!blob || typeof blob !== "object" || !isValidUserRecord(blob.user) || typeof blob.expiresAt !== "string") {
      return null;
    }
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    return {
      user: blob.user,
      token,
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: blob.expiresAt,
    };
  } catch {
    return null;
  }
}

/**
 * Returns the stored session even when the access token has expired.
 * Used internally so `apiFetch` can silently refresh using the still-valid
 * refresh token (valid up to 30 days) instead of forcing the user to sign in.
 */
export function getStoredSessionAllowExpired(): UserSession | null {
  return readStoredSession();
}

/**
 * Returns the stored session with an `expired` marker instead of dropping it.
 * Expiry of the short-lived access token is not a reason to discard a session:
 * `apiFetch` performs a silent refresh before the next request.
 */
export function getStoredSession(): UserSession | null {
  const session = readStoredSession();
  if (!session) return null;
  const expired = new Date(session.expiresAt).getTime() < Date.now();
  return { ...session, expired };
}

export function setStoredSession(session: UserSession): void {
  const previous = readStoredSession();
  if (!previous || previous.user.id !== session.user.id) {
    bumpSessionEpoch();
  }
  // Never persist the transient marker. Split the blob across the three keys
  // owned by this realm so the silent-refresh interceptor can read each part.
  const { expired: _expired, token, refreshToken, user, expiresAt } = session;
  const sanitizedUser = stripPrototypePollution({ ...user });
  try {
    localStorage.setItem(ACCESS_TOKEN_KEY, token);
    if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    else localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.setItem(USER_KEY, JSON.stringify({ user: sanitizedUser, expiresAt } satisfies StoredUserBlob));
  } catch {
    // Ignore storage quota / private-mode write failures safely.
  }
}

export function clearStoredSession(): void {
  bumpSessionEpoch();
  try {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    // Ignore storage removal errors in restricted environments.
  }
}
