/**
 * @vellum/storage - End-user auth storage operations.
 *
 * The same `AuthOperations` contract is implemented twice:
 *  - `createSqlAuthOperations` for the PostgreSQL and Neon adapters (all calls
 *    run inside `withTransaction`, so RLS + the project GUC are always bound).
 *  - `createMemoryAuthOperations` for the in-memory adapter used by tests.
 *
 * Tenant == project: every row and every key is scoped by project_id only.
 */

import crypto from "node:crypto";
import { VellumError } from "@vellum/core";
import type { TenantContext } from "./types.js";

export interface AuthUserRecord {
  id: string;
  projectId: string;
  email: string | null;
  emailVerified: boolean;
  passwordHash: string | null;
  displayName: string | null;
  photoUrl: string | null;
  phoneNumber: string | null;
  phoneVerified: boolean;
  isDisabled: boolean;
  isAnonymous: boolean;
  customClaims: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastSignInAt: string | null;
}

export interface AuthIdentityRecord {
  id: string;
  userId: string;
  projectId: string;
  provider: string;
  providerUserId: string;
  identityData: Record<string, unknown>;
  lastSignInAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  projectId: string;
  refreshTokenHash: string;
  previousRefreshTokenHash: string | null;
  rotationCounter: number;
  userAgent: string | null;
  ipAddress: string | null;
  revoked: boolean;
  revokedReason: string | null;
  revokedAt: string | null;
  /** Timestamp of the last refresh-token rotation (null until first rotation). */
  rotatedAt: string | null;
  expiresAt: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface AuthMfaRecord {
  id: string;
  userId: string;
  projectId: string;
  factorType: string;
  secretEncrypted: string;
  verified: boolean;
  recoveryCodesHashed: string[];
  createdAt: string;
  verifiedAt: string | null;
}

export interface AuthTokenRecord {
  id: string;
  userId: string;
  projectId: string;
  tokenHash: string;
  tokenType: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface ListAuthUsersOptions {
  limit?: number | undefined;
  cursor?: string | null | undefined;
  search?: string | null | undefined;
  isDisabled?: boolean | undefined;
  isAnonymous?: boolean | undefined;
  emailVerified?: boolean | undefined;
}

export interface AuthUserPage {
  users: AuthUserRecord[];
  nextCursor: string | null;
  total?: number | undefined;
}

export interface CreateAuthUserInput {
  email?: string | null | undefined;
  emailVerified?: boolean | undefined;
  passwordHash?: string | null | undefined;
  displayName?: string | null | undefined;
  photoUrl?: string | null | undefined;
  phoneNumber?: string | null | undefined;
  phoneVerified?: boolean | undefined;
  isAnonymous?: boolean | undefined;
  isDisabled?: boolean | undefined;
  customClaims?: Record<string, unknown> | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export type UpdateAuthUserInput = Partial<CreateAuthUserInput> & { lastSignInAt?: string | null | undefined };

export interface CreateAuthSessionInput {
  userId: string;
  refreshTokenHash: string;
  previousRefreshTokenHash?: string | null | undefined;
  rotationCounter?: number | undefined;
  userAgent?: string | null | undefined;
  ipAddress?: string | null | undefined;
  rotatedAt?: string | null | undefined;
  expiresAt: string;
}

export interface CreateAuthIdentityInput {
  userId: string;
  provider: string;
  providerUserId: string;
  identityData?: Record<string, unknown> | undefined;
  lastSignInAt?: string | undefined;
}

export interface CreateAuthMfaInput {
  userId: string;
  factorType?: string | undefined;
  secretEncrypted: string;
  verified?: boolean | undefined;
  recoveryCodesHashed?: string[] | undefined;
  verifiedAt?: string | null | undefined;
}

export interface CreateAuthTokenInput {
  userId: string;
  tokenHash: string;
  tokenType: string;
  expiresAt: string;
}

/** The auth surface added to `StorageAdapter`. */
export interface AuthOperations {
  createAuthUser(ctx: TenantContext, input: CreateAuthUserInput): Promise<AuthUserRecord>;
  getAuthUserById(ctx: TenantContext, id: string): Promise<AuthUserRecord | null>;
  getAuthUserByEmail(ctx: TenantContext, email: string): Promise<AuthUserRecord | null>;
  updateAuthUser(ctx: TenantContext, id: string, patch: UpdateAuthUserInput): Promise<AuthUserRecord>;
  deleteAuthUser(ctx: TenantContext, id: string): Promise<boolean>;
  listAuthUsers(ctx: TenantContext, options?: ListAuthUsersOptions): Promise<AuthUserPage>;
  countAuthUsers(ctx: TenantContext): Promise<number>;

  upsertAuthIdentity(ctx: TenantContext, input: CreateAuthIdentityInput): Promise<AuthIdentityRecord>;
  getAuthIdentityByProvider(
    ctx: TenantContext,
    provider: string,
    providerUserId: string
  ): Promise<AuthIdentityRecord | null>;
  listUserIdentities(ctx: TenantContext, userId: string): Promise<AuthIdentityRecord[]>;
  deleteAuthIdentity(ctx: TenantContext, userId: string, provider: string): Promise<boolean>;

  createAuthSession(ctx: TenantContext, input: CreateAuthSessionInput): Promise<AuthSessionRecord>;
  /** Checks BOTH refresh_token_hash and previous_refresh_token_hash (replay detection). */
  getAuthSessionByTokenHash(ctx: TenantContext, tokenHash: string): Promise<AuthSessionRecord | null>;
  rotateAuthSession(
    ctx: TenantContext,
    sessionId: string,
    oldHash: string,
    newHash: string,
    newExpiresAt: string
  ): Promise<AuthSessionRecord>;
  revokeAuthSession(ctx: TenantContext, sessionId: string, reason: string): Promise<AuthSessionRecord>;
  revokeAllUserSessions(ctx: TenantContext, userId: string, reason: string): Promise<number>;
  listUserSessions(ctx: TenantContext, userId: string): Promise<AuthSessionRecord[]>;

  upsertAuthMfa(ctx: TenantContext, input: CreateAuthMfaInput): Promise<AuthMfaRecord>;
  getAuthMfa(ctx: TenantContext, userId: string): Promise<AuthMfaRecord | null>;
  deleteAuthMfa(ctx: TenantContext, userId: string): Promise<boolean>;

