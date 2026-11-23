/**
 * @vellum/auth — realm-bound HS256 session service.
 *
 * The two control-plane realms (Platform Super Admin and Customer Console) are
 * cryptographically and semantically isolated from each other and from the
 * EdDSA end-user realm. A token minted for one realm is rejected by the other:
 * the signed header `typ`, the `iss`, the `aud` and the `realm` claim are all
 * bound to the configuration selected at construction time.
 *
 * Uses only `node:crypto` HMAC-SHA256 (a shared primitive). No `eval`, no
 * dynamic JWT verification, no external stateful services. The returned object
 * is structurally compatible with `@vellum/authorization`'s `SessionService` so
 * existing call sites keep compiling, but the local interfaces are declared
 * here to avoid coupling the two packages.
 */

import crypto from "node:crypto";
import { VellumError } from "@vellum/core";

export type AuthRealm = "super_admin" | "customer_console";

export interface RealmSessionConfig {
  realm: AuthRealm;
  typ: string;
  issuer: string;
  audience: string;
}

/** Locked per-realm typ/iss/aud values (see SECURITY-HARDENING-CONTRACT §4). */
const REALM_CONFIGS: Record<AuthRealm, RealmSessionConfig> = {
  super_admin: {
    realm: "super_admin",
    typ: "vellum+superadmin+jwt",
    issuer: "vellum:control-plane:super-admin",
    audience: "vellum-super-admin",
  },
  customer_console: {
    realm: "customer_console",
    typ: "vellum+console+jwt",
    issuer: "vellum:control-plane:console",
    audience: "vellum-customer-console",
  },
};

export function realmConfig(realm: AuthRealm): RealmSessionConfig {
  return { ...REALM_CONFIGS[realm] };
}

/** Mirrors `@vellum/authorization`'s Role union without importing it. */
export type RealmRole = "owner" | "admin" | "support_readonly" | "customer";

export interface RealmSessionClaims {
  typ: "access";
  sub: string;
  uid: string;
  role: RealmRole;
  orgIds: string[];
  realm: AuthRealm;
  iss: string;
  aud: string;
  jti: string;
  exp: number;
}

export interface RealmRefreshClaims {
  typ: "refresh";
  sub: string;
  realm: AuthRealm;
  iss: string;
  aud: string;
  jti: string;
  exp: number;
}

export interface SignRealmAccessInput {
  sub: string;
  uid: string;
  role: RealmRole;
  orgIds: string[];
}

