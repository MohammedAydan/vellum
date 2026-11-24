/**
 * @vellum/authorization - Shared Session / JWT Service 
 *
 * Locked shared interface (see delegation brief §2). Both the Console API and the
 * Platform Admin API import `createSessionService` from here — there is exactly
 * one JWT implementation in the monorepo.
 *
 * Cryptography notes
 * ------------------
 * - Algorithm is HS256. Tokens are canonical compact JWS strings fully
 *   interoperable with `jose.jwtVerify(secret)` (verified by the test suite).
 * - `jose`'s JWT sign/verify helpers are asynchronous, while the locked
 *   `SessionService` contract is synchronous. We therefore use `jose`'s
 *   *synchronous* parsing helpers (`decodeProtectedHeader`, `decodeJwt`) for
 *   structure/claim validation and Node's HMAC-SHA256 for the signature. The
 *   resulting tokens are standard HS256 JWTs; `jose` verifies them unchanged.
 * - Explicit `typ` and `realm` isolation: end-user JWTs (`typ === "vellum+enduser+jwt"`)
 *   and cross-realm tokens are unconditionally rejected.
 * - Revocation state lives in the `RevocationStore` (PostgreSQL in production). Runtime paths
 *   call `verifyAccessChecked` / `verifyRefreshChecked`, which look the `jti` up in the store.
 *   There is no in-process mirror, so a revocation is visible to every instance at once.
 */

import crypto from "node:crypto";
import * as jose from "jose";
import { VellumError } from "@vellum/core";

export type Role = "owner" | "admin" | "support_readonly" | "customer";

export interface SessionClaims {
  sub: string;
  uid: string;
  role: Role;
  orgIds: string[];
  jti: string;
  exp: number;
  realm?: string | undefined;
}

