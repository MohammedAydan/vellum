/**
 * `packages/database-data/src/schema.ts`
 * Production Drizzle ORM Schema for Document Data Plane Database (`data_db`)
 * Tenant == project: every table is keyed on `project_id` only (migration 0011).
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  smallint,
  integer,
  bigint,
  bigserial,
  timestamp,
  jsonb,
  customType,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const documents = pgTable(
  "documents",
  {
    projectId: uuid("project_id").notNull(),
    path: text("path").notNull(),
    collectionPath: text("collection_path").notNull(),
    collectionGroup: text("collection_group").notNull(),
    documentId: text("document_id").notNull(),
    pathDepth: smallint("path_depth").notNull(),
    data: jsonb("data").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** V2 optional TTL. NULL means the document never expires (migration 0007). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.path] }),
    colIdActiveIdx: index("idx_docs_collection_id_active")
      .on(table.projectId, table.collectionPath, table.documentId)
      .where(sql`${table.deletedAt} IS NULL`),
    colUpdatedActiveIdx: index("idx_docs_collection_updated_active")
      .on(table.projectId, table.collectionPath, table.updatedAt, table.documentId)
      .where(sql`${table.deletedAt} IS NULL`),
    colCreatedActiveIdx: index("idx_docs_collection_created_active")
      .on(table.projectId, table.collectionPath, table.createdAt, table.documentId)
      .where(sql`${table.deletedAt} IS NULL`),
    tombstonesIdx: index("idx_docs_tombstones")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
    expiresAtIdx: index("idx_docs_expires_at")
      .on(table.projectId, table.expiresAt)
      .where(sql`${table.expiresAt} IS NOT NULL AND ${table.deletedAt} IS NULL`),
  })
);

export const documentIndexes = pgTable(
  "document_indexes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    collectionPath: text("collection_path").notNull(),
    fields: jsonb("fields").notNull(),
    definitionHash: text("definition_hash").notNull(),
    status: text("status").notNull().default("building"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uqDefHash: uniqueIndex("uq_document_indexes_def").on(
      table.projectId,
      table.collectionPath,
      table.definitionHash
    ),
  })
);

export const documentIndexEntries = pgTable(
  "document_index_entries",
  {
    indexId: uuid("index_id")
      .notNull()
      .references(() => documentIndexes.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull(),
    collectionPath: text("collection_path").notNull(),
    sortKey: bytea("sort_key").notNull(),
    documentId: text("document_id").notNull(),
    path: text("path").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.indexId, table.sortKey, table.documentId] }),
    docCleanupIdx: index("idx_index_entries_doc_cleanup").on(table.projectId, table.path),
  })
);

export const realtimeOutbox = pgTable(
  "realtime_outbox",
  {
    seqId: bigserial("seq_id", { mode: "bigint" }).primaryKey(),
    projectId: uuid("project_id").notNull(),
    collectionPath: text("collection_path").notNull(),
    path: text("path").notNull(),
    documentId: text("document_id").notNull(),
    opType: text("op_type").notNull(),
    version: bigint("version", { mode: "number" }).notNull(),
    beforeData: jsonb("before_data"),
    afterData: jsonb("after_data"),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projSeqIdx: index("idx_outbox_project_seq").on(table.projectId, table.seqId),
    cleanupIdx: index("idx_outbox_cleanup").on(table.committedAt),
  })
);

export type DocumentRow = typeof documents.$inferSelect;
export type NewDocumentRow = typeof documents.$inferInsert;

export type DocumentIndexRow = typeof documentIndexes.$inferSelect;
export type NewDocumentIndexRow = typeof documentIndexes.$inferInsert;

export type DocumentIndexEntryRow = typeof documentIndexEntries.$inferSelect;
export type NewDocumentIndexEntryRow = typeof documentIndexEntries.$inferInsert;

export type RealtimeOutboxRow = typeof realtimeOutbox.$inferSelect;
export type NewRealtimeOutboxRow = typeof realtimeOutbox.$inferInsert;

/**
 * Durable, tenant-scoped collection registry (migration 0009). Empty collections
 * and their metadata persist here rather than in client-only state. FORCE RLS
 * with a per-table tenant policy is applied by the migration.
 */
export const projectCollections = pgTable(
  "project_collections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    defaultTtlSeconds: integer("default_ttl_seconds"),
    schemaValidation: jsonb("schema_validation").$type<{
      requiredFields?: string[];
      strict?: boolean;
    }>(),
    isSystem: boolean("is_system").notNull().default(false),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uqName: uniqueIndex("uq_project_collections_name").on(table.projectId, table.name),
    nameIdx: index("idx_project_collections_name").on(table.projectId, table.name),
  })
);

export type ProjectCollection = typeof projectCollections.$inferSelect;
export type NewProjectCollection = typeof projectCollections.$inferInsert;

