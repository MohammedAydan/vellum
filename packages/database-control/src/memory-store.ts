/**
 * @vellum/database-control - In-Memory Control Plane Store
 * Fast, deterministic store for unit tests, offline development, and mocking.
 *
 * This is the `DATABASE_MODE=memory` implementation of `ControlPlaneRepository`.
 * It is NOT the production path — see `pg-store.ts` for the PostgreSQL-backed one.
 */

import crypto from "node:crypto";
import { VellumError } from "@vellum/core";
import { validateRelationRuleInputs } from "./relation-rules.js";
import {
  ORGANIZATION_SLUG_PATTERN,
  type ApiKeyRecord,
  type AuditLogRecord,
  type ControlAuthRealm,
  type ControlPlaneRepository,
  type ControlRefreshSessionRecord,
  type CreateControlRefreshSessionInput,
  type CreateOrganizationInput,
  type CreateProjectInput,
  type CreateUserInput,
  type FeatureFlagRecord,
  type OrganizationMemberRecord,
  type OrganizationRecord,
  type PlatformAuthGlobalSettings,
  type ProjectAuthConfig,
  type ProjectRecord,
  type ProjectResult,
  type ProjectRelationRuleRecord,
  type PublishSecurityRulesetInput,
  type RecordAuditLogInput,
  type RelationRulesSnapshot,
  type ReplaceRelationRulesInput,
  type RegisterApiKeyInput,
  type SecurityRulesetRecord,
  type SetFeatureFlagInput,
  type UpdatePlatformAuthSettingsInput,
  type UsageDailyRecord,
  type UsageDeltas,
  type UpsertAuthConfigInput,
  type UserRecord,
} from "./types.js";
import {
  createInMemorySecurityRepository,
  type SecurityRepository,
} from "./security-repository.js";
import {
  createInMemoryBillingRepository,
  type BillingRepository,
} from "./billing-repository.js";

const AUDIT_LOG_CAP = 10_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 16 || value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  const clean: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    clean[key] = sanitizeValue(entry, depth + 1);
  }
  return clean;
}

function sanitizeObject(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return sanitizeValue(value) as Record<string, unknown>;
}

