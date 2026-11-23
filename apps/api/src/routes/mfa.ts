/**
 * @vellum/api - TOTP MFA REST routes 
 *
 * Mount with `app.route("/v1", createMfaRoutes(...))`. All four endpoints are
 * guarded by the shared `requireSession` middleware, so a missing, malformed,
 * expired or revoked Bearer token always yields 401.
 *
 * Locked wire contract (do not change shapes):
 *   GET  /v1/auth/mfa/status  -> { enabled: boolean }
 *   POST /v1/auth/mfa/setup   -> { secret, otpauthUri, recoveryCodes: string[] }
 *   POST /v1/auth/mfa/verify  { code } -> { enabled: true }
 *   POST /v1/auth/mfa/disable { code } -> { enabled: false }
 *
 * No Redis: verification throttling is an in-process sliding window and all
 * durable state lives in the control-plane `mfa_secrets` table.
 */

import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { generateURI, verifySync } from "otplib";
import { VellumError } from "@vellum/core";
import {
  deriveRecoveryCodes,
  generateMfaSecret,
  hashRecoveryCode,
  hashRecoveryCodes,
  consumeRecoveryCode as consumeRecoveryCodeList,
  type SessionClaims,
  type SessionService,
  type StoredRecoveryCode,
} from "@vellum/authorization";
import type { ControlPlaneRepository } from "@vellum/database-control";
import type { StructuredLogger } from "@vellum/observability";
import { getSession, requireSession } from "../middleware/session.js";
import { errorHandler } from "../middleware/error-handler.js";
import { constantTimeEqual, extractClientIp } from "../middleware/security.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface MfaRecord {
  userId: string;
  secretEnc: string;
  secretHash: string;
  enabled: boolean;
  recoveryCodes: StoredRecoveryCode[];
  createdAt: string;
  verifiedAt: string | null;
}

export interface MfaStore {
  get(userId: string): Promise<MfaRecord | null>;
  upsert(record: MfaRecord): Promise<void>;
  remove(userId: string): Promise<void>;
  /** Atomically consume one recovery code; returns false if unknown/used. */
  consumeRecoveryCode(userId: string, presentedCode: string, pepper: string): Promise<boolean>;
}

type PgQueryPool = {
  query(
    text: string,
    params: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
};

export interface MfaRouteOptions {
  controlStore: ControlPlaneRepository;
  sessionService: SessionService;
  /** Issuer embedded in the otpauth:// URI. Defaults to "VELLUM". */
  issuer?: string;
  /** Fallback secret material for encryption/recovery hashing. */
  apiKeyPepper?: string;
  /** HMAC pepper for recovery-code digests. */
  recoveryCodePepper?: string;
  /** AES-256-GCM key material for the TOTP secret at rest. */
  encryptionKey?: string;
  logger?: StructuredLogger;
  /** Override persistence (tests / alternative deployments). */
  store?: MfaStore;
  /** Max failed verification attempts per user per window (default: 5). */
  maxAttempts?: number;
  /** Throttling window in ms (default: 60_000). */
  attemptWindowMs?: number;
  /** Number of recovery codes issued per enrollment (default: 8). */
  recoveryCodeCount?: number;
}

/* -------------------------------------------------------------------------- */
/* In-memory store (hermetic tests / no control DB configured)                 */
/* -------------------------------------------------------------------------- */

export class InMemoryMfaStore implements MfaStore {
  private readonly records = new Map<string, MfaRecord>();

  async get(userId: string): Promise<MfaRecord | null> {
    const record = this.records.get(userId);
    return record ? structuredClone(record) : null;
  }

  async upsert(record: MfaRecord): Promise<void> {
    this.records.set(record.userId, structuredClone(record));
  }

  async remove(userId: string): Promise<void> {
    this.records.delete(userId);
  }

  async consumeRecoveryCode(userId: string, presentedCode: string, pepper: string): Promise<boolean> {
    const record = this.records.get(userId);
    if (!record || !record.enabled) return false;
    const result = consumeRecoveryCodeList(presentedCode, pepper, record.recoveryCodes);
    if (!result.valid) return false;
    this.records.set(userId, { ...structuredClone(record), recoveryCodes: result.codes });
    return true;
  }
}

/* -------------------------------------------------------------------------- */
/* PostgreSQL store (control plane)                                            */
/* -------------------------------------------------------------------------- */

function isStoredRecoveryCode(value: unknown): value is StoredRecoveryCode {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["hash"] === "string" &&
    (entry["consumedAt"] === null || typeof entry["consumedAt"] === "string")
  );
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : new Date(0).toISOString();
}

