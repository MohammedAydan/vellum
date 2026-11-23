/**
 * `packages/database-control/src/schema.ts`
 * Production Drizzle ORM Schema for Control Plane Database (`control_db`)
 * Matches Specification Section 5 100%.
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  date,
  timestamp,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  platformRole: text("platform_role").notNull().default("customer"),
  isSuspended: boolean("is_suspended").notNull().default(false),
  isPlatformSuperAdmin: boolean("is_platform_super_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  billingEmail: text("billing_email").notNull(),
  planId: text("plan_id").notNull().default("free"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.organizationId, table.userId] }),
  })
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    clusterId: text("cluster_id").notNull().default("cluster_shared_01"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgSlugUnique: uniqueIndex("uq_projects_org_slug").on(table.organizationId, table.slug),
  })
);

/**
 * The project is the sole tenant boundary. All metadata below is keyed by
 * `project_id` only (migration 0011).
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyType: text("key_type").notNull(),
    keyPrefix: text("key_prefix").notNull().unique(),
    secretHash: text("secret_hash").notNull(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`ARRAY['documents:read', 'documents:write']::text[]`),
    rateLimitRps: integer("rate_limit_rps").notNull().default(100),
    /** V1 §2.4: browser origins allowed to use this key (empty = no restriction). */
    allowedOrigins: jsonb("allowed_origins").notNull().default([]),
    /** V1 §2.4: source IPs allowed to use this key (empty = no restriction). */
    allowedIps: jsonb("allowed_ips").notNull().default([]),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lookupIdx: index("idx_api_keys_lookup")
      .on(table.keyPrefix)
      .where(sql`${table.revokedAt} IS NULL`),
  })
);

export const securityRulesets = pgTable(
  "security_rulesets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    rulesAst: jsonb("rules_ast").notNull(),
    isActive: boolean("is_active").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectVersionUnique: uniqueIndex("uq_ruleset_project_version").on(table.projectId, table.version),
    activePerProjectUnique: uniqueIndex("idx_active_ruleset_per_project")
      .on(table.projectId)
      .where(sql`${table.isActive} = TRUE`),
  })
);

export const projectUsageDaily = pgTable(
  "project_usage_daily",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    usageDate: date("usage_date").notNull(),
    documentReads: bigint("document_reads", { mode: "number" }).notNull().default(0),
    documentWrites: bigint("document_writes", { mode: "number" }).notNull().default(0),
    documentDeletes: bigint("document_deletes", { mode: "number" }).notNull().default(0),
    realtimeMessagesSent: bigint("realtime_messages_sent", { mode: "number" }).notNull().default(0),
    egressBytes: bigint("egress_bytes", { mode: "number" }).notNull().default(0),
    storageBytes: bigint("storage_bytes", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.usageDate] }),
  })
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    actorType: text("actor_type").notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id),
    projectId: uuid("project_id").references(() => projects.id),
    action: text("action").notNull(),
    targetId: text("target_id"),
    metadata: jsonb("metadata").notNull().default({}),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectCreatedIdx: index("idx_audit_logs_project").on(table.projectId, table.createdAt),
  })
);

/**
 * End-user auth configuration per project (control_db only).
 * Secrets are AES-256-GCM encrypted at rest; end-user rows live in data_db.
 */
