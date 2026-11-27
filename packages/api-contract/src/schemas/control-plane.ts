/**
 * @vellum/api-contract - Control Plane Schemas
 * Strictly matches Specification Section 5 and Section 7.2.
 */

import { z } from "zod";
import { CollectionPathSchema, FieldNameSchema } from "./limits.js";
import { createSafeRecordSchema } from "./safety.js";

const SafeRulesAstRecordSchema = createSafeRecordSchema({
  maxDepth: 20,
  maxKeys: 1_000,
  maxArrayLength: 500,
  maxBytes: 262_144,
});

const SafeMetadataRecordSchema = createSafeRecordSchema({
  maxDepth: 10,
  maxKeys: 100,
  maxArrayLength: 100,
  maxBytes: 32_768,
});

export const PlanTierEnum = z.enum(["free", "developer", "pro", "enterprise"]);
export type PlanTier = z.infer<typeof PlanTierEnum>;

export const OrganizationSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100),
  planTier: PlanTierEnum.default("free"),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CreateOrganizationRequestSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
  planTier: PlanTierEnum.optional().default("free"),
});

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CreateProjectRequestSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
});

export const ApiKeyTypeEnum = z.enum(["publishable", "secret"]);

export const ApiKeySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string().min(1).max(100),
  keyType: ApiKeyTypeEnum,
  keyPrefix: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().nullable().optional(),
  lastUsedAt: z.string().nullable().optional(),
});

export const CreateApiKeyRequestSchema = z.object({
  name: z.string().min(1).max(100),
  keyType: ApiKeyTypeEnum,
  /**
   * Development key: localhost/127.0.0.1 browser origins are allowed for this
   * project without listing them on the key. Publishable keys only.
   */
  isDev: z.boolean().optional(),
  expiresAt: z
    .string()
    .max(64)
    .refine((v) => Number.isFinite(Date.parse(v)), { message: "expiresAt must be an ISO-8601 date-time" })
    .optional(),
});

export const CreateApiKeyResponseSchema = z.object({
  apiKey: ApiKeySchema,
  rawKey: z.string(), // returned ONLY once at creation
});

export const SecurityRulesetSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  version: z.number().int().min(1),
  rulesAst: SafeRulesAstRecordSchema,
  createdAt: z.string(),
  isActive: z.boolean(),
});

export const UpdateRulesetRequestSchema = z.object({
  rulesAst: SafeRulesAstRecordSchema,
});

export const RelationRuleSchema = z
  .object({
    collection: z.string().min(1),
    field: z.string().min(1),
    targetCollection: z.string().min(1).nullish(),
    onDelete: z.enum(["cascade", "set_null", "restrict"]),
  })
  .strict();

export const UpdateRelationRulesRequestSchema = z
  .object({
    rules: z.array(RelationRuleSchema).max(50),
    /** Optimistic concurrency: must match the current version when provided. */
    expectedVersion: z.number().int().min(0).nullish(),
  })
  .strict();

export const CompositeIndexFieldSchema = z.object({
  fieldPath: FieldNameSchema,
  order: z.enum(["asc", "desc"]).default("asc"),
});

export const CreateIndexRequestSchema = z.object({
  collectionPath: CollectionPathSchema,
  fields: z.array(CompositeIndexFieldSchema).min(1).max(3),
  name: z.string().max(128).optional(),
});

export const CompositeIndexSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  collectionPath: z.string(),
  fields: z.array(CompositeIndexFieldSchema),
  status: z.enum(["building", "ready", "failed"]),
  createdAt: z.string(),
});

export const AuditLogSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  actorId: z.string(),
  actorType: z.enum(["user", "api_key", "system"]),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  ipAddress: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
  metadata: SafeMetadataRecordSchema.optional(),
  createdAt: z.string(),
});
