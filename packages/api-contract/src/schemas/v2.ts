/**
 * @vellum/api-contract - V2 Request / Response Schemas
 *
 * Runtime validation for the V2 endpoints locked in
 * `docs/V2-ENGINE-CONTRACT.md` §6.2, §6.4 and §6.5. These schemas are pure
 * contract definitions: all evaluation stays inside the owning packages.
 */

import { z } from "zod";
import { SYSTEM_LIMITS } from "@vellum/core";
import { DocumentPathSchema, CollectionPathSchema } from "./limits.js";
import {
  DotPathSchema,
  IncludeSpecSchema,
  SelectFieldsSchema,
  OrGroupsSchema,
  QueryFilterSchema,
} from "./queries.js";
import { createSafeRecordSchema, FORBIDDEN_OBJECT_KEYS, validateSafePayload } from "./safety.js";

const MAX_AGGREGATE_METRICS = 20;
const MAX_RULES_DSL_BYTES = 65_536;
const MAX_RULESET_RULES = 200;

const SafeSimulateRecordSchema = createSafeRecordSchema({
  maxDepth: 20,
  maxKeys: 500,
  maxArrayLength: 500,
  maxBytes: 262_144,
});

/* -------------------------------------------------------------------------- */
/* Aggregate & bulk delete (§6.2 / §6.5)                                       */
/* -------------------------------------------------------------------------- */

export const AggregateOperationEnum = z.enum(["count", "sum", "avg", "min", "max"]);
export type AggregateOperation = z.infer<typeof AggregateOperationEnum>;

export const AggregateMetricSchema = z.object({
  op: AggregateOperationEnum,
  field: DotPathSchema.optional(),
});
export type AggregateMetric = z.infer<typeof AggregateMetricSchema>;

export const AggregateRequestSchema = z
  .object({
    collectionPath: CollectionPathSchema,
    where: z.array(QueryFilterSchema).max(SYSTEM_LIMITS.MAX_WHERE_CLAUSES).optional().default([]),
    or: OrGroupsSchema.optional(),
    groupBy: z.array(DotPathSchema).max(SYSTEM_LIMITS.MAX_ORDER_BY_FIELDS).optional().default([]),
    metrics: z.record(z.string().min(1).max(128), AggregateMetricSchema),
  })
  .superRefine((request, ctx) => {
    const metricKeys = Object.keys(request.metrics);
    if (metricKeys.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'metrics' must declare at least one named aggregation",
      });
    }
    if (metricKeys.length > MAX_AGGREGATE_METRICS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `'metrics' exceeds maximum of ${MAX_AGGREGATE_METRICS} named aggregations`,
      });
    }
    for (const key of Object.getOwnPropertyNames(request.metrics)) {
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Forbidden metric name '${key}'`,
        });
      }
    }
    for (const [name, metric] of Object.entries(request.metrics)) {
      if (metric.op !== "count" && metric.field === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Metric '${name}' (${metric.op}) requires a 'field' dot path`,
        });
      }
    }
  });
export type AggregateRequest = z.infer<typeof AggregateRequestSchema>;

export const AggregateRowSchema = z.record(z.string(), z.unknown());
export type AggregateRow = z.infer<typeof AggregateRowSchema>;

export const AggregateResultSchema = z.object({
  rows: z.array(AggregateRowSchema),
  executionTimeMs: z.number().nonnegative(),
});
export type AggregateResult = z.infer<typeof AggregateResultSchema>;

export const BulkDeleteRequestSchema = z.object({
  collectionPath: CollectionPathSchema,
  where: z.array(QueryFilterSchema).max(SYSTEM_LIMITS.MAX_WHERE_CLAUSES).optional().default([]),
  or: OrGroupsSchema.optional(),
  // Bulk delete is a maintenance-style operation, not a paged read: its cap is
  // the engine's 5,000-row hard ceiling rather than MAX_QUERY_LIMIT (500).
  limit: z.number().int().min(1).max(5_000).optional().default(1_000),
});
export type BulkDeleteRequest = z.infer<typeof BulkDeleteRequestSchema>;

export const BulkDeleteResultSchema = z.object({
  deletedCount: z.number().int().nonnegative(),
});
export type BulkDeleteResult = z.infer<typeof BulkDeleteResultSchema>;

/* -------------------------------------------------------------------------- */
/* Rules DSL (§6.4)                                                            */
/* -------------------------------------------------------------------------- */

/** Supported AST operation names (no eval / function-call nodes). */
export const AstOperationEnum = z.enum([
  "all",
  "any",
  "not",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "in",
  "hasKey",
  "isType",
]);
export type AstOperation = z.infer<typeof AstOperationEnum>;

export interface AstExpressionNodeWire {
  op: AstOperation;
  conditions?: AstExpressionNodeWire[];
  condition?: AstExpressionNodeWire;
  left?: unknown;
  right?: unknown;
  [key: string]: unknown;
}

interface RawAstExpressionNodeWire {
  op: AstOperation;
  conditions?: AstExpressionNodeWire[] | undefined;
  condition?: AstExpressionNodeWire | undefined;
  left?: unknown;
  right?: unknown;
  [key: string]: unknown;
}

function normalizeAstExpressionNodeWire(raw: RawAstExpressionNodeWire): AstExpressionNodeWire {
  const normalized: AstExpressionNodeWire = { op: raw.op };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "op" || key === "conditions" || key === "condition") {
      continue;
    }
    normalized[key] = value;
  }
  if (raw.conditions !== undefined) {
    normalized.conditions = raw.conditions;
  }
  if (raw.condition !== undefined) {
    normalized.condition = raw.condition;
  }
  return normalized;
}

