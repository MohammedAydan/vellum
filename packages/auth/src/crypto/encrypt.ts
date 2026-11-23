/**
 * AES-256-GCM encryption for auth secrets at rest.
 * Key = HKDF-SHA256(MASTER_ENCRYPTION_KEY, salt="", info="vellum-auth-v1", 32).
 * Format: v1:<ivBase64>:<authTagBase64>:<ciphertextBase64>
 */

import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const INFO = "vellum-auth-v1";
const MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024; // 16 MiB cap
const MAX_PAYLOAD_BYTES = 24 * 1024 * 1024; // 24 MiB cap (base64 overhead)
const STRICT_BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const DEFAULT_MASTER_KEY =
  process.env["MASTER_ENCRYPTION_KEY"] ??
  "dev_master_key_change_me_to_64_hex_chars_0123456789abcdef0123456789abcdef";

/** Bounded HKDF key derivation cache keyed by SHA-256(masterKey) to avoid storing plaintext keys. */
const DERIVED_KEY_CACHE_MAX = 16;
const DERIVED_KEY_CACHE = new Map<string, Buffer>();

function deriveKey(masterKey: string): Buffer {
  if (typeof masterKey !== "string" || masterKey.length < 16) {
    throw new Error("MASTER_ENCRYPTION_KEY must be at least 16 characters");
  }
  const cacheKey = crypto.createHash("sha256").update(masterKey, "utf8").digest("hex");
  const cached = DERIVED_KEY_CACHE.get(cacheKey);
  if (cached !== undefined) {
    DERIVED_KEY_CACHE.delete(cacheKey);
    DERIVED_KEY_CACHE.set(cacheKey, cached);
    return cached;
  }
  const derived = Buffer.from(crypto.hkdfSync("sha256", masterKey, Buffer.alloc(0), INFO, 32));
  if (DERIVED_KEY_CACHE.size >= DERIVED_KEY_CACHE_MAX) {
    const oldest = DERIVED_KEY_CACHE.keys().next();
    if (oldest.done !== true) DERIVED_KEY_CACHE.delete(oldest.value);
  }
  DERIVED_KEY_CACHE.set(cacheKey, derived);
  return derived;
}

function generateUniqueIv(): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  // Defense-in-depth: never emit an all-zero GCM nonce
  for (let i = 0; i < iv.length; i += 1) {
    if (iv[i] !== 0) return iv;
  }
  return crypto.randomBytes(IV_BYTES);
}

export function encryptSecret(plaintext: string, masterKey: string = DEFAULT_MASTER_KEY): string {
  if (typeof plaintext !== "string") {
    throw new Error("Plaintext secret must be a string");
  }
  if (Buffer.byteLength(plaintext, "utf8") > MAX_PLAINTEXT_BYTES) {
    throw new Error("Plaintext secret exceeds maximum permitted size");
  }
  const key = deriveKey(masterKey);
  const iv = generateUniqueIv();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    throw new Error("AES-GCM authentication tag length mismatch");
  }
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptSecret(payload: string, masterKey: string = DEFAULT_MASTER_KEY): string {
  if (typeof payload !== "string" || payload.length === 0 || payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error("Malformed encrypted secret");
  }
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Malformed encrypted secret");
  }
  const ivB64 = parts[1] as string;
  const tagB64 = parts[2] as string;
  const ctB64 = parts[3] as string;
  if (
    !ivB64 ||
    !tagB64 ||
    !STRICT_BASE64_REGEX.test(ivB64) ||
    !STRICT_BASE64_REGEX.test(tagB64) ||
    !STRICT_BASE64_REGEX.test(ctB64)
  ) {
    throw new Error("Malformed encrypted secret");
  }
  const key = deriveKey(masterKey);
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Malformed encrypted secret (iv/tag length)");
  }
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Failed to decrypt secret");
  }
}
