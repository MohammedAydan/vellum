/**
 * @vellum/authorization - TOTP MFA primitives 
 *
 * Framework-agnostic, dependency-light building blocks for the full TOTP MFA
 * flow. Everything here is synchronous, uses only Node's `node:crypto`, and
 * never evaluates untrusted code.
 *
 * Security properties
 * -------------------
 * - Secrets are generated from `crypto.randomBytes` (160 bits by default) and
 *   encoded as RFC 4648 Base32, the format expected by authenticator apps.
 * - TOTP is RFC 6238 (HMAC-SHA1, 30s period, 6 digits) with a configurable
 *   ±1 step acceptance window. Comparisons are constant time.
 * - Recovery codes are *derived deterministically from the TOTP secret* via
 *   HMAC-SHA256. That makes a pre-verified `setup` call idempotent (the same
 *   plaintext codes can be shown again) while the database only ever stores
 *   keyed hashes of them — never the plaintext.
 * - Recovery-code consumption returns a new list with the matched code marked
 *   used; callers must persist that list for one-time semantics.
 */

import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNPQRSTUVWXYZ234567"; // Crockford-ish: no 0/1/I/O ambiguity in codes
const TOTP_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648 Base32 for TOTP secrets
const MAX_TOTP_WINDOW = 5;
const MAX_SECRET_LENGTH = 512;
const MAX_RECOVERY_CODE_LENGTH = 64;
const DIGITS_6_REGEX = /^\d{6}$/;
const DIGITS_7_REGEX = /^\d{7}$/;
const DIGITS_8_REGEX = /^\d{8}$/;

function isValidDigitsCode(code: string, digits: number): boolean {
  if (digits === 6) return DIGITS_6_REGEX.test(code);
  if (digits === 7) return DIGITS_7_REGEX.test(code);
  if (digits === 8) return DIGITS_8_REGEX.test(code);
  if (code.length !== digits) return false;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code.charCodeAt(i);
    if (ch < 48 || ch > 57) return false;
  }
  return true;
}

export interface TotpOptions {
  /** Time step in seconds (RFC 6238 default: 30). */
  stepSeconds?: number | undefined;
  /** Number of digits (RFC 6238 default: 6). */
  digits?: number | undefined;
  /** Injectable clock for deterministic tests. */
  nowMs?: number | undefined;
}

export interface VerifyTotpOptions extends TotpOptions {
  /** Number of adjacent time steps accepted on either side (default: 1). */
  window?: number | undefined;
}

export interface StoredRecoveryCode {
  /** HMAC-SHA256 (hex) of the normalised recovery code. */
  hash: string;
  /** ISO timestamp when the code was consumed, or null while unused. */
  consumedAt: string | null;
}

export interface RecoveryCodeConsumption {
  valid: boolean;
  codes: StoredRecoveryCode[];
}

/* -------------------------------------------------------------------------- */
/* Base32                                                                      */
/* -------------------------------------------------------------------------- */

function bytesToBase32(bytes: Uint8Array, alphabet: string): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) >>> 0;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31] ?? "";
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31] ?? "";
  return out;
}

function base32ToBytes(input: string): Buffer {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_SECRET_LENGTH) {
    return Buffer.alloc(0);
  }
  const cleaned = input.toUpperCase().replace(/=+$/, "").replace(/[^A-Z2-7]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of cleaned) {
    const index = TOTP_ALPHABET.indexOf(char);
    if (index < 0) continue;
    value = ((value << 5) | index) >>> 0;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

/* -------------------------------------------------------------------------- */
/* TOTP (RFC 6238)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Generate a crypto-secure, Base32-encoded TOTP secret (20 bytes = 160 bits).
 * Uses `crypto.randomBytes`; the encoding is RFC 4648 Base32 so the value can
 * be embedded directly in an `otpauth://` URI.
 */
export function generateMfaSecret(byteLength = 20): string {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 128) {
    throw new Error("generateMfaSecret requires at least 16 random bytes");
  }
  return bytesToBase32(crypto.randomBytes(byteLength), TOTP_ALPHABET);
}

function hotp(key: Buffer, counter: number, digits: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return ((binary >>> 0) % 10 ** digits).toString().padStart(digits, "0");
}

/** Generate the RFC 6238 code for a given secret and (optionally) instant. */
export function generateTotpCode(secret: string, options: TotpOptions = {}): string {
  const step = options.stepSeconds ?? 30;
  const digits = options.digits ?? 6;
  const nowMs = options.nowMs ?? Date.now();
  const counter = Math.max(0, Math.floor(nowMs / 1000 / step));
  return hotp(base32ToBytes(secret), counter, digits);
}