  saveAuthToken(ctx: TenantContext, input: CreateAuthTokenInput): Promise<AuthTokenRecord>;
  consumeAuthToken(ctx: TenantContext, tokenHash: string, tokenType: string): Promise<AuthTokenRecord>;
  /** Non-consuming validation: returns the live token without marking it used (for bounded-retry flows). */
  peekAuthToken(ctx: TenantContext, tokenHash: string, tokenType: string): Promise<AuthTokenRecord>;
}

// ---------------------------------------------------------------- utilities

/**
 * Constant-time string comparison via SHA-256 digests + `crypto.timingSafeEqual`.
 * Immune to both byte-by-byte and length-oracle timing side channels.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const digestA = crypto.createHash("sha256").update(a, "utf8").digest();
  const digestB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/** Escape LIKE/ILIKE metacharacters (`\`, `%`, `_`) so search input is literal. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return iso(value);
}

function obj(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function encodeUserCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url");
}

const MAX_CURSOR_LEN = 512;

export function decodeUserCursor(cursor: string): { createdAt: string; id: string } {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > MAX_CURSOR_LEN) {
    throw new VellumError("INVALID_ARGUMENT", "Malformed user pagination cursor");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("bad cursor shape");
    }
    const rec = parsed as Record<string, unknown>;
    const createdAt = Object.prototype.hasOwnProperty.call(rec, "createdAt") ? rec["createdAt"] : undefined;
    const id = Object.prototype.hasOwnProperty.call(rec, "id") ? rec["id"] : undefined;
    if (
      typeof createdAt !== "string" ||
      createdAt.length === 0 ||
      !Number.isFinite(Date.parse(createdAt)) ||
      typeof id !== "string" ||
      id.length === 0
    ) {
      throw new Error("bad cursor shape");
    }
    return { createdAt, id };
  } catch {
    throw new VellumError("INVALID_ARGUMENT", "Malformed user pagination cursor");
  }
}

function mapUser(r: Record<string, unknown>): AuthUserRecord {
  return {
    id: String(r["id"]),
    projectId: String(r["projectId"]),
    email: typeof r["email"] === "string" ? r["email"] : null,
    emailVerified: Boolean(r["emailVerified"]),
    passwordHash: typeof r["passwordHash"] === "string" ? r["passwordHash"] : null,
    displayName: typeof r["displayName"] === "string" ? r["displayName"] : null,
    photoUrl: typeof r["photoUrl"] === "string" ? r["photoUrl"] : null,
    phoneNumber: typeof r["phoneNumber"] === "string" ? r["phoneNumber"] : null,
    phoneVerified: Boolean(r["phoneVerified"]),
    isDisabled: Boolean(r["isDisabled"]),
    isAnonymous: Boolean(r["isAnonymous"]),
    customClaims: obj(r["customClaims"]),
    metadata: obj(r["metadata"]),
    createdAt: iso(r["createdAt"]),
    updatedAt: iso(r["updatedAt"]),
    lastSignInAt: isoOrNull(r["lastSignInAt"]),
  };
}

function mapIdentity(r: Record<string, unknown>): AuthIdentityRecord {
  return {
    id: String(r["id"]),
    userId: String(r["userId"]),
    projectId: String(r["projectId"]),
    provider: String(r["provider"]),
    providerUserId: String(r["providerUserId"]),
    identityData: obj(r["identityData"]),
    lastSignInAt: iso(r["lastSignInAt"]),
    createdAt: iso(r["createdAt"]),
    updatedAt: iso(r["updatedAt"]),
  };
}

function mapSession(r: Record<string, unknown>): AuthSessionRecord {
  return {
    id: String(r["id"]),
    userId: String(r["userId"]),
    projectId: String(r["projectId"]),
    refreshTokenHash: String(r["refreshTokenHash"]),
    previousRefreshTokenHash:
      typeof r["previousRefreshTokenHash"] === "string" ? r["previousRefreshTokenHash"] : null,
    rotationCounter: Number(r["rotationCounter"]),
    userAgent: typeof r["userAgent"] === "string" ? r["userAgent"] : null,
    ipAddress: typeof r["ipAddress"] === "string" ? r["ipAddress"] : null,
    revoked: Boolean(r["revoked"]),
    revokedReason: typeof r["revokedReason"] === "string" ? r["revokedReason"] : null,
    revokedAt: isoOrNull(r["revokedAt"]),
    rotatedAt: isoOrNull(r["rotatedAt"]),
    expiresAt: iso(r["expiresAt"]),
    createdAt: iso(r["createdAt"]),
    lastUsedAt: iso(r["lastUsedAt"]),
  };
}

function mapMfa(r: Record<string, unknown>): AuthMfaRecord {
  return {
    id: String(r["id"]),
    userId: String(r["userId"]),
    projectId: String(r["projectId"]),
    factorType: String(r["factorType"]),
    secretEncrypted: String(r["secretEncrypted"]),
    verified: Boolean(r["verified"]),
    recoveryCodesHashed: strArray(r["recoveryCodesHashed"]),
    createdAt: iso(r["createdAt"]),
    verifiedAt: isoOrNull(r["verifiedAt"]),
  };
}

function mapToken(r: Record<string, unknown>): AuthTokenRecord {
  return {
    id: String(r["id"]),
    userId: String(r["userId"]),
    projectId: String(r["projectId"]),
    tokenHash: String(r["tokenHash"]),
    tokenType: String(r["tokenType"]),
    expiresAt: iso(r["expiresAt"]),
    consumedAt: isoOrNull(r["consumedAt"]),
    createdAt: iso(r["createdAt"]),
  };
}

/**
 * Base class that exposes the AuthOperations surface on every StorageAdapter
 * implementation. Subclasses assign `authOps` in their constructor.
 */
export abstract class AuthMethodDelegates {
  protected authOps!: AuthOperations;

  createAuthUser(...args: Parameters<AuthOperations['createAuthUser']>): ReturnType<AuthOperations['createAuthUser']> {
    return this.authOps.createAuthUser(...args);
  }

  getAuthUserById(...args: Parameters<AuthOperations['getAuthUserById']>): ReturnType<AuthOperations['getAuthUserById']> {
    return this.authOps.getAuthUserById(...args);
  }

  getAuthUserByEmail(...args: Parameters<AuthOperations['getAuthUserByEmail']>): ReturnType<AuthOperations['getAuthUserByEmail']> {
    return this.authOps.getAuthUserByEmail(...args);
  }

  updateAuthUser(...args: Parameters<AuthOperations['updateAuthUser']>): ReturnType<AuthOperations['updateAuthUser']> {
    return this.authOps.updateAuthUser(...args);
  }

