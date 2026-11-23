/**
 * Ed25519 (EdDSA) end-user access tokens + RFC 8037 JWKS export.
 * Uses only node:crypto; no dynamic code execution and no external JWT library.
 */

import crypto from "node:crypto";
import { VellumError } from "@vellum/core";
import { decryptSecret, encryptSecret } from "./encrypt.js";

const MAX_JWT_BYTES = 16_384; // 16 KiB DoS cap
const ED25519_SIG_BYTES = 64;
const CLOCK_SKEW_SECONDS = 60;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

/** Bounded LRU cache for parsed Ed25519 public KeyObjects (hot verification path). */
const PUBKEY_CACHE_MAX = 256;
const PUBKEY_CACHE = new Map<string, crypto.KeyObject>();

function getEd25519PublicKey(publicKeyPem: string): crypto.KeyObject {
  const cached = PUBKEY_CACHE.get(publicKeyPem);
  if (cached !== undefined) {
    PUBKEY_CACHE.delete(publicKeyPem);
    PUBKEY_CACHE.set(publicKeyPem, cached);
    return cached;
  }
  let keyObj: crypto.KeyObject;
  try {
    keyObj = crypto.createPublicKey(publicKeyPem);
  } catch {
    throw new VellumError("UNAUTHENTICATED", "Invalid verification key");
  }
  if (keyObj.asymmetricKeyType !== "ed25519") {
    throw new VellumError("UNAUTHENTICATED", "Verification key must be Ed25519");
  }
  if (PUBKEY_CACHE.size >= PUBKEY_CACHE_MAX) {
    const oldest = PUBKEY_CACHE.keys().next();
    if (oldest.done !== true) PUBKEY_CACHE.delete(oldest.value);
  }
  PUBKEY_CACHE.set(publicKeyPem, keyObj);
  return keyObj;
}

export interface EndUserJwtPayload {
  iss: string;
  sub: string;
  aud: string;
  jti: string;
  email: string | null;
  email_verified: boolean;
  is_anonymous: boolean;
  claims: Record<string, unknown>;
  iat: number;
  exp: number;
  auth_time: number;
  nbf?: number | undefined;
}

export interface Ed25519KeyPair {
  keyId: string;
  publicKeyPem: string;
  privateKeyEncrypted: string;
}

export function generateEd25519KeyPair(masterKey?: string): Ed25519KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    keyId: crypto.randomUUID(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyEncrypted: encryptSecret(
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      masterKey
    ),
  };
}

export function decryptPrivateKey(encrypted: string, masterKey?: string): crypto.KeyObject {
  let keyObj: crypto.KeyObject;
  try {
    keyObj = crypto.createPrivateKey(decryptSecret(encrypted, masterKey));
  } catch {
    throw new VellumError("INTERNAL_ERROR", "Failed to load signing key");
  }
  if (keyObj.asymmetricKeyType !== "ed25519") {
    throw new VellumError("INTERNAL_ERROR", "Signing key must be Ed25519");
  }
  return keyObj;
}

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function signEndUserAccessToken(
  payload: EndUserJwtPayload,
  privateKey: crypto.KeyObject | string,
  keyId?: string
): string {
  const header = { alg: "EdDSA", typ: "vellum+enduser+jwt", ...(keyId ? { kid: keyId } : {}) };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  let keyObject: crypto.KeyObject;
  try {
    keyObject =
      typeof privateKey === "string"
        ? crypto.createPrivateKey(privateKey.includes("BEGIN") ? privateKey : decryptSecret(privateKey))
        : privateKey;
  } catch {
    throw new VellumError("INTERNAL_ERROR", "Failed to load signing key");
  }
  if (keyObject.asymmetricKeyType !== "ed25519") {
    throw new VellumError("INTERNAL_ERROR", "Signing key must be Ed25519");
  }
  const signature = crypto.sign(null, Buffer.from(signingInput, "utf8"), keyObject);
  return `${signingInput}.${signature.toString("base64url")}`;
}

export interface JwtVerificationTarget {
  projectId: string;
  /** The project-scoped issuer is mandatory: verification fails closed without it. */
  issuer: string;
}

