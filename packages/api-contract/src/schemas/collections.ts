/**
 * @vellum/api-contract - Collections Lifecycle Schemas
 *
 * Runtime validation for the collection-management surfaces described in
 * `docs/COLLECTIONS-CONTRACT.md` §2.2-2.3. Both the public data-plane routes
 * and the session-authenticated console routes validate their inputs here so
 * the wire contract stays identical across surfaces.
 */

import { z } from "zod";
import { SYSTEM_LIMITS } from "@vellum/core";
import { createSafeRecordSchema, FORBIDDEN_OBJECT_KEYS } from "./safety.js";

/** Locked collection-name grammar (docs/COLLECTIONS-CONTRACT.md §2.2). */
export const COLLECTION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const CollectionNameSchema = z
  .string()
  .regex(
    COLLECTION_NAME_PATTERN,
    "Collection name must be 1-128 characters: letters, digits, '.', '_' or '-', starting with a letter or digit"
  );

const CollectionDescriptionSchema = z.string().max(2048);
const DefaultTtlSecondsSchema = z.number().int().positive().max(2_147_483_647);
const CollectionMetadataSchema = createSafeRecordSchema({
  maxDepth: 10,
  maxKeys: 100,
  maxArrayLength: 100,
  maxBytes: 32_768,
});
const ImportDocumentDataSchema = createSafeRecordSchema({
  maxDepth: 20,
  maxKeys: 500,
  maxArrayLength: 5_000,
  maxBytes: 1_048_576,
});

/** Optional per-collection schema enforcement metadata. */
export const CollectionSchemaValidationSchema = z
  .object({
    requiredFields: z
      .array(
        z
          .string()
          .min(1)
          .max(256)
          .refine((f) => !FORBIDDEN_OBJECT_KEYS.has(f), "Forbidden field name")
      )
      .max(100)
      .optional(),
    strict: z.boolean().optional(),
  })
  .strict();

export const CreateCollectionSchema = z
  .object({
    name: CollectionNameSchema,
    description: CollectionDescriptionSchema.optional(),
    defaultTtlSeconds: DefaultTtlSecondsSchema.optional(),
    schemaValidation: CollectionSchemaValidationSchema.optional(),
    metadata: CollectionMetadataSchema.optional(),
    ifNotExists: z.boolean().optional(),
  })
  .strict();

export const UpdateCollectionSchema = z
  .object({
    description: CollectionDescriptionSchema.nullable().optional(),
    defaultTtlSeconds: DefaultTtlSecondsSchema.nullable().optional(),
    schemaValidation: CollectionSchemaValidationSchema.nullable().optional(),
    metadata: CollectionMetadataSchema.optional(),
  })
  .strict();

/** Query-string schema; `limit` is coerced from its URL string representation. */
export const ListCollectionsQuerySchema = z
  .object({
    search: z.string().max(256).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SYSTEM_LIMITS.MAX_QUERY_LIMIT)
      .default(SYSTEM_LIMITS.DEFAULT_QUERY_LIMIT),
    cursor: z.string().max(4_096).optional(),
  })
  .strict();

/** Bulk import body: a bounded array of documents with optional caller ids. */
export const ImportCollectionDocumentsSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(256).optional(),
        data: ImportDocumentDataSchema,
      })
      .strict()
  )
  .max(500, "A collection import accepts at most 500 documents");

/** Wire shape of a registry row joined with live-document statistics. */
export const CollectionWithStatsSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string().min(1),
    description: z.string().nullable(),
    defaultTtlSeconds: z.number().int().nullable(),
    schemaValidation: CollectionSchemaValidationSchema.nullable(),
    isSystem: z.boolean(),
    metadata: CollectionMetadataSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    documentCount: z.number().int().nonnegative(),
    storageBytes: z.number().int().nonnegative(),
    lastDocumentAt: z.string().nullable(),
  })
  .strict();

export type CreateCollectionRequest = z.infer<typeof CreateCollectionSchema>;
export type UpdateCollectionRequest = z.infer<typeof UpdateCollectionSchema>;
export type ListCollectionsQuery = z.infer<typeof ListCollectionsQuerySchema>;
/**
 * The SDKs and Dashboard send `{ documents, mode }`; the raw REST contract also
 * accepts a bare array. Accept both so no client shape is silently rejected.
 */
export const ImportModeSchema = z.enum(["upsert", "insert_only"]);

export const ImportCollectionRequestSchema = z.union([
  ImportCollectionDocumentsSchema,
  z
    .object({
      documents: ImportCollectionDocumentsSchema,
      mode: ImportModeSchema.optional(),
    })
    .strict(),
]);

export type ImportCollectionDocument = z.infer<typeof ImportCollectionDocumentsSchema>[number];

/** Normalise either accepted wire shape into the engine's import arguments. */
export function normalizeImportRequest(input: unknown): {
  documents: ImportCollectionDocument[];
  mode: "upsert" | "insert_only";
} {
  const parsed = ImportCollectionRequestSchema.parse(input);
  if (Array.isArray(parsed)) return { documents: parsed, mode: "upsert" };
  return { documents: parsed.documents, mode: parsed.mode ?? "upsert" };
}
export type CollectionWithStatsWire = z.infer<typeof CollectionWithStatsSchema>;