  deleteAuthUser(...args: Parameters<AuthOperations['deleteAuthUser']>): ReturnType<AuthOperations['deleteAuthUser']> {
    return this.authOps.deleteAuthUser(...args);
  }

  listAuthUsers(...args: Parameters<AuthOperations['listAuthUsers']>): ReturnType<AuthOperations['listAuthUsers']> {
    return this.authOps.listAuthUsers(...args);
  }

  countAuthUsers(...args: Parameters<AuthOperations['countAuthUsers']>): ReturnType<AuthOperations['countAuthUsers']> {
    return this.authOps.countAuthUsers(...args);
  }

  upsertAuthIdentity(...args: Parameters<AuthOperations['upsertAuthIdentity']>): ReturnType<AuthOperations['upsertAuthIdentity']> {
    return this.authOps.upsertAuthIdentity(...args);
  }

  getAuthIdentityByProvider(...args: Parameters<AuthOperations['getAuthIdentityByProvider']>): ReturnType<AuthOperations['getAuthIdentityByProvider']> {
    return this.authOps.getAuthIdentityByProvider(...args);
  }

  listUserIdentities(...args: Parameters<AuthOperations['listUserIdentities']>): ReturnType<AuthOperations['listUserIdentities']> {
    return this.authOps.listUserIdentities(...args);
  }

  deleteAuthIdentity(...args: Parameters<AuthOperations['deleteAuthIdentity']>): ReturnType<AuthOperations['deleteAuthIdentity']> {
    return this.authOps.deleteAuthIdentity(...args);
  }

  createAuthSession(...args: Parameters<AuthOperations['createAuthSession']>): ReturnType<AuthOperations['createAuthSession']> {
    return this.authOps.createAuthSession(...args);
  }

  getAuthSessionByTokenHash(...args: Parameters<AuthOperations['getAuthSessionByTokenHash']>): ReturnType<AuthOperations['getAuthSessionByTokenHash']> {
    return this.authOps.getAuthSessionByTokenHash(...args);
  }

  rotateAuthSession(...args: Parameters<AuthOperations['rotateAuthSession']>): ReturnType<AuthOperations['rotateAuthSession']> {
    return this.authOps.rotateAuthSession(...args);
  }

  revokeAuthSession(...args: Parameters<AuthOperations['revokeAuthSession']>): ReturnType<AuthOperations['revokeAuthSession']> {
    return this.authOps.revokeAuthSession(...args);
  }

  revokeAllUserSessions(...args: Parameters<AuthOperations['revokeAllUserSessions']>): ReturnType<AuthOperations['revokeAllUserSessions']> {
    return this.authOps.revokeAllUserSessions(...args);
  }

  listUserSessions(...args: Parameters<AuthOperations['listUserSessions']>): ReturnType<AuthOperations['listUserSessions']> {
    return this.authOps.listUserSessions(...args);
  }

  upsertAuthMfa(...args: Parameters<AuthOperations['upsertAuthMfa']>): ReturnType<AuthOperations['upsertAuthMfa']> {
    return this.authOps.upsertAuthMfa(...args);
  }

  getAuthMfa(...args: Parameters<AuthOperations['getAuthMfa']>): ReturnType<AuthOperations['getAuthMfa']> {
    return this.authOps.getAuthMfa(...args);
  }

  deleteAuthMfa(...args: Parameters<AuthOperations['deleteAuthMfa']>): ReturnType<AuthOperations['deleteAuthMfa']> {
    return this.authOps.deleteAuthMfa(...args);
  }

  saveAuthToken(...args: Parameters<AuthOperations['saveAuthToken']>): ReturnType<AuthOperations['saveAuthToken']> {
    return this.authOps.saveAuthToken(...args);
  }

