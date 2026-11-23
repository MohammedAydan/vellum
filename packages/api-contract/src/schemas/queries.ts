/**
 * @vellum/api-contract - Query Schemas
 * Strictly matches Specification Section 7 and System Limits Section 2.3.
 *
 * V2 additions (contract §2.9):
 *   - `V2QueryOperatorEnum` adds contains_ci / starts_with_ci / text_search.
 *   - `OrGroupsSchema` (disjunctive groups, each group ANDed, groups ORed).
 *   - `IncludeSpecSchema` (recursive relation includes, max depth 3).
 *   - dot-path `select`, `ttlSeconds` and `expiresAt`.
 *
 * `QueryOperatorEnum` and `VALID_QUERY_OPERATORS` are intentionally left at the
 * original ten operators for backwards compatibility; the V2 enum is additive.
 */

import { z } from "zod";
import { SYSTEM_LIMITS } from "@vellum/core";
import { CollectionPathSchema, FieldNameSchema, QueryLimitSchema } from "./limits.js";
import { FORBIDDEN_OBJECT_KEYS, validateSafePayload } from "./safety.js";

const MAX_DOT_PATH_SEGMENTS = 10;
const MAX_DOT_PATH_LENGTH = 512;
const MAX_TEXT_OPERATOR_LENGTH = 200;
const MAX_SELECT_FIELDS = 100;
const MAX_CURSOR_LENGTH = 4_096;
const MAX_TTL_SECONDS = 2_147_483_647;

export const QueryOperatorEnum = z.enum([
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "in",
  "not-in",
  "array-contains",
  "array-contains-any",
]);

export type QueryOperator = z.infer<typeof QueryOperatorEnum>;

/** V2 query operators: all v1 operators plus the three case-insensitive/text ops. */
export const V2QueryOperatorEnum = z.enum([
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "in",
  "not-in",
  "array-contains",
  "array-contains-any",
  "contains_ci",
  "starts_with_ci",
  "text_search",
]);

export type V2QueryOperator = z.infer<typeof V2QueryOperatorEnum>;

const TEXT_OPERATORS: ReadonlySet<string> = new Set([
  "contains_ci",
  "starts_with_ci",
  "text_search",
]);

