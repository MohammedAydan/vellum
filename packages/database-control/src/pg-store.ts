/**
 * `packages/database-control/src/pg-store.ts`
 * PostgreSQL-backed Control Plane repository (`control_db`).
 *
 * ## Design
 * The public API server still has *synchronous* control-plane reads:
 * `@vellum/document-engine` calls `getActiveRuleset()` inside synchronous code
 * paths and the legacy `verifyApiKey()` reads `apiKeysByPrefix` directly.
 * Therefore this repository is **read-through-cached** for those metadata reads.
 * Metering is different: `incrementUsage()` is async and writes straight to
 * PostgreSQL with an atomic upsert — there is no in-process usage buffer.
 *
 *  - `initialize()` hydrates an in-process mirror of the control-plane tables
 *    (users, organizations, memberships, projects, api keys, rulesets,
 *    today's usage counters, recent audit logs, feature flags).
 *  - Reads are served from that mirror and stay synchronous.
 *  - Mutations are written to PostgreSQL **first** and then reflected in the mirror.
 *  - `refresh()` re-hydrates the mirror; `runMaintenanceWorkers()` calls it so
 *    cross-instance control-plane writes become visible within one worker tick.
 *
 * ## Known limitation (documented, not hidden)
 * The mirror is process-local. A control-plane write performed by instance A becomes
 * visible on instance B only after B's next `refresh()`. Control-plane writes are rare
 * and administrative, and document data never flows through this cache, so tenant data
 * isolation is unaffected. A `LISTEN/NOTIFY` invalidation channel is the follow-up.
 *
 * ## Data Plane
 * Nothing here touches customer documents. RLS and tenant isolation live in
 * `@vellum/storage` (`PgStorageAdapter` + `SET LOCAL app.current_project_id`).
 */

import crypto from "node:crypto";
import pg from "pg";
import { BoundedLruCache, VellumError } from "@vellum/core";
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
  createPgSecurityRepository,
  type SecurityRepository,
} from "./security-repository.js";
import { PgThrottleRepository, type ThrottleRepository } from "./throttle-repository.js";
import {
  createPgBillingRepository,
  type BillingRepository,
} from "./billing-repository.js";
import { iso, isoOrNull, asObject, mapAuthConfigRow, mapControlRefreshSession, mapPlatformAuthSettings } from "./pg-row-mappers.js";
import { redactConnectionString } from "./env-file.js";
import { validateRelationRuleInputs } from "./relation-rules.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STATEMENT_TIMEOUT_MS = 3_600_000;
const MAX_AUDIT_LOG_CACHE_LIMIT = 100_000;

export interface PgStoreLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface PgControlPlaneStoreOptions {
  connectionString?: string;
  pool?: pg.Pool;
  /** Per-transaction `SET LOCAL statement_timeout`. Defaults to 15000ms (remote-safe). */
  statementTimeoutMs?: number;
  /** Maximum number of audit-log rows mirrored in memory for the admin UI. */
  auditLogCacheLimit?: number;
  logger?: PgStoreLogger;
}

/**
 * V2 synchronous read-through caches (Zero-Redis). The in-process mirrors
 * below remain the authoritative read path; these bounded LRU layers only
 * shortcut repeated lookups of the two hottest keys:
 *   - active security ruleset by projectId
 *   - end-user auth config by projectId
 *
 * 2,000 entries / 10s TTL is enough for every project in a large
 * deployment while keeping memory hard-capped. Local writes delete the entry
 * synchronously, so an admin publish/upsert is reflected with 0ms staleness.
 * Cached values are the same objects already held by the mirrors — no secret
 * is stored in plaintext beyond what the mirror already holds.
 */
const SYNC_CACHE_MAX_ENTRIES = 2_000;
const SYNC_CACHE_TTL_MS = 10_000;

/** Throttle events outlive the longest window (signup budget, 1h) by a wide margin. */
const THROTTLE_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;

function safeCounterDelta(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function safeSignedDelta(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
}

function safeErrorReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactConnectionString(raw);
}

/**
 * Reconciles a `readonly Map` in place without clearing existing entries first,
 * so concurrent synchronous readers never see an empty map mid-refresh.
 */
const AUTH_CONFIG_COLUMNS = `id, project_id AS "projectId",
                auth_service_suspended AS "authServiceSuspended",
                suspension_reason AS "suspensionReason",
                max_users_quota AS "maxUsersQuota",
                max_signups_per_hour AS "maxSignupsPerHour",
                enable_email_password AS "enableEmailPassword",
                require_email_verification AS "requireEmailVerification",
                enable_anonymous_auth AS "enableAnonymousAuth",
                enable_totp_mfa AS "enableTotpMfa",
                enable_user_projection AS "enableUserProjection",
                projection_collection_path AS "projectionCollectionPath",
                password_min_length AS "passwordMinLength",
                password_require_uppercase AS "passwordRequireUppercase",
                password_require_number AS "passwordRequireNumber",
                password_require_symbol AS "passwordRequireSymbol",
                access_token_ttl_seconds AS "accessTokenTtlSeconds",
                refresh_token_ttl_days AS "refreshTokenTtlDays",
                jwt_key_id AS "jwtKeyId", jwt_public_key_pem AS "jwtPublicKeyPem",
                jwt_private_key_encrypted AS "jwtPrivateKeyEncrypted",
                oauth_providers AS "oauthProviders",
                custom_smtp_config_encrypted AS "customSmtpConfigEncrypted",
                created_at AS "createdAt", updated_at AS "updatedAt"`;

function reconcileMapInPlace<K, V>(target: Map<K, V>, next: Map<K, V>): void {
  for (const [key, value] of next) {
    target.set(key, value);
  }
  for (const key of target.keys()) {
    if (!next.has(key)) target.delete(key);
  }
}