export const projectAuthConfigs = pgTable(
  "project_auth_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().unique(),
    authServiceSuspended: boolean("auth_service_suspended").notNull().default(false),
    suspensionReason: text("suspension_reason"),
    maxUsersQuota: integer("max_users_quota").notNull().default(50000),
    maxSignupsPerHour: integer("max_signups_per_hour").notNull().default(1000),
    enableEmailPassword: boolean("enable_email_password").notNull().default(true),
    requireEmailVerification: boolean("require_email_verification").notNull().default(false),
    enableAnonymousAuth: boolean("enable_anonymous_auth").notNull().default(false),
    enableTotpMfa: boolean("enable_totp_mfa").notNull().default(true),
    enableUserProjection: boolean("enable_user_projection").notNull().default(true),
    projectionCollectionPath: text("projection_collection_path").notNull().default("users"),
    passwordMinLength: integer("password_min_length").notNull().default(8),
    passwordRequireUppercase: boolean("password_require_uppercase").notNull().default(false),
    passwordRequireNumber: boolean("password_require_number").notNull().default(true),
    passwordRequireSymbol: boolean("password_require_symbol").notNull().default(false),
    accessTokenTtlSeconds: integer("access_token_ttl_seconds").notNull().default(3600),
    refreshTokenTtlDays: integer("refresh_token_ttl_days").notNull().default(30),
    jwtKeyId: text("jwt_key_id").notNull(),
    jwtPublicKeyPem: text("jwt_public_key_pem").notNull(),
    jwtPrivateKeyEncrypted: text("jwt_private_key_encrypted").notNull(),
    oauthProviders: jsonb("oauth_providers").$type<Record<string, unknown>>().notNull().default({}),
    customSmtpConfigEncrypted: text("custom_smtp_config_encrypted"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdx: index("idx_auth_configs_project").on(table.projectId),
  })
);

export type ProjectAuthConfigRow = typeof projectAuthConfigs.$inferSelect;
export type NewProjectAuthConfigRow = typeof projectAuthConfigs.$inferInsert;

/**
 * Durable refresh sessions for the two control-plane realms
 * (`customer_console` and `super_admin`). Mirrors migration
 * `0005_three_realm_auth_isolation.sql` exactly. Token hashes are SHA-256 hex
 * strings computed by callers — raw tokens and secrets never reach this table.
 */
export const controlPlaneRefreshSessions = pgTable(
  "control_plane_refresh_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    realm: text("realm").notNull(),
    accessTokenHash: text("access_token_hash").notNull().unique(),
    refreshTokenHash: text("refresh_token_hash").notNull().unique(),
    previousRefreshTokenHash: text("previous_refresh_token_hash"),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    rotationCounter: integer("rotation_counter").notNull().default(0),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    revoked: boolean("revoked").notNull().default(false),
    revokedReason: text("revoked_reason"),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userRealmIdx: index("idx_cp_sessions_user_realm")
      .on(table.userId, table.realm)
      .where(sql`${table.revoked} = FALSE`),
    refreshIdx: index("idx_cp_sessions_refresh").on(table.refreshTokenHash),
    prevRefreshIdx: index("idx_cp_sessions_prev_refresh")
      .on(table.previousRefreshTokenHash)
      .where(sql`${table.previousRefreshTokenHash} IS NOT NULL`),
    realmCheck: check(
      "control_plane_refresh_sessions_realm_check",
      sql`${table.realm} IN ('customer_console', 'super_admin')`
    ),
  })
);

export type ControlPlaneRefreshSessionRow = typeof controlPlaneRefreshSessions.$inferSelect;
export type NewControlPlaneRefreshSessionRow = typeof controlPlaneRefreshSessions.$inferInsert;

