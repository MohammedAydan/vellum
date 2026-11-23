/**
 * Password hashing — asynchronous scrypt, N=2^14, r=8, p=1, keylen=64.
 * Canonical format: scrypt$16384$8$1$<saltBase64>$<hashBase64>
 * The legacy `scrypt$<saltHex>$<hashHex>` format from the console auth routes
 * is still verified so existing accounts remain valid.
 */

import crypto from "node:crypto";

const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/** Hard upper bound on password length (UTF-8 bytes) to prevent scrypt DoS. */
const MAX_PASSWORD_BYTES = 1_024;
const MAX_STORED_HASH_LENGTH = 512;
const MIN_SCRYPT_N = 1_024;
const MAX_SCRYPT_N = 131_072;
const MAX_SCRYPT_R = 32;
const MAX_SCRYPT_P = 8;
const MAX_SCRYPT_MEM_BYTES = 128 * 1024 * 1024;
const STRICT_HEX_REGEX = /^[0-9a-f]+$/i;
const STRICT_BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_SCRYPT_MEM_BYTES }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("password must be a non-empty string");
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw new Error(`password exceeds maximum length of ${MAX_PASSWORD_BYTES} bytes`);
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (
    typeof stored !== "string" ||
    typeof password !== "string" ||
    password.length === 0 ||
    stored.length === 0 ||
    stored.length > MAX_STORED_HASH_LENGTH ||
    Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES
  ) {
    return false;
  }
  const parts = stored.split("$");
  try {
    if (parts[0] === "scrypt" && parts.length === 6) {
      const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [string, string, string, string, string, string];
      const n = Number(nRaw);
      const r = Number(rRaw);
      const p = Number(pRaw);
      if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
      // N must be a power of two within safe CPU/memory bounds
      if (n < MIN_SCRYPT_N || n > MAX_SCRYPT_N || (n & (n - 1)) !== 0) return false;
      if (r < 1 || r > MAX_SCRYPT_R || p < 1 || p > MAX_SCRYPT_P) return false;
      if (!saltRaw || !hashRaw || !STRICT_BASE64_REGEX.test(saltRaw) || !STRICT_BASE64_REGEX.test(hashRaw)) {
        return false;
      }
      const salt = Buffer.from(saltRaw, "base64");
      const expected = Buffer.from(hashRaw, "base64");
      if (salt.length < 8 || salt.length > 64 || expected.length < 16 || expected.length > 128) {
        return false;
      }
      const derived = await new Promise<Buffer>((resolve, reject) => {
        crypto.scrypt(password, salt, expected.length, { N: n, r, p, maxmem: MAX_SCRYPT_MEM_BYTES }, (err, key) =>
          err ? reject(err) : resolve(key)
        );
      });
      return safeEqual(derived, expected);
    }
    // Legacy console-auth format: scrypt$<saltHex>$<hashHex>
    if (parts[0] === "scrypt" && parts.length === 3) {
      const saltHex = parts[1] as string;
      const hashHex = parts[2] as string;
      if (
        !saltHex ||
        !hashHex ||
        saltHex.length % 2 !== 0 ||
        hashHex.length % 2 !== 0 ||
        !STRICT_HEX_REGEX.test(saltHex) ||
        !STRICT_HEX_REGEX.test(hashHex)
      ) {
        return false;
      }
      const salt = Buffer.from(saltHex, "hex");
      const expected = Buffer.from(hashHex, "hex");
      if (salt.length < 8 || salt.length > 64 || expected.length !== KEY_LENGTH) return false;
      const derived = await scrypt(password, salt);
      return safeEqual(derived, expected);
    }
    return false;
  } catch {
    return false;
  }
}