  consumeAuthToken(...args: Parameters<AuthOperations['consumeAuthToken']>): ReturnType<AuthOperations['consumeAuthToken']> {
    return this.authOps.consumeAuthToken(...args);
  }
  peekAuthToken(...args: Parameters<AuthOperations['peekAuthToken']>): ReturnType<AuthOperations['peekAuthToken']> {
    return this.authOps.peekAuthToken(...args);
  }
}

// ------------------------------------------------------------- SQL adapter

export interface SqlAuthTx {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export type AuthTxRunner = <T>(
  ctx: TenantContext,
  callback: (tx: SqlAuthTx) => Promise<T>
) => Promise<T>;

const USER_COLUMNS = `id, project_id AS "projectId",
  email, email_verified AS "emailVerified", password_hash AS "passwordHash",
  display_name AS "displayName", photo_url AS "photoUrl", phone_number AS "phoneNumber",
  phone_verified AS "phoneVerified", is_disabled AS "isDisabled", is_anonymous AS "isAnonymous",
  custom_claims AS "customClaims", metadata, created_at AS "createdAt",
  updated_at AS "updatedAt", last_sign_in_at AS "lastSignInAt"`;

const IDENTITY_COLUMNS = `id, user_id AS "userId", project_id AS "projectId",
  provider, provider_user_id AS "providerUserId",
  identity_data AS "identityData", last_sign_in_at AS "lastSignInAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const SESSION_COLUMNS = `id, user_id AS "userId", project_id AS "projectId",
  refresh_token_hash AS "refreshTokenHash",
  previous_refresh_token_hash AS "previousRefreshTokenHash",
  rotation_counter AS "rotationCounter", user_agent AS "userAgent", ip_address AS "ipAddress",
  revoked, revoked_reason AS "revokedReason", revoked_at AS "revokedAt",
  rotated_at AS "rotatedAt", expires_at AS "expiresAt", created_at AS "createdAt",
  last_used_at AS "lastUsedAt"`;

const MFA_COLUMNS = `id, user_id AS "userId", project_id AS "projectId",
  factor_type AS "factorType",
  secret_encrypted AS "secretEncrypted", verified,
  recovery_codes_hashed AS "recoveryCodesHashed", created_at AS "createdAt",
  verified_at AS "verifiedAt"`;

const TOKEN_COLUMNS = `id, user_id AS "userId", project_id AS "projectId",
  token_hash AS "tokenHash", token_type AS "tokenType",
  expires_at AS "expiresAt", consumed_at AS "consumedAt", created_at AS "createdAt"`;

const UPDATE_USER_COLUMNS: Record<keyof UpdateAuthUserInput, string> = {
  email: "email",
  emailVerified: "email_verified",
  passwordHash: "password_hash",
  displayName: "display_name",
  photoUrl: "photo_url",
  phoneNumber: "phone_number",
  phoneVerified: "phone_verified",
  isAnonymous: "is_anonymous",
  isDisabled: "is_disabled",
  customClaims: "custom_claims",
  metadata: "metadata",
  lastSignInAt: "last_sign_in_at",
};

const JSONB_USER_FIELDS: ReadonlySet<string> = new Set(["customClaims", "metadata"]);

function firstRow(rows: Record<string, unknown>[]): Record<string, unknown> | null {
  return rows[0] ?? null;
}

export function createSqlAuthOperations(runInTx: AuthTxRunner): AuthOperations {
  return {
    async createAuthUser(ctx, input) {
      return runInTx(ctx, async (tx) => {
        let rows: Record<string, unknown>[];
        try {
          ({ rows } = await tx.query(
            `INSERT INTO project_auth_users (
               project_id, email, email_verified, password_hash, display_name,
               photo_url, phone_number, phone_verified, is_disabled, is_anonymous,
               custom_claims, metadata, last_sign_in_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13
             ) RETURNING ${USER_COLUMNS}`,
            [
              ctx.projectId,
              input.email ?? null,
              input.emailVerified ?? false,
              input.passwordHash ?? null,
              input.displayName ?? null,
              input.photoUrl ?? null,
              input.phoneNumber ?? null,
              input.phoneVerified ?? false,
              input.isDisabled ?? false,
              input.isAnonymous ?? false,
              JSON.stringify(input.customClaims ?? {}),
              JSON.stringify(input.metadata ?? {}),
              null,
            ]
          ));
        } catch (err: unknown) {
          if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
            throw new VellumError("ALREADY_EXISTS", "An end-user with this email already exists");
          }
          throw err;
        }
        const row = firstRow(rows);
        if (!row) throw new VellumError("INTERNAL_ERROR", "Auth user insert returned no row");
        return mapUser(row);
      });
    },

    async getAuthUserById(ctx, id) {
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `SELECT ${USER_COLUMNS} FROM project_auth_users
            WHERE project_id=$1 AND id=$2::uuid`,
          [ctx.projectId, id]
        );
        const row = firstRow(rows);
        return row ? mapUser(row) : null;
      });
    },

    async getAuthUserByEmail(ctx, email) {
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `SELECT ${USER_COLUMNS} FROM project_auth_users
            WHERE project_id=$1 AND LOWER(email)=LOWER($2) LIMIT 1`,
          [ctx.projectId, email.toLowerCase()]
        );
        const row = firstRow(rows);
        return row ? mapUser(row) : null;
      });
    },

    async updateAuthUser(ctx, id, patch) {
      return runInTx(ctx, async (tx) => {
        const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
        if (entries.length === 0) {
          const { rows } = await tx.query(
            `SELECT ${USER_COLUMNS} FROM project_auth_users
              WHERE project_id=$1 AND id=$2::uuid`,
            [ctx.projectId, id]
          );
          const row = firstRow(rows);
          if (!row) throw new VellumError("NOT_FOUND", "Auth user not found");
          return mapUser(row);
        }
        const sets = entries.map(([key], i) => {
          if (!Object.prototype.hasOwnProperty.call(UPDATE_USER_COLUMNS, key)) {
            throw new VellumError("INVALID_ARGUMENT", `Unknown auth user field '${key}'`);
          }
          const col = UPDATE_USER_COLUMNS[key as keyof UpdateAuthUserInput];
          const cast = JSONB_USER_FIELDS.has(key) ? "::jsonb" : "";
          return `${col}=$${i + 3}${cast}`;
        });
        sets.push(`updated_at=now()`);
        const values = entries.map(([key, v]) =>
          JSONB_USER_FIELDS.has(key) || (typeof v === "object" && v !== null)
            ? JSON.stringify(v)
            : v
        );
        const { rows } = await tx.query(
          `UPDATE project_auth_users SET ${sets.join(", ")}
            WHERE project_id=$1 AND id=$2::uuid
            RETURNING ${USER_COLUMNS}`,
          [ctx.projectId, id, ...values]
        );
        const row = firstRow(rows);
        if (!row) throw new VellumError("NOT_FOUND", "Auth user not found");
        return mapUser(row);
      });
    },

    async deleteAuthUser(ctx, id) {
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `DELETE FROM project_auth_users
            WHERE project_id=$1 AND id=$2::uuid RETURNING id`,
          [ctx.projectId, id]
        );
        return rows.length > 0;
      });
    },

    async listAuthUsers(ctx, options = {}) {
      return runInTx(ctx, async (tx) => {
        const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
        const params: unknown[] = [ctx.projectId];
        const clauses = ["project_id=$1"];
        if (options.search) {
          params.push(`%${escapeLikePattern(options.search)}%`);
          clauses.push(
            `(email ILIKE $${params.length} ESCAPE '\\' OR display_name ILIKE $${params.length} ESCAPE '\\')`
          );
        }
        if (options.isDisabled !== undefined) {
          params.push(options.isDisabled);
          clauses.push(`is_disabled=$${params.length}`);
        }
        if (options.isAnonymous !== undefined) {
          params.push(options.isAnonymous);
          clauses.push(`is_anonymous=$${params.length}`);
        }
        if (options.emailVerified !== undefined) {
          params.push(options.emailVerified);
          clauses.push(`email_verified=$${params.length}`);
        }
        if (options.cursor) {
          const { createdAt, id } = decodeUserCursor(options.cursor);
          params.push(createdAt, id);
          clauses.push(
            `(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`
          );
        }
        params.push(limit + 1);
        const { rows } = await tx.query(
          `SELECT ${USER_COLUMNS} FROM project_auth_users
            WHERE ${clauses.join(" AND ")}
            ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
          params
        );
        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        const last = pageRows[pageRows.length - 1];
        return {
          users: pageRows.map(mapUser),
          nextCursor: hasMore && last ? encodeUserCursor(String(last["createdAt"]), String(last["id"])) : null,
        };
      });
    },

