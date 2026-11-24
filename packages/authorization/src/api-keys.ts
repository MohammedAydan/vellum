/**
 * @vellum/authorization - API Key Generator & Constant-Time Verifier
 * Generates and verifies Public (`pk_`) and Server (`sk_`) API keys.
 * The project is the sole tenant unit.
 */

import crypto from "node:crypto";
import { VellumError } from "@vellum/core";
import type { ApiKeyRecord } from "@vellum/database-control";

const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MAX_API_KEY_LENGTH = 256;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;
const VERIFIED_CACHE_MAX_ENTRIES = 10_000;

/**
 * Canonical API-key pepper. Generation and verification MUST agree. The
 * deployment-facing name is `API_KEY_PEPPER` (see apps/api/src/config.ts);
 * `PEPPER_HEX` is retained as a legacy alias.
 *
 * Resolution is lazy because dotenv is loaded by the API app's config module,
 * which is evaluated after this package in the ESM graph. A module-level
 * constant would freeze the pre-dotenv fallback and break verification.
 */
export const FALLBACK_PEPPER = "vellum_default_pepper_v1";

export function getDefaultPepper(): string {
  return process.env["API_KEY_PEPPER"] ?? process.env["PEPPER_HEX"] ?? FALLBACK_PEPPER;
}

/** @deprecated Use `getDefaultPepper()` for lazy, dotenv-safe resolution. */
export const DEFAULT_PEPPER = FALLBACK_PEPPER;

/**
 * Uniform Base62 generator using rejection sampling (< 248 = 62 * 4) to eliminate modulo bias.
 */
function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    const needed = length - out.length;
    const bytes = crypto.randomBytes(Math.max(needed * 2, 16));
    for (let i = 0; i < bytes.length && out.length < length; i += 1) {
      const byte = bytes[i]!;
      if (byte < 248) {
        out += BASE62_ALPHABET.charAt(byte % 62);
      }
    }
  }
  return out;
}

export function hashApiKey(fullKey: string, pepper: string = getDefaultPepper()): string {
  return crypto.createHash("sha256").update(`${fullKey}:${pepper}`).digest("hex");
}

export interface GeneratedApiKey {
  fullKey: string;
  keyPrefix: string;
  secretHash: string;
  keyType: "public" | "server";
}

/**
 * Generates a new Public (`pk_<32_base62>`) or Server (`sk_<48_base62>`) API key.
 * The key prefix is `pk_`/`sk_` only; the project is the sole tenant unit.
 */
export function generateProjectApiKey({
  keyType,
  pepper = getDefaultPepper(),
}: {
  keyType: "public" | "server";
  pepper?: string | undefined;
}): GeneratedApiKey {
  const prefixTag = keyType === "server" ? "sk" : "pk";
  const randomLen = keyType === "server" ? 48 : 32;
  const randomBody = randomBase62(randomLen);
  const fullKey = `${prefixTag}_${randomBody}`;
  const keyPrefix = fullKey.slice(0, 16);
  const secretHash = hashApiKey(fullKey, pepper);
  return { fullKey, keyPrefix, secretHash, keyType };
}

// 30-second TTL bounded verified key metadata cache (never bypasses constant-time digest check!)
interface CacheEntry {
  record: ApiKeyRecord;
  secretHash: string;
  secretHashBuf: Buffer;
  expiresAtMs: number | null;
  cachedAt: number;
}
const VERIFIED_KEY_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

export function invalidateApiKeyCache(keyPrefix?: string): void {
  if (keyPrefix) {
    VERIFIED_KEY_CACHE.delete(keyPrefix);
  } else {
    VERIFIED_KEY_CACHE.clear();
  }
}

export interface ApiKeyStore {
  apiKeysByPrefix: Map<string, ApiKeyRecord>;
}

/** Store that answers key lookups from the source of truth (the database), never from a local copy. */
export interface AsyncApiKeyStore {
  findApiKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null>;
  touchApiKeyLastUsed?(keyId: string): Promise<void>;
}

/**
 * Same checks as `verifyApiKey`, but the key record is read from the database on every call.
 * There is no cache: a revoke, an expiry change or a restriction edit applies to the next request.
 * The secret hash is always compared in constant time.
 */