export interface RevocationStore {
  revoke(jti: string, expiresAtMs: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
}

export interface SessionService {
  signAccess(input: Omit<SessionClaims, "jti" | "exp">, ttlSeconds?: number): string;
  /** Signature, expiry, type and realm only. Runtime paths must use `verifyAccessChecked`, which also reads the revocation store. */
  verifyAccess(token: string): SessionClaims;
  /** `verifyAccess` plus a revocation lookup in the (database-backed) store. */
  verifyAccessChecked(token: string): Promise<SessionClaims>;
  signRefresh(sub: string, ttlSeconds?: number): string;
  verifyRefresh(token: string): { sub: string; jti: string; exp: number };
  verifyRefreshChecked(token: string): Promise<{ sub: string; jti: string; exp: number }>;
  revoke(jti: string, expiresAtMs: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
}

export interface SessionServiceOptions {
  secret: string;
  revocationStore: RevocationStore;
  /** Optional realm binding; when set, tokens must carry this exact `realm` claim. */
  realm?: string | undefined;
  /** Optional expected JWT header `typ` (defaults to `"JWT"`). */
  expectedHeaderTyp?: string | undefined;
}

export const ACCESS_TOKEN_TTL_SECONDS = 900; // 15 minutes
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 3600; // 7 days

const MAX_JWT_BYTES = 16_384;
const CLOCK_SKEW_SECONDS = 60;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;
const MAX_REVOCATION_ENTRIES = 100_000;
const END_USER_JWT_TYP = "vellum+enduser+jwt";

const ROLES: ReadonlySet<string> = new Set<Role>(["owner", "admin", "support_readonly", "customer"]);

function unauthenticated(message: string): VellumError {
  return new VellumError("UNAUTHENTICATED", message);
}

function encodeSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** Sign a canonical HS256 compact JWT synchronously. */
function signHs256(
  payload: Record<string, unknown>,
  secret: string,
  headerTyp: string = "JWT"
): string {
  const header = encodeSegment(JSON.stringify({ alg: "HS256", typ: headerTyp }));
  const body = encodeSegment(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

/**
 * Verify an HS256 compact JWT synchronously.
 * Signature is checked with a constant-time comparison; structure/claims are
 * parsed with jose's synchronous helpers. Explicitly rejects end-user tokens
 * (`typ === "vellum+enduser+jwt"`) and header `typ` mismatches.
 */
function verifyHs256(
  token: string,
  secret: string,
  expectedHeaderTyp: string = "JWT"
): Record<string, unknown> {
  if (typeof token !== "string" || token.length === 0) throw unauthenticated("Missing session token");
  if (token.length > MAX_JWT_BYTES) throw unauthenticated("Malformed session token");
  const parts = token.split(".");
  if (parts.length !== 3) throw unauthenticated("Malformed session token");
  const [headerB64, bodyB64, sigB64] = parts as [string, string, string];
  if (
    !headerB64 ||
    !bodyB64 ||
    !sigB64 ||
    !BASE64URL_REGEX.test(headerB64) ||
    !BASE64URL_REGEX.test(bodyB64) ||
    !BASE64URL_REGEX.test(sigB64)
  ) {
    throw unauthenticated("Malformed session token");
  }

  let header: jose.ProtectedHeaderParameters;
  try {
    header = jose.decodeProtectedHeader(token);
  } catch {
    throw unauthenticated("Malformed session token header");
  }
  if (header.alg !== "HS256") {
    throw unauthenticated(`Unsupported session token algorithm '${String(header.alg)}'`);
  }
  if (header.typ === END_USER_JWT_TYP) {
    throw unauthenticated("End-user JWT tokens are not permitted for control-plane sessions");
  }
  if (header.typ !== expectedHeaderTyp) {
    throw unauthenticated(`Invalid session token header type '${String(header.typ)}'`);
  }

  const expected = crypto.createHmac("sha256", secret).update(`${headerB64}.${bodyB64}`).digest();
  const actualBuf = Buffer.from(sigB64, "base64url");
  if (actualBuf.length !== expected.length || !crypto.timingSafeEqual(actualBuf, expected)) {
    throw unauthenticated("Invalid session token signature");
  }

  let payload: jose.JWTPayload;
  try {
    payload = jose.decodeJwt(token);
  } catch {
    throw unauthenticated("Invalid session token payload");
  }
  return payload as Record<string, unknown>;
}

function assertTemporalClaims(payload: Record<string, unknown>): number {
  const exp = payload["exp"];
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    throw unauthenticated("Session token is missing a valid 'exp' claim");
  }
  const nowMs = Date.now();
  if (exp * 1000 <= nowMs) throw unauthenticated("Session token has expired");

  const nbf = payload["nbf"];
  if (nbf !== undefined) {
    if (typeof nbf !== "number" || !Number.isFinite(nbf) || nbf * 1000 > nowMs + CLOCK_SKEW_SECONDS * 1000) {
      throw unauthenticated("Session token is not yet valid");
    }
  }
  const iat = payload["iat"];
  if (iat !== undefined) {
    if (typeof iat !== "number" || !Number.isFinite(iat) || iat * 1000 > nowMs + CLOCK_SKEW_SECONDS * 1000) {
      throw unauthenticated("Session token issued-at timestamp is invalid");
    }
  }
  return exp;
}

function pruneRevocationMap(map: Map<string, number>, now: number): void {
  for (const [jti, expiresAtMs] of map) {
    if (expiresAtMs <= now) map.delete(jti);
  }
  while (map.size > MAX_REVOCATION_ENTRIES) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

/**
 * In-process revocation store with lazy TTL expiry and hard memory cap. No timers are created, so
 * there are no `unref()`/timer leaks. Suitable for single-instance deployments.
 */
export function createInMemoryRevocationStore(): RevocationStore {
  const revoked = new Map<string, number>();

  return {
    async revoke(jti: string, expiresAtMs: number): Promise<void> {
      if (!jti) return;
      const now = Date.now();
      if (expiresAtMs > now) revoked.set(jti, expiresAtMs);
      pruneRevocationMap(revoked, now);
    },
    async isRevoked(jti: string): Promise<boolean> {
      const expiresAtMs = revoked.get(jti);
      if (expiresAtMs === undefined) return false;
      if (expiresAtMs <= Date.now()) {
        revoked.delete(jti);
        return false;
      }
      return true;
    },
  };
}

export function createSessionService(opts: SessionServiceOptions): SessionService {
  const secret = opts.secret;
  const revocationStore = opts.revocationStore;
  const configuredRealm = opts.realm;
  const expectedHeaderTyp = opts.expectedHeaderTyp ?? "JWT";

  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("createSessionService requires a non-empty secret");
  }
  if (expectedHeaderTyp === END_USER_JWT_TYP) {
    throw new Error("createSessionService cannot use end-user JWT header type");
  }

  function checkTokenType(payload: Record<string, unknown>, expected: "access" | "refresh"): void {
    const tokenTyp = payload["typ"];
    if (tokenTyp === END_USER_JWT_TYP) {
      throw unauthenticated("End-user JWT tokens are not permitted for control-plane sessions");
    }
    if (tokenTyp !== expected) {
      throw unauthenticated(`Invalid session token type (expected '${expected}')`);
    }
  }

  function assertRealm(payload: Record<string, unknown>): void {
    const tokenRealm = payload["realm"];
    if (configuredRealm !== undefined) {
      if (typeof tokenRealm !== "string" || tokenRealm !== configuredRealm) {
        throw unauthenticated("Session token realm mismatch");
      }
    } else if (tokenRealm !== undefined) {
      throw unauthenticated("Cross-realm session token rejected");
    }
  }

  return {
    signAccess(input: Omit<SessionClaims, "jti" | "exp">, ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS): string {
      if (!input || typeof input.sub !== "string" || typeof input.uid !== "string") {
        throw new Error("signAccess requires sub and uid");
      }
      if (!ROLES.has(input.role)) throw new Error(`Invalid session role '${String(input.role)}'`);
      if (!Array.isArray(input.orgIds) || !input.orgIds.every((id) => typeof id === "string")) {
        throw new Error("signAccess requires orgIds to be a string array");
      }
      // A non-finite ttl falls back to the default; finite values (including
      // 0/negative, useful for expiry tests) are honored verbatim.
      const ttl = Number.isFinite(ttlSeconds) ? ttlSeconds : ACCESS_TOKEN_TTL_SECONDS;
      const nowSec = Math.floor(Date.now() / 1000);
      const exp = nowSec + Math.floor(ttl);
      return signHs256(
        {
          typ: "access",
          ...(configuredRealm !== undefined ? { realm: configuredRealm } : {}),
          sub: input.sub,
          uid: input.uid,
          role: input.role,
          orgIds: [...input.orgIds],
          jti: crypto.randomUUID(),
          iat: nowSec,
          exp,
        },
        secret,
        expectedHeaderTyp
      );
    },

    verifyAccess(token: string): SessionClaims {
      const payload = verifyHs256(token, secret, expectedHeaderTyp);
      checkTokenType(payload, "access");
      assertRealm(payload);
      const exp = assertTemporalClaims(payload);

      const sub = payload["sub"];
      const uid = payload["uid"];
      const role = payload["role"];
      const orgIds = payload["orgIds"];
      const jti = payload["jti"];
      if (typeof sub !== "string" || typeof uid !== "string") {
        throw unauthenticated("Session token is missing subject claims");
      }
      if (typeof role !== "string" || !ROLES.has(role)) {
        throw unauthenticated("Session token has an invalid role claim");
      }
      if (!Array.isArray(orgIds) || !orgIds.every((id) => typeof id === "string")) {
        throw unauthenticated("Session token has an invalid orgIds claim");
      }
      if (typeof jti !== "string" || jti.length === 0) {
        throw unauthenticated("Session token is missing a jti claim");
      }

      return {
        sub,
        uid,
        role: role as Role,
        orgIds: orgIds as string[],
        jti,
        exp,
        ...(configuredRealm !== undefined ? { realm: configuredRealm } : {}),
      };
    },

    signRefresh(sub: string, ttlSeconds: number = REFRESH_TOKEN_TTL_SECONDS): string {
      if (typeof sub !== "string" || sub.length === 0) throw new Error("signRefresh requires a sub");
      const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : REFRESH_TOKEN_TTL_SECONDS;
      const nowSec = Math.floor(Date.now() / 1000);
      const exp = nowSec + Math.floor(ttl);
      return signHs256(
        {
          typ: "refresh",
          ...(configuredRealm !== undefined ? { realm: configuredRealm } : {}),
          sub,
          jti: crypto.randomUUID(),
          iat: nowSec,
          exp,
        },
        secret,
        expectedHeaderTyp
      );
    },

    verifyRefresh(token: string): { sub: string; jti: string; exp: number } {
      const payload = verifyHs256(token, secret, expectedHeaderTyp);
      checkTokenType(payload, "refresh");
      assertRealm(payload);
      const exp = assertTemporalClaims(payload);
      const sub = payload["sub"];
      const jti = payload["jti"];
      if (typeof sub !== "string" || typeof jti !== "string" || jti.length === 0) {
        throw unauthenticated("Refresh token is missing required claims");
      }
      return { sub, jti, exp };
    },

    async verifyAccessChecked(token: string): Promise<SessionClaims> {
      const claims = this.verifyAccess(token);
      if (await revocationStore.isRevoked(claims.jti)) {
        throw unauthenticated("Session token has been revoked");
      }
      return claims;
    },

    async verifyRefreshChecked(token: string): Promise<{ sub: string; jti: string; exp: number }> {
      const claims = this.verifyRefresh(token);
      if (await revocationStore.isRevoked(claims.jti)) {
        throw unauthenticated("Refresh token has been revoked");
      }
      return claims;
    },

    async revoke(jti: string, expiresAtMs: number): Promise<void> {
      if (!jti) return;
      await revocationStore.revoke(jti, expiresAtMs);
    },

    async isRevoked(jti: string): Promise<boolean> {
      return revocationStore.isRevoked(jti);
    },
  };
}