    async countAuthUsers(ctx) {
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `SELECT count(*)::int AS n FROM project_auth_users
            WHERE project_id=$1`,
          [ctx.projectId]
        );
        return Number(rows[0]?.["n"] ?? 0);
      });
    },

    async upsertAuthIdentity(ctx, input) {
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO project_auth_identities (
             project_id, user_id, provider, provider_user_id,
             identity_data, last_sign_in_at
           ) VALUES ($1,$2::uuid,$3,$4,$5::jsonb,$6)
           ON CONFLICT (project_id, provider, provider_user_id) DO UPDATE SET
             identity_data=EXCLUDED.identity_data, last_sign_in_at=EXCLUDED.last_sign_in_at,
             updated_at=now()
           RETURNING ${IDENTITY_COLUMNS}`,
          [
            ctx.projectId,
            input.userId,
            input.provider,
            input.providerUserId,
            JSON.stringify(input.identityData ?? {}),
            input.lastSignInAt ?? new Date().toISOString(),
          ]
        );
        const row = firstRow(rows);
        if (!row) throw new VellumError("INTERNAL_ERROR", "Identity upsert returned no row");
        return mapIdentity(row);
      });
    },

    async getAuthIdentityByProvider(ctx, provider, providerUserId) {
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `SELECT ${IDENTITY_COLUMNS} FROM project_auth_identities
            WHERE project_id=$1 AND provider=$2 AND provider_user_id=$3 LIMIT 1`,
          [ctx.projectId, provider, providerUserId]
        );
        const row = firstRow(rows);
        return row ? mapIdentity(row) : null;
      });
    },

    async listUserIdentities(ctx, userId) {
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `SELECT ${IDENTITY_COLUMNS} FROM project_auth_identities
            WHERE project_id=$1 AND user_id=$2::uuid
            ORDER BY created_at ASC`,
          [ctx.projectId, userId]
        );
        return rows.map(mapIdentity);
      });
    },

    async deleteAuthIdentity(ctx, userId, provider) {
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `DELETE FROM project_auth_identities
            WHERE project_id=$1 AND user_id=$2::uuid AND provider=$3
            RETURNING id`,
          [ctx.projectId, userId, provider]
        );
        return rows.length > 0;
      });
    },

    async createAuthSession(ctx, input) {
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO project_auth_sessions (
             project_id, user_id, refresh_token_hash,
             previous_refresh_token_hash, rotation_counter, user_agent, ip_address,
             expires_at, rotated_at
           ) VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9)
           RETURNING ${SESSION_COLUMNS}`,
          [
            ctx.projectId,
            input.userId,
            input.refreshTokenHash,
            input.previousRefreshTokenHash ?? null,
            input.rotationCounter ?? 0,
            input.userAgent ?? null,
            input.ipAddress ?? null,
            input.expiresAt,
            input.rotatedAt ?? null,
          ]
        );
        const row = firstRow(rows);
        if (!row) throw new VellumError("INTERNAL_ERROR", "Session insert returned no row");
        return mapSession(row);
      });
    },

    async getAuthSessionByTokenHash(ctx, tokenHash) {
      if (!tokenHash) return null;
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `SELECT ${SESSION_COLUMNS} FROM project_auth_sessions
            WHERE project_id=$1
              AND (refresh_token_hash=$2 OR previous_refresh_token_hash=$2)
            LIMIT 1`,
          [ctx.projectId, tokenHash]
        );
        const row = firstRow(rows);
        return row ? mapSession(row) : null;
      });
    },

    async rotateAuthSession(ctx, sessionId, oldHash, newHash, newExpiresAt) {
      if (!oldHash || !newHash || timingSafeEqualStr(oldHash, newHash)) {
        throw new VellumError("UNAUTHENTICATED", "Session rotation failed");
      }
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `UPDATE project_auth_sessions SET
             refresh_token_hash=$3, previous_refresh_token_hash=$4,
             rotation_counter=rotation_counter+1, last_used_at=now(),
             rotated_at=now(), expires_at=$5
           WHERE project_id=$1 AND id=$2::uuid AND refresh_token_hash=$4
             AND revoked=FALSE AND expires_at > now()
           RETURNING ${SESSION_COLUMNS}`,
          [ctx.projectId, sessionId, newHash, oldHash, newExpiresAt]
        );
        const row = firstRow(rows);
        if (!row) throw new VellumError("UNAUTHENTICATED", "Session rotation failed");
        return mapSession(row);
      });
    },

    async revokeAuthSession(ctx, sessionId, reason) {
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `UPDATE project_auth_sessions SET revoked=TRUE, revoked_reason=$3, revoked_at=now()
           WHERE project_id=$1 AND id=$2::uuid
           RETURNING ${SESSION_COLUMNS}`,
          [ctx.projectId, sessionId, reason]
        );
        const row = firstRow(rows);
        if (!row) throw new VellumError("NOT_FOUND", "Session not found");
        return mapSession(row);
      });
    },

    async revokeAllUserSessions(ctx, userId, reason) {
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `UPDATE project_auth_sessions SET revoked=TRUE, revoked_reason=$2, revoked_at=now()
           WHERE project_id=$1 AND user_id=$3::uuid AND revoked=FALSE
           RETURNING id`,
          [ctx.projectId, reason, userId]
        );
        return rows.length;
      });
    },

    async listUserSessions(ctx, userId) {
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `SELECT ${SESSION_COLUMNS} FROM project_auth_sessions
            WHERE project_id=$1 AND user_id=$2::uuid
            ORDER BY created_at DESC`,
          [ctx.projectId, userId]
        );
        return rows.map(mapSession);
      });
    },

    async upsertAuthMfa(ctx, input) {
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO project_auth_mfa (
             project_id, user_id, factor_type, secret_encrypted,
             verified, recovery_codes_hashed, verified_at
           ) VALUES ($1,$2::uuid,$3,$4,$5,$6::jsonb,$7)
           ON CONFLICT (project_id, user_id, factor_type) DO UPDATE SET
             secret_encrypted=EXCLUDED.secret_encrypted, verified=EXCLUDED.verified,
             recovery_codes_hashed=EXCLUDED.recovery_codes_hashed,
             verified_at=EXCLUDED.verified_at
           RETURNING ${MFA_COLUMNS}`,
          [
            ctx.projectId,
            input.userId,
            input.factorType ?? "totp",
            input.secretEncrypted,
            input.verified ?? false,
            JSON.stringify(input.recoveryCodesHashed ?? []),
            input.verifiedAt ?? null,
          ]
        );
        const row = firstRow(rows);
        if (!row) throw new VellumError("INTERNAL_ERROR", "MFA upsert returned no row");
        return mapMfa(row);
      });
    },

    async getAuthMfa(ctx, userId) {
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `SELECT ${MFA_COLUMNS} FROM project_auth_mfa
            WHERE project_id=$1 AND user_id=$2::uuid LIMIT 1`,
          [ctx.projectId, userId]
        );
        const row = firstRow(rows);
        return row ? mapMfa(row) : null;
      });
    },

    async deleteAuthMfa(ctx, userId) {
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `DELETE FROM project_auth_mfa
            WHERE project_id=$1 AND user_id=$2::uuid RETURNING id`,
          [ctx.projectId, userId]
        );
        return rows.length > 0;
      });
    },

    async saveAuthToken(ctx, input) {
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO project_auth_tokens (
             project_id, user_id, token_hash, token_type, expires_at
           ) VALUES ($1,$2::uuid,$3,$4,$5) RETURNING ${TOKEN_COLUMNS}`,
          [ctx.projectId, input.userId, input.tokenHash, input.tokenType, input.expiresAt]
        );
        const row = firstRow(rows);
        if (!row) throw new VellumError("INTERNAL_ERROR", "Token insert returned no row");
        return mapToken(row);
      });
    },

    async consumeAuthToken(ctx, tokenHash, tokenType) {
      if (!tokenHash || !tokenType) {
        throw new VellumError("UNAUTHENTICATED", "Invalid or expired action token");
      }
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `UPDATE project_auth_tokens SET consumed_at=now()
           WHERE project_id=$1 AND token_hash=$2 AND token_type=$3
             AND consumed_at IS NULL AND expires_at > now()
           RETURNING ${TOKEN_COLUMNS}`,
          [ctx.projectId, tokenHash, tokenType]
        );
        const row = firstRow(rows);
        if (!row) throw new VellumError("UNAUTHENTICATED", "Invalid or expired action token");
        return mapToken(row);
      });
    },
    async peekAuthToken(ctx, tokenHash, tokenType) {
      if (!tokenHash || !tokenType) {
        throw new VellumError("UNAUTHENTICATED", "Invalid or expired action token");
      }
      return runInTx(ctx, async (tx) => {
        const { rows } = await tx.query(
          `SELECT ${TOKEN_COLUMNS} FROM project_auth_tokens
           WHERE project_id=$1 AND token_hash=$2 AND token_type=$3
             AND consumed_at IS NULL AND expires_at > now()`,
          [ctx.projectId, tokenHash, tokenType]
        );
        const row = firstRow(rows);
        if (!row) throw new VellumError("UNAUTHENTICATED", "Invalid or expired action token");
        return mapToken(row);
      });
    },
  };
}