export async function verifyApiKeyAsync(
  fullKey: unknown,
  store: AsyncApiKeyStore,
  pepper: string = getDefaultPepper()
): Promise<ApiKeyRecord> {
  if (typeof fullKey !== "string" || fullKey.length < 20 || fullKey.length > MAX_API_KEY_LENGTH) {
    throw new VellumError("UNAUTHENTICATED", "Missing or malformed X-Project-Key header");
  }
  const keyRecord = await store.findApiKeyByPrefix(fullKey.slice(0, 16));
  if (!keyRecord || keyRecord.revokedAt) {
    throw new VellumError("UNAUTHENTICATED", "Invalid or revoked API key");
  }
  const computed = crypto.createHash("sha256").update(`${fullKey}:${pepper}`).digest();
  if (typeof keyRecord.secretHash !== "string" || !SHA256_HEX_REGEX.test(keyRecord.secretHash)) {
    throw new VellumError("UNAUTHENTICATED", "Invalid API key signature");
  }
  const expected = Buffer.from(keyRecord.secretHash, "hex");
  if (computed.length !== expected.length || !crypto.timingSafeEqual(computed, expected)) {
    throw new VellumError("UNAUTHENTICATED", "Invalid API key signature");
  }
  const now = Date.now();
  if (keyRecord.expiresAt) {
    const expiresAtMs = Date.parse(keyRecord.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
      throw new VellumError("UNAUTHENTICATED", "API key has expired");
    }
  }
  const lastUsed = keyRecord.lastUsedAt ? Date.parse(keyRecord.lastUsedAt) : 0;
  if (store.touchApiKeyLastUsed && now - lastUsed > 60_000) {
    void store.touchApiKeyLastUsed(keyRecord.id).catch(() => undefined);
  }
  return keyRecord;
}

/**
 * Verifies an incoming `X-Project-Key` against Control Plane metadata using constant-time digest comparison.
 * Always verifies the full key's SHA-256 digest in constant time on every request — even on cache hits —
 * so knowing a key's public 16-character prefix can never bypass authentication.
 */
export function verifyApiKey(
  fullKey: unknown,
  controlStore: ApiKeyStore,
  pepper: string = getDefaultPepper()
): ApiKeyRecord {
  if (typeof fullKey !== "string" || fullKey.length < 20 || fullKey.length > MAX_API_KEY_LENGTH) {
    throw new VellumError("UNAUTHENTICATED", "Missing or malformed X-Project-Key header");
  }

  const keyPrefix = fullKey.slice(0, 16);
  const now = Date.now();

  // Always consult the live Control Plane store before trusting a cached
  // entry. Revocation removes the key from `apiKeysByPrefix`; without this
  // check a 30s cache entry keeps accepting a revoked key.
  const keyRecord = controlStore.apiKeysByPrefix.get(keyPrefix);
  if (!keyRecord || keyRecord.revokedAt) {
    VERIFIED_KEY_CACHE.delete(keyPrefix);
    throw new VellumError("UNAUTHENTICATED", "Invalid or revoked API key");
  }

  // Always compute the candidate key hash and compare in constant time
  const computedBuf = crypto.createHash("sha256").update(`${fullKey}:${pepper}`).digest();

  // Fast path: reuse pre-decoded secretHashBuf & parsed expiresAtMs when the live record matches
  const cached = VERIFIED_KEY_CACHE.get(keyPrefix);
  if (
    cached &&
    now - cached.cachedAt < CACHE_TTL_MS &&
    cached.record === keyRecord &&
    cached.secretHash === keyRecord.secretHash
  ) {
    if (cached.expiresAtMs !== null && cached.expiresAtMs <= now) {
      VERIFIED_KEY_CACHE.delete(keyPrefix);
      throw new VellumError("UNAUTHENTICATED", "API key has expired");
    }
    if (
      computedBuf.length !== cached.secretHashBuf.length ||
      !crypto.timingSafeEqual(computedBuf, cached.secretHashBuf)
    ) {
      throw new VellumError("UNAUTHENTICATED", "Invalid API key signature");
    }
    // LRU touch
    VERIFIED_KEY_CACHE.delete(keyPrefix);
    VERIFIED_KEY_CACHE.set(keyPrefix, cached);
    keyRecord.lastUsedAt = new Date(now).toISOString();
    return keyRecord;
  }

  let expiresAtMs: number | null = null;
  if (keyRecord.expiresAt) {
    expiresAtMs = Date.parse(keyRecord.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
      VERIFIED_KEY_CACHE.delete(keyPrefix);
      throw new VellumError("UNAUTHENTICATED", "API key has expired");
    }
  }

  if (typeof keyRecord.secretHash !== "string" || !SHA256_HEX_REGEX.test(keyRecord.secretHash)) {
    throw new VellumError("UNAUTHENTICATED", "Invalid API key signature");
  }
  const expectedBuf = Buffer.from(keyRecord.secretHash, "hex");

  if (computedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(computedBuf, expectedBuf)) {
    throw new VellumError("UNAUTHENTICATED", "Invalid API key signature");
  }

  keyRecord.lastUsedAt = new Date(now).toISOString();
  if (VERIFIED_KEY_CACHE.has(keyPrefix)) {
    VERIFIED_KEY_CACHE.delete(keyPrefix);
  } else if (VERIFIED_KEY_CACHE.size >= VERIFIED_CACHE_MAX_ENTRIES) {
    const oldest = VERIFIED_KEY_CACHE.keys().next();
    if (oldest.done !== true) VERIFIED_KEY_CACHE.delete(oldest.value);
  }
  VERIFIED_KEY_CACHE.set(keyPrefix, {
    record: keyRecord,
    secretHash: keyRecord.secretHash,
    secretHashBuf: expectedBuf,
    expiresAtMs,
    cachedAt: now,
  });
  return keyRecord;
}
