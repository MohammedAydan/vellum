/**
 * @vellum/authorization - End-User JWT Claims Verifier
 * Enforces asymmetric JWKS verification via `jose` (Ed25519/EdDSA, RS*, ES*, PS*).
 * HS256 fallback is disabled for end-user JWT verification (Security Contract §2.4).
 */

import crypto from "node:crypto";
import * as jose from "jose";
import { VellumError } from "@vellum/core";

export interface AuthContext {
  uid: string | null;
  claims: Record<string, unknown>;
  /** Verified end-user email address, when the token carries one. */
  email?: string | null | undefined;
  /** Whether the end-user email address was verified. */
  email_verified?: boolean | undefined;
  /** Whether the token was issued for an anonymous end-user. */
  is_anonymous?: boolean | undefined;
  /** The verified token payload (never the raw credential string). */
  token?: Record<string, unknown> | undefined;
}

export const DEFAULT_JWT_SECRET = process.env["JWT_SECRET"] ?? "vellum_jwt_secret_v1";

const MAX_JWT_BYTES = 16_384;
const CLOCK_SKEW_SECONDS = 60;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;
const JWKS_CACHE_MAX = 256;
/** Asymmetric algorithms permitted for remote JWKS verification (blocks HS* key-confusion). */
const ALLOWED_JWKS_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
  "PS256",
  "PS384",
  "PS512",
  "EdDSA",
];

// Bounded cache for remote JWKS sets per URL
const JWKS_CACHE = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>();

function getJwks(jwksUrl: string): ReturnType<typeof jose.createRemoteJWKSet> {
  const cached = JWKS_CACHE.get(jwksUrl);
  if (cached !== undefined) {
    JWKS_CACHE.delete(jwksUrl);
    JWKS_CACHE.set(jwksUrl, cached);
    return cached;
  }
  const parsed = new URL(jwksUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new VellumError("UNAUTHENTICATED", "Unsupported JWKS URL protocol");
  }
  const jwks = jose.createRemoteJWKSet(parsed, {
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  });
  if (JWKS_CACHE.size >= JWKS_CACHE_MAX) {
    const oldest = JWKS_CACHE.keys().next();
    if (oldest.done !== true) JWKS_CACHE.delete(oldest.value);
  }
  JWKS_CACHE.set(jwksUrl, jwks);
  return jwks;
}

export function clearJwksCache(): void {
  JWKS_CACHE.clear();
}

/**
 * Signs an end-user test/local JWT using HS256 HMAC.
 */
export function signEndUserJwt(
  payload: Record<string, unknown>,
  secret: string = DEFAULT_JWT_SECRET
): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

export interface VerifyJwtOptions {
  secret?: string | undefined;
  jwksUrl?: string | null | undefined;
  issuer?: string | null | undefined;
  audience?: string | null | undefined;
}

