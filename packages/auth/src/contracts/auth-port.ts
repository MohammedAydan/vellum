/**
 * @vellum/auth - Canonical Authentication Port Contracts
 */

import type crypto from "node:crypto";
import type { EndUserJwtPayload, JwtVerificationTarget } from "../crypto/jwt.js";
import type { Mailer } from "../mailer.js";
import type { RealmSessionService } from "../realm-session.js";
import type { AuthSessionService } from "../services/session-service.js";

/** Outbound port for Ed25519/EdDSA end-user JWT signing, verification, and JWKS export. */
export interface EndUserJwtPort {
  signEndUserAccessToken(
    payload: EndUserJwtPayload,
    privateKey: crypto.KeyObject | string,
    keyId?: string
  ): string;
  verifyEndUserAccessToken(
    token: string,
    publicKeyPem: string,
    expected: JwtVerificationTarget
  ): EndUserJwtPayload;
  exportPublicJwks(config: {
    jwtKeyId: string;
    jwtPublicKeyPem: string;
  }): { keys: Array<Record<string, unknown>> };
}

/** Outbound port for realm-bound control-plane session services. */
export type RealmSessionPort = RealmSessionService;

/** Outbound port for RFC 6238 TOTP and hashed recovery code MFA operations. */
export interface MfaServicePort {
  generateTotpSecret(byteLength?: number): string;
  generateTotpCode(secret: string, atEpochMs?: number): string;
  verifyTotpCode(secret: string, code: string, window?: number, atEpochMs?: number): boolean;
  deriveRecoveryCodes(count?: number): string[];
  hashRecoveryCodes(codes: string[]): string[];
  verifyRecoveryCode(code: string, hashedCodes: string[]): number;
}

/** Outbound port for end-user session issuance, refresh rotation, and revocation. */
export type SessionServicePort = AuthSessionService;

/** Outbound port for transactional auth token email delivery. */
export type MailerPort = Mailer;