export function verifyEndUserAccessToken(
  token: string,
  publicKeyPem: string,
  expected: JwtVerificationTarget
): EndUserJwtPayload {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_JWT_BYTES) {
    throw new VellumError("UNAUTHENTICATED", "Malformed bearer JWT");
  }
  if (
    !expected ||
    typeof expected.projectId !== "string" ||
    expected.projectId.length === 0 ||
    typeof expected.issuer !== "string" ||
    expected.issuer.length === 0
  ) {
    throw new VellumError("UNAUTHENTICATED", "Missing JWT verification target");
  }

  const parts = token.split(".");
  if (parts.length !== 3) throw new VellumError("UNAUTHENTICATED", "Malformed bearer JWT");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  if (
    !BASE64URL_REGEX.test(headerB64) ||
    !BASE64URL_REGEX.test(payloadB64) ||
    !BASE64URL_REGEX.test(sigB64)
  ) {
    throw new VellumError("UNAUTHENTICATED", "Malformed bearer JWT");
  }

  let header: { alg?: unknown; typ?: unknown } | null;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as {
      alg?: unknown;
      typ?: unknown;
    } | null;
  } catch {
    throw new VellumError("UNAUTHENTICATED", "Invalid JWT header");
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    throw new VellumError("UNAUTHENTICATED", "Invalid JWT header");
  }
  if (header.alg !== "EdDSA" || header.typ !== "vellum+enduser+jwt") {
    throw new VellumError("UNAUTHENTICATED", "Unsupported JWT algorithm or type");
  }

  const sigBuf = Buffer.from(sigB64, "base64url");
  if (sigBuf.length !== ED25519_SIG_BYTES) {
    throw new VellumError("UNAUTHENTICATED", "Invalid end-user JWT signature");
  }

  const pubKey = getEd25519PublicKey(publicKeyPem);
  const valid = crypto.verify(null, Buffer.from(`${headerB64}.${payloadB64}`, "utf8"), pubKey, sigBuf);
  if (!valid) throw new VellumError("UNAUTHENTICATED", "Invalid end-user JWT signature");

  let payload: EndUserJwtPayload | null;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as EndUserJwtPayload | null;
  } catch {
    throw new VellumError("UNAUTHENTICATED", "Invalid JWT payload");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new VellumError("UNAUTHENTICATED", "Invalid JWT payload");
  }

  const nowMs = Date.now();
  // `exp` is intentionally checked only after signature verification: an
  // unauthenticated token must never be able to influence error semantics.
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp * 1000 <= nowMs) {
    throw new VellumError("TOKEN_EXPIRED", "Access token has expired", {
      retryableWithRefresh: true,
    });
  }
  if (payload.nbf !== undefined) {
    if (
      typeof payload.nbf !== "number" ||
      !Number.isFinite(payload.nbf) ||
      payload.nbf * 1000 > nowMs + CLOCK_SKEW_SECONDS * 1000
    ) {
      throw new VellumError("UNAUTHENTICATED", "Access token is not yet valid");
    }
  }
  if (payload.iat !== undefined) {
    if (
      typeof payload.iat !== "number" ||
      !Number.isFinite(payload.iat) ||
      payload.iat * 1000 > nowMs + CLOCK_SKEW_SECONDS * 1000
    ) {
      throw new VellumError("UNAUTHENTICATED", "Access token issued-at timestamp is invalid");
    }
  }
  if (typeof payload.aud !== "string" || payload.aud !== expected.projectId) {
    throw new VellumError("PERMISSION_DENIED", "JWT audience mismatch");
  }
  if (typeof payload.iss !== "string" || payload.iss !== expected.issuer) {
    throw new VellumError("UNAUTHENTICATED", "JWT issuer mismatch");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new VellumError("UNAUTHENTICATED", "JWT subject missing");
  }
  return payload;
}

export function exportPublicJwks(config: {
  jwtKeyId: string;
  jwtPublicKeyPem: string;
}): { keys: Array<Record<string, unknown>> } {
  const pubKey = getEd25519PublicKey(config.jwtPublicKeyPem);
  const jwk = pubKey.export({ format: "jwk" });
  return {
    keys: [
      {
        ...jwk,
        kty: "OKP",
        crv: "Ed25519",
        alg: "EdDSA",
        use: "sig",
        kid: config.jwtKeyId,
      },
    ],
  };
}