function safeCounterDelta(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function safeSignedDelta(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
}

function cloneRefreshSession(session: ControlRefreshSessionRecord): ControlRefreshSessionRecord {
  return { ...session };
}

function cloneAuthConfig(config: ProjectAuthConfig): ProjectAuthConfig {
  return { ...config, oauthProviders: sanitizeObject(config.oauthProviders) };
}

function clonePlatformAuthSettings(settings: PlatformAuthGlobalSettings): PlatformAuthGlobalSettings {
  return { ...settings };
}

function cloneFeatureFlag(flag: FeatureFlagRecord): FeatureFlagRecord {
  return { ...flag };
}

export class ControlPlaneStore implements ControlPlaneRepository {
  users = new Map<string, UserRecord>();
  organizations = new Map<string, OrganizationRecord>();
  organizationMembers = new Map<string, OrganizationMemberRecord>();
  projects = new Map<string, ProjectRecord>();
  apiKeysByPrefix = new Map<string, ApiKeyRecord>();
  apiKeysById = new Map<string, ApiKeyRecord>();
  securityRulesets = new Map<string, SecurityRulesetRecord>();
  /** Active ruleset per project, keyed by projectId. */
  activeRulesetsByProject = new Map<string, SecurityRulesetRecord>();
  /** Relation rules per project, keyed by projectId (mirror of migration 0012). */
  relationRulesByProject = new Map<string, ProjectRelationRuleRecord[]>();
  private relationRulesVersionByProject = new Map<string, number>();
  usageDaily = new Map<string, UsageDailyRecord>();
  auditLogs: AuditLogRecord[] = [];
  featureFlags = new Map<string, FeatureFlagRecord>();
  controlRefreshSessions = new Map<string, ControlRefreshSessionRecord>();
  /** Auth configuration per project, keyed by projectId. */
  authConfigsByProject = new Map<string, ProjectAuthConfig>();
  platformAuthSettings: PlatformAuthGlobalSettings = {
    id: 1,
    globalSignupsEnabled: true,
    defaultMaxUsersPerFreeProject: 10000,
    defaultMaxUsersPerProProject: 250000,
    platformSmtpHost: null,
    platformSmtpPort: null,
    platformSmtpUser: null,
    platformSmtpPassEncrypted: null,
    platformSmtpFromEmail: "noreply@vellum.dev",
    updatedAt: new Date().toISOString(),
  };

  // O(1) secondary indexes for control-plane refresh sessions.
  private readonly sessionsByRefreshHash = new Map<string, string>();
  private readonly sessionsByAccessHash = new Map<string, string>();
  private readonly sessionsByPreviousHash = new Map<string, string>();
  private readonly sessionsByUserId = new Map<string, Set<string>>();

  /**
   * Security Fortress repository. The in-memory implementation is wrapped so
   * that API-key restriction updates also mutate the key mirrors — the base
   * implementation is intentionally storage-agnostic and cannot see them.
   */
  readonly security: SecurityRepository = (() => {
    const base = createInMemorySecurityRepository();
    return {
      getLastAuditHash: () => base.getLastAuditHash(),
      appendAuditLog: (input) => base.appendAuditLog(input),
      listAuditLogs: (filter) => base.listAuditLogs(filter),
      recordThreat: (input) => base.recordThreat(input),
      listThreats: (filter) => base.listThreats(filter),
      updateThreatStatus: (id, status) => base.updateThreatStatus(id, status),
      upsertBlocklist: (input) => base.upsertBlocklist(input),
      listBlocklist: (activeOnly) => base.listBlocklist(activeOnly),
      deactivateBlocklist: (id) => base.deactivateBlocklist(id),
      deleteBlocklist: (id) => base.deleteBlocklist(id),
      updateApiKeyRestrictions: (
        keyId: string,
        patch: { allowedOrigins?: string[]; allowedIps?: string[]; expiresAt?: string | null }
      ): void => {
        const key = this.apiKeysById.get(keyId);
        if (!key) return;
        if (patch.allowedOrigins !== undefined) key.allowedOrigins = [...patch.allowedOrigins];
        if (patch.allowedIps !== undefined) key.allowedIps = [...patch.allowedIps];
        if (patch.expiresAt !== undefined) key.expiresAt = patch.expiresAt;
        const byPrefix = this.apiKeysByPrefix.get(key.keyPrefix);
        if (byPrefix && byPrefix !== key) {
          if (patch.allowedOrigins !== undefined) byPrefix.allowedOrigins = [...patch.allowedOrigins];
          if (patch.allowedIps !== undefined) byPrefix.allowedIps = [...patch.allowedIps];
          if (patch.expiresAt !== undefined) byPrefix.expiresAt = patch.expiresAt;
        }
      },
    };
  })();

  readonly billing: BillingRepository = createInMemoryBillingRepository(
    (orgId) => this.organizations.get(orgId)?.billingEmail ?? null
  );

  createUser({
    email,
    name,
    platformRole = "customer",
    emailVerified = true,
  }: CreateUserInput): UserRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const user: UserRecord = {
      id,
      email,
      emailVerified,
      name,
      avatarUrl: null,
      platformRole,
      isSuspended: false,
      // Signup can never grant platform super-admin privileges.
      isPlatformSuperAdmin: false,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(id, user);
    return user;
  }

  createControlRefreshSession(
    input: CreateControlRefreshSessionInput
  ): ControlRefreshSessionRecord {
    if (input.realm !== "customer_console" && input.realm !== "super_admin") {
      throw new VellumError("INVALID_ARGUMENT", `Invalid control auth realm '${String(input.realm)}'`);
    }
    const now = new Date().toISOString();
    const record: ControlRefreshSessionRecord = {
      id: crypto.randomUUID(),
      userId: input.userId,
      realm: input.realm,
      accessTokenHash: input.accessTokenHash,
      refreshTokenHash: input.refreshTokenHash,
      previousRefreshTokenHash: input.previousRefreshTokenHash ?? null,
      rotatedAt: null,
      rotationCounter: 0,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      revoked: false,
      revokedReason: null,
      accessExpiresAt: input.accessExpiresAt,
      refreshExpiresAt: input.refreshExpiresAt,
      createdAt: now,
      lastUsedAt: now,
    };
    this.controlRefreshSessions.set(record.id, record);
    this.sessionsByRefreshHash.set(record.refreshTokenHash, record.id);
    this.sessionsByAccessHash.set(record.accessTokenHash, record.id);
    if (record.previousRefreshTokenHash !== null) {
      this.sessionsByPreviousHash.set(record.previousRefreshTokenHash, record.id);
    }
    let userSessions = this.sessionsByUserId.get(record.userId);
    if (!userSessions) {
      userSessions = new Set<string>();
      this.sessionsByUserId.set(record.userId, userSessions);
    }
    userSessions.add(record.id);
    return cloneRefreshSession(record);
  }

  getControlRefreshSessionByHash(hash: string): ControlRefreshSessionRecord | null {
    if (typeof hash !== "string" || hash.length === 0) return null;
    const candidateId =
      this.sessionsByRefreshHash.get(hash) ?? this.sessionsByAccessHash.get(hash);
    if (candidateId !== undefined) {
      const session = this.controlRefreshSessions.get(candidateId);
      if (
        session &&
        (timingSafeStringEqual(session.refreshTokenHash, hash) ||
          timingSafeStringEqual(session.accessTokenHash, hash))
      ) {
        return cloneRefreshSession(session);
      }
    }
    // Fallback scan in case a caller directly mutated `this.controlRefreshSessions`.
    for (const session of this.controlRefreshSessions.values()) {
      if (
        timingSafeStringEqual(session.refreshTokenHash, hash) ||
        timingSafeStringEqual(session.accessTokenHash, hash)
      ) {
        return cloneRefreshSession(session);
      }
    }
    return null;
  }

  getControlRefreshSessionByPreviousHash(hash: string): ControlRefreshSessionRecord | null {
    if (typeof hash !== "string" || hash.length === 0) return null;
    const candidateId = this.sessionsByPreviousHash.get(hash);
    if (candidateId !== undefined) {
      const session = this.controlRefreshSessions.get(candidateId);
      if (
        session &&
        session.previousRefreshTokenHash !== null &&
        timingSafeStringEqual(session.previousRefreshTokenHash, hash)
      ) {
        return cloneRefreshSession(session);
      }
    }
    for (const session of this.controlRefreshSessions.values()) {
      if (
        session.previousRefreshTokenHash !== null &&
        timingSafeStringEqual(session.previousRefreshTokenHash, hash)
      ) {
        return cloneRefreshSession(session);
      }
    }
    return null;
  }

  rotateControlRefreshSession(
    id: string,
    oldHash: string,
    newAccessHash: string,
    newRefreshHash: string,
    accessExpiresAt: string,
    refreshExpiresAt: string
  ): ControlRefreshSessionRecord {
    const session = this.controlRefreshSessions.get(id);
    if (
      !session ||
      session.revoked ||
      typeof oldHash !== "string" ||
      !timingSafeStringEqual(session.refreshTokenHash, oldHash)
    ) {
      throw new VellumError("UNAUTHENTICATED", "Session rotation failed");
    }

    // Update O(1) hash indexes cleanly before replacing the session record.
    this.sessionsByRefreshHash.delete(session.refreshTokenHash);
    this.sessionsByAccessHash.delete(session.accessTokenHash);
    if (session.previousRefreshTokenHash !== null) {
      this.sessionsByPreviousHash.delete(session.previousRefreshTokenHash);
    }

    const now = new Date().toISOString();
    const rotated: ControlRefreshSessionRecord = {
      ...session,
      accessTokenHash: newAccessHash,
      refreshTokenHash: newRefreshHash,
      previousRefreshTokenHash: oldHash,
      rotatedAt: now,
      rotationCounter: session.rotationCounter + 1,
      accessExpiresAt,
      refreshExpiresAt,
      lastUsedAt: now,
    };
    this.controlRefreshSessions.set(id, rotated);
    this.sessionsByRefreshHash.set(rotated.refreshTokenHash, id);
    this.sessionsByAccessHash.set(rotated.accessTokenHash, id);
    this.sessionsByPreviousHash.set(oldHash, id);
    return cloneRefreshSession(rotated);
  }

  revokeControlRefreshSessionsForUser(
    userId: string,
    reason: string,
    realm?: ControlAuthRealm
  ): number {
    let revoked = 0;
    const indexedIds = this.sessionsByUserId.get(userId);
    if (indexedIds) {
      for (const sessionId of indexedIds) {
        const session = this.controlRefreshSessions.get(sessionId);
        if (
          session &&
          session.userId === userId &&
          !session.revoked &&
          (realm === undefined || session.realm === realm)
        ) {
          session.revoked = true;
          session.revokedReason = reason;
          revoked++;
        }
      }
      return revoked;
    }
    for (const session of this.controlRefreshSessions.values()) {
      if (
        session.userId === userId &&
        !session.revoked &&
        (realm === undefined || session.realm === realm)
      ) {
        session.revoked = true;
        session.revokedReason = reason;
        revoked++;
      }
    }
    return revoked;
  }

  listControlRefreshSessions(): ControlRefreshSessionRecord[] {
    return Array.from(this.controlRefreshSessions.values(), cloneRefreshSession);
  }

  isPlatformSuperAdmin(userId: string): boolean {
    return this.users.get(userId)?.isPlatformSuperAdmin === true;
  }

  setPlatformSuperAdmin(userId: string, value: boolean): void {
    const user = this.users.get(userId);
    if (!user) {
      throw new VellumError("NOT_FOUND", `User '${userId}' not found`);
    }
    user.isPlatformSuperAdmin = value;
    user.updatedAt = new Date().toISOString();
  }

  createOrganization({
    slug,
    name,
    billingEmail,
    ownerUserId,
    planId = "free",
  }: CreateOrganizationInput): OrganizationRecord {
    if (!ORGANIZATION_SLUG_PATTERN.test(slug)) {
      throw new VellumError("INVALID_ARGUMENT", `Invalid organization slug '${slug}'`);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const org: OrganizationRecord = {
      id,
      slug,
      name,
      billingEmail,
      planId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.organizations.set(id, org);
    if (ownerUserId) {
      this.organizationMembers.set(`${id}:${ownerUserId}`, {
        organizationId: id,
        userId: ownerUserId,
        role: "owner",
        joinedAt: now,
      });
    }
    return org;
  }

  createProject({
    organizationId,
    slug,
    name,
    actorUserId = null,
  }: CreateProjectInput): ProjectResult {
    if (!this.organizations.has(organizationId)) {
      throw new VellumError("NOT_FOUND", `Organization '${organizationId}' not found`);
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      id,
      organizationId,
      slug,
      name,
      status: "active",
      clusterId: "cluster_shared_01",
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(id, project);

    void this.recordAuditLog({
      actorUserId,
      actorType: actorUserId ? "user" : "system",
      organizationId,
      projectId: id,
      action: "project.created",
      targetId: id,
      metadata: { slug, name },
    });

    return { project };
  }

  getProject(projectId: string): ProjectResult {
    const project = this.projects.get(projectId);
    if (!project || project.status === "deleted") {
      throw new VellumError("NOT_FOUND", `Project '${projectId}' not found`);
    }
    if (project.status === "suspended") {
      throw new VellumError("PERMISSION_DENIED", `Project '${projectId}' is currently suspended`);
    }
    return { project };
  }

  registerApiKey({
    projectId,
    name,
    keyType,
    keyPrefix,
    secretHash,
    scopes = ["documents:read", "documents:write"],
    rateLimitRps = 100,
    expiresAt = null,
    createdBy = null,
  }: RegisterApiKeyInput): ApiKeyRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const clonedScopes = Array.isArray(scopes) ? [...scopes] : [];
    const record: ApiKeyRecord = {
      id,
      projectId,
      name,
      keyType,
      keyPrefix,
      secretHash,
      scopes: clonedScopes,
      rateLimitRps: Number.isFinite(rateLimitRps) && rateLimitRps >= 0 ? rateLimitRps : 100,
      lastUsedAt: null,
      expiresAt,
      revokedAt: null,
      createdBy,
      createdAt: now,
    };
    this.apiKeysByPrefix.set(keyPrefix, record);
    this.apiKeysById.set(id, record);
    void this.recordAuditLog({
      actorUserId: createdBy,
      actorType: createdBy ? "user" : "system",
      projectId,
      action: "api_key.created",
      targetId: id,
      metadata: { keyPrefix, keyType, scopes: [...clonedScopes] },
    });
    return record;
  }

  getApiKey(keyId: string): ApiKeyRecord | undefined {
    return this.apiKeysById.get(keyId);
  }

  getApiKeyByPrefix(prefix: string): ApiKeyRecord | null {
    return this.apiKeysByPrefix.get(prefix) ?? null;
  }

  revokeApiKey(keyId: string, actorUserId: string | null = null): ApiKeyRecord {
    const record = this.apiKeysById.get(keyId);
    if (!record) {
      throw new VellumError("NOT_FOUND", `API key '${keyId}' not found`);
    }
    record.revokedAt = new Date().toISOString();
    this.apiKeysByPrefix.delete(record.keyPrefix);
    void this.recordAuditLog({
      actorUserId,
      actorType: actorUserId ? "user" : "system",
      projectId: record.projectId,
      action: "api_key.revoked",
      targetId: keyId,
      metadata: { keyPrefix: record.keyPrefix },
    });
    return record;
  }

  publishSecurityRuleset({
    projectId,
    rulesAst,
    createdBy = null,
  }: PublishSecurityRulesetInput): SecurityRulesetRecord {
    const existingActive = this.activeRulesetsByProject.get(projectId);
    const nextVersion = existingActive ? existingActive.version + 1 : 1;
    if (existingActive) {
      existingActive.isActive = false;
    }
    const record: SecurityRulesetRecord = {
      id: crypto.randomUUID(),
      projectId,
      version: nextVersion,
      rulesAst: sanitizeObject(rulesAst),
      isActive: true,
      createdBy,
      createdAt: new Date().toISOString(),
    };
    this.securityRulesets.set(`${projectId}:${nextVersion}`, record);
    this.activeRulesetsByProject.set(projectId, record);
    void this.recordAuditLog({
      actorUserId: createdBy,
      actorType: createdBy ? "user" : "system",
      projectId,
      action: "ruleset.published",
      targetId: record.id,
      metadata: { version: nextVersion },
    });
    return record;
  }

  getActiveRuleset(projectId: string): SecurityRulesetRecord | null {
    return this.activeRulesetsByProject.get(projectId) ?? null;
  }

  getRelationRules(projectId: string): ProjectRelationRuleRecord[] {
    return this.relationRulesByProject.get(projectId) ?? [];
  }

  getRelationRulesVersion(projectId: string): number {
    return this.relationRulesVersionByProject.get(projectId) ?? 0;
  }

  replaceRelationRules({
    projectId,
    rules,
    expectedVersion = null,
    createdBy = null,
  }: ReplaceRelationRulesInput): RelationRulesSnapshot {
    const validated = validateRelationRuleInputs(rules);
    const current = this.getRelationRulesVersion(projectId);
    if (expectedVersion !== null && expectedVersion !== current) {
      throw new VellumError(
        "ABORTED_CONFLICT",
        `Relation rules version conflict: expected ${expectedVersion}, current ${current}`
      );
    }
    const version = current + 1;
    const now = new Date().toISOString();
    const records: ProjectRelationRuleRecord[] = validated.map((rule) => ({
      id: crypto.randomUUID(),
      projectId,
      collection: rule.collection,
      field: rule.field,
      targetCollection: rule.targetCollection ?? null,
      onDelete: rule.onDelete,
      version,
      createdAt: now,
      updatedAt: now,
    }));
    this.relationRulesByProject.set(projectId, records);
    this.relationRulesVersionByProject.set(projectId, version);
    void this.recordAuditLog({
      actorUserId: createdBy,
      actorType: createdBy ? "user" : "system",
      projectId,
      action: "relation_rules.replaced",
      targetId: projectId,
      metadata: { version, ruleCount: records.length },
    });
    return { projectId, version, rules: records, updatedAt: now };
  }

  incrementUsage(projectId: string, deltas: UsageDeltas = {}): UsageDailyRecord {
    const usageDate = new Date().toISOString().slice(0, 10);
    const key = `${projectId}:${usageDate}`;
    const current = this.usageDaily.get(key) ?? {
      projectId,
      usageDate,
      documentReads: 0,
      documentWrites: 0,
      documentDeletes: 0,
      realtimeMessagesSent: 0,
      egressBytes: 0,
      storageBytes: 0,
      updatedAt: new Date().toISOString(),
    };
    current.documentReads += safeCounterDelta(deltas.documentReads);
    current.documentWrites += safeCounterDelta(deltas.documentWrites);
    current.documentDeletes += safeCounterDelta(deltas.documentDeletes);
    current.realtimeMessagesSent += safeCounterDelta(deltas.realtimeMessagesSent);
    current.egressBytes += safeCounterDelta(deltas.egressBytes);
    current.storageBytes = Math.max(0, current.storageBytes + safeSignedDelta(deltas.storageBytesDelta));
    current.updatedAt = new Date().toISOString();
    this.usageDaily.set(key, current);
    return current;
  }

  recordAuditLog({
    actorUserId = null,
    actorType = "system",
    organizationId = null,
    projectId = null,
    action,
    targetId = null,
    metadata = {},
    ipAddress = null,
    userAgent = null,
  }: RecordAuditLogInput): AuditLogRecord {
    const log: AuditLogRecord = {
      id: crypto.randomUUID(),
      actorUserId,
      actorType,
      organizationId,
      projectId,
      action,
      targetId,
      metadata: sanitizeObject(metadata),
      ipAddress,
      userAgent,
      createdAt: new Date().toISOString(),
    };
    this.auditLogs.push(log);
    if (this.auditLogs.length > AUDIT_LOG_CAP) {
      this.auditLogs.splice(0, this.auditLogs.length - AUDIT_LOG_CAP);
    }
    return log;
  }

  listFeatureFlags(): FeatureFlagRecord[] {
    return Array.from(this.featureFlags.values(), cloneFeatureFlag).sort((a, b) =>
      a.key.localeCompare(b.key)
    );
  }

  setFeatureFlag({
    key,
    description = "",
    enabled,
    rolloutPercent = 100,
    updatedBy = null,
  }: SetFeatureFlagInput): FeatureFlagRecord {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key)) {
      throw new VellumError("INVALID_ARGUMENT", `Invalid feature flag key '${key}'`);
    }
    if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
      throw new VellumError(
        "INVALID_ARGUMENT",
        `Feature flag rolloutPercent must be an integer between 0 and 100 (received ${rolloutPercent})`
      );
    }
    const record: FeatureFlagRecord = {
      key,
      description,
      enabled,
      rolloutPercent,
      updatedAt: new Date().toISOString(),
      updatedBy,
    };
    this.featureFlags.set(key, record);
    return cloneFeatureFlag(record);
  }

  getAuthConfig(projectId: string): ProjectAuthConfig | null {
    const record = this.authConfigsByProject.get(projectId);
    return record ? cloneAuthConfig(record) : null;
  }

  listAuthConfigs(): ProjectAuthConfig[] {
    return Array.from(this.authConfigsByProject.values(), cloneAuthConfig);
  }

  upsertAuthConfig(input: UpsertAuthConfigInput): ProjectAuthConfig {
    const existing = this.authConfigsByProject.get(input.projectId);
    const now = new Date().toISOString();
    const record: ProjectAuthConfig = {
      id: existing?.id ?? crypto.randomUUID(),
      projectId: input.projectId,
      authServiceSuspended: input.authServiceSuspended ?? existing?.authServiceSuspended ?? false,
      suspensionReason: input.suspensionReason !== undefined
        ? input.suspensionReason
        : (existing?.suspensionReason ?? null),
      maxUsersQuota: input.maxUsersQuota ?? existing?.maxUsersQuota ?? 50000,
      maxSignupsPerHour: input.maxSignupsPerHour ?? existing?.maxSignupsPerHour ?? 1000,
      enableEmailPassword: input.enableEmailPassword ?? existing?.enableEmailPassword ?? true,
      requireEmailVerification: input.requireEmailVerification ?? existing?.requireEmailVerification ?? false,
      enableAnonymousAuth: input.enableAnonymousAuth ?? existing?.enableAnonymousAuth ?? false,
      enableTotpMfa: input.enableTotpMfa ?? existing?.enableTotpMfa ?? true,
      enableUserProjection: input.enableUserProjection ?? existing?.enableUserProjection ?? true,
      projectionCollectionPath: input.projectionCollectionPath ?? existing?.projectionCollectionPath ?? "users",
      passwordMinLength: input.passwordMinLength ?? existing?.passwordMinLength ?? 8,
      passwordRequireUppercase: input.passwordRequireUppercase ?? existing?.passwordRequireUppercase ?? false,
      passwordRequireNumber: input.passwordRequireNumber ?? existing?.passwordRequireNumber ?? true,
      passwordRequireSymbol: input.passwordRequireSymbol ?? existing?.passwordRequireSymbol ?? false,
      accessTokenTtlSeconds: input.accessTokenTtlSeconds ?? existing?.accessTokenTtlSeconds ?? 3600,
      refreshTokenTtlDays: input.refreshTokenTtlDays ?? existing?.refreshTokenTtlDays ?? 30,
      jwtKeyId: input.jwtKeyId,
      jwtPublicKeyPem: input.jwtPublicKeyPem,
      jwtPrivateKeyEncrypted: input.jwtPrivateKeyEncrypted,
      oauthProviders: sanitizeObject(input.oauthProviders ?? existing?.oauthProviders),
      customSmtpConfigEncrypted: input.customSmtpConfigEncrypted !== undefined
        ? input.customSmtpConfigEncrypted
        : (existing?.customSmtpConfigEncrypted ?? null),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.authConfigsByProject.set(record.projectId, record);
    return cloneAuthConfig(record);
  }

  getPlatformAuthSettings(): PlatformAuthGlobalSettings {
    return clonePlatformAuthSettings(this.platformAuthSettings);
  }

  updatePlatformAuthSettings(input: UpdatePlatformAuthSettingsInput): PlatformAuthGlobalSettings {
    const cleanPatch = sanitizeObject(input as Record<string, unknown>) as UpdatePlatformAuthSettingsInput;
    this.platformAuthSettings = {
      ...this.platformAuthSettings,
      ...cleanPatch,
      id: 1,
      updatedAt: new Date().toISOString(),
    };
    return clonePlatformAuthSettings(this.platformAuthSettings);
  }
}