/** End-user identities. Tenant-scoped with FORCE RLS in migration 0005. */
export const projectAuthUsers = pgTable(
  "project_auth_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    passwordHash: text("password_hash"),
    displayName: text("display_name"),
    photoUrl: text("photo_url"),
    phoneNumber: text("phone_number"),
    phoneVerified: boolean("phone_verified").notNull().default(false),
    isDisabled: boolean("is_disabled").notNull().default(false),
    isAnonymous: boolean("is_anonymous").notNull().default(false),
    customClaims: jsonb("custom_claims").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
  },
  (table) => ({
    emailIdx: uniqueIndex("idx_auth_users_email")
      .on(table.projectId, sql`LOWER(${table.email})`)
      .where(sql`${table.email} IS NOT NULL`),
    phoneIdx: index("idx_auth_users_phone")
      .on(table.projectId, table.phoneNumber)
      .where(sql`${table.phoneNumber} IS NOT NULL`),
    createdIdx: index("idx_auth_users_created").on(table.projectId, table.createdAt, table.id),
  })
);

export const projectAuthIdentities = pgTable(
  "project_auth_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => projectAuthUsers.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull(),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    identityData: jsonb("identity_data").$type<Record<string, unknown>>().notNull().default({}),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerUq: uniqueIndex("idx_auth_identities_provider").on(
      table.projectId,
      table.provider,
      table.providerUserId
    ),
    userIdx: index("idx_auth_identities_user").on(table.projectId, table.userId),
  })
);

export const projectAuthSessions = pgTable(
  "project_auth_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => projectAuthUsers.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull(),
    refreshTokenHash: text("refresh_token_hash").notNull().unique(),
    previousRefreshTokenHash: text("previous_refresh_token_hash").unique(),
    rotationCounter: integer("rotation_counter").notNull().default(0),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    revoked: boolean("revoked").notNull().default(false),
    revokedReason: text("revoked_reason"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index("idx_auth_sessions_user")
      .on(table.projectId, table.userId)
      .where(sql`${table.revoked} = FALSE`),
  })
);

export const projectAuthMfa = pgTable(
  "project_auth_mfa",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => projectAuthUsers.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull(),
    factorType: text("factor_type").notNull().default("totp"),
    secretEncrypted: text("secret_encrypted").notNull(),
    verified: boolean("verified").notNull().default(false),
    recoveryCodesHashed: jsonb("recovery_codes_hashed")
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (table) => ({
    factorUq: uniqueIndex("idx_auth_mfa_factor").on(
      table.projectId,
      table.userId,
      table.factorType
    ),
  })
);

export const projectAuthTokens = pgTable(
  "project_auth_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => projectAuthUsers.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    tokenType: text("token_type").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lookupIdx: index("idx_auth_tokens_lookup")
      .on(table.projectId, table.tokenHash)
      .where(sql`${table.consumedAt} IS NULL`),
  })
);

export type AuthUserRow = typeof projectAuthUsers.$inferSelect;
export type NewAuthUserRow = typeof projectAuthUsers.$inferInsert;
export type AuthIdentityRow = typeof projectAuthIdentities.$inferSelect;
export type NewAuthIdentityRow = typeof projectAuthIdentities.$inferInsert;
export type AuthSessionRow = typeof projectAuthSessions.$inferSelect;
export type NewAuthSessionRow = typeof projectAuthSessions.$inferInsert;
export type AuthMfaRow = typeof projectAuthMfa.$inferSelect;
export type NewAuthMfaRow = typeof projectAuthMfa.$inferInsert;
export type AuthTokenRow = typeof projectAuthTokens.$inferSelect;
export type NewAuthTokenRow = typeof projectAuthTokens.$inferInsert;

/**
 * Durable, tenant-scoped OCC transaction ledger (migration 0004, extended by
 * migration 0010). `token_hash` is UNIQUE so a signed token can only be begun
 * once; `committed_at` / `rolled_back_at` record the terminal ledger state.
 * FORCE RLS with a per-table tenant policy is applied by the migration.
 */
export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    projectId: uuid("project_id").notNull(),
    readSet: jsonb("read_set").notNull().default({}),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("idx_tx_token_hash").on(table.tokenHash),
    tenantStatusExpIdx: index("idx_tx_tenant_status_exp").on(
      table.projectId,
      table.status,
      table.expiresAt
    ),
    tenantIdx: index("idx_transactions_tenant").on(table.projectId, table.createdAt),
    expiresAtIdx: index("idx_transactions_expires_at")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'active'`),
  })
);

export type TransactionRow = typeof transactions.$inferSelect;
export type NewTransactionRow = typeof transactions.$inferInsert;

/**
 * Durable, tenant-scoped cache of a committed batchWrite response (migration
 * 0010). The (project_id, idempotency_key) pair is the PK, so a retried batch
 * after a client timeout replays the original result instead of re-applying
 * writes. FORCE RLS with a per-table tenant policy is applied by the migration;
 * rows self-expire via `expires_at` (24h default).
 */
export const batchIdempotencyKeys = pgTable(
  "batch_idempotency_keys",
  {
    projectId: uuid("project_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    responseHash: text("response_hash").notNull(),
    responsePayload: jsonb("response_payload").notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`(now() + interval '24 hours')`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.idempotencyKey] }),
    expiresIdx: index("idx_idempotency_expires").on(table.expiresAt),
  })
);

export type BatchIdempotencyKeyRow = typeof batchIdempotencyKeys.$inferSelect;
export type NewBatchIdempotencyKeyRow = typeof batchIdempotencyKeys.$inferInsert;