/** 31-bit FNV-1a hash — used for advisory locks (stable within a deployment). */
function advisoryKey(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash & 0x7fffffff;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

const CP_SESSION_COLUMNS = `id, user_id AS "userId", realm,
  access_token_hash AS "accessTokenHash", refresh_token_hash AS "refreshTokenHash",
  previous_refresh_token_hash AS "previousRefreshTokenHash",
  rotated_at AS "rotatedAt", rotation_counter AS "rotationCounter",
  ip_address AS "ipAddress", user_agent AS "userAgent", revoked,
  revoked_reason AS "revokedReason", access_expires_at AS "accessExpiresAt",
  refresh_expires_at AS "refreshExpiresAt", created_at AS "createdAt",
  last_used_at AS "lastUsedAt"`;

export class PgControlPlaneStore implements ControlPlaneRepository {
  public readonly pool: pg.Pool;
  /** Security Fortress repository (audit chain, threats, blocklist). */
  public readonly security: SecurityRepository;
  /** Billing repository (plans, subscriptions, rollups, ledger, invoices). */
  public readonly billing: BillingRepository;
  /** Durable auth throttles (sliding windows, signup budget, MFA lockouts). */
  public readonly throttle: ThrottleRepository;
  private readonly ownsPool: boolean;
  private readonly statementTimeoutMs: number;
  private readonly auditLogCacheLimit: number;
  private readonly logger: PgStoreLogger | undefined;

  public readonly users = new Map<string, UserRecord>();
  public readonly organizations = new Map<string, OrganizationRecord>();
  public readonly organizationMembers = new Map<string, OrganizationMemberRecord>();
  public readonly projects = new Map<string, ProjectRecord>();
  // Swapped atomically during refresh so a key created between two refreshes
  // is never briefly invisible to `verifyApiKey` (which reads byPrefix).
  public apiKeysByPrefix = new Map<string, ApiKeyRecord>();
  public apiKeysById = new Map<string, ApiKeyRecord>();
  public readonly securityRulesets = new Map<string, SecurityRulesetRecord>();
  /** Active ruleset per project, keyed by projectId. */
  public readonly activeRulesetsByProject = new Map<string, SecurityRulesetRecord>();
  /** Relation rules per project (migration 0012), hydrated by refresh(). */
  public readonly relationRulesByProject = new Map<string, ProjectRelationRuleRecord[]>();
  /** Rule-set version per project (survives empty replacements). */
  public readonly relationRulesVersionByProject = new Map<string, number>();
  public readonly usageDaily = new Map<string, UsageDailyRecord>();
  public readonly auditLogs: AuditLogRecord[] = [];
  public readonly featureFlags = new Map<string, FeatureFlagRecord>();
  public readonly controlRefreshSessions = new Map<string, ControlRefreshSessionRecord>();
  // Swapped atomically in refresh() so a config written concurrently is never
  // briefly invisible to the synchronous auth hot path. Keyed by projectId.
  public authConfigsByProject = new Map<string, ProjectAuthConfig>();
  public platformAuthSettings: PlatformAuthGlobalSettings = {
    id: 1,
    globalSignupsEnabled: true,
    defaultMaxUsersPerFreeProject: 10000,
    defaultMaxUsersPerProProject: 250000,
    platformSmtpHost: null,
    platformSmtpPort: null,
    platformSmtpUser: null,
    platformSmtpPassEncrypted: null,
    platformSmtpFromEmail: "noreply@vellum.dev",
    updatedAt: new Date(0).toISOString(),
  };

  private readonly dirtyApiKeyLastUsed = new Set<string>();
  private writeChain: Promise<void> = Promise.resolve();
  private flushChain: Promise<void> = Promise.resolve();
  private refreshInFlight: Promise<void> | null = null;
  private initialized = false;
  private closed = false;

  /** V2 read-through caches; see SYNC_CACHE_* constants for sizing rationale. */
  private readonly activeRulesetCache = new BoundedLruCache<string, SecurityRulesetRecord>({
    maxEntries: SYNC_CACHE_MAX_ENTRIES,
    ttlMs: SYNC_CACHE_TTL_MS,
  });
  private readonly authConfigCache = new BoundedLruCache<string, ProjectAuthConfig>({
    maxEntries: SYNC_CACHE_MAX_ENTRIES,
    ttlMs: SYNC_CACHE_TTL_MS,
  });

  constructor(options: PgControlPlaneStoreOptions = {}) {
    this.wrapMutatorsToInvalidate();
    this.logger = options.logger;
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      const configuredConnectionString =
        options.connectionString ?? process.env["CONTROL_DATABASE_URL"];
      if (!configuredConnectionString && process.env["NODE_ENV"] === "production") {
        throw new Error("CONTROL_DATABASE_URL must be configured in production");
      }
      const connectionString =
        configuredConnectionString ??
        "postgresql://vellum_control:control_secret@localhost:5432/control_db";
      this.pool = new pg.Pool({
        connectionString,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 15_000,
        application_name: "vellum-control-plane",
      });
      this.pool.on("error", (err: unknown) => {
        this.logger?.warn("Idle PostgreSQL pool client error", {
          reason: safeErrorReason(err),
        });
      });
      this.ownsPool = true;
    }
    const rawTimeout = options.statementTimeoutMs ?? 15_000;
    this.statementTimeoutMs =
      typeof rawTimeout === "number" && Number.isFinite(rawTimeout)
        ? Math.min(MAX_STATEMENT_TIMEOUT_MS, Math.max(1, Math.floor(rawTimeout)))
        : 15_000;
    const rawAuditLimit = options.auditLogCacheLimit ?? 1_000;
    this.auditLogCacheLimit =
      typeof rawAuditLimit === "number" && Number.isFinite(rawAuditLimit)
        ? Math.min(MAX_AUDIT_LOG_CACHE_LIMIT, Math.max(1, Math.floor(rawAuditLimit)))
        : 1_000;
    // Pool is assigned above; field initializers cannot reference `this.pool`.
    this.security = createPgSecurityRepository(this.pool);
    this.billing = createPgBillingRepository(this.pool);
    this.throttle = new PgThrottleRepository(this.pool);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Verifies connectivity and hydrates the read cache. Safe to call repeatedly. */
  public async initialize(): Promise<void> {
    await this.pool.query("SELECT 1");
    await this.refresh();
    this.initialized = true;
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  /** Re-hydrates the in-process mirror from PostgreSQL. Concurrent calls coalesce. */
  public refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const run = this.executeRefresh().finally(() => {
      if (this.refreshInFlight === run) {
        this.refreshInFlight = null;
      }
    });
    this.refreshInFlight = run;
    return run;
  }

  private async executeRefresh(): Promise<void> {
    const refreshStartedAt = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

      const users = await client.query(
        `SELECT id, email, email_verified AS "emailVerified", name, avatar_url AS "avatarUrl",
                platform_role AS "platformRole", is_suspended AS "isSuspended",
                is_platform_super_admin AS "isPlatformSuperAdmin",
                created_at AS "createdAt", updated_at AS "updatedAt"
           FROM users`
      );
      const organizations = await client.query(
        `SELECT id, slug, name, billing_email AS "billingEmail", plan_id AS "planId", status,
                created_at AS "createdAt", updated_at AS "updatedAt"
           FROM organizations`
      );
      const members = await client.query(
        `SELECT organization_id AS "organizationId", user_id AS "userId", role, joined_at AS "joinedAt"
           FROM organization_members`
      );
      const projects = await client.query(
        `SELECT id, organization_id AS "organizationId", slug, name, status,
                cluster_id AS "clusterId", created_at AS "createdAt", updated_at AS "updatedAt"
           FROM projects`
      );
      const apiKeys = await client.query(
        `SELECT id, project_id AS "projectId", name,
                key_type AS "keyType", key_prefix AS "keyPrefix", secret_hash AS "secretHash",
                scopes, allowed_origins AS "allowedOrigins", allowed_ips AS "allowedIps",
                rate_limit_rps AS "rateLimitRps", last_used_at AS "lastUsedAt",
                expires_at AS "expiresAt", revoked_at AS "revokedAt", created_by AS "createdBy",
                created_at AS "createdAt"
           FROM api_keys`
      );
      const authConfigs = await client.query(
        `SELECT ${AUTH_CONFIG_COLUMNS}
           FROM project_auth_configs`
      );
      const globalSettings = await client.query(
        `SELECT id, global_signups_enabled AS "globalSignupsEnabled",
                default_max_users_per_free_project AS "defaultMaxUsersPerFreeProject",
                default_max_users_per_pro_project AS "defaultMaxUsersPerProProject",
                platform_smtp_host AS "platformSmtpHost",
                platform_smtp_port AS "platformSmtpPort",
                platform_smtp_user AS "platformSmtpUser",
                platform_smtp_pass_encrypted AS "platformSmtpPassEncrypted",
                platform_smtp_from_email AS "platformSmtpFromEmail",
                updated_at AS "updatedAt"
           FROM platform_auth_global_settings WHERE id = 1`
      );
      const rulesets = await client.query(
        `SELECT id, project_id AS "projectId", version,
                rules_ast AS "rulesAst", is_active AS "isActive", created_by AS "createdBy",
                created_at AS "createdAt"
           FROM security_rulesets
          ORDER BY version ASC`
      );
      const relationRules = await client.query(
        `SELECT id, project_id AS "projectId", collection, field,
                target_collection AS "targetCollection", on_delete AS "onDelete", version,
                created_at AS "createdAt", updated_at AS "updatedAt"
           FROM project_relation_rules
          ORDER BY collection ASC, field ASC`
      );
      const relationRulesMeta = await client.query(
        `SELECT project_id AS "projectId", version FROM project_relation_rules_meta`
      );
      const usage = await client.query(
        `SELECT project_id AS "projectId",
                usage_date::text AS "usageDate",
                document_reads::bigint AS "documentReads", document_writes::bigint AS "documentWrites",
                document_deletes::bigint AS "documentDeletes",
                realtime_messages_sent::bigint AS "realtimeMessagesSent",
                egress_bytes::bigint AS "egressBytes", storage_bytes::bigint AS "storageBytes",
                updated_at AS "updatedAt"
           FROM project_usage_daily`
      );
      const auditLogs = await client.query(
        `SELECT * FROM (
           SELECT id, actor_user_id AS "actorUserId", actor_type AS "actorType",
                  organization_id AS "organizationId", project_id AS "projectId", action,
                  target_id AS "targetId", metadata, ip_address AS "ipAddress",
                  user_agent AS "userAgent", created_at AS "createdAt"
             FROM audit_logs
            ORDER BY created_at DESC
            LIMIT $1
         ) recent ORDER BY "createdAt" ASC`,
        [this.auditLogCacheLimit]
      );
      const flags = await client.query(
        `SELECT key, description, enabled, rollout_percent AS "rolloutPercent",
                updated_at AS "updatedAt", updated_by AS "updatedBy"
           FROM feature_flags`
      );
      const controlRefreshSessions = await client.query(
        `SELECT ${CP_SESSION_COLUMNS} FROM control_plane_refresh_sessions`
      );

      await client.query("COMMIT");

      const nextUsers = new Map<string, UserRecord>();
      for (const row of users.rows as UserRecord[]) {
        nextUsers.set(row.id, { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
      }
      reconcileMapInPlace(this.users, nextUsers);

      const nextOrganizations = new Map<string, OrganizationRecord>();
      for (const row of organizations.rows as OrganizationRecord[]) {
        nextOrganizations.set(row.id, {
          ...row,
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
        });
      }
      reconcileMapInPlace(this.organizations, nextOrganizations);

      const nextMembers = new Map<string, OrganizationMemberRecord>();
      for (const row of members.rows as OrganizationMemberRecord[]) {
        nextMembers.set(`${row.organizationId}:${row.userId}`, {
          ...row,
          joinedAt: iso(row.joinedAt),
        });
      }
      reconcileMapInPlace(this.organizationMembers, nextMembers);

      const nextProjects = new Map<string, ProjectRecord>();
      for (const row of projects.rows as ProjectRecord[]) {
        nextProjects.set(row.id, { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
      }
      reconcileMapInPlace(this.projects, nextProjects);

      const nextKeysByPrefix = new Map<string, ApiKeyRecord>();
      const nextKeysById = new Map<string, ApiKeyRecord>();
      for (const row of apiKeys.rows as ApiKeyRecord[]) {
        const record: ApiKeyRecord = {
          ...row,
          scopes: Array.isArray(row.scopes) ? [...row.scopes] : [],
          lastUsedAt: isoOrNull(row.lastUsedAt),
          expiresAt: isoOrNull(row.expiresAt),
          revokedAt: isoOrNull(row.revokedAt),
          createdAt: iso(row.createdAt),
        };
        nextKeysById.set(record.id, record);
        if (record.revokedAt === null) {
          nextKeysByPrefix.set(record.keyPrefix, record);
        }
      }
      // Preserve keys registered while the snapshot query was in flight.
      for (const [prefix, record] of this.apiKeysByPrefix) {
        if (nextKeysByPrefix.has(prefix)) continue;
        if (record.revokedAt !== null) continue;
        const created = Date.parse(record.createdAt);
        if (Number.isFinite(created) && created >= refreshStartedAt - 1_000) {
          nextKeysByPrefix.set(prefix, record);
          nextKeysById.set(record.id, record);
        }
      }
      this.apiKeysById = nextKeysById;
      this.apiKeysByPrefix = nextKeysByPrefix;

      const nextRulesets = new Map<string, SecurityRulesetRecord>();
      const nextActiveRulesets = new Map<string, SecurityRulesetRecord>();
      for (const row of rulesets.rows as SecurityRulesetRecord[]) {
        const record: SecurityRulesetRecord = {
          ...row,
          rulesAst: asObject(row.rulesAst),
          createdAt: iso(row.createdAt),
        };
        nextRulesets.set(`${record.projectId}:${record.version}`, record);
        if (record.isActive) nextActiveRulesets.set(record.projectId, record);
      }
      reconcileMapInPlace(this.securityRulesets, nextRulesets);
      reconcileMapInPlace(this.activeRulesetsByProject, nextActiveRulesets);

      const nextRelationRules = new Map<string, ProjectRelationRuleRecord[]>();
      for (const row of relationRules.rows as ProjectRelationRuleRecord[]) {
        const record: ProjectRelationRuleRecord = {
          ...row,
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
        };
        const bucket = nextRelationRules.get(record.projectId);
        if (bucket) bucket.push(record);
        else nextRelationRules.set(record.projectId, [record]);
      }
      reconcileMapInPlace(this.relationRulesByProject, nextRelationRules);

      const nextRelationRulesVersions = new Map<string, number>();
      for (const row of relationRulesMeta.rows as Array<{ projectId: string; version: number }>) {
        nextRelationRulesVersions.set(row.projectId, Number(row.version));
      }
      reconcileMapInPlace(this.relationRulesVersionByProject, nextRelationRulesVersions);

      const nextUsage = new Map<string, UsageDailyRecord>();
      for (const row of usage.rows as UsageDailyRecord[]) {
        const record: UsageDailyRecord = {
          projectId: row.projectId,
          usageDate: String(row.usageDate),
          documentReads: Number(row.documentReads),
          documentWrites: Number(row.documentWrites),
          documentDeletes: Number(row.documentDeletes),
          realtimeMessagesSent: Number(row.realtimeMessagesSent),
          egressBytes: Number(row.egressBytes),
          storageBytes: Number(row.storageBytes),
          updatedAt: iso(row.updatedAt),
        };
        nextUsage.set(`${record.projectId}:${record.usageDate}`, record);
      }
      // Metering is written to PostgreSQL on every call, so the rows just
      // read are authoritative — no local delta overlay to re-apply.
      reconcileMapInPlace(this.usageDaily, nextUsage);

      this.auditLogs.length = 0;
      for (const row of auditLogs.rows as AuditLogRecord[]) {
        this.auditLogs.push({
          id: row.id,
          actorUserId: row.actorUserId,
          actorType: row.actorType,
          organizationId: row.organizationId,
          projectId: row.projectId,
          action: row.action,
          targetId: row.targetId,
          metadata: asObject(row.metadata),
          ipAddress: row.ipAddress,
          userAgent: row.userAgent,
          createdAt: iso(row.createdAt),
        });
      }

      const nextFlags = new Map<string, FeatureFlagRecord>();
      for (const row of flags.rows as FeatureFlagRecord[]) {
        nextFlags.set(row.key, { ...row, updatedAt: iso(row.updatedAt) });
      }
      reconcileMapInPlace(this.featureFlags, nextFlags);

      const nextSessions = new Map<string, ControlRefreshSessionRecord>();
      for (const row of controlRefreshSessions.rows as Record<string, unknown>[]) {
        const record = mapControlRefreshSession(row);
        nextSessions.set(record.id, record);
      }
      reconcileMapInPlace(this.controlRefreshSessions, nextSessions);

      const nextAuthConfigsByProject = new Map<string, ProjectAuthConfig>();
      for (const row of authConfigs.rows as Record<string, unknown>[]) {
        const record = mapAuthConfigRow(row);
        nextAuthConfigsByProject.set(record.projectId, record);
      }
      this.authConfigsByProject = nextAuthConfigsByProject;
      const settingsRow = globalSettings.rows[0] as Record<string, unknown> | undefined;
      if (settingsRow) this.platformAuthSettings = mapPlatformAuthSettings(settingsRow);

      // The mirrors were rebuilt from PostgreSQL; every cached object may be
      // stale (including a ruleset deactivated by another instance).
      this.activeRulesetCache.clear();
      this.authConfigCache.clear();
      this.invalidateReadCache();
    } catch (err: unknown) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore: the original failure is what matters.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.flush();
    } catch (err: unknown) {
      this.logger?.warn("Control plane flush on shutdown failed", {
        reason: safeErrorReason(err),
      });
    }
    this.activeRulesetCache.dispose();
    this.authConfigCache.dispose();
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  // ------------------------------------------------------------- transactions

  private async withTx<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${this.statementTimeoutMs}ms`,
      ]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (err: unknown) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback failures on broken sockets.
      }
      throw err;
    } finally {
      client.release();
    }
  }


  // ------------------------------------------------- short-TTL async read cache
  // Per-request hot-path reads (project, ruleset, auth config, relation rules, api key) are served from a
  // small in-process cache for a few seconds. Local mutations clear it at once; other instances see a change
  // after at most the TTL (CONTROL_READ_CACHE_TTL_MS, default 5000, 0 disables). Errors and null results are
  // never cached, so a new key or a suspended project is never "remembered" as missing.
  private readonly readCache = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly readInflight = new Map<string, Promise<unknown>>();
  private readonly readCacheTtlMs = (() => {
    const raw = Number(process.env["CONTROL_READ_CACHE_TTL_MS"] ?? 5000);
    return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
  })();
  private readCacheGeneration = 0;

  public invalidateReadCache(): void {
    this.readCacheGeneration += 1;
    this.readCache.clear();
    this.readInflight.clear();
  }

  private async readCached<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.readCacheTtlMs === 0) return load();
    const hit = this.readCache.get(key);
    if (hit !== undefined && hit.expiresAt > Date.now()) return structuredClone(hit.value) as T;
    const pending = this.readInflight.get(key);
    if (pending !== undefined) return (pending as Promise<T>).then((v) => (v === null ? v : (structuredClone(v) as T)));
    const generation = this.readCacheGeneration;
    const p = load()
      .then((value) => {
        if (value !== null && generation === this.readCacheGeneration) {
          while (this.readCache.size >= 1000) {
            const oldest = this.readCache.keys().next().value;
            if (oldest === undefined) break;
            this.readCache.delete(oldest);
          }
          this.readCache.set(key, { value, expiresAt: Date.now() + this.readCacheTtlMs });
        }
        return value;
      })
      .then((value) => (value === null ? value : (structuredClone(value) as T)))
      .finally(() => {
        if (this.readInflight.get(key) === p) this.readInflight.delete(key);
      });
    this.readInflight.set(key, p);
    return p;
  }

  private wrapMutatorsToInvalidate(): void {
    const self = this as unknown as Record<string, unknown>;
    for (const name of [
      "registerApiKey", "revokeApiKey", "publishSecurityRuleset", "replaceRelationRules", "upsertAuthConfig", "createProject",
    ]) {
      const original = self[name] as ((...a: unknown[]) => unknown) | undefined;
      if (typeof original !== "function") continue;
      self[name] = async (...a: unknown[]) => {
        this.invalidateReadCache();
        try {
          return await original.apply(this, a);
        } finally {
          this.invalidateReadCache();
        }
      };
    }
  }

  // ------------------------------------------------------------- sync reads

  private static readonly UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** Authoritative project read from PostgreSQL (no mirror, no cache). */
  public getProjectAsync(projectId: string): Promise<ProjectResult> {
    return this.readCached("getProjectAsync:" + projectId, () => this.getProjectAsyncUncached(projectId));
  }

  private async getProjectAsyncUncached(projectId: string): Promise<ProjectResult> {
    if (!PgControlPlaneStore.UUID_RE.test(projectId)) {
      throw new VellumError("NOT_FOUND", `Project '${projectId}' not found`);
    }
    const { rows } = await this.pool.query(
      `SELECT id, organization_id AS "organizationId", slug, name, status,
              cluster_id AS "clusterId", created_at AS "createdAt", updated_at AS "updatedAt"
         FROM projects WHERE id = $1::uuid`,
      [projectId]
    );
    const row = rows[0] as ProjectRecord | undefined;
    if (!row || row.status === "deleted") {
      throw new VellumError("NOT_FOUND", `Project '${projectId}' not found`);
    }
    if (row.status === "suspended") {
      throw new VellumError("PERMISSION_DENIED", `Project '${projectId}' is currently suspended`);
    }
    return { project: { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) } };
  }

  /** Authoritative active-ruleset read (unique partial index idx_active_ruleset_per_project). */
  public getActiveRulesetAsync(projectId: string): Promise<SecurityRulesetRecord | null> {
    return this.readCached("getActiveRulesetAsync:" + projectId, () => this.getActiveRulesetAsyncUncached(projectId));
  }

  private async getActiveRulesetAsyncUncached(projectId: string): Promise<SecurityRulesetRecord | null> {
    if (!PgControlPlaneStore.UUID_RE.test(projectId)) return null;
    const { rows } = await this.pool.query(
      `SELECT id, project_id AS "projectId", version, rules_ast AS "rulesAst",
              is_active AS "isActive", created_by AS "createdBy", created_at AS "createdAt"
         FROM security_rulesets WHERE project_id = $1::uuid AND is_active = true LIMIT 1`,
      [projectId]
    );
    const row = rows[0] as SecurityRulesetRecord | undefined;
    return row ? { ...row, rulesAst: asObject(row.rulesAst), createdAt: iso(row.createdAt) } : null;
  }

  public getAuthConfigAsync(projectId: string): Promise<ProjectAuthConfig | null> {
    return this.readCached("getAuthConfigAsync:" + projectId, () => this.getAuthConfigAsyncUncached(projectId));
  }

  private async getAuthConfigAsyncUncached(projectId: string): Promise<ProjectAuthConfig | null> {
    if (!PgControlPlaneStore.UUID_RE.test(projectId)) return null;
    const { rows } = await this.pool.query(
      `SELECT ${AUTH_CONFIG_COLUMNS} FROM project_auth_configs WHERE project_id = $1::uuid`,
      [projectId]
    );
    return rows[0] ? mapAuthConfigRow(rows[0] as Record<string, unknown>) : null;
  }

  public getRelationRulesVersionAsync(projectId: string): Promise<number> {
    return this.readCached("getRelationRulesVersionAsync:" + projectId, () => this.getRelationRulesVersionAsyncUncached(projectId));
  }

  private async getRelationRulesVersionAsyncUncached(projectId: string): Promise<number> {
    if (!PgControlPlaneStore.UUID_RE.test(projectId)) return 0;
    const { rows } = await this.pool.query(
      `SELECT version FROM project_relation_rules_meta WHERE project_id = $1::uuid`,
      [projectId]
    );
    return rows[0] ? Number((rows[0] as { version: number }).version) : 0;
  }

  public getRelationRulesAsync(projectId: string): Promise<ProjectRelationRuleRecord[]> {
    return this.readCached("getRelationRulesAsync:" + projectId, () => this.getRelationRulesAsyncUncached(projectId));
  }

  private async getRelationRulesAsyncUncached(projectId: string): Promise<ProjectRelationRuleRecord[]> {
    if (!PgControlPlaneStore.UUID_RE.test(projectId)) return [];
    const { rows } = await this.pool.query(
      `SELECT id, project_id AS "projectId", collection, field,
              target_collection AS "targetCollection", on_delete AS "onDelete", version,
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM project_relation_rules WHERE project_id = $1::uuid
        ORDER BY collection ASC, field ASC`,
      [projectId]
    );
    return (rows as ProjectRelationRuleRecord[]).map((r) => ({
      ...r,
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
    }));
  }

  public getProject(projectId: string): ProjectResult {
    const project = this.projects.get(projectId);
    if (!project || project.status === "deleted") {
      throw new VellumError("NOT_FOUND", `Project '${projectId}' not found`);
    }
    if (project.status === "suspended") {
      throw new VellumError("PERMISSION_DENIED", `Project '${projectId}' is currently suspended`);
    }
    return { project };
  }

  public getApiKey(keyId: string): ApiKeyRecord | undefined {
    return this.apiKeysById.get(keyId);
  }

  public getApiKeyByPrefix(prefix: string): ApiKeyRecord | null {
    return this.apiKeysByPrefix.get(prefix) ?? null;
  }

  private static readonly API_KEY_COLUMNS = `id, project_id AS "projectId", name,
                key_type AS "keyType", key_prefix AS "keyPrefix", secret_hash AS "secretHash",
                scopes, allowed_origins AS "allowedOrigins", allowed_ips AS "allowedIps",
                rate_limit_rps AS "rateLimitRps", last_used_at AS "lastUsedAt",
                expires_at AS "expiresAt", revoked_at AS "revokedAt", created_by AS "createdBy",
                created_at AS "createdAt"`;

  private static apiKeyFromRow(row: ApiKeyRecord): ApiKeyRecord {
    return {
      ...row,
      scopes: Array.isArray(row.scopes) ? [...row.scopes] : [],
      allowedOrigins: Array.isArray(row.allowedOrigins) ? [...row.allowedOrigins] : [],
      allowedIps: Array.isArray(row.allowedIps) ? [...row.allowedIps] : [],
      lastUsedAt: isoOrNull(row.lastUsedAt),
      expiresAt: isoOrNull(row.expiresAt),
      revokedAt: isoOrNull(row.revokedAt),
      createdAt: iso(row.createdAt),
    };
  }

  public async findApiKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT ${PgControlPlaneStore.API_KEY_COLUMNS} FROM api_keys WHERE key_prefix = $1 AND revoked_at IS NULL LIMIT 1`,
      [prefix]
    );
    return rows[0] ? PgControlPlaneStore.apiKeyFromRow(rows[0] as ApiKeyRecord) : null;
  }

  public async findApiKeyById(keyId: string): Promise<ApiKeyRecord | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(keyId)) return null;
    const { rows } = await this.pool.query(
      `SELECT ${PgControlPlaneStore.API_KEY_COLUMNS} FROM api_keys WHERE id = $1::uuid`,
      [keyId]
    );
    return rows[0] ? PgControlPlaneStore.apiKeyFromRow(rows[0] as ApiKeyRecord) : null;
  }

  public async listProjectApiKeys(projectId: string): Promise<ApiKeyRecord[]> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) return [];
    const { rows } = await this.pool.query(
      `SELECT ${PgControlPlaneStore.API_KEY_COLUMNS} FROM api_keys WHERE project_id = $1::uuid ORDER BY created_at ASC`,
      [projectId]
    );
    return (rows as ApiKeyRecord[]).map((row) => PgControlPlaneStore.apiKeyFromRow(row));
  }

  public async listActiveApiKeyOrigins(projectId: string): Promise<string[]> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) return [];
    const { rows } = await this.pool.query(
      `SELECT DISTINCT o.origin
         FROM api_keys k, jsonb_array_elements_text(k.allowed_origins) AS o(origin)
        WHERE k.project_id = $1::uuid AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > now())
          AND jsonb_typeof(k.allowed_origins) = 'array'`,
      [projectId]
    );
    return rows.map((r: { origin: string }) => r.origin);
  }

  public async touchApiKeyLastUsed(keyId: string): Promise<void> {
    await this.pool.query(
      `UPDATE api_keys SET last_used_at = now()
        WHERE id = $1::uuid AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`,
      [keyId]
    );
  }

  /** Synchronous read-through: cache -> in-process mirror. */
  public getActiveRuleset(projectId: string): SecurityRulesetRecord | null {
    const cached = this.activeRulesetCache.get(projectId);
    if (cached !== undefined) return cached;
    const record = this.activeRulesetsByProject.get(projectId) ?? null;
    if (record !== null) this.activeRulesetCache.set(projectId, record);
    return record;
  }

  /**
   * Durable, atomic metering: one INSERT ... ON CONFLICT upsert applies the
   * deltas under a row lock, so concurrent API instances never lose counts and
   * no 5-second write-behind window can drop them on a crash. The local mirror
   * is updated from the RETURNING row so synchronous readers stay fresh.
   */
  public async incrementUsage(projectId: string, deltas: UsageDeltas = {}): Promise<UsageDailyRecord> {
    const usageDate = new Date().toISOString().slice(0, 10);
    const key = `${projectId}:${usageDate}`;
    const reads = safeCounterDelta(deltas.documentReads);
    const writes = safeCounterDelta(deltas.documentWrites);
    const deletes = safeCounterDelta(deltas.documentDeletes);
    const realtime = safeCounterDelta(deltas.realtimeMessagesSent);
    const egress = safeCounterDelta(deltas.egressBytes);
    const storageDelta = safeSignedDelta(deltas.storageBytesDelta);

    if (!UUID_RE.test(projectId)) {
      // The old flush-time guard, kept: non-UUID project ids (offline/test
      // fixtures) have no row to upsert, so only the mirror moves.
      this.logger?.warn("Skipping durable metering for a non-UUID project identifier", {
        projectId,
      });
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
      current.documentReads += reads;
      current.documentWrites += writes;
      current.documentDeletes += deletes;
      current.realtimeMessagesSent += realtime;
      current.egressBytes += egress;
      current.storageBytes = Math.max(0, current.storageBytes + storageDelta);
      current.updatedAt = new Date().toISOString();
      this.usageDaily.set(key, current);
      return current;
    }

    const { rows } = await this.pool.query(
      `INSERT INTO project_usage_daily (
         project_id, usage_date, document_reads, document_writes, document_deletes,
         realtime_messages_sent, egress_bytes, storage_bytes, updated_at
       )
       VALUES ($1::uuid, $2::date, $3, $4, $5, $6, $7, GREATEST(0, $8::bigint), now())
       ON CONFLICT (project_id, usage_date) DO UPDATE SET
         document_reads = project_usage_daily.document_reads + EXCLUDED.document_reads,
         document_writes = project_usage_daily.document_writes + EXCLUDED.document_writes,
         document_deletes = project_usage_daily.document_deletes + EXCLUDED.document_deletes,
         realtime_messages_sent =
           project_usage_daily.realtime_messages_sent + EXCLUDED.realtime_messages_sent,
         egress_bytes = project_usage_daily.egress_bytes + EXCLUDED.egress_bytes,
         storage_bytes = GREATEST(0, project_usage_daily.storage_bytes + $8::bigint),
         updated_at = now()
       RETURNING project_id AS "projectId", usage_date::text AS "usageDate",
                 document_reads AS "documentReads", document_writes AS "documentWrites",
                 document_deletes AS "documentDeletes",
                 realtime_messages_sent AS "realtimeMessagesSent",
                 egress_bytes AS "egressBytes", storage_bytes AS "storageBytes",
                 updated_at AS "updatedAt"`,
      [projectId, usageDate, reads, writes, deletes, realtime, egress, storageDelta]
    );
    const row = rows[0] as UsageDailyRecord;
    const record: UsageDailyRecord = {
      projectId: row.projectId,
      usageDate: String(row.usageDate),
      documentReads: Number(row.documentReads),
      documentWrites: Number(row.documentWrites),
      documentDeletes: Number(row.documentDeletes),
      realtimeMessagesSent: Number(row.realtimeMessagesSent),
      egressBytes: Number(row.egressBytes),
      storageBytes: Number(row.storageBytes),
      updatedAt: iso(row.updatedAt),
    };
    this.usageDaily.set(key, record);
    return record;
  }

  /** Records that an API key authenticated a request (flushed by `flush()`). */
  public touchApiKey(keyId: string): void {
    const record = this.apiKeysById.get(keyId);
    if (!record) return;
    record.lastUsedAt = new Date().toISOString();
    this.dirtyApiKeyLastUsed.add(keyId);
  }

  // ------------------------------------------------------------- flush

  /** Persists dirty API-key `last_used_at` timestamps and prunes expired throttle rows. */
  public flush(): Promise<void> {
    const work = this.flushChain.then(() => this.executeFlush());
    this.flushChain = work.then(
      () => undefined,
      () => undefined
    );
    return work;
  }

  private async executeFlush(): Promise<void> {
    // Drop throttle rows that can never count again: rate-limit events past
    // the retention horizon and expired MFA lockout counters.
    try {
      await this.throttle.pruneExpiredThrottleState(THROTTLE_EVENT_RETENTION_MS);
    } catch (err: unknown) {
      this.logger?.warn("Throttle state pruning failed", {
        reason: safeErrorReason(err),
      });
    }

    const dirtyKeys = Array.from(this.dirtyApiKeyLastUsed);
    this.dirtyApiKeyLastUsed.clear();
    const validDirtyKeys = dirtyKeys.filter((id) => UUID_RE.test(id));
    if (validDirtyKeys.length > 0) {
      try {
        await this.pool.query(
          `UPDATE api_keys SET last_used_at = now() WHERE id = ANY($1::uuid[])`,
          [validDirtyKeys]
        );
      } catch (err: unknown) {
        for (const id of validDirtyKeys) {
          this.dirtyApiKeyLastUsed.add(id);
        }
        this.logger?.warn("API key last_used_at flush failed", {
          reason: safeErrorReason(err),
        });
      }
    }

    await this.writeChain;
  }

  // ------------------------------------------------------------- mutations

  public async createUser({
    email,
    name,
    platformRole = "customer",
    emailVerified = true,
  }: CreateUserInput): Promise<UserRecord> {
    const id = crypto.randomUUID();
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO users (id, email, email_verified, name, platform_role)
         VALUES ($1::uuid, $2, $3, $4, $5)
         RETURNING id, email, email_verified AS "emailVerified", name, avatar_url AS "avatarUrl",
                   platform_role AS "platformRole", is_suspended AS "isSuspended",
                   is_platform_super_admin AS "isPlatformSuperAdmin",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [id, email, emailVerified, name, platformRole]
      );
      const row = rows[0] as UserRecord;
      const record: UserRecord = {
        ...row,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      };
      this.users.set(record.id, record);
      return record;
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new VellumError("ALREADY_EXISTS", `User with email '${email}' already exists`);
      }
      throw err;
    }
  }

  // ------------------------------------------ control-plane refresh sessions

  public async createControlRefreshSession(
    input: CreateControlRefreshSessionInput
  ): Promise<ControlRefreshSessionRecord> {
    if (input.realm !== "customer_console" && input.realm !== "super_admin") {
      throw new VellumError("INVALID_ARGUMENT", `Invalid control auth realm '${String(input.realm)}'`);
    }
    const { rows } = await this.pool.query(
      `INSERT INTO control_plane_refresh_sessions (
         id, user_id, realm, access_token_hash, refresh_token_hash,
         previous_refresh_token_hash, ip_address, user_agent,
         access_expires_at, refresh_expires_at
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz
       )
       RETURNING ${CP_SESSION_COLUMNS}`,
      [
        crypto.randomUUID(),
        input.userId,
        input.realm,
        input.accessTokenHash,
        input.refreshTokenHash,
        input.previousRefreshTokenHash ?? null,
        input.ipAddress ?? null,
        input.userAgent ?? null,
        input.accessExpiresAt,
        input.refreshExpiresAt,
      ]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new VellumError("INTERNAL_ERROR", "Control refresh session insert returned no row");
    }
    const record = mapControlRefreshSession(row);
    this.controlRefreshSessions.set(record.id, record);
    return record;
  }

  public async getControlRefreshSessionByHash(
    hash: string
  ): Promise<ControlRefreshSessionRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT ${CP_SESSION_COLUMNS} FROM control_plane_refresh_sessions
        WHERE refresh_token_hash = $1 OR access_token_hash = $1
        LIMIT 1`,
      [hash]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapControlRefreshSession(row) : null;
  }

  public async getControlRefreshSessionByPreviousHash(
    hash: string
  ): Promise<ControlRefreshSessionRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT ${CP_SESSION_COLUMNS} FROM control_plane_refresh_sessions
        WHERE previous_refresh_token_hash = $1
        LIMIT 1`,
      [hash]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? mapControlRefreshSession(row) : null;
  }

  public async rotateControlRefreshSession(
    id: string,
    oldHash: string,
    newAccessHash: string,
    newRefreshHash: string,
    accessExpiresAt: string,
    refreshExpiresAt: string
  ): Promise<ControlRefreshSessionRecord> {
    const { rows } = await this.pool.query(
      `UPDATE control_plane_refresh_sessions SET
         access_token_hash = $3,
         refresh_token_hash = $4,
         previous_refresh_token_hash = $2,
         rotated_at = now(),
         rotation_counter = rotation_counter + 1,
         access_expires_at = $5::timestamptz,
         refresh_expires_at = $6::timestamptz,
         last_used_at = now()
       WHERE id = $1::uuid AND refresh_token_hash = $2 AND revoked = FALSE
       RETURNING ${CP_SESSION_COLUMNS}`,
      [id, oldHash, newAccessHash, newRefreshHash, accessExpiresAt, refreshExpiresAt]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new VellumError("UNAUTHENTICATED", "Session rotation failed");
    const record = mapControlRefreshSession(row);
    this.controlRefreshSessions.set(record.id, record);
    return record;
  }

  public async revokeControlRefreshSessionsForUser(
    userId: string,
    reason: string,
    realm?: ControlAuthRealm
  ): Promise<number> {
    const { rows } = await this.pool.query(
      `UPDATE control_plane_refresh_sessions
          SET revoked = TRUE, revoked_reason = $2
        WHERE user_id = $1 AND revoked = FALSE
          AND ($3::text IS NULL OR realm = $3)
        RETURNING id`,
      [userId, reason, realm ?? null]
    );
    for (const session of this.controlRefreshSessions.values()) {
      if (
        session.userId === userId &&
        !session.revoked &&
        (realm === undefined || session.realm === realm)
      ) {
        session.revoked = true;
        session.revokedReason = reason;
      }
    }
    return rows.length;
  }

  public listControlRefreshSessions(): ControlRefreshSessionRecord[] {
    return Array.from(this.controlRefreshSessions.values(), (session) => ({ ...session }));
  }

  // ------------------------------------------ platform super-admin privileges

  /** Authoritative: a demotion or suspension applies on the next request on every instance. */
  public async isPlatformSuperAdmin(userId: string): Promise<boolean> {
    const user = await this.findUserById(userId);
    return user !== null && user.isPlatformSuperAdmin === true && !user.isSuspended;
  }

  public async findUserById(userId: string): Promise<UserRecord | null> {
    if (!PgControlPlaneStore.UUID_RE.test(userId)) return null;
    const { rows } = await this.pool.query(
      `SELECT id, email, email_verified AS "emailVerified", name, avatar_url AS "avatarUrl",
              platform_role AS "platformRole", is_suspended AS "isSuspended",
              is_platform_super_admin AS "isPlatformSuperAdmin",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM users WHERE id = $1::uuid`,
      [userId]
    );
    const row = rows[0] as UserRecord | undefined;
    return row ? { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) } : null;
  }

  public async findUserByEmail(email: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT id, email, email_verified AS "emailVerified", name, avatar_url AS "avatarUrl",
              platform_role AS "platformRole", is_suspended AS "isSuspended",
              is_platform_super_admin AS "isPlatformSuperAdmin",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM users WHERE LOWER(email) = $1 LIMIT 1`,
      [email.trim().toLowerCase()]
    );
    const row = rows[0] as UserRecord | undefined;
    return row ? { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) } : null;
  }

  public async findProjectById(projectId: string): Promise<ProjectRecord | null> {
    if (!PgControlPlaneStore.UUID_RE.test(projectId)) return null;
    const { rows } = await this.pool.query(
      `SELECT id, organization_id AS "organizationId", slug, name, status,
              cluster_id AS "clusterId", created_at AS "createdAt", updated_at AS "updatedAt"
         FROM projects WHERE id = $1::uuid`,
      [projectId]
    );
    const row = rows[0] as ProjectRecord | undefined;
    return row ? { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) } : null;
  }

  public async setPlatformSuperAdmin(userId: string, value: boolean): Promise<void> {
    const { rows } = await this.pool.query(
      `UPDATE users SET is_platform_super_admin = $2, updated_at = now()
        WHERE id = $1::uuid
        RETURNING id, updated_at AS "updatedAt"`,
      [userId, value]
    );
    const row = rows[0] as { id?: string; updatedAt?: unknown } | undefined;
    if (!row) throw new VellumError("NOT_FOUND", `User '${userId}' not found`);
    const cached = this.users.get(userId);
    if (cached) {
      cached.isPlatformSuperAdmin = value;
      cached.updatedAt = iso(row.updatedAt);
    }
  }

  public async createOrganization({
    slug,
    name,
    billingEmail,
    ownerUserId = null,
    planId = "free",
  }: CreateOrganizationInput): Promise<OrganizationRecord> {
    if (!ORGANIZATION_SLUG_PATTERN.test(slug)) {
      throw new VellumError("INVALID_ARGUMENT", `Invalid organization slug '${slug}'`);
    }
    const id = crypto.randomUUID();
    const record = await this.withTx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO organizations (id, slug, name, billing_email, plan_id)
         VALUES ($1::uuid, $2, $3, $4, $5)
         RETURNING id, slug, name, billing_email AS "billingEmail", plan_id AS "planId", status,
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [id, slug, name, billingEmail, planId]
      );
      const row = rows[0] as OrganizationRecord;
      if (ownerUserId) {
        await client.query(
          `INSERT INTO organization_members (organization_id, user_id, role)
           VALUES ($1::uuid, $2::uuid, 'owner')
           ON CONFLICT (organization_id, user_id) DO NOTHING`,
          [id, ownerUserId]
        );
      }
      return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
    }).catch((err: unknown) => {
      if (isUniqueViolation(err)) {
        throw new VellumError("ALREADY_EXISTS", `Organization slug '${slug}' already exists`);
      }
      throw err;
    });

    this.organizations.set(record.id, record);
    if (ownerUserId) {
      this.organizationMembers.set(`${record.id}:${ownerUserId}`, {
        organizationId: record.id,
        userId: ownerUserId,
        role: "owner",
        joinedAt: record.createdAt,
      });
    }
    return record;
  }

  public async createProject({
    organizationId,
    slug,
    name,
    actorUserId = null,
  }: CreateProjectInput): Promise<ProjectResult> {
    if (!this.organizations.has(organizationId)) {
      throw new VellumError("NOT_FOUND", `Organization '${organizationId}' not found`);
    }
    const projectId = crypto.randomUUID();

    const outcome = await this.withTx(async (client) => {
      const orgCheck = await client.query("SELECT 1 FROM organizations WHERE id = $1::uuid", [
        organizationId,
      ]);
      if (orgCheck.rowCount === 0) {
        throw new VellumError("NOT_FOUND", `Organization '${organizationId}' not found`);
      }

      const { rows: projectRows } = await client.query(
        `INSERT INTO projects (id, organization_id, slug, name)
         VALUES ($1::uuid, $2::uuid, $3, $4)
         RETURNING id, organization_id AS "organizationId", slug, name, status,
                   cluster_id AS "clusterId", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [projectId, organizationId, slug, name]
      );
      const projectRow = projectRows[0] as ProjectRecord;

      const auditId = crypto.randomUUID();
      const { rows: auditRows } = await client.query(
        `INSERT INTO audit_logs (
           id, actor_user_id, actor_type, organization_id, project_id, action, target_id, metadata
         ) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, 'project.created', $6::text, $7::jsonb)
         RETURNING id, actor_user_id AS "actorUserId", actor_type AS "actorType",
                   organization_id AS "organizationId", project_id AS "projectId", action,
                   target_id AS "targetId", metadata, ip_address AS "ipAddress",
                   user_agent AS "userAgent", created_at AS "createdAt"`,
        [
          auditId,
          actorUserId,
          actorUserId ? "user" : "system",
          organizationId,
          projectId,
          projectId,
          JSON.stringify({ slug, name }),
        ]
      );

      return {
        project: {
          ...projectRow,
          createdAt: iso(projectRow.createdAt),
          updatedAt: iso(projectRow.updatedAt),
        },
        auditRow: auditRows[0] as AuditLogRecord,
      };
    }).catch((err: unknown) => {
      if (isUniqueViolation(err)) {
        throw new VellumError(
          "ALREADY_EXISTS",
          `Project slug '${slug}' already exists in organization '${organizationId}'`
        );
      }
      throw err;
    });

    this.projects.set(outcome.project.id, outcome.project);
    this.pushAuditCache({
      ...outcome.auditRow,
      metadata: asObject(outcome.auditRow.metadata),
      createdAt: iso(outcome.auditRow.createdAt),
    });

    return { project: outcome.project };
  }

  public async registerApiKey({
    projectId,
    name,
    keyType,
    keyPrefix,
    secretHash,
    scopes = ["documents:read", "documents:write"],
    rateLimitRps = 100,
    expiresAt = null,
    createdBy = null,
  }: RegisterApiKeyInput): Promise<ApiKeyRecord> {
    const id = crypto.randomUUID();
    const clonedScopes = Array.isArray(scopes) ? [...scopes] : [];
    const safeRateLimit = Number.isFinite(rateLimitRps) && rateLimitRps >= 0 ? rateLimitRps : 100;
    let record: ApiKeyRecord;
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO api_keys (
           id, project_id, name, key_type, key_prefix, secret_hash,
           scopes, rate_limit_rps, expires_at, created_by
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::text[], $8, $9::timestamptz, $10::uuid)
         RETURNING id, project_id AS "projectId", name,
                   key_type AS "keyType", key_prefix AS "keyPrefix", secret_hash AS "secretHash",
                   scopes, allowed_origins AS "allowedOrigins", allowed_ips AS "allowedIps",
                rate_limit_rps AS "rateLimitRps", last_used_at AS "lastUsedAt",
                   expires_at AS "expiresAt", revoked_at AS "revokedAt", created_by AS "createdBy",
                   created_at AS "createdAt"`,
        [
          id,
          projectId,
          name,
          keyType,
          keyPrefix,
          secretHash,
          clonedScopes,
          safeRateLimit,
          expiresAt,
          createdBy,
        ]
      );
      const row = rows[0] as ApiKeyRecord;
      record = {
        ...row,
        scopes: Array.isArray(row.scopes) ? [...row.scopes] : [],
        lastUsedAt: isoOrNull(row.lastUsedAt),
        expiresAt: isoOrNull(row.expiresAt),
        revokedAt: isoOrNull(row.revokedAt),
        createdAt: iso(row.createdAt),
      };
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new VellumError("ALREADY_EXISTS", `API key prefix '${keyPrefix}' already exists`);
      }
      throw err;
    }

    this.apiKeysById.set(record.id, record);
    this.apiKeysByPrefix.set(record.keyPrefix, record);
    await this.recordAuditLog({
      actorUserId: createdBy,
      actorType: createdBy ? "user" : "system",
      projectId,
      action: "api_key.created",
      targetId: record.id,
      metadata: { keyPrefix, keyType, scopes: [...clonedScopes] },
    });
    return record;
  }

  public async revokeApiKey(keyId: string, actorUserId: string | null = null): Promise<ApiKeyRecord> {
    const { rows } = await this.pool.query(
      `UPDATE api_keys SET revoked_at = now()
        WHERE id = $1::uuid
        RETURNING id, project_id AS "projectId", name,
                  key_type AS "keyType", key_prefix AS "keyPrefix", secret_hash AS "secretHash",
                  scopes, allowed_origins AS "allowedOrigins", allowed_ips AS "allowedIps",
                rate_limit_rps AS "rateLimitRps", last_used_at AS "lastUsedAt",
                  expires_at AS "expiresAt", revoked_at AS "revokedAt", created_by AS "createdBy",
                  created_at AS "createdAt"`,
      [keyId]
    );
    const row = rows[0] as ApiKeyRecord | undefined;
    if (!row) {
      throw new VellumError("NOT_FOUND", `API key '${keyId}' not found`);
    }
    const record: ApiKeyRecord = {
      ...row,
      scopes: Array.isArray(row.scopes) ? [...row.scopes] : [],
      lastUsedAt: isoOrNull(row.lastUsedAt),
      expiresAt: isoOrNull(row.expiresAt),
      revokedAt: isoOrNull(row.revokedAt),
      createdAt: iso(row.createdAt),
    };
    this.apiKeysById.set(record.id, record);
    this.apiKeysByPrefix.delete(record.keyPrefix);
    this.dirtyApiKeyLastUsed.delete(record.id);

    await this.recordAuditLog({
      actorUserId,
      actorType: actorUserId ? "user" : "system",
      projectId: record.projectId,
      action: "api_key.revoked",
      targetId: keyId,
      metadata: { keyPrefix: record.keyPrefix },
    });
    return record;
  }

  public async publishSecurityRuleset({
    projectId,
    rulesAst,
    createdBy = null,
  }: PublishSecurityRulesetInput): Promise<SecurityRulesetRecord> {
    const id = crypto.randomUUID();
    const lockKey = advisoryKey(projectId);
    const sanitizedAst = asObject(rulesAst);

    const record = await this.withTx(async (client) => {
      // Serialise concurrent publishes for the same project.
      await client.query("SELECT pg_advisory_xact_lock($1::int, 7)", [lockKey]);
      await client.query(
        `UPDATE security_rulesets SET is_active = FALSE
          WHERE project_id = $1::uuid AND is_active = TRUE`,
        [projectId]
      );
      const { rows } = await client.query(
        `INSERT INTO security_rulesets (id, project_id, version, rules_ast, is_active, created_by)
         VALUES (
           $1::uuid, $2::uuid,
           (SELECT COALESCE(MAX(version), 0) + 1 FROM security_rulesets WHERE project_id = $2::uuid),
           $3::jsonb, TRUE, $4::uuid
         )
         RETURNING id, project_id AS "projectId", version,
                   rules_ast AS "rulesAst", is_active AS "isActive", created_by AS "createdBy",
                   created_at AS "createdAt"`,
        [id, projectId, JSON.stringify(sanitizedAst), createdBy]
      );
      return rows[0] as SecurityRulesetRecord;
    });

    const normalized: SecurityRulesetRecord = {
      ...record,
      rulesAst: asObject(record.rulesAst),
      createdAt: iso(record.createdAt),
    };
    this.securityRulesets.set(`${normalized.projectId}:${normalized.version}`, normalized);
    for (const existing of this.securityRulesets.values()) {
      if (existing.projectId === normalized.projectId && existing.id !== normalized.id) {
        existing.isActive = false;
      }
    }
    this.activeRulesetsByProject.set(normalized.projectId, normalized);
    // Local publish must be visible on the very next synchronous read.
    this.activeRulesetCache.delete(normalized.projectId);

    await this.recordAuditLog({
      actorUserId: createdBy,
      actorType: createdBy ? "user" : "system",
      projectId,
      action: "ruleset.published",
      targetId: normalized.id,
      metadata: { version: normalized.version },
    });
    return normalized;
  }

  /** Synchronous mirror read used by the document engine inside batchWrite. */
  public getRelationRules(projectId: string): ProjectRelationRuleRecord[] {
    return this.relationRulesByProject.get(projectId) ?? [];
  }

  public getRelationRulesVersion(projectId: string): number {
    return this.relationRulesVersionByProject.get(projectId) ?? 0;
  }

  public async replaceRelationRules({
    projectId,
    rules,
    expectedVersion = null,
    createdBy = null,
  }: ReplaceRelationRulesInput): Promise<RelationRulesSnapshot> {
    const validated = validateRelationRuleInputs(rules);
    const lockKey = advisoryKey(projectId);

    const snapshot = await this.withTx(async (client) => {
      // Serialise concurrent replacements for the same project.
      await client.query("SELECT pg_advisory_xact_lock($1::int, 9)", [lockKey]);
      const { rows: metaRows } = await client.query(
        `INSERT INTO project_relation_rules_meta (project_id, version)
         VALUES ($1::uuid, 0)
         ON CONFLICT (project_id) DO NOTHING
         RETURNING version`,
        [projectId]
      );
      let currentVersion: number;
      if (metaRows.length > 0) {
        currentVersion = Number((metaRows[0] as { version: number }).version);
      } else {
        const { rows: existing } = await client.query(
          `SELECT version FROM project_relation_rules_meta WHERE project_id = $1::uuid`,
          [projectId]
        );
        currentVersion = Number((existing[0] as { version: number }).version);
      }
      if (expectedVersion !== null && expectedVersion !== currentVersion) {
        throw new VellumError(
          "ABORTED_CONFLICT",
          `Relation rules version conflict: expected ${expectedVersion}, current ${currentVersion}`
        );
      }
      const version = currentVersion + 1;
      await client.query(
        `UPDATE project_relation_rules_meta SET version = $2, updated_at = now()
         WHERE project_id = $1::uuid`,
        [projectId, version]
      );
      await client.query(`DELETE FROM project_relation_rules WHERE project_id = $1::uuid`, [
        projectId,
      ]);
      const inserted: ProjectRelationRuleRecord[] = [];
      for (const rule of validated) {
        const { rows } = await client.query(
          `INSERT INTO project_relation_rules
             (project_id, collection, field, target_collection, on_delete, version)
           VALUES ($1::uuid, $2, $3, $4, $5, $6)
           RETURNING id, project_id AS "projectId", collection, field,
                     target_collection AS "targetCollection", on_delete AS "onDelete", version,
                     created_at AS "createdAt", updated_at AS "updatedAt"`,
          [projectId, rule.collection, rule.field, rule.targetCollection ?? null, rule.onDelete, version]
        );
        inserted.push(rows[0] as ProjectRelationRuleRecord);
      }
      return { version, inserted };
    });

    const now = new Date().toISOString();
    const records: ProjectRelationRuleRecord[] = snapshot.inserted.map((record) => ({
      ...record,
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
    }));
    this.relationRulesByProject.set(projectId, records);
    this.relationRulesVersionByProject.set(projectId, snapshot.version);

    await this.recordAuditLog({
      actorUserId: createdBy,
      actorType: createdBy ? "user" : "system",
      projectId,
      action: "relation_rules.replaced",
      targetId: projectId,
      metadata: { version: snapshot.version, ruleCount: records.length },
    });
    return { projectId, version: snapshot.version, rules: records, updatedAt: now };
  }

  public recordAuditLog({
    actorUserId = null,
    actorType = "system",
    organizationId = null,
    projectId = null,
    action,
    targetId = null,
    metadata = {},
    ipAddress = null,
    userAgent = null,
  }: RecordAuditLogInput): Promise<AuditLogRecord> {
    const log: AuditLogRecord = {
      id: crypto.randomUUID(),
      actorUserId,
      actorType,
      organizationId,
      projectId,
      action,
      targetId,
      metadata: asObject(metadata),
      ipAddress,
      userAgent,
      createdAt: new Date().toISOString(),
    };
    // Serialised so that audit ordering matches call order even under concurrency.
    const write = this.writeChain.then(async () => {
      await this.pool.query(
        `INSERT INTO audit_logs (
           id, actor_user_id, actor_type, organization_id, project_id, action, target_id,
           metadata, ip_address, user_agent, created_at
         ) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7, $8::jsonb, $9, $10, $11::timestamptz)`,
        [
          log.id,
          log.actorUserId,
          log.actorType,
          log.organizationId,
          log.projectId,
          log.action,
          log.targetId,
          JSON.stringify(log.metadata),
          log.ipAddress,
          log.userAgent,
          log.createdAt,
        ]
      );
      this.pushAuditCache(log);
    });
    // Keep the chain alive even when an individual write fails.
    this.writeChain = write.then(
      () => undefined,
      () => undefined
    );
    return write.then(() => log);
  }

  public async listFeatureFlags(): Promise<FeatureFlagRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT key, description, enabled, rollout_percent AS "rolloutPercent",
              updated_at AS "updatedAt", updated_by AS "updatedBy"
         FROM feature_flags
        ORDER BY key ASC`
    );
    const flags = (rows as FeatureFlagRecord[]).map((row) => ({ ...row, updatedAt: iso(row.updatedAt) }));
    const nextFlags = new Map<string, FeatureFlagRecord>();
    for (const flag of flags) nextFlags.set(flag.key, flag);
    reconcileMapInPlace(this.featureFlags, nextFlags);
    return flags;
  }

  public async setFeatureFlag({
    key,
    description = "",
    enabled,
    rolloutPercent = 100,
    updatedBy = null,
  }: SetFeatureFlagInput): Promise<FeatureFlagRecord> {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key)) {
      throw new VellumError("INVALID_ARGUMENT", `Invalid feature flag key '${key}'`);
    }
    if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
      throw new VellumError(
        "INVALID_ARGUMENT",
        `Feature flag rolloutPercent must be an integer between 0 and 100 (received ${rolloutPercent})`
      );
    }
    const { rows } = await this.pool.query(
      `INSERT INTO feature_flags (key, description, enabled, rollout_percent, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5::uuid, now())
       ON CONFLICT (key) DO UPDATE SET
         description = EXCLUDED.description,
         enabled = EXCLUDED.enabled,
         rollout_percent = EXCLUDED.rollout_percent,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING key, description, enabled, rollout_percent AS "rolloutPercent",
                 updated_at AS "updatedAt", updated_by AS "updatedBy"`,
      [key, description, enabled, rolloutPercent, updatedBy]
    );
    const row = rows[0] as FeatureFlagRecord;
    const record: FeatureFlagRecord = { ...row, updatedAt: iso(row.updatedAt) };
    this.featureFlags.set(record.key, record);
    return record;
  }

  /**
   * durable feature-flag deletion. Returns the removed record, or
   * `null` when the key did not exist. The in-process mirror is updated only
   * after PostgreSQL confirms the delete.
   */
  public async deleteFeatureFlag(
    key: string,
    _updatedBy: string | null = null
  ): Promise<FeatureFlagRecord | null> {
    const { rows } = await this.pool.query(
      `DELETE FROM feature_flags WHERE key = $1
        RETURNING key, description, enabled, rollout_percent AS "rolloutPercent",
                  updated_at AS "updatedAt", updated_by AS "updatedBy"`,
      [key]
    );
    const row = rows[0] as FeatureFlagRecord | undefined;
    if (!row) {
      this.featureFlags.delete(key);
      return null;
    }
    const record: FeatureFlagRecord = { ...row, updatedAt: iso(row.updatedAt) };
    this.featureFlags.delete(record.key);
    return record;
  }

  // ------------------------------------------------------------- end-user auth config

  /** Synchronous read-through: cache -> in-process mirror. */
  public getAuthConfig(projectId: string): ProjectAuthConfig | null {
    const cached = this.authConfigCache.get(projectId);
    if (cached !== undefined) return cached;
    const record = this.authConfigsByProject.get(projectId) ?? null;
    if (record !== null) this.authConfigCache.set(projectId, record);
    return record;
  }

  public listAuthConfigs(): ProjectAuthConfig[] {
    return Array.from(this.authConfigsByProject.values());
  }

  public async upsertAuthConfig(
    input: UpsertAuthConfigInput
  ): Promise<ProjectAuthConfig> {
    const existing = this.getAuthConfig(input.projectId);
    const resolved = {
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
      oauthProviders: asObject(input.oauthProviders ?? existing?.oauthProviders),
      customSmtpConfigEncrypted: input.customSmtpConfigEncrypted !== undefined
        ? input.customSmtpConfigEncrypted
        : (existing?.customSmtpConfigEncrypted ?? null),
    };

    const record = await this.withTx(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO project_auth_configs (
           id, project_id, auth_service_suspended, suspension_reason,
           max_users_quota, max_signups_per_hour, enable_email_password,
           require_email_verification, enable_anonymous_auth, enable_totp_mfa,
           enable_user_projection, projection_collection_path, password_min_length,
           password_require_uppercase, password_require_number, password_require_symbol,
           access_token_ttl_seconds, refresh_token_ttl_days, jwt_key_id,
           jwt_public_key_pem, jwt_private_key_encrypted, oauth_providers,
           custom_smtp_config_encrypted, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13, $14, $15, $16, $17, $18, $19, $20, $21, $22::jsonb, $23, now(), now()
         )
         ON CONFLICT (project_id) DO UPDATE SET
           auth_service_suspended = EXCLUDED.auth_service_suspended,
           suspension_reason = EXCLUDED.suspension_reason,
           max_users_quota = EXCLUDED.max_users_quota,
           max_signups_per_hour = EXCLUDED.max_signups_per_hour,
           enable_email_password = EXCLUDED.enable_email_password,
           require_email_verification = EXCLUDED.require_email_verification,
           enable_anonymous_auth = EXCLUDED.enable_anonymous_auth,
           enable_totp_mfa = EXCLUDED.enable_totp_mfa,
           enable_user_projection = EXCLUDED.enable_user_projection,
           projection_collection_path = EXCLUDED.projection_collection_path,
           password_min_length = EXCLUDED.password_min_length,
           password_require_uppercase = EXCLUDED.password_require_uppercase,
           password_require_number = EXCLUDED.password_require_number,
           password_require_symbol = EXCLUDED.password_require_symbol,
           access_token_ttl_seconds = EXCLUDED.access_token_ttl_seconds,
           refresh_token_ttl_days = EXCLUDED.refresh_token_ttl_days,
           jwt_key_id = EXCLUDED.jwt_key_id,
           jwt_public_key_pem = EXCLUDED.jwt_public_key_pem,
           jwt_private_key_encrypted = EXCLUDED.jwt_private_key_encrypted,
           oauth_providers = EXCLUDED.oauth_providers,
           custom_smtp_config_encrypted = EXCLUDED.custom_smtp_config_encrypted,
           updated_at = now()
         RETURNING id, project_id AS "projectId",
           auth_service_suspended AS "authServiceSuspended", suspension_reason AS "suspensionReason",
           max_users_quota AS "maxUsersQuota", max_signups_per_hour AS "maxSignupsPerHour",
           enable_email_password AS "enableEmailPassword",
           require_email_verification AS "requireEmailVerification",
           enable_anonymous_auth AS "enableAnonymousAuth", enable_totp_mfa AS "enableTotpMfa",
           enable_user_projection AS "enableUserProjection",
           projection_collection_path AS "projectionCollectionPath",
           password_min_length AS "passwordMinLength",
           password_require_uppercase AS "passwordRequireUppercase",
           password_require_number AS "passwordRequireNumber",
           password_require_symbol AS "passwordRequireSymbol",
           access_token_ttl_seconds AS "accessTokenTtlSeconds",
           refresh_token_ttl_days AS "refreshTokenTtlDays", jwt_key_id AS "jwtKeyId",
           jwt_public_key_pem AS "jwtPublicKeyPem",
           jwt_private_key_encrypted AS "jwtPrivateKeyEncrypted",
           oauth_providers AS "oauthProviders",
           custom_smtp_config_encrypted AS "customSmtpConfigEncrypted",
           created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          existing?.id ?? crypto.randomUUID(),
          input.projectId,
          resolved.authServiceSuspended,
          resolved.suspensionReason,
          resolved.maxUsersQuota,
          resolved.maxSignupsPerHour,
          resolved.enableEmailPassword,
          resolved.requireEmailVerification,
          resolved.enableAnonymousAuth,
          resolved.enableTotpMfa,
          resolved.enableUserProjection,
          resolved.projectionCollectionPath,
          resolved.passwordMinLength,
          resolved.passwordRequireUppercase,
          resolved.passwordRequireNumber,
          resolved.passwordRequireSymbol,
          resolved.accessTokenTtlSeconds,
          resolved.refreshTokenTtlDays,
          input.jwtKeyId,
          input.jwtPublicKeyPem,
          input.jwtPrivateKeyEncrypted,
          JSON.stringify(resolved.oauthProviders),
          resolved.customSmtpConfigEncrypted,
        ]
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new VellumError("INTERNAL_ERROR", "Auth config upsert returned no row");
      return mapAuthConfigRow(row);
    });

    this.authConfigsByProject.set(record.projectId, record);
    // Local upsert must be visible on the very next synchronous read.
    this.authConfigCache.delete(record.projectId);
    return record;
  }

  public getPlatformAuthSettings(): PlatformAuthGlobalSettings {
    return { ...this.platformAuthSettings };
  }

  public async updatePlatformAuthSettings(
    input: UpdatePlatformAuthSettingsInput
  ): Promise<PlatformAuthGlobalSettings> {
    const record = await this.withTx(async (client) => {
      const { rows } = await client.query(
        `UPDATE platform_auth_global_settings SET
           global_signups_enabled = COALESCE($1, global_signups_enabled),
           default_max_users_per_free_project = COALESCE($2, default_max_users_per_free_project),
           default_max_users_per_pro_project = COALESCE($3, default_max_users_per_pro_project),
           platform_smtp_host = COALESCE($4, platform_smtp_host),
           platform_smtp_port = COALESCE($5, platform_smtp_port),
           platform_smtp_user = COALESCE($6, platform_smtp_user),
           platform_smtp_pass_encrypted = COALESCE($7, platform_smtp_pass_encrypted),
           platform_smtp_from_email = COALESCE($8, platform_smtp_from_email),
           updated_at = now()
         WHERE id = 1
         RETURNING id, global_signups_enabled AS "globalSignupsEnabled",
           default_max_users_per_free_project AS "defaultMaxUsersPerFreeProject",
           default_max_users_per_pro_project AS "defaultMaxUsersPerProProject",
           platform_smtp_host AS "platformSmtpHost", platform_smtp_port AS "platformSmtpPort",
           platform_smtp_user AS "platformSmtpUser",
           platform_smtp_pass_encrypted AS "platformSmtpPassEncrypted",
           platform_smtp_from_email AS "platformSmtpFromEmail", updated_at AS "updatedAt"`,
        [
          input.globalSignupsEnabled ?? null,
          input.defaultMaxUsersPerFreeProject ?? null,
          input.defaultMaxUsersPerProProject ?? null,
          input.platformSmtpHost ?? null,
          input.platformSmtpPort ?? null,
          input.platformSmtpUser ?? null,
          input.platformSmtpPassEncrypted ?? null,
          input.platformSmtpFromEmail ?? null,
        ]
      );
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new VellumError("NOT_FOUND", "Platform auth settings row not initialized");
      return mapPlatformAuthSettings(row);
    });
    this.platformAuthSettings = record;
    return { ...record };
  }

  // ------------------------------------------------------------- internals

  private pushAuditCache(log: AuditLogRecord): void {
    this.auditLogs.push(log);
    if (this.auditLogs.length > this.auditLogCacheLimit) {
      this.auditLogs.splice(0, this.auditLogs.length - this.auditLogCacheLimit);
    }
  }
}