// ---------------------------------------------------------- memory adapter

export interface AuthMemoryState {
  users: Map<string, AuthUserRecord>;
  identities: Map<string, AuthIdentityRecord>;
  sessions: Map<string, AuthSessionRecord>;
  mfa: Map<string, AuthMfaRecord>;
  tokens: Map<string, AuthTokenRecord>;
}

export function createAuthMemoryState(): AuthMemoryState {
  return {
    users: new Map(),
    identities: new Map(),
    sessions: new Map(),
    mfa: new Map(),
    tokens: new Map(),
  };
}

function requireAuthTenant(ctx: TenantContext): void {
  if (!ctx || typeof ctx.projectId !== "string" || ctx.projectId.length === 0) {
    throw new VellumError(
      "PERMISSION_DENIED",
      "RLS Violation: Missing tenant context (app.current_project_id)"
    );
  }
}

function authKey(ctx: TenantContext, ...parts: string[]): string {
  requireAuthTenant(ctx);
  return `${ctx.projectId.length}:${ctx.projectId}:${parts.join(":")}`;
}

export function createMemoryAuthOperations(state: AuthMemoryState): AuthOperations {
  const now = () => new Date().toISOString();

  function pruneExpiredTokens(): void {
    if (state.tokens.size <= 1_000) return;
    const nowMs = Date.now();
    for (const [key, token] of state.tokens.entries()) {
      if (token.consumedAt !== null || !(Date.parse(token.expiresAt) > nowMs)) {
        state.tokens.delete(key);
      }
    }
  }

  return {
    async createAuthUser(ctx, input) {
      const id = crypto.randomUUID();
      const ts = now();
      const user: AuthUserRecord = {
        id,
        projectId: ctx.projectId,
        email: input.email ?? null,
        emailVerified: input.emailVerified ?? false,
        passwordHash: input.passwordHash ?? null,
        displayName: input.displayName ?? null,
        photoUrl: input.photoUrl ?? null,
        phoneNumber: input.phoneNumber ?? null,
        phoneVerified: input.phoneVerified ?? false,
        isDisabled: input.isDisabled ?? false,
        isAnonymous: input.isAnonymous ?? false,
        customClaims: structuredClone(input.customClaims ?? {}),
        metadata: structuredClone(input.metadata ?? {}),
        createdAt: ts,
        updatedAt: ts,
        lastSignInAt: null,
      };
      state.users.set(authKey(ctx, id), user);
      return structuredClone(user);
    },

    async getAuthUserById(ctx, id) {
      const user = state.users.get(authKey(ctx, id));
      if (!user || user.projectId !== ctx.projectId) return null;
      return structuredClone(user);
    },

    async getAuthUserByEmail(ctx, email) {
      requireAuthTenant(ctx);
      const normalized = email.toLowerCase();
      for (const user of state.users.values()) {
        if (
          user.projectId === ctx.projectId &&
          user.email?.toLowerCase() === normalized
        ) {
          return structuredClone(user);
        }
      }
      return null;
    },

    async updateAuthUser(ctx, id, patch) {
      const key = authKey(ctx, id);
      const existing = state.users.get(key);
      if (!existing || existing.projectId !== ctx.projectId) {
        throw new VellumError("NOT_FOUND", "Auth user not found");
      }
      for (const field of Object.keys(patch)) {
        if (patch[field as keyof UpdateAuthUserInput] === undefined) continue;
        if (!Object.prototype.hasOwnProperty.call(UPDATE_USER_COLUMNS, field)) {
          throw new VellumError("INVALID_ARGUMENT", `Unknown auth user field '${field}'`);
        }
      }
      const updated: AuthUserRecord = {
        id: existing.id,
        projectId: existing.projectId,
        email: patch.email !== undefined ? patch.email : existing.email,
        emailVerified: patch.emailVerified ?? existing.emailVerified,
        passwordHash: patch.passwordHash !== undefined ? patch.passwordHash : existing.passwordHash,
        displayName: patch.displayName !== undefined ? patch.displayName : existing.displayName,
        photoUrl: patch.photoUrl !== undefined ? patch.photoUrl : existing.photoUrl,
        phoneNumber: patch.phoneNumber !== undefined ? patch.phoneNumber : existing.phoneNumber,
        phoneVerified: patch.phoneVerified ?? existing.phoneVerified,
        isDisabled: patch.isDisabled ?? existing.isDisabled,
        isAnonymous: patch.isAnonymous ?? existing.isAnonymous,
        customClaims:
          patch.customClaims !== undefined ? structuredClone(patch.customClaims) : existing.customClaims,
        metadata: patch.metadata !== undefined ? structuredClone(patch.metadata) : existing.metadata,
        createdAt: existing.createdAt,
        updatedAt: now(),
        lastSignInAt: patch.lastSignInAt !== undefined ? patch.lastSignInAt : existing.lastSignInAt,
      };
      state.users.set(key, updated);
      return structuredClone(updated);
    },

    async deleteAuthUser(ctx, id) {
      const key = authKey(ctx, id);
      const existing = state.users.get(key);
      if (!existing || existing.projectId !== ctx.projectId) return false;
      state.users.delete(key);
      // Mirror SQL ON DELETE CASCADE so deleted users' sessions/identities/MFA/tokens do not linger.
      for (const [k, v] of state.sessions.entries()) {
        if (v.projectId === ctx.projectId && v.userId === id) state.sessions.delete(k);
      }
      for (const [k, v] of state.identities.entries()) {
        if (v.projectId === ctx.projectId && v.userId === id) state.identities.delete(k);
      }
      for (const [k, v] of state.mfa.entries()) {
        if (v.projectId === ctx.projectId && v.userId === id) state.mfa.delete(k);
      }
      for (const [k, v] of state.tokens.entries()) {
        if (v.projectId === ctx.projectId && v.userId === id) state.tokens.delete(k);
      }
      return true;
    },

    async listAuthUsers(ctx, options = {}) {
      requireAuthTenant(ctx);
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
      let users = Array.from(state.users.values()).filter(
        (u) => u.projectId === ctx.projectId
      );
      if (options.search) {
        const needle = options.search.toLowerCase();
        users = users.filter(
          (u) =>
            u.email?.toLowerCase().includes(needle) ||
            u.displayName?.toLowerCase().includes(needle)
        );
      }
      if (options.isDisabled !== undefined) users = users.filter((u) => u.isDisabled === options.isDisabled);
      if (options.isAnonymous !== undefined) users = users.filter((u) => u.isAnonymous === options.isAnonymous);
      if (options.emailVerified !== undefined) users = users.filter((u) => u.emailVerified === options.emailVerified);
      users.sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
      );
      if (options.cursor) {
        const { createdAt, id } = decodeUserCursor(options.cursor);
        users = users.filter(
          (u) => u.createdAt < createdAt || (u.createdAt === createdAt && u.id < id)
        );
      }
      const hasMore = users.length > limit;
      const page = users.slice(0, limit);
      const last = page[page.length - 1];
      return {
        users: page.map((u) => structuredClone(u)),
        nextCursor: hasMore && last ? encodeUserCursor(last.createdAt, last.id) : null,
      };
    },

    async countAuthUsers(ctx) {
      requireAuthTenant(ctx);
      let n = 0;
      for (const user of state.users.values()) {
        if (user.projectId === ctx.projectId) n++;
      }
      return n;
    },

    async upsertAuthIdentity(ctx, input) {
      requireAuthTenant(ctx);
      const existingKey = Array.from(state.identities.entries()).find(([, v]) =>
        v.projectId === ctx.projectId &&
        v.provider === input.provider &&
        v.providerUserId === input.providerUserId
      )?.[0];
      const ts = now();
      const record: AuthIdentityRecord = existingKey
        ? {
            ...(state.identities.get(existingKey) as AuthIdentityRecord),
            identityData: structuredClone(input.identityData ?? {}),
            lastSignInAt: input.lastSignInAt ?? ts,
            updatedAt: ts,
          }
        : {
            id: crypto.randomUUID(),
            userId: input.userId,
            projectId: ctx.projectId,
            provider: input.provider,
            providerUserId: input.providerUserId,
            identityData: structuredClone(input.identityData ?? {}),
            lastSignInAt: input.lastSignInAt ?? ts,
            createdAt: ts,
            updatedAt: ts,
          };
      state.identities.set(existingKey ?? authKey(ctx, record.id), record);
      return structuredClone(record);
    },

    async getAuthIdentityByProvider(ctx, provider, providerUserId) {
      requireAuthTenant(ctx);
      for (const v of state.identities.values()) {
        if (
          v.projectId === ctx.projectId &&
          v.provider === provider && v.providerUserId === providerUserId
        ) return structuredClone(v);
      }
      return null;
    },

    async listUserIdentities(ctx, userId) {
      requireAuthTenant(ctx);
      return Array.from(state.identities.values())
        .filter((v) => v.projectId === ctx.projectId && v.userId === userId)
        .map((v) => structuredClone(v));
    },

    async deleteAuthIdentity(ctx, userId, provider) {
      requireAuthTenant(ctx);
      for (const [key, v] of state.identities.entries()) {
        if (v.projectId === ctx.projectId && v.userId === userId && v.provider === provider) {
          return state.identities.delete(key);
        }
      }
      return false;
    },

    async createAuthSession(ctx, input) {
      const ts = now();
      const session: AuthSessionRecord = {
        id: crypto.randomUUID(),
        userId: input.userId,
        projectId: ctx.projectId,
        refreshTokenHash: input.refreshTokenHash,
        previousRefreshTokenHash: input.previousRefreshTokenHash ?? null,
        rotationCounter: input.rotationCounter ?? 0,
        userAgent: input.userAgent ?? null,
        ipAddress: input.ipAddress ?? null,
        revoked: false,
        revokedReason: null,
        revokedAt: null,
        rotatedAt: input.rotatedAt ?? null,
        expiresAt: input.expiresAt,
        createdAt: ts,
        lastUsedAt: ts,
      };
      state.sessions.set(authKey(ctx, session.id), session);
      return structuredClone(session);
    },

    async getAuthSessionByTokenHash(ctx, tokenHash) {
      requireAuthTenant(ctx);
      if (!tokenHash) return null;
      let matched: AuthSessionRecord | null = null;
      for (const v of state.sessions.values()) {
        if (v.projectId !== ctx.projectId) continue;
        const currentMatch = timingSafeEqualStr(v.refreshTokenHash, tokenHash);
        const prevMatch =
          v.previousRefreshTokenHash !== null &&
          timingSafeEqualStr(v.previousRefreshTokenHash, tokenHash);
        if ((currentMatch || prevMatch) && matched === null) {
          matched = v;
        }
      }
      return matched ? structuredClone(matched) : null;
    },

    async rotateAuthSession(ctx, sessionId, oldHash, newHash, newExpiresAt) {
      const key = authKey(ctx, sessionId);
      const existing = state.sessions.get(key);
      if (
        !oldHash ||
        !newHash ||
        timingSafeEqualStr(oldHash, newHash) ||
        !existing ||
        existing.projectId !== ctx.projectId ||
        existing.revoked ||
        !(Date.parse(existing.expiresAt) > Date.now()) ||
        !timingSafeEqualStr(existing.refreshTokenHash, oldHash)
      ) {
        throw new VellumError("UNAUTHENTICATED", "Session rotation failed");
      }
      const ts = now();
      const rotated: AuthSessionRecord = {
        ...existing,
        refreshTokenHash: newHash,
        previousRefreshTokenHash: oldHash,
        rotationCounter: existing.rotationCounter + 1,
        rotatedAt: ts,
        expiresAt: newExpiresAt,
        lastUsedAt: ts,
      };
      state.sessions.set(key, rotated);
      return structuredClone(rotated);
    },

    async revokeAuthSession(ctx, sessionId, reason) {
      const key = authKey(ctx, sessionId);
      const existing = state.sessions.get(key);
      if (!existing || existing.projectId !== ctx.projectId) {
        throw new VellumError("NOT_FOUND", "Session not found");
      }
      const revoked: AuthSessionRecord = {
        ...existing,
        revoked: true,
        revokedReason: reason,
        revokedAt: now(),
      };
      state.sessions.set(key, revoked);
      return structuredClone(revoked);
    },

    async revokeAllUserSessions(ctx, userId, reason) {
      requireAuthTenant(ctx);
      let n = 0;
      const ts = now();
      for (const [key, v] of state.sessions.entries()) {
        if (
          v.projectId === ctx.projectId &&
          v.userId === userId && !v.revoked
        ) {
          state.sessions.set(key, { ...v, revoked: true, revokedReason: reason, revokedAt: ts });
          n++;
        }
      }
      return n;
    },

    async listUserSessions(ctx, userId) {
      requireAuthTenant(ctx);
      return Array.from(state.sessions.values())
        .filter((v) => v.projectId === ctx.projectId && v.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((v) => structuredClone(v));
    },

    async upsertAuthMfa(ctx, input) {
      requireAuthTenant(ctx);
      const existingKey = Array.from(state.mfa.entries()).find(([, v]) =>
        v.projectId === ctx.projectId &&
        v.userId === input.userId && v.factorType === (input.factorType ?? "totp")
      )?.[0];
      const record: AuthMfaRecord = existingKey
        ? {
            ...(state.mfa.get(existingKey) as AuthMfaRecord),
            secretEncrypted: input.secretEncrypted,
            verified: input.verified ?? false,
            recoveryCodesHashed: [...(input.recoveryCodesHashed ?? [])],
            verifiedAt: input.verifiedAt ?? null,
          }
        : {
            id: crypto.randomUUID(),
            userId: input.userId,
            projectId: ctx.projectId,
            factorType: input.factorType ?? "totp",
            secretEncrypted: input.secretEncrypted,
            verified: input.verified ?? false,
            recoveryCodesHashed: [...(input.recoveryCodesHashed ?? [])],
            createdAt: now(),
            verifiedAt: input.verifiedAt ?? null,
          };
      state.mfa.set(existingKey ?? authKey(ctx, record.id), record);
      return structuredClone(record);
    },

    async getAuthMfa(ctx, userId) {
      requireAuthTenant(ctx);
      for (const v of state.mfa.values()) {
        if (v.projectId === ctx.projectId && v.userId === userId) {
          return structuredClone(v);
        }
      }
      return null;
    },

    async deleteAuthMfa(ctx, userId) {
      requireAuthTenant(ctx);
      for (const [key, v] of state.mfa.entries()) {
        if (v.projectId === ctx.projectId && v.userId === userId) {
          return state.mfa.delete(key);
        }
      }
      return false;
    },

    async saveAuthToken(ctx, input) {
      pruneExpiredTokens();
      const record: AuthTokenRecord = {
        id: crypto.randomUUID(),
        userId: input.userId,
        projectId: ctx.projectId,
        tokenHash: input.tokenHash,
        tokenType: input.tokenType,
        expiresAt: input.expiresAt,
        consumedAt: null,
        createdAt: now(),
      };
      state.tokens.set(authKey(ctx, record.id), record);
      return structuredClone(record);
    },

    async consumeAuthToken(ctx, tokenHash, tokenType) {
      requireAuthTenant(ctx);
      if (!tokenHash || !tokenType) {
        throw new VellumError("UNAUTHENTICATED", "Invalid or expired action token");
      }
      const nowMs = Date.now();
      let matchedKey: string | null = null;
      let matchedRecord: AuthTokenRecord | null = null;
      for (const [key, v] of state.tokens.entries()) {
        if (v.projectId !== ctx.projectId) continue;
        const hashMatches = timingSafeEqualStr(v.tokenHash, tokenHash);
        if (
          hashMatches &&
          v.tokenType === tokenType &&
          v.consumedAt === null &&
          Date.parse(v.expiresAt) > nowMs &&
          matchedKey === null
        ) {
          matchedKey = key;
          matchedRecord = v;
        }
      }
      if (matchedKey !== null && matchedRecord !== null) {
        const consumed: AuthTokenRecord = { ...matchedRecord, consumedAt: now() };
        state.tokens.set(matchedKey, consumed);
        return structuredClone(consumed);
      }
      throw new VellumError("UNAUTHENTICATED", "Invalid or expired action token");
    },
    async peekAuthToken(ctx, tokenHash, tokenType) {
      requireAuthTenant(ctx);
      if (!tokenHash || !tokenType) {
        throw new VellumError("UNAUTHENTICATED", "Invalid or expired action token");
      }
      const nowMs = Date.now();
      for (const v of state.tokens.values()) {
        if (v.projectId !== ctx.projectId) continue;
        if (
          timingSafeEqualStr(v.tokenHash, tokenHash) &&
          v.tokenType === tokenType &&
          v.consumedAt === null &&
          Date.parse(v.expiresAt) > nowMs
        ) {
          return structuredClone(v);
        }
      }
      throw new VellumError("UNAUTHENTICATED", "Invalid or expired action token");
    },
  };
}
