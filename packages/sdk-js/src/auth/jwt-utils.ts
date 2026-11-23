/**
 * @vellumdb/sdk-js - Pure end-user auth & JWT helpers.
 *
 * JWT payloads are decoded with a small hand-rolled base64url decoder with a
 * strict payload size cap. No `eval`, `new Function`, or any other dynamic code
 * execution is used, and no token material is ever written to logs.
 */

import { safeJsonParse, sanitizeAndClone } from "../core/safe-json.js";
import type {
  ActionTokenResult,
  AuthState,
  VellumAuthUser,
  EmailVerifyConfirmResult,
  MfaRequiredResult,
  SuccessResult,
  TotpEnrollmentResult,
} from "../types.js";

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_JWT_PAYLOAD_BYTES = 65_536;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode base64url (no padding) into bytes without relying on platform globals. */
function base64UrlToBytes(input: string): Uint8Array {
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
  return new Uint8Array(bytes);
}

/**
 * Read the `exp` claim (seconds since epoch) from an encoded JWT payload.
 * Returns `null` for malformed or non-JWT tokens; never throws.
 */
export function parseJwtExp(token: string): number | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (!payload || payload.length > MAX_JWT_PAYLOAD_BYTES) return null;
  try {
    const text = new TextDecoder("utf-8").decode(base64UrlToBytes(payload));
    const parsed: unknown = safeJsonParse(text);
    if (!isRecord(parsed)) return null;
    return typeof parsed["exp"] === "number" && Number.isFinite(parsed["exp"]) ? parsed["exp"] : null;
  } catch {
    return null;
  }
}

/** Identity hint for local state invalidation only, never for authorization. */
export function parseJwtSubject(token: string | null): string | null {
  const payload = token?.split(".")[1];
  if (!payload || payload.length > MAX_JWT_PAYLOAD_BYTES) return null;
  try {
    const value: unknown = safeJsonParse(new TextDecoder().decode(base64UrlToBytes(payload)));
    return isRecord(value) && typeof value["sub"] === "string" ? value["sub"] : null;
  } catch { return null; }
}

/**
 * True when the token expires within `skewMs`; tokens without a parseable
 * `exp` are treated as non-expiring (no silent refresh is attempted).
 * Defaults to a 45 s safety window for silent pre-flight refresh.
 */
export function isTokenExpiringWithin(token: string, skewMs = 45_000): boolean {
  const exp = parseJwtExp(token);
  if (exp === null) return false;
  return exp * 1000 - skewMs <= Date.now();
}

/** Backward-compatible wrapper that keeps the historical 60 s skew. */
export function isTokenExpiring(token: string, skewMs = 60_000): boolean {
  return isTokenExpiringWithin(token, skewMs);
}

/** Read a required string field from an untrusted response body. */
export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`@vellumdb/sdk-js: invalid auth response (missing '${field}')`);
  }
  return value;
}

/** Normalize untrusted response data into a public end-user record. */
export function parseAuthUser(value: unknown): VellumAuthUser {
  if (!isRecord(value)) {
    throw new Error("@vellumdb/sdk-js: invalid auth response (missing 'user')");
  }
  return {
    id: requiredString(value["id"], "user.id"),
    email: typeof value["email"] === "string" ? value["email"] : null,
    emailVerified: value["emailVerified"] === true,
    displayName: typeof value["displayName"] === "string" ? value["displayName"] : null,
    photoUrl: typeof value["photoUrl"] === "string" ? value["photoUrl"] : null,
    phoneNumber: typeof value["phoneNumber"] === "string" ? value["phoneNumber"] : null,
    phoneVerified: value["phoneVerified"] === true,
    isDisabled: value["isDisabled"] === true,
    isAnonymous: value["isAnonymous"] === true,
    customClaims: isRecord(value["customClaims"]) ? sanitizeAndClone(value["customClaims"]) : {},
    metadata: isRecord(value["metadata"]) ? sanitizeAndClone(value["metadata"]) : {},
    createdAt: typeof value["createdAt"] === "string" ? value["createdAt"] : "",
    updatedAt: typeof value["updatedAt"] === "string" ? value["updatedAt"] : "",
    lastSignInAt: typeof value["lastSignInAt"] === "string" ? value["lastSignInAt"] : null,
  };
}

/** Parse a session response (`{ user, accessToken, refreshToken, ... }`). */
export function parseSessionResponse(value: unknown): AuthState {
  if (!isRecord(value)) {
    throw new Error("@vellumdb/sdk-js: invalid auth response");
  }
  const user = parseAuthUser(value["user"]);
  return {
    ...user,
    accessToken: requiredString(value["accessToken"], "accessToken"),
    refreshToken: requiredString(value["refreshToken"], "refreshToken"),
    tokenType: typeof value["tokenType"] === "string" ? value["tokenType"] : "Bearer",
    sessionId: typeof value["sessionId"] === "string" ? value["sessionId"] : "",
    expiresAt: typeof value["expiresAt"] === "string" ? value["expiresAt"] : "",
  };
}

/** Parse the `{ mfaRequired, mfaTicket, factors, expiresAt }` sign-in shape. */
export function parseMfaRequiredResponse(value: Record<string, unknown>): MfaRequiredResult {
  return {
    mfaRequired: true,
    mfaTicket: requiredString(value["mfaTicket"], "mfaTicket"),
    factors: Array.isArray(value["factors"])
      ? value["factors"].filter((factor): factor is string => typeof factor === "string")
      : [],
    expiresAt: typeof value["expiresAt"] === "string" ? value["expiresAt"] : "",
  };
}

export function parseTotpEnrollmentResponse(value: unknown): TotpEnrollmentResult {
  if (!isRecord(value)) throw new Error("@vellumdb/sdk-js: invalid MFA enrollment response");
  return {
    secret: requiredString(value["secret"], "secret"),
    otpauthUri: requiredString(value["otpauthUri"], "otpauthUri"),
    recoveryCodes: Array.isArray(value["recoveryCodes"])
      ? value["recoveryCodes"].filter((code): code is string => typeof code === "string")
      : [],
  };
}

export function parseActionTokenResponse(value: unknown): ActionTokenResult {
  if (!isRecord(value)) throw new Error("@vellumdb/sdk-js: invalid auth response");
  const result: ActionTokenResult = { success: true };
  if (typeof value["devToken"] === "string") result.devToken = value["devToken"];
  if (typeof value["expiresAt"] === "string") result.expiresAt = value["expiresAt"];
  return result;
}

export function parseEmailVerifyConfirmResponse(value: unknown): EmailVerifyConfirmResult {
  if (!isRecord(value)) throw new Error("@vellumdb/sdk-js: invalid auth response");
  const result: EmailVerifyConfirmResult = { success: true };
  if (value["user"] !== undefined) result.user = parseAuthUser(value["user"]);
  return result;
}

export function parseSuccessResponse(value: unknown): SuccessResult {
  if (!isRecord(value)) throw new Error("@vellumdb/sdk-js: invalid auth response");
  return { success: true };
}