function verifyHmacTokenCore(
  raw: string,
  secret: string,
  issuer?: string | null,
  audience?: string | null
): AuthContext {
  if (raw.length > MAX_JWT_BYTES) {
    throw new VellumError("UNAUTHENTICATED", "Malformed Bearer JWT token");
  }
  const parts = raw.split(".");
  if (parts.length !== 3) {
    throw new VellumError("UNAUTHENTICATED", "Malformed Bearer JWT token");
  }

  const [headerB64, bodyB64, sigB64] = parts as [string, string, string];
  if (
    !headerB64 ||
    !bodyB64 ||
    !sigB64 ||
    !BASE64URL_REGEX.test(headerB64) ||
    !BASE64URL_REGEX.test(bodyB64) ||
    !BASE64URL_REGEX.test(sigB64)
  ) {
    throw new VellumError("UNAUTHENTICATED", "Malformed Bearer JWT token");
  }

  let header: { alg?: unknown } | null;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as { alg?: unknown } | null;
  } catch {
    throw new VellumError("UNAUTHENTICATED", "Invalid JWT header JSON");
  }
  if (!header || typeof header !== "object" || Array.isArray(header) || header.alg !== "HS256") {
    throw new VellumError("UNAUTHENTICATED", "Unsupported Bearer JWT algorithm");
  }

  const expectedSig = crypto.createHmac("sha256", secret).update(`${headerB64}.${bodyB64}`).digest();
  const actualSig = Buffer.from(sigB64, "base64url");
  if (actualSig.length !== expectedSig.length || !crypto.timingSafeEqual(actualSig, expectedSig)) {
    throw new VellumError("UNAUTHENTICATED", "Invalid Bearer JWT signature");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf8"));
  } catch {
    throw new VellumError("UNAUTHENTICATED", "Invalid JWT payload JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new VellumError("UNAUTHENTICATED", "Invalid JWT payload JSON");
  }
  const claims = payload as Record<string, unknown>;
  const nowMs = Date.now();

  if (claims["exp"] !== undefined) {
    if (typeof claims["exp"] !== "number" || !Number.isFinite(claims["exp"]) || claims["exp"] * 1000 <= nowMs) {
      throw new VellumError("UNAUTHENTICATED", "Bearer JWT token has expired");
    }
  }
  if (claims["nbf"] !== undefined) {
    if (
      typeof claims["nbf"] !== "number" ||
      !Number.isFinite(claims["nbf"]) ||
      claims["nbf"] * 1000 > nowMs + CLOCK_SKEW_SECONDS * 1000
    ) {
      throw new VellumError("UNAUTHENTICATED", "Bearer JWT token is not yet valid");
    }
  }
  if (claims["iat"] !== undefined) {
    if (
      typeof claims["iat"] !== "number" ||
      !Number.isFinite(claims["iat"]) ||
      claims["iat"] * 1000 > nowMs + CLOCK_SKEW_SECONDS * 1000
    ) {
      throw new VellumError("UNAUTHENTICATED", "Bearer JWT issued-at timestamp is invalid");
    }
  }
  if (issuer && claims["iss"] !== issuer) {
    throw new VellumError("UNAUTHENTICATED", "Bearer JWT issuer mismatch");
  }
  if (audience) {
    const aud = claims["aud"];
    const audMatches = aud === audience || (Array.isArray(aud) && aud.includes(audience));
    if (!audMatches) {
      throw new VellumError("UNAUTHENTICATED", "Bearer JWT audience mismatch");
    }
  }

  const uid =
    (typeof claims["sub"] === "string" ? claims["sub"] : undefined) ??
    (typeof claims["uid"] === "string" ? claims["uid"] : undefined) ??
    null;
  return { uid, claims };
}

/**
 * Verifies an end-user Bearer JWT against a remote asymmetric JWKS endpoint via `jose`.
 * Fails closed whenever `options.jwksUrl` is omitted — HS256 fallback is disabled (§2.4).
 */
export async function verifyEndUserJwt(
  token: string | null | undefined,
  options: VerifyJwtOptions = {}
): Promise<AuthContext> {
  if (!token) {
    return { uid: null, claims: {} };
  }

  const raw = token.startsWith("Bearer ") ? token.slice(7).trim() : token.trim();
  if (!raw) {
    return { uid: null, claims: {} };
  }
  if (raw.length > MAX_JWT_BYTES) {
    throw new VellumError("UNAUTHENTICATED", "Malformed Bearer JWT token");
  }

  // Fail closed when remote JWKS is omitted: HS256 fallback is prohibited for end-user tokens (§2.4).
  if (!options.jwksUrl || options.jwksUrl.trim().length === 0) {
    throw new VellumError(
      "UNAUTHENTICATED",
      "End-user JWT verification requires an Ed25519/EdDSA JWKS endpoint; HS256 fallback is disabled"
    );
  }

  try {
    const jwks = getJwks(options.jwksUrl);
    const verifyOpts: jose.JWTVerifyOptions = {
      algorithms: ALLOWED_JWKS_ALGORITHMS,
    };
    if (options.issuer) verifyOpts.issuer = options.issuer;
    if (options.audience) verifyOpts.audience = options.audience;

    const { payload } = await jose.jwtVerify(raw, jwks, verifyOpts);
    const claims: Record<string, unknown> = { ...payload };
    const uid =
      (typeof payload.sub === "string" ? payload.sub : undefined) ??
      (typeof claims["uid"] === "string" ? claims["uid"] : undefined) ??
      null;
    return { uid, claims };
  } catch (err) {
    if (err instanceof VellumError) {
      throw err;
    }
    throw new VellumError("UNAUTHENTICATED", "JWKS token verification failed");
  }
}

/**
 * Synchronous variant for HMAC tokens (preserves backwards-compatibility with existing sync test callers).
 */
export function verifyEndUserJwtSync(
  token: string | null | undefined,
  secret: string = DEFAULT_JWT_SECRET
): AuthContext {
  if (!token) return { uid: null, claims: {} };
  const raw = token.startsWith("Bearer ") ? token.slice(7).trim() : token.trim();
  if (!raw) return { uid: null, claims: {} };
  return verifyHmacTokenCore(raw, secret);
}