export const platformAuthGlobalSettings = pgTable("platform_auth_global_settings", {
  id: integer("id").primaryKey().default(1),
  globalSignupsEnabled: boolean("global_signups_enabled").notNull().default(true),
  defaultMaxUsersPerFreeProject: integer("default_max_users_per_free_project").notNull().default(10000),
  defaultMaxUsersPerProProject: integer("default_max_users_per_pro_project").notNull().default(250000),
  platformSmtpHost: text("platform_smtp_host"),
  platformSmtpPort: integer("platform_smtp_port"),
  platformSmtpUser: text("platform_smtp_user"),
  platformSmtpPassEncrypted: text("platform_smtp_pass_encrypted"),
  platformSmtpFromEmail: text("platform_smtp_from_email").notNull().default("noreply@vellum.dev"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PlatformAuthGlobalSettingsRow = typeof platformAuthGlobalSettings.$inferSelect;
export type NewPlatformAuthGlobalSettingsRow = typeof platformAuthGlobalSettings.$inferInsert;

// ---------------------------------------------------------------------------
// Security Fortress + Billing (migrations 0007 / 0008).
// These tables live strictly in control_db. They never hold document payloads.
// ---------------------------------------------------------------------------

/** Append-only, HMAC-SHA256 hash-chained security audit log. */
export const securityAuditLogs = pgTable(
  "security_audit_logs",
  {
    seq: bigint("seq", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    id: uuid("id").notNull().defaultRandom().unique(),
    actorRealm: text("actor_realm").notNull(),
    actorId: text("actor_id"),
    orgId: uuid("org_id"),
    projectId: uuid("project_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    outcome: text("outcome").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    details: jsonb("details").notNull().default({}),
    prevHash: text("prev_hash").notNull(),
    entryHash: text("entry_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgTimeIdx: index("idx_audit_logs_org_time").on(table.orgId, table.createdAt.desc()),
    actionTimeIdx: index("idx_audit_logs_action_time").on(table.action, table.createdAt.desc()),
  })
);

/** Real-time anomaly / threat alerts consumed by the super-admin command center. */
export const securityThreatEvents = pgTable(
  "security_threat_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    severity: text("severity").notNull(),
    category: text("category").notNull(),
    sourceIp: text("source_ip"),
    actorId: text("actor_id"),
    orgId: uuid("org_id"),
    projectId: uuid("project_id"),
    summary: text("summary").notNull(),
    evidence: jsonb("evidence").notNull().default({}),
    autoMitigated: boolean("auto_mitigated").notNull().default(false),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusTimeIdx: index("idx_threat_events_status_time").on(table.status, table.createdAt.desc()),
  })
);

/** Circuit-breaker blocklist (IP / API key / org / project). */
export const securityBlocklist = pgTable(
  "security_blocklist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    targetType: text("target_type").notNull(),
    targetValue: text("target_value").notNull(),
    reason: text("reason").notNull(),
    createdBy: text("created_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    targetKey: uniqueIndex("security_blocklist_target_key").on(table.targetType, table.targetValue),
    activeIdx: index("idx_blocklist_active")
      .on(table.targetType, table.targetValue)
      .where(sql`${table.active} = TRUE`),
  })
);

/** Locked platform plans. Money is integer cents; overage rates are integer cents per unit. */
export const billingPlans = pgTable("billing_plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  monthlyBasePriceCents: integer("monthly_base_price_cents").notNull(),
  includedDocReads: bigint("included_doc_reads", { mode: "number" }).notNull(),
  includedDocWrites: bigint("included_doc_writes", { mode: "number" }).notNull(),
  includedDocDeletes: bigint("included_doc_deletes", { mode: "number" }).notNull(),
  includedStorageBytes: bigint("included_storage_bytes", { mode: "number" }).notNull(),
  includedEgressBytes: bigint("included_egress_bytes", { mode: "number" }).notNull(),
  includedAuthMau: integer("included_auth_mau").notNull(),
  maxConcurrentWs: integer("max_concurrent_ws").notNull(),
  overageReadPer100kCents: integer("overage_read_per_100k_cents").notNull().default(0),
  overageWritePer100kCents: integer("overage_write_per_100k_cents").notNull().default(0),
  overageDeletePer100kCents: integer("overage_delete_per_100k_cents").notNull().default(0),
  overageStoragePerGbCents: integer("overage_storage_per_gb_cents").notNull().default(0),
  overageEgressPerGbCents: integer("overage_egress_per_gb_cents").notNull().default(0),
  overageMauPer1kCents: integer("overage_mau_per_1k_cents").notNull().default(0),
  hardLimitEnforced: boolean("hard_limit_enforced").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per org. monthly_spend_cap_cents = NULL means no hard cap. */
export const orgSubscriptions = pgTable("org_subscriptions", {
  orgId: uuid("org_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  planId: text("plan_id").notNull().default("free").references(() => billingPlans.id),
  status: text("status").notNull().default("active"),
  monthlySpendCapCents: integer("monthly_spend_cap_cents"),
  billingEmail: text("billing_email"),
  externalCustomerId: text("external_customer_id"),
  externalSubscriptionId: text("external_subscription_id"),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull().default(sql`date_trunc('month', now())`),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull().default(sql`date_trunc('month', now()) + interval '1 month'`),
  quotaOverride: jsonb("quota_override").notNull().default({}),
  alert80SentAt: timestamp("alert_80_sent_at", { withTimezone: true }),
  alert95SentAt: timestamp("alert_95_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Async-flusher-only monthly billing rollup (never written from the request path). */
export const usageMonthlyRollups = pgTable(
  "usage_monthly_rollups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    projectId: uuid("project_id").notNull(),
    billingMonth: text("billing_month").notNull(),
    docReads: bigint("doc_reads", { mode: "number" }).notNull().default(0),
    docWrites: bigint("doc_writes", { mode: "number" }).notNull().default(0),
    docDeletes: bigint("doc_deletes", { mode: "number" }).notNull().default(0),
    storageBytes: bigint("storage_bytes", { mode: "number" }).notNull().default(0),
    egressBytes: bigint("egress_bytes", { mode: "number" }).notNull().default(0),
    authMau: bigint("auth_mau", { mode: "number" }).notNull().default(0),
    peakConcurrentWs: integer("peak_concurrent_ws").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantMonthKey: uniqueIndex("usage_monthly_rollups_unique")
      .on(table.orgId, table.projectId, table.billingMonth),
    orgMonthIdx: index("idx_usage_monthly_org").on(table.orgId, table.billingMonth),
  })
);

/** Async-flusher-only daily billing rollup. */
export const usageDailyRollups = pgTable(
  "usage_daily_rollups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    projectId: uuid("project_id").notNull(),
    usageDate: text("usage_date").notNull(),
    docReads: bigint("doc_reads", { mode: "number" }).notNull().default(0),
    docWrites: bigint("doc_writes", { mode: "number" }).notNull().default(0),
    docDeletes: bigint("doc_deletes", { mode: "number" }).notNull().default(0),
    egressBytes: bigint("egress_bytes", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantDateKey: uniqueIndex("usage_daily_rollups_unique")
      .on(table.orgId, table.projectId, table.usageDate),
    orgDateIdx: index("idx_usage_daily_org_date").on(table.orgId, table.usageDate.desc()),
  })
);

/** Append-only, HMAC-SHA256 hash-chained double-entry billing ledger. */
export const billingLedgerEntries = pgTable(
  "billing_ledger_entries",
  {
    seq: bigint("seq", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    id: uuid("id").notNull().defaultRandom().unique(),
    orgId: uuid("org_id").notNull(),
    billingMonth: text("billing_month").notNull(),
    entryType: text("entry_type").notNull(),
    amountCents: integer("amount_cents").notNull().default(0),
    metricSnapshot: jsonb("metric_snapshot").notNull().default({}),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    description: text("description").notNull(),
    prevHash: text("prev_hash").notNull(),
    entryHash: text("entry_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgMonthIdx: index("idx_billing_ledger_org_month").on(table.orgId, table.billingMonth, table.seq.desc()),
  })
);

/** Monthly invoices, one per org per billing month. */
export const billingInvoices = pgTable(
  "billing_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceNumber: text("invoice_number").notNull().unique(),
    orgId: uuid("org_id").notNull(),
    billingMonth: text("billing_month").notNull(),
    planId: text("plan_id").notNull(),
    baseAmountCents: integer("base_amount_cents").notNull(),
    overageAmountCents: integer("overage_amount_cents").notNull(),
    creditsAppliedCents: integer("credits_applied_cents").notNull().default(0),
    totalAmountCents: integer("total_amount_cents").notNull(),
    lineItems: jsonb("line_items").notNull().default([]),
    status: text("status").notNull().default("draft"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgMonthKey: uniqueIndex("billing_invoices_org_month_unique").on(table.orgId, table.billingMonth),
  })
);

/** Payment-provider webhook idempotency / replay protection. */
export const billingWebhookEvents = pgTable("billing_webhook_events", {
  eventId: text("event_id").primaryKey(),
  provider: text("provider").notNull(),
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});