/**
 * Verify an RFC 6238 TOTP code. Accepts ±`window` time steps by default to
 * tolerate clock drift. Invalid shapes always return false (never throw).
 * Evaluates all steps in the window without early return to avoid timing leaks.
 */
export function verifyTotp(secret: string, token: string, options: VerifyTotpOptions = {}): boolean {
  const step = options.stepSeconds ?? 30;
  const digits = options.digits ?? 6;
  const rawWindow = options.window ?? 1;
  const nowMs = options.nowMs ?? Date.now();
  if (
    !Number.isFinite(step) ||
    step < 1 ||
    step > 300 ||
    !Number.isInteger(digits) ||
    digits < 4 ||
    digits > 10 ||
    !Number.isFinite(nowMs) ||
    nowMs < 0
  ) {
    return false;
  }
  const window = Number.isInteger(rawWindow) ? Math.max(0, Math.min(MAX_TOTP_WINDOW, rawWindow)) : 1;
  const code = typeof token === "string" ? token.trim() : "";
  if (!isValidDigitsCode(code, digits)) return false;

  const key = base32ToBytes(secret);
  if (key.length === 0) return false;

  const counter = Math.floor(nowMs / 1000 / step);
  let matched = 0;
  for (let delta = -window; delta <= window; delta += 1) {
    const candidate = counter + delta;
    if (candidate < 0) continue;
    if (safeEqual(hotp(key, candidate, digits), code)) {
      matched |= 1;
    }
  }
  return matched === 1;
}

/* -------------------------------------------------------------------------- */
/* Recovery codes                                                              */
/* -------------------------------------------------------------------------- */

/** Normalise a recovery code the same way on generation and verification. */
function normaliseRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Hash a recovery code with a server-side pepper. Hex HMAC-SHA256, 64 chars. */
export function hashRecoveryCode(code: string, pepper: string): string {
  return crypto.createHmac("sha256", pepper).update(normaliseRecoveryCode(code)).digest("hex");
}

/**
 * Derive recovery codes deterministically from a TOTP secret. Because the
 * secret is high-entropy, these are unguessable; deriving instead of storing
 * plaintext lets an unverified `setup` be repeated safely.
 *
 * Codes are returned formatted as `XXXX-XXXX-XXXX-XXXX`.
 */
export function deriveRecoveryCodes(secret: string, count = 8): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 30) {
    throw new Error("deriveRecoveryCodes requires count between 1 and 30");
  }
  const key = base32ToBytes(secret);
  if (key.length === 0) throw new Error("deriveRecoveryCodes requires a valid Base32 secret");

  const codes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const digest = crypto
      .createHmac("sha256", key)
      .update(`vellum-mfa-recovery:v1:${index}`)
      .digest();
    let raw = "";
    for (let position = 0; position < 16; position += 1) {
      const byte = digest[position % digest.length] ?? 0;
      raw += BASE32_ALPHABET[byte % BASE32_ALPHABET.length] ?? "";
    }
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`);
  }
  return codes;
}

/** Hash all plaintext recovery codes for persistence (never store plaintext). */
export function hashRecoveryCodes(codes: readonly string[], pepper: string): StoredRecoveryCode[] {
  return codes.map((code) => ({ hash: hashRecoveryCode(code, pepper), consumedAt: null }));
}

/**
 * Attempt to consume a recovery code from a list of stored hashes.
 *
 * Returns `{ valid: true, codes }` with the matching entry marked consumed, or
 * `{ valid: false, codes }` unchanged when the code is unknown/already used.
 * All entries are inspected so lookup time does not reveal the match position.
 */
export function consumeRecoveryCode(
  presentedCode: string,
  pepper: string,
  storedCodes: readonly StoredRecoveryCode[]
): RecoveryCodeConsumption {
  if (
    typeof presentedCode !== "string" ||
    presentedCode.length === 0 ||
    presentedCode.length > MAX_RECOVERY_CODE_LENGTH
  ) {
    return {
      valid: false,
      codes: storedCodes.map((entry) => ({ hash: entry.hash, consumedAt: entry.consumedAt })),
    };
  }
  const target = hashRecoveryCode(presentedCode, pepper);
  let matchIndex = -1;
  for (let index = 0; index < storedCodes.length; index += 1) {
    const entry = storedCodes[index];
    if (!entry || entry.consumedAt !== null) continue;
    if (safeEqual(entry.hash, target) && matchIndex === -1) matchIndex = index;
  }

  const now = new Date().toISOString();
  const codes = storedCodes.map((entry, index) =>
    index === matchIndex ? { hash: entry.hash, consumedAt: now } : { hash: entry.hash, consumedAt: entry.consumedAt }
  );
  return { valid: matchIndex !== -1, codes };
}