export const QueryFilterSchema = z
  .object({
    field: FieldNameSchema,
    op: V2QueryOperatorEnum,
    value: z.unknown(),
  })
  .superRefine((filter, ctx) => {
    const safety = validateSafePayload(filter.value, {
      maxDepth: 10,
      maxKeys: 100,
      maxArrayLength: Math.max(SYSTEM_LIMITS.MAX_DISJUNCTIVE_VALUES, 100),
      maxBytes: 65_536,
    });
    if (!safety.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: safety.message,
      });
      return;
    }

    if (filter.op === "in" || filter.op === "not-in" || filter.op === "array-contains-any") {
      if (!Array.isArray(filter.value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Operator '${filter.op}' requires an array value`,
        });
      } else if (filter.value.length > SYSTEM_LIMITS.MAX_DISJUNCTIVE_VALUES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Disjunctive query array exceeds maximum of ${SYSTEM_LIMITS.MAX_DISJUNCTIVE_VALUES} elements`,
        });
      } else if (filter.value.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Operator '${filter.op}' requires at least one element in array`,
        });
      }
    }
    if (TEXT_OPERATORS.has(filter.op)) {
      if (typeof filter.value !== "string" || filter.value.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Operator '${filter.op}' requires a non-empty string value`,
        });
      } else if (filter.value.length > MAX_TEXT_OPERATOR_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Operator '${filter.op}' value exceeds maximum of ${MAX_TEXT_OPERATOR_LENGTH} characters`,
        });
      }
    }
  });

export type QueryFilter = z.infer<typeof QueryFilterSchema>;

/**
 * Disjunctive normal form: an outer array of at most 10 AND-groups. Each inner
 * group is ANDed internally (bounded by MAX_WHERE_CLAUSES) and groups are ORed.
 */
export const OrGroupsSchema = z
  .array(z.array(QueryFilterSchema).max(SYSTEM_LIMITS.MAX_WHERE_CLAUSES))
  .max(10);
export type OrGroups = z.infer<typeof OrGroupsSchema>;

/**
 * Accepts both canonical `direction` and the SDK shorthand `dir` (emitted by
 * `@vellumdb/sdk-js` and `vellum_flutter`), normalizing to `direction`.
 */
export const QueryOrderBySchema = z.preprocess(
  (raw) => {
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if (obj["direction"] === undefined && obj["dir"] !== undefined) {
        return { ...obj, direction: obj["dir"] };
      }
    }
    return raw;
  },
  z.object({
    field: FieldNameSchema,
    direction: z.enum(["asc", "desc"]).default("asc"),
  })
);

export type QueryOrderBy = z.infer<typeof QueryOrderBySchema>;

/** A dot path such as `author.profile.name`. Every segment is a safe field name. */
export const DotPathSchema = z
  .string()
  .min(1)
  .max(MAX_DOT_PATH_LENGTH, `Dot path exceeds ${MAX_DOT_PATH_LENGTH} characters`)
  .superRefine((value, ctx) => {
    if (value.includes("\u0000")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Dot path cannot contain NUL bytes",
      });
      return;
    }
    const segments = value.split(".");
    if (segments.length > MAX_DOT_PATH_SEGMENTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Dot path exceeds maximum depth of ${MAX_DOT_PATH_SEGMENTS} segments`,
      });
      return;
    }
    if (segments.some((segment) => segment.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Dot path cannot contain empty segments",
      });
      return;
    }
    for (const segment of segments) {
      if (FORBIDDEN_OBJECT_KEYS.has(segment)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Dot path cannot contain forbidden segment '${segment}'`,
        });
        return;
      }
      if (segment.length > SYSTEM_LIMITS.MAX_FIELD_NAME_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Dot path segment exceeds ${SYSTEM_LIMITS.MAX_FIELD_NAME_LENGTH} characters`,
        });
        return;
      }
    }
  });

export const SelectFieldsSchema = z.array(DotPathSchema).max(MAX_SELECT_FIELDS);
export type SelectFields = z.infer<typeof SelectFieldsSchema>;

/** ISO-8601 timestamp accepted for explicit document expiry. */
export const ExpiresAtSchema = z
  .string()
  .max(64, "'expiresAt' exceeds maximum length")
  .superRefine((value, ctx) => {
    if (value.length === 0 || Number.isNaN(Date.parse(value))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'expiresAt' must be a valid ISO-8601 timestamp",
      });
    }
  });

export const TTL_SECONDS_SCHEMA = z.number().int().nonnegative().max(MAX_TTL_SECONDS);

/** Wire shape of a relation include. Mirrors `IncludeSpec` from document-engine. */
export interface IncludeSpecWire {
  field: string;
  collection?: string;
  as?: string;
  select?: string[];
  include?: IncludeSpecWire[];
  onDelete?: "cascade" | "set_null" | "restrict";
}

interface RawIncludeSpecWire {
  field: string;
  collection?: string | undefined;
  as?: string | undefined;
  select?: string[] | undefined;
  include?: IncludeSpecWire[] | undefined;
  onDelete?: "cascade" | "set_null" | "restrict" | undefined;
}

function normalizeIncludeSpecWire(raw: RawIncludeSpecWire): IncludeSpecWire {
  const normalized: IncludeSpecWire = { field: raw.field };
  if (raw.collection !== undefined) normalized.collection = raw.collection;
  if (raw.as !== undefined) normalized.as = raw.as;
  if (raw.select !== undefined) normalized.select = raw.select;
  if (raw.include !== undefined) normalized.include = raw.include;
  if (raw.onDelete !== undefined) normalized.onDelete = raw.onDelete;
  return normalized;
}

const MAX_INCLUDE_DEPTH = 3;
// Locked by docs/ENGINE-HARDENING-CONTRACT.md — must match relations.MAX_INCLUDES.
const MAX_INCLUDES_PER_LEVEL = 10;

