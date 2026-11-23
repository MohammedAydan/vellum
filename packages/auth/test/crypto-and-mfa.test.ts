import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptPrivateKey,
  decryptSecret,
  encryptSecret,
  exportPublicJwks,
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
} from "../src/index.js";

describe("@vellum/auth / password scrypt", () => {
  it("hashes with the canonical scrypt$16384$8$1$... format and verifies", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("still verifies the legacy console hash format", async () => {
    const hash = await hashPassword("legacy-format");
    const [prefix, n, r, p, salt, digest] = hash.split("$") as string[];
    const legacy = `scrypt$${Buffer.from(salt as string, "base64").toString("hex")}$${Buffer.from(digest as string, "base64").toString("hex")}`;
    expect(prefix === "scrypt" && n === "16384" && r === "8" && p === "1").toBe(true);
    expect(await verifyPassword("legacy-format", legacy)).toBe(true);
  });
});

describe("@vellum/auth / AES-256-GCM", () => {
  it("round-trips and rejects tampering", () => {
    const encrypted = encryptSecret("super-secret-value", "test-master-key-0123456789abcdef");
    expect(encrypted).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(decryptSecret(encrypted, "test-master-key-0123456789abcdef")).toBe("super-secret-value");
    const tampered = encrypted.slice(0, -2) + (encrypted.endsWith("A") ? "B" : "A");
    expect(() => decryptSecret(tampered, "test-master-key-0123456789abcdef")).toThrow();
  });
});

describe("@vellum/auth / Ed25519 JWT + JWKS", () => {
  const makePayload = (): EndUserJwtPayload => {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: "vellum://proj-1",
      sub: "user-1",
      aud: "proj-1",
      jti: "jti-1",
      email: "user@example.com",
      email_verified: true,
      is_anonymous: false,
      claims: { role: "editor" },
      iat: now,
      exp: now + 300,
      auth_time: now,
    };
  };

  it("verifies a real signature, exports JWKS and rejects wrong audience/issuer", () => {
    const keys = generateEd25519KeyPair("test-master-key-0123456789abcdef");
    const privateKey = decryptPrivateKey(keys.privateKeyEncrypted, "test-master-key-0123456789abcdef");
    const token = signEndUserAccessToken(makePayload(), privateKey, keys.keyId);
    const expected = { projectId: "proj-1", issuer: "vellum://proj-1" };
    const payload = verifyEndUserAccessToken(token, keys.publicKeyPem, expected);
    expect(payload.sub).toBe("user-1");
    expect(payload.jti).toBe("jti-1");
    expect(payload.claims).toEqual({ role: "editor" });

    const header = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"));
    expect(header).toMatchObject({ alg: "EdDSA", typ: "vellum+enduser+jwt", kid: keys.keyId });

    const jwks = exportPublicJwks({ jwtKeyId: keys.keyId, jwtPublicKeyPem: keys.publicKeyPem });
    expect(jwks.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", kid: keys.keyId });

    expect(() =>
      verifyEndUserAccessToken(token, keys.publicKeyPem, { ...expected, projectId: "other" })
    ).toThrow();
    expect(() =>
      verifyEndUserAccessToken(token, keys.publicKeyPem, { ...expected, issuer: "vellum://other" })
    ).toThrow();
    expect(() => verifyEndUserAccessToken(`${token}x`, keys.publicKeyPem, expected)).toThrow();
  });

  it("rejects a non-EdDSA header and maps expired tokens to TOKEN_EXPIRED", () => {
    const keys = generateEd25519KeyPair("test-master-key-0123456789abcdef");
    const privateKey = decryptPrivateKey(keys.privateKeyEncrypted, "test-master-key-0123456789abcdef");
    const expected = { projectId: "proj-1", issuer: "vellum://proj-1" };

    // Re-sign the same payload with a legacy `typ` header using the real key.
    const original = signEndUserAccessToken(makePayload(), privateKey, keys.keyId);
    const payloadB64 = original.split(".")[1] as string;
    const legacyHeader = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
    const legacySignedInput = `${legacyHeader}.${payloadB64}`;
    const legacySig = crypto
      .sign(null, Buffer.from(legacySignedInput, "utf8"), privateKey)
      .toString("base64url");
    expect(() =>
      verifyEndUserAccessToken(`${legacySignedInput}.${legacySig}`, keys.publicKeyPem, expected)
    ).toThrow();

    const expired = signEndUserAccessToken(
      { ...makePayload(), exp: Math.floor(Date.now() / 1000) - 10 },
      privateKey,
      keys.keyId
    );
    let caught: unknown;
    try {
      verifyEndUserAccessToken(expired, keys.publicKeyPem, expected);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      code: "TOKEN_EXPIRED",
      details: { retryableWithRefresh: true },
    });
  });
});

describe("@vellum/auth / TOTP + recovery codes", () => {
  it("verifies a generated 6-digit code with clock drift", () => {
    const secret = generateTotpSecret();
    const code = generateTotpCode(secret);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotpCode(secret, code)).toBe(true);
    expect(verifyTotpCode(secret, code, 1, Date.now() + 30_000)).toBe(true);
    expect(verifyTotpCode(secret, "000000", 1, Date.now() + 10 * 60_000)).toBe(false);
    expect(verifyTotpCode(secret, "12345")).toBe(false);
  });

  it("hashes recovery codes and finds the matching index", () => {
    const codes = ["ABC123DEF4", "ZZZ999YYY0"];
    const hashed = hashRecoveryCodes(codes);
    expect(hashed.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
    expect(verifyRecoveryCode("abc123def4", hashed)).toBe(0);
    expect(verifyRecoveryCode("ZZZ999YYY0", hashed)).toBe(1);
    expect(verifyRecoveryCode("NOPE", hashed)).toBe(-1);
  });
});