// BOUNDARY-DECODER: validated by the recursive AST schema below.
export const AstExpressionNodeSchema: z.ZodType<
  AstExpressionNodeWire,
  z.ZodTypeDef,
  unknown
> = z.lazy(() =>
  z
    .object({
      op: AstOperationEnum,
      conditions: z.array(AstExpressionNodeSchema).max(50).optional(),
      condition: AstExpressionNodeSchema.optional(),
      left: z.unknown().optional(),
      right: z.unknown().optional(),
    })
    .passthrough()
    .transform(normalizeAstExpressionNodeWire)
);

export const SecurityRulesetAstSchema = z
  .object({
    version: z.literal(1),
    rules: z
      .array(
        z.object({
          match: z.string().min(1).max(512),
          allow: z.record(z.string().max(64), z.union([z.boolean(), AstExpressionNodeSchema])),
        })
      )
      .max(MAX_RULESET_RULES),
  })
  .superRefine((ast, ctx) => {
    const res = validateSafePayload(ast, {
      maxDepth: 20,
      maxKeys: 2_000,
      maxArrayLength: MAX_RULESET_RULES,
      maxBytes: 262_144,
    });
    if (!res.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: res.message });
    }
  });
export type SecurityRulesetAstWire = z.infer<typeof SecurityRulesetAstSchema>;

export const RulesDslDiagnosticSchema = z.object({
  message: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  snippet: z.string().optional(),
});
export type RulesDslDiagnostic = z.infer<typeof RulesDslDiagnosticSchema>;

/** `source` is canonical; `dsl` / `rulesDsl` are accepted aliases. */
export const CompileRulesDslSchema = z.preprocess((raw) => {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj["source"] !== "string") {
      const alias = obj["dsl"] ?? obj["rulesDsl"] ?? obj["rules"];
      if (typeof alias === "string") return { ...obj, source: alias };
    }
  }
  return raw;
}, z.object({ source: z.string().min(1, "'source' is required").max(MAX_RULES_DSL_BYTES) }));
export type CompileRulesDslRequest = z.infer<typeof CompileRulesDslSchema>;

export const CompiledRulesSchema = z.object({
  ast: SecurityRulesetAstSchema,
  diagnostics: z.array(RulesDslDiagnosticSchema),
});
export type CompiledRules = z.infer<typeof CompiledRulesSchema>;

/** Accepts `{ rulesAst }` or a bare AST object. */
export const DecompileRulesSchema = z.union([
  z.object({ rulesAst: SecurityRulesetAstSchema }),
  SecurityRulesetAstSchema,
]);
export type DecompileRulesRequest = z.infer<typeof DecompileRulesSchema>;

export const RulesOperationEnum = z.enum(["get", "list", "create", "update", "delete"]);
export type RulesOperation = z.infer<typeof RulesOperationEnum>;

export const SimulateRulesSchema = z.object({
  rulesAst: SecurityRulesetAstSchema.optional(),
  operation: RulesOperationEnum,
  path: z.string().min(1).max(2_048),
  auth: z.union([SafeSimulateRecordSchema, z.null()]).optional(),
  resourceData: SafeSimulateRecordSchema.nullable().optional(),
  incomingData: SafeSimulateRecordSchema.nullable().optional(),
});
export type SimulateRulesRequest = z.infer<typeof SimulateRulesSchema>;

export const SimulateRulesResultSchema = z.object({
  allowed: z.boolean(),
  matchedRule: z.string().nullable(),
  evaluationTrace: z.array(z.string()),
});
export type SimulateRulesResult = z.infer<typeof SimulateRulesResultSchema>;

/* -------------------------------------------------------------------------- */
/* Index recommendations (§2.8 / §6.5)                                        */
/* -------------------------------------------------------------------------- */

export const IndexRecommendationFieldSchema = z.object({
  path: z.string().min(1),
  dir: z.enum(["asc", "desc"]),
});
export type IndexRecommendationField = z.infer<typeof IndexRecommendationFieldSchema>;

export const IndexRecommendationStatusEnum = z.enum(["pending", "applied", "dismissed"]);
export type IndexRecommendationStatus = z.infer<typeof IndexRecommendationStatusEnum>;

export const IndexRecommendationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  fingerprint: z.string(),
  collectionPath: z.string(),
  recommendedFields: z.array(IndexRecommendationFieldSchema),
  sampleQuery: z.unknown(),
  reason: z.string(),
  hitCount: z.number().int().nonnegative(),
  totalDurationMs: z.number().nonnegative(),
  maxDurationMs: z.number().nonnegative(),
  status: IndexRecommendationStatusEnum,
  lastSeenAt: z.string(),
  createdAt: z.string(),
});
export type IndexRecommendation = z.infer<typeof IndexRecommendationSchema>;

export const IndexRecommendationListResponseSchema = z.object({
  recommendations: z.array(IndexRecommendationSchema),
});
export type IndexRecommendationListResponse = z.infer<typeof IndexRecommendationListResponseSchema>;

export const ApplyRecommendationResponseSchema = z.object({
  applied: z.literal(true),
  id: z.string(),
  fingerprint: z.string(),
});

export const DismissRecommendationResponseSchema = z.object({
  dismissed: z.literal(true),
  id: z.string(),
});


/** Bounded, permission-filtered reverse references. Cursors are opaque. */
export const ReferencedByRequestSchema = z.object({
  targetPath: DocumentPathSchema,
  collection: CollectionPathSchema.optional(),
  field: DotPathSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(32768).optional(),
  select: SelectFieldsSchema.optional(),
  include: z.array(IncludeSpecSchema).max(10).optional(),
}).strict();