function buildIncludeSpecSchema(
  depth: number,
): z.ZodType<IncludeSpecWire, z.ZodTypeDef, unknown> {
  const base = {
    field: FieldNameSchema,
    collection: z.string().min(1).max(256).optional(),
    as: FieldNameSchema.optional(),
    select: SelectFieldsSchema.optional(),
    onDelete: z.enum(["cascade", "set_null", "restrict"]).optional(),
  };
  // Depth is 1-based: a spec at the maximum depth may not carry further
  // nested includes, which bounds the wire graph to three levels.
  if (depth >= MAX_INCLUDE_DEPTH) {
    // Strict at the leaf so a fourth `include` level is rejected rather than
    // silently stripped by Zod's default object behavior.
    return z.object(base).strict().transform(normalizeIncludeSpecWire);
  }
  return z
    .object({
      ...base,
      include: z.array(buildIncludeSpecSchema(depth + 1)).max(MAX_INCLUDES_PER_LEVEL).optional(),
    })
    .transform(normalizeIncludeSpecWire);
}

// BOUNDARY-DECODER: validated by the recursive IncludeSpec schema above.
export const IncludeSpecSchema: z.ZodType<
  IncludeSpecWire,
  z.ZodTypeDef,
  unknown
> = buildIncludeSpecSchema(1);
export type IncludeSpec = z.infer<typeof IncludeSpecSchema>;

const CursorBoundsArraySchema = z
  .array(z.unknown())
  .max(SYSTEM_LIMITS.MAX_ORDER_BY_FIELDS + 1)
  .superRefine((arr, ctx) => {
    const res = validateSafePayload(arr, { maxDepth: 6, maxKeys: 50, maxArrayLength: 50 });
    if (!res.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: res.message });
  });

/** Accepts either an opaque HMAC cursor string (SDK wire format) or a tuple of field bounds. */
const CursorBoundSchema = z.union([
  z.string().max(MAX_CURSOR_LENGTH),
  CursorBoundsArraySchema,
]);

export const QuerySpecSchema = z
  .object({
    collectionPath: CollectionPathSchema.optional(),
    collectionGroup: z.string().min(1).max(128).optional(),
    where: z.array(QueryFilterSchema).max(SYSTEM_LIMITS.MAX_WHERE_CLAUSES).optional().default([]),
    or: OrGroupsSchema.optional(),
    orderBy: z.array(QueryOrderBySchema).max(SYSTEM_LIMITS.MAX_ORDER_BY_FIELDS).optional().default([]),
    limit: QueryLimitSchema,
    cursor: z.string().max(MAX_CURSOR_LENGTH).nullable().optional(),
    startAt: CursorBoundSchema.nullable().optional(),
    startAfter: CursorBoundSchema.nullable().optional(),
    endAt: CursorBoundSchema.nullable().optional(),
    endBefore: CursorBoundSchema.nullable().optional(),
    select: SelectFieldsSchema.nullable().optional(),
    include: z.array(IncludeSpecSchema).max(MAX_INCLUDES_PER_LEVEL).optional(),
    ttlSeconds: TTL_SECONDS_SCHEMA.optional(),
    expiresAt: ExpiresAtSchema.optional(),
  })
  .superRefine((query, ctx) => {
    if (!query.collectionPath && !query.collectionGroup) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Query must specify either 'collectionPath' or 'collectionGroup'",
      });
    }
    if (query.collectionPath && query.collectionGroup) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Query cannot specify both 'collectionPath' and 'collectionGroup'",
      });
    }
  });

export type QuerySpec = z.infer<typeof QuerySpecSchema>;

export const QueryResponseSchema = z.object({
  documents: z.array(z.record(z.string(), z.unknown())),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  executionStats: z
    .object({
      scannedCount: z.number().int().nonnegative().optional(),
      matchedCount: z.number().int().nonnegative().optional(),
      executionDurationMs: z.number().nonnegative().optional(),
      indexUsed: z.string().nullable().optional(),
    })
    .optional(),
});
