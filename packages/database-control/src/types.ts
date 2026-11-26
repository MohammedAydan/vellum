/**
 * `packages/database-control/src/types.ts`
 * Shared Control Plane record shapes and the `ControlPlaneRepository` contract.
 *
 * Two implementations satisfy this contract:
 *  - `ControlPlaneStore`    (in-memory, synchronous, used by unit tests + offline dev)
 *  - `PgControlPlaneStore`  (PostgreSQL-backed, durable, used by the real API server)
 *
 * Why the mutators return `MaybePromise<T>`:
 * The HTTP/WS request hot path needs *synchronous* metadata lookups (`getProject`,
 * `getActiveRuleset`, `apiKeysByPrefix`) because `@vellum/document-engine` and
 * `@vellum/realtime` call them inside synchronous code paths. The PostgreSQL
 * implementation therefore keeps a hydrated in-process read cache and performs the
 * durable write on the same call. Mutators may return either a value or a promise, so
 * every caller `await`s them — which is correct for both implementations.
 */

export type MaybePromise<T> = T | Promise<T>;

// Security Fortress + Billing repositories (migrations 0007 / 0008).
// Both stores expose these as first-class members so the API/WS layers can
// read and append tamper-evident records without touching raw SQL.
import type { SecurityRepository } from "./security-repository.js";
import type { BillingRepository } from "./billing-repository.js";
import type { ThrottleRepository } from "./throttle-repository.js";

