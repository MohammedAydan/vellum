/**
 * unit tests for the framework-agnostic MFA primitives.
 *
 * Run: corepack pnpm vitest run tests/unit/mfa-authorization.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  generateMfaSecret,
  generateTotpCode,
  verifyTotp,
  hashRecoveryCode,
  deriveRecoveryCodes,
  hashRecoveryCodes,
  consumeRecoveryCode,
  type StoredRecoveryCode,
} from "@vellum/authorization";

const NOW = 1_793_000_000_000;
const PEPPER = "unit-test-recovery-pepper";

describe("@vellum/authorization MFA primitives", () => {
  it("generateMfaSecret is crypto-secure, Base32-shaped and non-repeating", () => {
    const first = generateMfaSecret();
    const second = generateMfaSecret();
    // 20 random bytes -> exactly 32 RFC 4648 Base32 characters.
    expect(first).toMatch(/^[A-Z2-7]{32}$/);
    expect(second).toMatch(/^[A-Z2-7]{32}$/);
    expect(first).not.toBe(second);
    expect(() => generateMfaSecret(8)).toThrow();
  });

  it("generateTotpCode / verifyTotp implement RFC 6238 with a drift window", () => {
    const secret = generateMfaSecret();
    const code = generateTotpCode(secret, { nowMs: NOW });
    expect(code).toMatch(/^\d{6}$/);

    expect(verifyTotp(secret, code, { nowMs: NOW })).toBe(true);
    expect(verifyTotp(secret, "000000", { nowMs: NOW })).toBe(false);
    expect(verifyTotp(secret, "12345", { nowMs: NOW })).toBe(false); // wrong shape
    expect(verifyTotp(secret, "abcdef", { nowMs: NOW })).toBe(false);

    // One step earlier (30s) is inside the default ±1 window.
    expect(verifyTotp(secret, code, { nowMs: NOW - 30_000 })).toBe(true);
    // ...but rejected when the window is closed.
    expect(verifyTotp(secret, code, { nowMs: NOW - 30_000, window: 0 })).toBe(false);
    // Two steps earlier is outside the default window.
    expect(verifyTotp(secret, code, { nowMs: NOW - 60_000 })).toBe(false);
  });

  it("hashRecoveryCode is deterministic, peppered and normalisation-stable", () => {
    const code = "ABCD-EFGH-IJKL-MNOP";
    const hash = hashRecoveryCode(code, PEPPER);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode("abcdefghijklmnop", PEPPER)).toBe(hash);
    expect(hashRecoveryCode(" abcd efgh ijkl mnop ", PEPPER)).toBe(hash);
    expect(hashRecoveryCode(code, "a-different-pepper")).not.toBe(hash);
  });

  it("deriveRecoveryCodes is deterministic per secret and hashes cleanly", () => {
    const secret = generateMfaSecret();
    const codes = deriveRecoveryCodes(secret, 8);
    expect(codes).toHaveLength(8);
    expect(codes[0]).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(deriveRecoveryCodes(secret, 8)).toEqual(codes); // idempotent setup
    expect(deriveRecoveryCodes(generateMfaSecret(), 8)).not.toEqual(codes);

    const hashes = hashRecoveryCodes(codes, PEPPER);
    expect(hashes).toHaveLength(8);
    expect(hashes.every((entry) => entry.consumedAt === null)).toBe(true);
    expect(hashes.every((entry) => /^[0-9a-f]{64}$/.test(entry.hash))).toBe(true);
  });

  it("consumeRecoveryCode is strictly one-time", () => {
    const secret = generateMfaSecret();
    const code = deriveRecoveryCodes(secret, 8)[1]!;
    const stored: StoredRecoveryCode[] = hashRecoveryCodes(deriveRecoveryCodes(secret, 8), PEPPER);

    const unknown = consumeRecoveryCode("ZZZZ-ZZZZ-ZZZZ-ZZZZ", PEPPER, stored);
    expect(unknown.valid).toBe(false);
    expect(unknown.codes).toEqual(stored);

    const first = consumeRecoveryCode(code, PEPPER, stored);
    expect(first.valid).toBe(true);
    expect(first.codes.filter((entry) => entry.consumedAt !== null)).toHaveLength(1);

    const replay = consumeRecoveryCode(code, PEPPER, first.codes);
    expect(replay.valid).toBe(false);
    expect(replay.codes).toEqual(first.codes);
  });
});