function rowToRecord(row: Record<string, unknown>): MfaRecord | null {
  const userId = row["user_id"];
  const secretEnc = row["secret_enc"];
  const secretHash = row["secret_hash"];
  if (typeof userId !== "string" || typeof secretEnc !== "string" || typeof secretHash !== "string") {
    return null;
  }
  const rawCodes = row["recovery_codes"];
  const recoveryCodes: StoredRecoveryCode[] = Array.isArray(rawCodes)
    ? rawCodes.filter(isStoredRecoveryCode).map((entry) => ({
        hash: entry.hash,
        consumedAt: entry.consumedAt,
      }))
    : [];
  const verifiedAt = row["verified_at"];
  return {
    userId,
    secretEnc,
    secretHash,
    enabled: Boolean(row["enabled"]),
    recoveryCodes,
    createdAt: toIso(row["created_at"]),
    verifiedAt: verifiedAt === null || verifiedAt === undefined ? null : toIso(verifiedAt),
  };
}

export class PgMfaStore implements MfaStore {
  constructor(private readonly pool: PgQueryPool) {}

  async get(userId: string): Promise<MfaRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT user_id, secret_enc, secret_hash, enabled, recovery_codes, created_at, verified_at
         FROM mfa_secrets WHERE user_id = $1::uuid`,
      [userId]
    );
    const row = rows[0];
    return row ? rowToRecord(row) : null;
  }

  async upsert(record: MfaRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO mfa_secrets
         (user_id, secret_enc, secret_hash, enabled, recovery_codes, created_at, verified_at)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::timestamptz, $7::timestamptz)
       ON CONFLICT (user_id) DO UPDATE SET
         secret_enc = EXCLUDED.secret_enc,
         secret_hash = EXCLUDED.secret_hash,
         enabled = EXCLUDED.enabled,
         recovery_codes = EXCLUDED.recovery_codes,
         verified_at = EXCLUDED.verified_at`,
      [
        record.userId,
        record.secretEnc,
        record.secretHash,
        record.enabled,
        JSON.stringify(record.recoveryCodes),
        record.createdAt,
        record.verifiedAt,
      ]
    );
  }

  async remove(userId: string): Promise<void> {
    await this.pool.query("DELETE FROM mfa_secrets WHERE user_id = $1::uuid", [userId]);
  }

  async consumeRecoveryCode(userId: string, presentedCode: string, pepper: string): Promise<boolean> {
    const hash = hashRecoveryCode(presentedCode, pepper);
    const { rows } = await this.pool.query(
      `UPDATE mfa_secrets
          SET recovery_codes = (
            SELECT COALESCE(jsonb_agg(
              CASE WHEN elem->>'hash' = $2 AND elem->>'consumedAt' IS NULL
                   THEN jsonb_set(elem, '{consumedAt}', to_jsonb($3::text))
                   ELSE elem END
            ), '[]'::jsonb)
            FROM jsonb_array_elements(recovery_codes) AS elem
          )
        WHERE user_id = $1::uuid
          AND enabled = TRUE
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(recovery_codes) AS elem
            WHERE elem->>'hash' = $2 AND elem->>'consumedAt' IS NULL
          )
        RETURNING user_id`,
      [userId, hash, new Date().toISOString()]
    );
    return rows.length > 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Crypto helpers                                                              */
/* -------------------------------------------------------------------------- */

function deriveKey(material: string): Buffer {
  return crypto.createHash("sha256").update(material, "utf8").digest();
}

function encryptSecret(secret: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decryptSecret(encoded: string, key: Buffer): string | null {
  try {
    const [version, ivPart, tagPart, dataPart] = encoded.split(".");
    if (version !== "v1" || !ivPart || !tagPart || !dataPart) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function integrityHash(secret: string, pepper: string): string {
  return crypto.createHmac("sha256", pepper).update(secret).digest("hex");
}

/** TOTP verification via the `otplib` dependency; ±30s tolerance (one step). */
function verifyTotp(secret: string, code: string): boolean {
  try {
    const result = verifySync({
      secret,
      token: code,
      algorithm: "sha1",
      digits: 6,
      period: 30,
      epochTolerance: 30,
    });
    return result.valid === true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* In-process verification throttling (no Redis)                              */
/* -------------------------------------------------------------------------- */

export interface MfaAttemptLimiter {
  check(key: string): void;
  reset(key: string): void;
}

export function createMfaAttemptLimiter(maxAttempts: number, windowMs: number): MfaAttemptLimiter {
  const attempts = new Map<string, number[]>();
  return {
    check(key: string): void {
      const now = Date.now();
      const recent = (attempts.get(key) ?? []).filter((timestamp) => timestamp > now - windowMs);
      if (recent.length >= maxAttempts) {
        attempts.set(key, recent);
        throw new VellumError("RATE_LIMITED", "Too many MFA verification attempts. Please try again later.", {
          retryAfterMs: windowMs,
        });
      }
      recent.push(now);
      attempts.set(key, recent);
      // Lazy sweep keeps the map bounded without any timers.
      if (attempts.size > 1_000) {
        for (const [candidate, timestamps] of attempts) {
          if (!timestamps.some((timestamp) => timestamp > now - windowMs)) attempts.delete(candidate);
        }
      }
    },
    reset(key: string): void {
      attempts.delete(key);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Router                                                                      */
/* -------------------------------------------------------------------------- */

export function createMfaRoutes(options: MfaRouteOptions): Hono {
  const {
    controlStore,
    sessionService,
    issuer = "VELLUM",
    recoveryCodePepper = process.env["MFA_RECOVERY_CODE_PEPPER"] ?? options.apiKeyPepper ?? "vellum-mfa-recovery-v1",
    encryptionKey = process.env["MFA_ENCRYPTION_KEY"] ?? options.apiKeyPepper ?? "vellum-mfa-encryption-v1",
    logger,
    maxAttempts = 5,
    attemptWindowMs = 60_000,
    recoveryCodeCount = 8,
  } = options;

  const key = deriveKey(encryptionKey);
  const limiter = createMfaAttemptLimiter(maxAttempts, attemptWindowMs);
  const poolCandidate = "pool" in controlStore ? controlStore.pool : undefined;
  const pool =
    typeof poolCandidate === "object" &&
    poolCandidate !== null &&
    "query" in poolCandidate &&
    typeof poolCandidate.query === "function"
      ? (poolCandidate as PgQueryPool)
      : undefined;
  const store: MfaStore = options.store ?? (pool ? new PgMfaStore(pool) : new InMemoryMfaStore());

  function currentUser(c: Context): SessionClaims {
    const claims = getSession(c);
    if (!claims) throw new VellumError("UNAUTHENTICATED", "A valid session is required");
    return claims;
  }

  async function audit(c: Context, action: string, metadata: Record<string, unknown> = {}): Promise<void> {
    const claims = getSession(c);
    try {
      await controlStore.recordAuditLog({
        actorUserId: claims?.uid ?? null,
        actorType: "user",
        action,
        targetId: claims?.uid ?? null,
        metadata,
        ipAddress: extractClientIp(c),
        userAgent: c.req.header("user-agent") ?? null,
      });
    } catch (error: unknown) {
      // Auditing must never leak secrets; log only the error class/message.
      logger?.warn("MFA audit write failed", {
        action,
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  function readCode(body: unknown): string {
    if (typeof body !== "object" || body === null) {
      throw new VellumError("INVALID_ARGUMENT", "A verification 'code' string is required");
    }
    const code = (body as Record<string, unknown>)["code"];
    if (typeof code !== "string" || code.trim().length === 0) {
      throw new VellumError("INVALID_ARGUMENT", "A verification 'code' string is required");
    }
    return code.trim();
  }

  function otpauthUri(label: string, secret: string): string {
    return generateURI({ issuer, label, secret, algorithm: "sha1", digits: 6, period: 30 });
  }

  async function decryptOrFail(record: MfaRecord): Promise<{ secret: string; codes: string[] }> {
    const secret = decryptSecret(record.secretEnc, key);
    if (!secret || !constantTimeEqual(integrityHash(secret, recoveryCodePepper), record.secretHash)) {
      throw new VellumError("INTERNAL_ERROR", "Stored MFA enrollment failed integrity verification");
    }
    return { secret, codes: deriveRecoveryCodes(secret, record.recoveryCodes.length || recoveryCodeCount) };
  }

  const routes = new Hono();
  const mfa = new Hono();

  // Strict session auth on every MFA endpoint. No role widening: any valid
  // session may manage its own enrollment.
  mfa.use("*", requireSession(sessionService));

  mfa.get("/status", async (c) => {
    const claims = currentUser(c);
    const record = await store.get(claims.uid);
    return c.json({ enabled: record?.enabled === true });
  });

  mfa.post("/setup", async (c) => {
    const claims = currentUser(c);
    const existing = await store.get(claims.uid);

    if (existing?.enabled === true) {
      throw new VellumError("ALREADY_EXISTS", "MFA is already enabled. Disable it before setting it up again.");
    }

    let secret: string;
    let codes: string[];
    if (existing) {
      // Idempotent while unverified: return the exact same secret and codes.
      // Plaintext codes are deterministically derived from the encrypted secret
      // so nothing plaintext is ever persisted.
      ({ secret, codes } = await decryptOrFail(existing));
      await audit(c, "mfa.setup", { status: "pending_existing" });
    } else {
      secret = generateMfaSecret();
      codes = deriveRecoveryCodes(secret, recoveryCodeCount);
      const now = new Date().toISOString();
      await store.upsert({
        userId: claims.uid,
        secretEnc: encryptSecret(secret, key),
        secretHash: integrityHash(secret, recoveryCodePepper),
        enabled: false,
        recoveryCodes: hashRecoveryCodes(codes, recoveryCodePepper),
        createdAt: now,
        verifiedAt: null,
      });
      await audit(c, "mfa.setup", { status: "pending" });
    }

    return c.json({ secret, otpauthUri: otpauthUri(claims.uid, secret), recoveryCodes: codes });
  });

  mfa.post("/verify", async (c) => {
    const claims = currentUser(c);
    const code = readCode(await c.req.json().catch(() => null));
    const throttleKey = `mfa:verify:${claims.uid}`;
    limiter.check(throttleKey);

    const record = await store.get(claims.uid);
    if (!record) {
      throw new VellumError("FAILED_PRECONDITION", "MFA setup must be initiated before verification");
    }
    if (record.enabled === true) {
      limiter.reset(throttleKey);
      return c.json({ enabled: true } as const);
    }

    const { secret } = await decryptOrFail(record);
    if (!/^\d{6}$/.test(code) || !verifyTotp(secret, code)) {
      throw new VellumError("UNAUTHENTICATED", "Invalid TOTP verification code");
    }

    await store.upsert({ ...record, enabled: true, verifiedAt: new Date().toISOString() });
    limiter.reset(throttleKey);
    await audit(c, "mfa.verify", { status: "enabled" });
    return c.json({ enabled: true } as const);
  });

  mfa.post("/disable", async (c) => {
    const claims = currentUser(c);
    const code = readCode(await c.req.json().catch(() => null));
    const throttleKey = `mfa:disable:${claims.uid}`;
    limiter.check(throttleKey);

    const record = await store.get(claims.uid);
    if (!record || record.enabled !== true) {
      throw new VellumError("FAILED_PRECONDITION", "MFA is not enabled for this account");
    }

    const normalised = code.replace(/[^A-Za-z0-9]/g, "");
    let method: "totp" | "recovery_code";
    if (/^\d{6}$/.test(normalised)) {
      method = "totp";
      const { secret } = await decryptOrFail(record);
      if (!verifyTotp(secret, normalised)) {
        throw new VellumError("UNAUTHENTICATED", "Invalid TOTP code");
      }
    } else {
      method = "recovery_code";
      const consumed = await store.consumeRecoveryCode(claims.uid, code, recoveryCodePepper);
      if (!consumed) {
        throw new VellumError("UNAUTHENTICATED", "Invalid or already used recovery code");
      }
    }

    await store.remove(claims.uid);
    limiter.reset(throttleKey);
    await audit(c, "mfa.disable", { method });
    return c.json({ enabled: false } as const);
  });

  routes.route("/auth/mfa", mfa);
  return routes;
}

/**
 * Convenience wrapper that mounts the router at `/v1` with the canonical error
 * envelope. Production `app.ts` uses `app.route("/v1", createMfaRoutes(...))`
 * inside the full platform app; this helper is useful for isolated deployments
 * and hermetic HTTP tests.
 */
export function createMfaApp(options: MfaRouteOptions): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/v1", createMfaRoutes(options));
  return app;
}