export interface UserRecord {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  avatarUrl: string | null;
  platformRole: string;
  isSuspended: boolean;
  /** Platform Super Admin privileges. Never derived from a signup payload. */
  isPlatformSuperAdmin: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The two control-plane realms; end users live in data_db and are not stored here. */
export type ControlAuthRealm = "customer_console" | "super_admin";

/**
 * A durable refresh session for a console or super-admin operator.
 * All token hashes are SHA-256 hex strings; raw tokens/secrets never appear here.
 */
export interface ControlRefreshSessionRecord {
  id: string;
  userId: string;
  realm: ControlAuthRealm;
  accessTokenHash: string;
  refreshTokenHash: string;
  previousRefreshTokenHash: string | null;
  rotatedAt: string | null;
  rotationCounter: number;
  ipAddress: string | null;
  userAgent: string | null;
  revoked: boolean;
  revokedReason: string | null;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface CreateControlRefreshSessionInput {
  userId: string;
  realm: ControlAuthRealm;
  accessTokenHash: string;
  refreshTokenHash: string;
  previousRefreshTokenHash?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

export interface OrganizationRecord {
  id: string;
  slug: string;
  name: string;
  billingEmail: string;
  planId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMemberRecord {
  organizationId: string;
  userId: string;
  role: string;
  joinedAt: string;
}

export interface ProjectRecord {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  status: string;
  clusterId: string;
  createdAt: string;
  updatedAt: string;
}

/** Result wrapper shared by `getProject()` and `createProject()`. */
export interface ProjectResult {
  project: ProjectRecord;
}

export interface ApiKeyRecord {
  id: string;
  projectId: string;
  name: string;
  keyType: string;
  keyPrefix: string;
  secretHash: string;
  scopes: string[];
  rateLimitRps: number;
  /** Browser origins permitted for this key; empty array means unrestricted. */
  allowedOrigins?: string[];
  /** Source IPs permitted for this key; empty array means unrestricted. */
  allowedIps?: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface SecurityRulesetRecord {
  id: string;
  projectId: string;
  version: number;
  rulesAst: Record<string, unknown>;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
}

export interface UsageDailyRecord {
  projectId: string;
  usageDate: string;
  documentReads: number;
  documentWrites: number;
  documentDeletes: number;
  realtimeMessagesSent: number;
  egressBytes: number;
  storageBytes: number;
  updatedAt: string;
}

export interface AuditLogRecord {
  id: string;
  actorUserId: string | null;
  actorType: string;
  organizationId: string | null;
  projectId: string | null;
  action: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface FeatureFlagRecord {
  key: string;
  description: string;
  enabled: boolean;
  rolloutPercent: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface UsageDeltas {
  documentReads?: number;
  documentWrites?: number;
  documentDeletes?: number;
  realtimeMessagesSent?: number;
  egressBytes?: number;
  storageBytesDelta?: number;
}

export interface CreateUserInput {
  email: string;
  name: string;
  platformRole?: string;
  emailVerified?: boolean;
}

export interface CreateOrganizationInput {
  slug: string;
  name: string;
  billingEmail: string;
  ownerUserId?: string | null;
  planId?: string;
}

export interface CreateProjectInput {
  organizationId: string;
  slug: string;
  name: string;
  actorUserId?: string | null;
}

export interface RegisterApiKeyInput {
  projectId: string;
  name: string;
  keyType: string;
  keyPrefix: string;
  secretHash: string;
  scopes?: string[];
  rateLimitRps?: number;
  expiresAt?: string | null;
  createdBy?: string | null;
}

export interface PublishSecurityRulesetInput {
  projectId: string;
  rulesAst: Record<string, unknown>;
  createdBy?: string | null;
}

export type RelationRuleOnDelete = "cascade" | "set_null" | "restrict";

/** Persisted referential-integrity rule (migration 0012). */
export interface ProjectRelationRuleRecord {
  id: string;
  projectId: string;
  /** Dependent collection holding the reference field. */
  collection: string;
  /** Reference field on the dependent (dot paths allowed). */
  field: string;
  /** Optional: only fire for deletes in this target collection. */
  targetCollection: string | null;
  onDelete: RelationRuleOnDelete;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RelationRuleInput {
  collection: string;
  field: string;
  targetCollection?: string | null | undefined;
  onDelete: RelationRuleOnDelete;
}

/** Full-replacement write of a project's relation rules (optimistic concurrency). */
export interface ReplaceRelationRulesInput {
  projectId: string;
  rules: RelationRuleInput[];
  /** When provided, the replace fails with CONFLICT unless it matches the current version. */
  expectedVersion?: number | null;
  createdBy?: string | null;
}

export interface RelationRulesSnapshot {
  projectId: string;
  version: number;
  rules: ProjectRelationRuleRecord[];
  updatedAt: string;
}

export interface RecordAuditLogInput {
  actorUserId?: string | null;
  actorType?: string;
  organizationId?: string | null;
  projectId?: string | null;
  action: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface SetFeatureFlagInput {
  key: string;
  description?: string;
  enabled: boolean;
  rolloutPercent?: number;
  updatedBy?: string | null;
}

/** End-user auth configuration for one project (control_db). */
export interface ProjectAuthConfig {
  id: string;
  projectId: string;
  authServiceSuspended: boolean;
  suspensionReason: string | null;
  maxUsersQuota: number;
  maxSignupsPerHour: number;
  enableEmailPassword: boolean;
  requireEmailVerification: boolean;
  enableAnonymousAuth: boolean;
  enableTotpMfa: boolean;
  enableUserProjection: boolean;
  projectionCollectionPath: string;
  passwordMinLength: number;
  passwordRequireUppercase: boolean;
  passwordRequireNumber: boolean;
  passwordRequireSymbol: boolean;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  jwtKeyId: string;
  jwtPublicKeyPem: string;
  jwtPrivateKeyEncrypted: string;
  oauthProviders: Record<string, unknown>;
  customSmtpConfigEncrypted: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertAuthConfigInput {
  projectId: string;
  authServiceSuspended?: boolean | undefined;
  suspensionReason?: string | null | undefined;
  maxUsersQuota?: number | undefined;
  maxSignupsPerHour?: number | undefined;
  enableEmailPassword?: boolean | undefined;
  requireEmailVerification?: boolean | undefined;
  enableAnonymousAuth?: boolean | undefined;
  enableTotpMfa?: boolean | undefined;
  enableUserProjection?: boolean | undefined;
  projectionCollectionPath?: string | undefined;
  passwordMinLength?: number | undefined;
  passwordRequireUppercase?: boolean | undefined;
  passwordRequireNumber?: boolean | undefined;
  passwordRequireSymbol?: boolean | undefined;
  accessTokenTtlSeconds?: number | undefined;
  refreshTokenTtlDays?: number | undefined;
  jwtKeyId: string;
  jwtPublicKeyPem: string;
  jwtPrivateKeyEncrypted: string;
  oauthProviders?: Record<string, unknown> | undefined;
  customSmtpConfigEncrypted?: string | null | undefined;
}

export interface PlatformAuthGlobalSettings {
  id: number;
  globalSignupsEnabled: boolean;
  /** When true (default), console sign-up marks the email verified without sending mail. */
  consoleSignupAutoVerifyEmail: boolean;
  defaultMaxUsersPerFreeProject: number;
  defaultMaxUsersPerProProject: number;
  platformSmtpHost: string | null;
  platformSmtpPort: number | null;
  platformSmtpUser: string | null;
  platformSmtpPassEncrypted: string | null;
  platformSmtpFromEmail: string;
  updatedAt: string;
}

export type UpdatePlatformAuthSettingsInput = Partial<
  Omit<PlatformAuthGlobalSettings, "id" | "updatedAt">
>;

/**
 * V2 index-recommendation row + recorder input. Canonical definitions live in
 * `index-recommendations.ts`; they are type-only imports here so the repository
 * interface stays in sync without a runtime import cycle.
 */
import type {
  IndexRecommendationRecord,
  RecordIndexRecommendationInput,
} from "./index-recommendations.js";

/**
 * The contract every control-plane repository must satisfy.
 *
 * `readonly Map` members are intentionally part of the contract: the legacy
 * `@vellum/admin` service and `verifyApiKey()` read them directly.
 */
export interface ControlPlaneRepository {
  /** Re-reads the list mirrors from the database (PostgreSQL store only). Used by operator list views. */
  refresh?(): Promise<void>;
  readonly users: Map<string, UserRecord>;
  readonly organizations: Map<string, OrganizationRecord>;
  readonly projects: Map<string, ProjectRecord>;
  readonly apiKeysByPrefix: Map<string, ApiKeyRecord>;
  readonly apiKeysById: Map<string, ApiKeyRecord>;
  readonly auditLogs: AuditLogRecord[];

  /** Process-local mirrors (present on both implementations). Optional so
   * lightweight test doubles can omit them. */
  readonly usageDaily?: Map<string, UsageDailyRecord>;
  readonly featureFlags?: Map<string, FeatureFlagRecord>;
  /** Process-local auth-config mirror keyed by project id. */
  authConfigsByProject?: Map<string, ProjectAuthConfig>;
  platformAuthSettings?: PlatformAuthGlobalSettings;
  /** Process-local mirror of control-plane refresh sessions, keyed by session id. */
  readonly controlRefreshSessions?: Map<string, ControlRefreshSessionRecord>;

  /** Synchronous project lookup (throws NOT_FOUND / PERMISSION_DENIED). */
  getProject(projectId: string): ProjectResult;
  /** Authoritative PostgreSQL read (same errors as getProject). */
  getProjectAsync(projectId: string): Promise<ProjectResult>;
  getApiKey(keyId: string): ApiKeyRecord | undefined;
  getApiKeyByPrefix(prefix: string): ApiKeyRecord | null;
  /**
   * Source-of-truth API key reads. On PostgreSQL these are indexed queries against `api_keys`
   * on every call, with no process-local copy, so a revoke or a restriction edit made by any
   * instance (or by the console deployment) applies to the very next request.
   */
  /** Active (not revoked) key by its 16-character prefix, or null. Expiry is checked by the caller. */
  findApiKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null>;
  /** Any key (revoked included) by id, or null. */
  findApiKeyById(keyId: string): Promise<ApiKeyRecord | null>;
  /** Every key of a project, revoked included, oldest first. */
  listProjectApiKeys(projectId: string): Promise<ApiKeyRecord[]>;
  /** Origins listed on the active, unexpired keys of a project (one DB read, no local copy). */
  listActiveApiKeyOrigins(projectId: string): Promise<string[]>;
  /** Marks a key as used now. Best effort and throttled by the implementation. */
  touchApiKeyLastUsed(keyId: string): Promise<void>;
  getActiveRuleset(projectId: string): SecurityRulesetRecord | null;
  /** Authoritative PostgreSQL read; no cache. Use on every request path. */
  getActiveRulesetAsync(projectId: string): Promise<SecurityRulesetRecord | null>;
  getAuthConfig(projectId: string): ProjectAuthConfig | null;
  /** Authoritative PostgreSQL read; no cache. */
  getAuthConfigAsync(projectId: string): Promise<ProjectAuthConfig | null>;
  listAuthConfigs(): ProjectAuthConfig[];
  upsertAuthConfig(input: UpsertAuthConfigInput): MaybePromise<ProjectAuthConfig>;
  getPlatformAuthSettings(): PlatformAuthGlobalSettings;
  updatePlatformAuthSettings(
    input: UpdatePlatformAuthSettingsInput
  ): MaybePromise<PlatformAuthGlobalSettings>;
  /**
   * Durable, atomic per-day metering. The PostgreSQL store applies the deltas
   * with a single INSERT ... ON CONFLICT upsert (race-free across instances);
   * there is no in-process write buffer, so every caller must `await`.
   */
  incrementUsage(projectId: string, deltas?: UsageDeltas): MaybePromise<UsageDailyRecord>;

  recordAuditLog(input: RecordAuditLogInput): MaybePromise<AuditLogRecord>;
  createUser(input: CreateUserInput): MaybePromise<UserRecord>;

  /** Control-plane refresh sessions (realms: customer_console | super_admin). */
  createControlRefreshSession(
    input: CreateControlRefreshSessionInput
  ): MaybePromise<ControlRefreshSessionRecord>;
  getControlRefreshSessionByHash(hash: string): MaybePromise<ControlRefreshSessionRecord | null>;
  getControlRefreshSessionByPreviousHash(hash: string): MaybePromise<ControlRefreshSessionRecord | null>;
  rotateControlRefreshSession(
    id: string,
    oldHash: string,
    newAccessHash: string,
    newRefreshHash: string,
    accessExpiresAt: string,
    refreshExpiresAt: string
  ): MaybePromise<ControlRefreshSessionRecord>;
  revokeControlRefreshSessionsForUser(
    userId: string,
    reason: string,
    realm?: ControlAuthRealm
  ): MaybePromise<number>;
  listControlRefreshSessions(): MaybePromise<ControlRefreshSessionRecord[]>;

  /** Platform Super Admin privileges are opt-in and never set from signup payloads. */
  isPlatformSuperAdmin(userId: string): MaybePromise<boolean>;
  /** Authoritative PostgreSQL reads (no mirror). `null` when absent. */
  findUserById(userId: string): Promise<UserRecord | null>;
  /** Authoritative, case-insensitive lookup. Sign-up and sign-in decide on this, never on a cache. */
  findUserByEmail(email: string): Promise<UserRecord | null>;
  /** Raw project row regardless of status (callers decide how to treat suspended/deleted). */
  findProjectById(projectId: string): Promise<ProjectRecord | null>;
  setPlatformSuperAdmin(userId: string, value: boolean): MaybePromise<void>;

  createOrganization(input: CreateOrganizationInput): MaybePromise<OrganizationRecord>;
  createProject(input: CreateProjectInput): MaybePromise<ProjectResult>;
  registerApiKey(input: RegisterApiKeyInput): MaybePromise<ApiKeyRecord>;
  revokeApiKey(keyId: string, actorUserId?: string | null): MaybePromise<ApiKeyRecord>;
  publishSecurityRuleset(input: PublishSecurityRulesetInput): MaybePromise<SecurityRulesetRecord>;
  /** Synchronous mirror read used by the document engine inside batchWrite. */
  getRelationRules(projectId: string): ProjectRelationRuleRecord[];
  /** Current relation-rules version for a project (0 when none was ever written). */
  getRelationRulesVersion(projectId: string): number;
  getRelationRulesAsync(projectId: string): Promise<ProjectRelationRuleRecord[]>;
  getRelationRulesVersionAsync(projectId: string): Promise<number>;
  replaceRelationRules(input: ReplaceRelationRulesInput): MaybePromise<RelationRulesSnapshot>;
  listFeatureFlags(): MaybePromise<FeatureFlagRecord[]>;
  setFeatureFlag(input: SetFeatureFlagInput): MaybePromise<FeatureFlagRecord>;

  /** Optional on stores backed by durable PostgreSQL. */
  deleteFeatureFlag?(key: string, updatedBy?: string | null): MaybePromise<FeatureFlagRecord | null>;

  /** durable metering flush + read-cache refresh (PostgreSQL store). */
  flush?(): Promise<void>;
  refresh?(): Promise<void>;

  /** Releases pooled connections. No-op for the in-memory implementation. */
  close?(): Promise<void>;

  // ----- Security Fortress + Billing (contract §12.4) -----
  /** Append-only audit log, threat feed and circuit-breaker blocklist. */
  readonly security: SecurityRepository;
  /**
   * Durable auth throttles: sliding-window rate limits, the hourly signup
   * budget and MFA bad-code lockouts, shared by every API instance.
   */
  readonly throttle: ThrottleRepository;
  /** Locked plans, subscriptions, rollups, immutable ledger and invoices. */
  readonly billing: BillingRepository;

  // ----- V2 index recommendations (contract §2.8; implemented in phase 1B) -----
  /** Non-blocking, in-memory dedupe; flush at most once per 5s per fingerprint. */
  recordIndexRecommendation?(input: RecordIndexRecommendationInput): void;
  listIndexRecommendations?(projectId: string): Promise<IndexRecommendationRecord[]>;
  setIndexRecommendationStatus?(id: string, status: "applied" | "dismissed"): Promise<void>;
}

export const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
