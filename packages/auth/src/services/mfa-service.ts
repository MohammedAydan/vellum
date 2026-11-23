/**
 * RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30-second step, ±1 step drift)
 * and hashed recovery codes. node:crypto only.
 */

import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;
const RECOVERY_CODE_COUNT = 8;
const MAX_TOTP_WINDOW = 5;
const MAX_SECRET_LENGTH = 512;
const MAX_RECOVERY_CODE_LENGTH = 64;
const SIX_DIGIT_REGEX = /^\d{6}$/;

export function generateTotpSecret(byteLength = 20): string {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 128) {
    throw new Error("generateTotpSecret requires byteLength between 16 and 128");
  }
  return encodeBase32(crypto.randomBytes(byteLength));
}

function encodeBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
  return output;
}

function decodeBase32(input: string): Buffer {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_SECRET_LENGTH) {
    return Buffer.alloc(0);
  }
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function totpAtKey(key: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buffer).digest();
  const offset = (hmac[hmac.length - 1] as number) & 0x0f;
  const binary =
    (((hmac[offset] as number) & 0x7f) << 24) |
    (((hmac[offset + 1] as number) & 0xff) << 16) |
    (((hmac[offset + 2] as number) & 0xff) << 8) |
    ((hmac[offset + 3] as number) & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function generateTotpCode(secret: string, atEpochMs = Date.now()): string {
  const key = decodeBase32(secret);
  const counter = Math.max(0, Math.floor(atEpochMs / 1000 / STEP_SECONDS));
  return totpAtKey(key, counter);
}

export function verifyTotpCode(
  secret: string,
  code: string,
  window = 1,
  atEpochMs = Date.now()
): boolean {
  if (typeof code !== "string" || !SIX_DIGIT_REGEX.test(code)) return false;
  if (!Number.isFinite(atEpochMs) || atEpochMs < 0) return false;
  const key = decodeBase32(secret);
  if (key.length === 0) return false;

  const boundedWindow = Number.isInteger(window) ? Math.max(0, Math.min(MAX_TOTP_WINDOW, window)) : 1;
  const counter = Math.floor(atEpochMs / 1000 / STEP_SECONDS);
  const codeBuf = Buffer.from(code, "utf8");

  // Evaluate every step in [-boundedWindow, +boundedWindow] without early exit
  // to avoid leaking which drift step matched via timing.
  let matched = 0;
  for (let delta = -boundedWindow; delta <= boundedWindow; delta += 1) {
    const step = counter + delta;
    if (step < 0) continue;
    const candidateBuf = Buffer.from(totpAtKey(key, step), "utf8");
    if (candidateBuf.length === codeBuf.length && crypto.timingSafeEqual(candidateBuf, codeBuf)) {
      matched |= 1;
    }
  }
  return matched === 1;
}

/**
 * Stateful TOTP replay guard that rejects reuse of a TOTP code within the same
 * (or earlier) 30-second time step per subject. Bounded in memory.
 */
export interface TotpReplayGuard {
  verifyAndConsume(subjectId: string, secret: string, code: string, window?: number, atEpochMs?: number): boolean;
  clear(): void;
}

export function createTotpReplayGuard(maxTrackedSubjects = 50_000): TotpReplayGuard {
  const lastStepBySubject = new Map<string, number>();
  const cap = Math.max(1, Math.floor(maxTrackedSubjects));

  return {
    verifyAndConsume(
      subjectId: string,
      secret: string,
      code: string,
      window = 1,
      atEpochMs = Date.now()
    ): boolean {
      if (typeof subjectId !== "string" || subjectId.length === 0) return false;
      if (typeof code !== "string" || !SIX_DIGIT_REGEX.test(code)) return false;
      if (!Number.isFinite(atEpochMs) || atEpochMs < 0) return false;
      const key = decodeBase32(secret);
      if (key.length === 0) return false;

      const boundedWindow = Number.isInteger(window) ? Math.max(0, Math.min(MAX_TOTP_WINDOW, window)) : 1;
      const counter = Math.floor(atEpochMs / 1000 / STEP_SECONDS);
      const codeBuf = Buffer.from(code, "utf8");

      let matchedStep = -1;
      for (let delta = -boundedWindow; delta <= boundedWindow; delta += 1) {
        const step = counter + delta;
        if (step < 0) continue;
        const candidateBuf = Buffer.from(totpAtKey(key, step), "utf8");
        if (candidateBuf.length === codeBuf.length && crypto.timingSafeEqual(candidateBuf, codeBuf)) {
          if (matchedStep === -1) matchedStep = step;
        }
      }
      if (matchedStep === -1) return false;

      const prevStep = lastStepBySubject.get(subjectId);
      if (prevStep !== undefined && matchedStep <= prevStep) {
        return false;
      }
      if (lastStepBySubject.has(subjectId)) {
        lastStepBySubject.delete(subjectId);
      } else if (lastStepBySubject.size >= cap) {
        const oldest = lastStepBySubject.keys().next();
        if (oldest.done !== true) lastStepBySubject.delete(oldest.value);
      }
      lastStepBySubject.set(subjectId, matchedStep);
      return true;
    },
    clear(): void {
      lastStepBySubject.clear();
    },
  };
}

function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(code.toUpperCase()).digest("hex");
}

export function deriveRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 32) {
    throw new Error("deriveRecoveryCodes requires count between 1 and 32");
  }
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    codes.push(encodeBase32(crypto.randomBytes(6)).replace(/=/g, "").slice(0, 10));
  }
  return codes;
}

export function hashRecoveryCodes(codes: string[]): string[] {
  return codes.map(hashRecoveryCode);
}

/** Returns the matched index, or -1 when no recovery code matches. Scans all entries in constant time. */
export function verifyRecoveryCode(code: string, hashedCodes: string[]): number {
  if (typeof code !== "string" || code.length === 0 || code.length > MAX_RECOVERY_CODE_LENGTH) {
    return -1;
  }
  if (!Array.isArray(hashedCodes) || hashedCodes.length === 0) {
    return -1;
  }
  const candidate = Buffer.from(hashRecoveryCode(code), "utf8");
  let matchedIndex = -1;
  for (let i = 0; i < hashedCodes.length; i += 1) {
    const stored = hashedCodes[i];
    if (typeof stored !== "string") continue;
    const storedBuf = Buffer.from(stored, "utf8");
    if (candidate.length === storedBuf.length && crypto.timingSafeEqual(candidate, storedBuf)) {
      if (matchedIndex === -1) matchedIndex = i;
    }
  }
  return matchedIndex;
}
