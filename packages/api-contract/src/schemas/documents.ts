/**
 * @vellum/api-contract - Document & Tagged Wire Format Schemas
 * Strictly matches Specification Section 6.2 and Section 8.
 */

import { z } from "zod";
import { DocumentPathSchema } from "./limits.js";
import { createSafeRecordSchema, FORBIDDEN_OBJECT_KEYS, validateSafePayload } from "./safety.js";

const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;
const MAX_BASE64_LENGTH = 1_398_104; // 1 MiB encoded in base64
const BASE64_CHARSET_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;

function isValidBase64Linear(val: string): boolean {
  if (val.length === 0) return true;
  if (val.length > MAX_BASE64_LENGTH || val.length % 4 !== 0) return false;
  return BASE64_CHARSET_REGEX.test(val);
}

export const TaggedInt64Schema = z.object({
  $t: z.literal("int"),
  $v: z
    .string()
    .max(20, "int64 value exceeds maximum length")
    .regex(/^-?\d+$/, "int64 value must be a valid integer string")
    .refine((val) => {
      try {
        const n = BigInt(val);
        return n >= INT64_MIN && n <= INT64_MAX;
      } catch {
        return false;
      }
    }, "int64 value is out of 64-bit signed integer range"),
});

/**
 * Canonical tagged timestamp (`@vellum/core` TaggedTimestamp): `$t: "ts"` with an
 * ISO-8601 `$v` and an optional finite epoch-millisecond `$ms`.
 */
export const TaggedTimestampSchema = z.object({
  $t: z.literal("ts"),
  $v: z
    .string()
    .max(64, "Timestamp string exceeds maximum length")
    .refine((val) => !isNaN(Date.parse(val)), "Invalid ISO 8601 timestamp string"),
  $ms: z.number().finite().optional(),
});

export const TaggedReferenceSchema = z.object({
  $t: z.literal("ref"),
  $v: DocumentPathSchema,
});

export const TaggedBytesSchema = z.object({
  $t: z.literal("bytes"),
  $v: z.string().refine(isValidBase64Linear, "Must be valid base64"),
});

/**
 * Canonical tagged geopoint (`@vellum/core` TaggedGeopoint): `$v: { lat, lng }`.
 */
export const TaggedGeoPointSchema = z.object({
  $t: z.literal("geo"),
  $v: z.object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
  }),
});

export const TaggedTransformIncrementSchema = z.object({
  $op: z.literal("increment"),
  $v: z.union([z.number().finite(), TaggedInt64Schema]),
});

export const TaggedTransformArrayUnionSchema = z.object({
  $op: z.literal("arrayUnion"),
  $v: z
    .array(z.unknown())
    .max(500, "arrayUnion exceeds maximum of 500 elements")
    .superRefine((arr, ctx) => {
      const res = validateSafePayload(arr, { maxDepth: 10, maxKeys: 200, maxArrayLength: 500 });
      if (!res.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: res.message });
    }),
});

export const TaggedTransformArrayRemoveSchema = z.object({
  $op: z.literal("arrayRemove"),
  $v: z
    .array(z.unknown())
    .max(500, "arrayRemove exceeds maximum of 500 elements")
    .superRefine((arr, ctx) => {
      const res = validateSafePayload(arr, { maxDepth: 10, maxKeys: 200, maxArrayLength: 500 });
      if (!res.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: res.message });
    }),
});

export const TaggedTransformServerTimestampSchema = z.object({
  $op: z.literal("serverTimestamp"),
});

export const TaggedTransformDeleteFieldSchema = z.object({
  $op: z.literal("deleteField"),
});

export const TaggedFieldTransformSchema = z.discriminatedUnion("$op", [
  TaggedTransformIncrementSchema,
  TaggedTransformArrayUnionSchema,
  TaggedTransformArrayRemoveSchema,
  TaggedTransformServerTimestampSchema,
  TaggedTransformDeleteFieldSchema,
]);

/**
 * Normalizes pre-v1 wire aliases into the canonical core tags before validation,
 * so legacy clients are accepted while the validated/output shape is canonical.
 *   $t: "time"          -> $t: "ts"
 *   $v.latitude/longitude -> $v.lat/$v.lng
 */
function canonicalizeTaggedValue(val: unknown): unknown {
  if (val === null || typeof val !== "object" || Array.isArray(val)) return val;
  const rec = val as Record<string, unknown>;
  if (rec["$t"] === "time") {
    return { ...rec, $t: "ts" };
  }
  if (rec["$t"] === "geo" && rec["$v"] && typeof rec["$v"] === "object" && !Array.isArray(rec["$v"])) {
    const geo = rec["$v"] as Record<string, unknown>;
    if ("latitude" in geo || "longitude" in geo) {
      return {
        ...rec,
        $v: { lat: geo["latitude"], lng: geo["longitude"] },
      };
    }
  }
  return val;
}

export const TaggedObjectSchema = z.preprocess(
  canonicalizeTaggedValue,
  z.discriminatedUnion("$t", [
    TaggedInt64Schema,
    TaggedTimestampSchema,
    TaggedReferenceSchema,
    TaggedBytesSchema,
    TaggedGeoPointSchema,
  ])
);

export const TaggedValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().refine((s) => !s.includes("\u0000"), "NUL byte is not allowed"),
    z.number().finite(),
    z.boolean(),
    z.null(),
    TaggedObjectSchema,
    z.array(TaggedValueSchema).max(5_000),
    z
      .record(z.string(), TaggedValueSchema)
      .refine((val) => !("$t" in val), {
        message: "Objects with '$t' property must be valid tagged types",
      })
      .refine(
        (val) => !Object.getOwnPropertyNames(val).some((k) => FORBIDDEN_OBJECT_KEYS.has(k)),
        { message: "Forbidden prototype-pollution key in object" }
      ),
  ])
);

export const DocumentDataSchema = createSafeRecordSchema({
  maxDepth: 20,
  maxKeys: 500,
  maxArrayLength: 5_000,
  maxBytes: 1_048_576,
});

export const DocumentPayloadSchema = z.object({
  _included: z.record(z.unknown()).optional(),
  _redactedRefs: z.array(z.string()).optional(),
  path: z.string().max(2_048),
  collectionPath: z.string().max(2_048),
  collectionGroup: z.string().max(256),
  documentId: z.string().max(512),
  data: DocumentDataSchema,
  sizeBytes: z.number().int().nonnegative().optional(),
  version: z.number().int().min(1),
  createdAt: z.string().max(64),
  updatedAt: z.string().max(64),
});

export type DocumentPayload = z.infer<typeof DocumentPayloadSchema>;

export const CreateDocumentRequestSchema = z.object({
  data: DocumentDataSchema,
});

export const SetDocumentRequestSchema = z.object({
  data: DocumentDataSchema,
  merge: z.boolean().optional(),
});

export const DocumentPreconditionSchema = z.object({
  exists: z.boolean().optional(),
  version: z.number().int().min(1).optional(),
  lastUpdateTime: z.string().max(64).optional(),
});

export const UpdateDocumentRequestSchema = z.object({
  data: DocumentDataSchema,
  preconditions: DocumentPreconditionSchema.optional(),
});
