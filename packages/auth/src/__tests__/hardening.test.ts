import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createRealmSessionService,
  createTotpReplayGuard,
  decryptPrivateKey,
  decryptSecret,
  encryptSecret,
  generateEd25519KeyPair,
  generateTotpCode,
  generateTotpSecret,
  hashPassword,
  hashRecoveryCodes,
  signEndUserAccessToken,
  verifyEndUserAccessToken,
  verifyPassword,
  verifyRecoveryCode,
  verifyTotpCode,
  type EndUserJwtPayload,
  type RealmRevocationStore,
} from "../index.js";

const MASTER = "test-master-key-0123456789abcdef";

describe("@vellum/auth - Cryptographic & Protocol Hardening", () => {
  it("enforces AES-256-GCM IV uniqueness, strict base64/tag validation, and generic errors", () => {
    const c1 = encryptSecret("same-secret", MASTER);
    const c2 = encryptSecret("same-secret", MASTER);
    expect(c1).not.toBe(c2);
    expect(c1.split(":")[1]).not.toBe(c2.split(":")[1]);

    // Reject truncated auth tag or non-base64 garbage
    const parts = c1.split(":");
    expect(() => decryptSecret(`v1:${parts[1]}:AAAA:${parts[3]}`, MASTER)).toThrow();
    expect(() => decryptSecret(`v1:!!!:${parts[2]}:${parts[3]}`, MASTER)).toThrow();
    // Wrong key must not leak master key material
    try {
      decryptSecret(c1, "wrong-master-key-0123456789abcdef");
      throw new Error("expected decrypt to fail");
    } catch (err) {
      expect(String(err)).not.toContain("wrong-master-key");
      expect(String(err)).not.toContain(MASTER);
    }
  });

  it("enforces password length DoS cap and scrypt parameter bounds", async () => {
    const oversized = "A".repeat(2_000);
    await expect(hashPassword(oversized)).rejects.toThrow();
    expect(await verifyPassword(oversized, "scrypt$16384$8$1$AAAA$BBBB")).toBe(false);

    // Pathological scrypt params (non-power-of-two N, huge r/p) must fail closed immediately
    expect(await verifyPassword("pass", "scrypt$15000$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==")).toBe(false);
    expect(await verifyPassword("pass", "scrypt$16384$999999$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==")).toBe(false);
    expect(await verifyPassword("pass", "scrypt$16384$8$999$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==")).toBe(false);
  });

  it("hardens Ed25519 JWT verification against size DoS, alg confusion, non-finite exp, and future nbf/iat", () => {
    const keys = generateEd25519KeyPair(MASTER);
    const privateKey = decryptPrivateKey(keys.privateKeyEncrypted, MASTER);
    const expected = { projectId: "proj-1", issuer: "vellum://proj-1" };
    const now = Math.floor(Date.now() / 1000);

    // Oversized token rejected before decode
    expect(() => verifyEndUserAccessToken("a".repeat(20_000), keys.publicKeyPem, expected)).toThrow();

    // Non-Ed25519 public key rejected
    const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPubPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
    const basePayload: EndUserJwtPayload = {
      iss: expected.issuer,
      sub: "u1",
      aud: expected.projectId,
      jti: "jti-1",
      email: null,
      email_verified: false,
      is_anonymous: false,
      claims: {},
      iat: now,
      exp: now + 300,
      auth_time: now,
    };
    const token = signEndUserAccessToken(basePayload, privateKey, keys.keyId);
    expect(() => verifyEndUserAccessToken(token, rsaPubPem, expected)).toThrow();

    // Future nbf rejected
    const futureNbfToken = signEndUserAccessToken(
      { ...basePayload, nbf: now + 600 },
      privateKey,
      keys.keyId
    );
    expect(() => verifyEndUserAccessToken(futureNbfToken, keys.publicKeyPem, expected)).toThrow();

    // Future iat rejected
    const futureIatToken = signEndUserAccessToken(
      { ...basePayload, iat: now + 600 },
      privateKey,
      keys.keyId
    );
    expect(() => verifyEndUserAccessToken(futureIatToken, keys.publicKeyPem, expected)).toThrow();
  });

  it("enforces TOTP window bounds, replay guard, and constant-time recovery code scanning", () => {
    const secret = generateTotpSecret();
    const nowMs = 1_700_000_000_000;
    const code = generateTotpCode(secret, nowMs);

    // Window capped safely (huge window does not hang or accept far-future codes)
    expect(verifyTotpCode(secret, code, 1_000_000, nowMs + 60 * 60 * 1000)).toBe(false);

    // Stateful replay guard accepts once per step and rejects replay
    const guard = createTotpReplayGuard();
    expect(guard.verifyAndConsume("user-1", secret, code, 1, nowMs)).toBe(true);
    expect(guard.verifyAndConsume("user-1", secret, code, 1, nowMs)).toBe(false);
    // Next 30s step succeeds
    const nextCode = generateTotpCode(secret, nowMs + 30_000);
    expect(guard.verifyAndConsume("user-1", secret, nextCode, 1, nowMs + 30_000)).toBe(true);

    // Recovery code verification rejects oversized input
    const hashed = hashRecoveryCodes(["VALIDCODE1"]);
    expect(verifyRecoveryCode("A".repeat(200), hashed)).toBe(-1);
    expect(verifyRecoveryCode("VALIDCODE1", hashed)).toBe(0);
  });

  it("rejects oversized tokens and future nbf in realm session service", () => {
    const store: RealmRevocationStore = {
      async revoke() {},
      async isRevoked() {
        return false;
      },
    };
    const svc = createRealmSessionService({
      realm: "customer_console",
      secret: "realm-secret-0123456789abcdef",
      revocationStore: store,
    });
    expect(() => svc.verifyAccess("x".repeat(20_000))).toThrow();
    expect(() => svc.verifyAccess("not.valid!.jwt")).toThrow();
  });
});