export interface RealmRevocationStore {
  revoke(jti: string, expiresAtMs: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
}

export interface RealmSessionService {
  signAccess(input: SignRealmAccessInput, ttlSeconds?: number): string;
  verifyAccess(token: string): RealmSessionClaims;
  signRefresh(sub: string, ttlSeconds?: number): string;
  verifyRefresh(token: string): RealmRefreshClaims;
  revoke(jti: string, expiresAtMs: number): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
}

export const REALM_ACCESS_TOKEN_TTL_SECONDS = 900; // 15 minutes
export const REALM_REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 3600; // 7 days

const MAX_JWT_BYTES = 16_384;
const CLOCK_SKEW_SECONDS = 60;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;
const MAX_LOCAL_REVOCATIONS = 100_000;

const ROLES: ReadonlySet<string> = new Set<RealmRole>([
  "owner",
  "admin",
  "support_readonly",
  "customer",
]);

function unauthenticated(message: string): VellumError {
  return new VellumError("UNAUTHENTICATED", message);
}

function encodeSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** Sign a canonical HS256 compact JWT synchronously with a realm-bound `typ`. */
function signHs256(payload: Record<string, unknown>, secret: string, typ: string): string {
  const header = encodeSegment(JSON.stringify({ alg: "HS256", typ }));
  const body = encodeSegment(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

/**
 * Verify an HS256 compact JWT synchronously. The signature is checked with a
 * constant-time comparison before any claim is trusted, and the header `typ`
 * must match the realm's locked value.
 */
function verifyHs256(token: string, secret: string, expectedTyp: string): Record<string, unknown> {
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

  let header: { alg?: unknown; typ?: unknown } | null;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as {
      alg?: unknown;
      typ?: unknown;
    } | null;
  } catch {
    throw unauthenticated("Malformed session token header");
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    throw unauthenticated("Malformed session token header");
  }
  if (header.alg !== "HS256") {
    throw unauthenticated("Unsupported session token algorithm");
  }
  if (header.typ !== expectedTyp) {
    throw unauthenticated("Session token realm/type mismatch");
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${bodyB64}`)
    .digest();
  const actualBuf = Buffer.from(sigB64, "base64url");
  if (actualBuf.length !== expected.length || !crypto.timingSafeEqual(actualBuf, expected)) {
    throw unauthenticated("Invalid session token signature");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(bodyB64, "base64url").toString("utf8"));
  } catch {
    throw unauthenticated("Invalid session token payload");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw unauthenticated("Invalid session token payload");
  }
  return payload as Record<string, unknown>;
}

/** Reject tokens whose realm-bound claims do not match this service's realm. */
function assertRealmClaims(payload: Record<string, unknown>, config: RealmSessionConfig): void {
  if (payload["realm"] !== config.realm) throw unauthenticated("Session token realm mismatch");
  if (payload["iss"] !== config.issuer) throw unauthenticated("Session token issuer mismatch");
  if (payload["aud"] !== config.audience) throw unauthenticated("Session token audience mismatch");
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

export function createRealmSessionService(opts: {
  realm: AuthRealm;
  secret: string;
  revocationStore: RealmRevocationStore;
}): RealmSessionService {
  const config = realmConfig(opts.realm);
  const secret = opts.secret;
  const revocationStore = opts.revocationStore;
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("createRealmSessionService requires a non-empty secret");
  }

  /** Synchronous mirror of revocations performed through this service instance. */
  const localRevocations = new Map<string, number>();

  function pruneLocalRevocations(now: number): void {
    for (const [key, expMs] of localRevocations) {
      if (expMs <= now) localRevocations.delete(key);
    }
    while (localRevocations.size > MAX_LOCAL_REVOCATIONS) {
      const oldest = localRevocations.keys().next();
      if (oldest.done === true) break;
      localRevocations.delete(oldest.value);
    }
  }

  function isLocallyRevoked(jti: string): boolean {
    const expiresAtMs = localRevocations.get(jti);
    if (expiresAtMs === undefined) return false;
    if (expiresAtMs <= Date.now()) {
      localRevocations.delete(jti);
      return false;
    }
    return true;
  }

  function checkTokenType(payload: Record<string, unknown>, expected: "access" | "refresh"): void {
    if (payload["typ"] !== expected) {
      throw unauthenticated(`Invalid session token type (expected '${expected}')`);
    }
  }

  return {
    signAccess(
      input: SignRealmAccessInput,
      ttlSeconds: number = REALM_ACCESS_TOKEN_TTL_SECONDS
    ): string {
      if (!input || typeof input.sub !== "string" || typeof input.uid !== "string") {
        throw new Error("signAccess requires sub and uid");
      }
      if (!ROLES.has(input.role)) throw new Error(`Invalid session role '${String(input.role)}'`);
      if (!Array.isArray(input.orgIds) || !input.orgIds.every((id) => typeof id === "string")) {
        throw new Error("signAccess requires orgIds to be a string array");
      }
      const ttl = Number.isFinite(ttlSeconds) ? ttlSeconds : REALM_ACCESS_TOKEN_TTL_SECONDS;
      const nowSec = Math.floor(Date.now() / 1000);
      const exp = nowSec + Math.floor(ttl);
      return signHs256(
        {
          typ: "access",
          realm: config.realm,
          iss: config.issuer,
          aud: config.audience,
          sub: input.sub,
          uid: input.uid,
          role: input.role,
          orgIds: [...input.orgIds],
          jti: crypto.randomUUID(),
          iat: nowSec,
          exp,
        },
        secret,
        config.typ
      );
    },

    verifyAccess(token: string): RealmSessionClaims {
      const payload = verifyHs256(token, secret, config.typ);
      checkTokenType(payload, "access");
      assertRealmClaims(payload, config);
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
      if (isLocallyRevoked(jti)) throw unauthenticated("Session token has been revoked");

      return {
        typ: "access",
        realm: config.realm,
        iss: config.issuer,
        aud: config.audience,
        sub,
        uid,
        role: role as RealmRole,
        orgIds: orgIds as string[],
        jti,
        exp,
      };
    },

    signRefresh(sub: string, ttlSeconds: number = REALM_REFRESH_TOKEN_TTL_SECONDS): string {
      if (typeof sub !== "string" || sub.length === 0) throw new Error("signRefresh requires a sub");
      const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : REALM_REFRESH_TOKEN_TTL_SECONDS;
      const nowSec = Math.floor(Date.now() / 1000);
      const exp = nowSec + Math.floor(ttl);
      return signHs256(
        {
          typ: "refresh",
          realm: config.realm,
          iss: config.issuer,
          aud: config.audience,
          sub,
          jti: crypto.randomUUID(),
          iat: nowSec,
          exp,
        },
        secret,
        config.typ
      );
    },

    verifyRefresh(token: string): RealmRefreshClaims {
      const payload = verifyHs256(token, secret, config.typ);
      checkTokenType(payload, "refresh");
      assertRealmClaims(payload, config);
      const exp = assertTemporalClaims(payload);
      const sub = payload["sub"];
      const jti = payload["jti"];
      if (typeof sub !== "string" || typeof jti !== "string" || jti.length === 0) {
        throw unauthenticated("Refresh token is missing required claims");
      }
      if (isLocallyRevoked(jti)) throw unauthenticated("Refresh token has been revoked");
      return {
        typ: "refresh",
        realm: config.realm,
        iss: config.issuer,
        aud: config.audience,
        sub,
        jti,
        exp,
      };
    },

    async revoke(jti: string, expiresAtMs: number): Promise<void> {
      if (!jti) return;
      const now = Date.now();
      if (expiresAtMs > now) {
        localRevocations.set(jti, expiresAtMs);
        if (localRevocations.size > MAX_LOCAL_REVOCATIONS) {
          pruneLocalRevocations(now);
        }
      }
      await revocationStore.revoke(jti, expiresAtMs);
    },

    async isRevoked(jti: string): Promise<boolean> {
      if (isLocallyRevoked(jti)) return true;
      return revocationStore.isRevoked(jti);
    },
  };
}
