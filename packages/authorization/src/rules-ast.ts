/**
 * @vellum/authorization - Declarative Security Rules AST Validator & Evaluator
 * Strictly matches Specification Section 10 and System Limits Section 2.3.
 */

import { VellumError, SYSTEM_LIMITS, getFieldByPath, wireValuesEqual, compareWireValues } from "@vellum/core";
import type { ApiKeyRecord, SecurityRulesetRecord } from "@vellum/database-control";
import type { AuthContext } from "./jwt.js";

const hasOwn = Object.prototype.hasOwnProperty;

/** Keys blocked everywhere in AST paths, bindings, and `hasKey` to prevent prototype pollution / sandbox escape. */
const DANGEROUS_KEYS = new Set<string>(["__proto__", "constructor", "prototype"]);

/** Hard runtime budgets for AST evaluation (prevents CPU DoS on unvalidated or crafted ASTs). */
const MAX_EVAL_STEPS = 256;
const MAX_EVAL_DEPTH = SYSTEM_LIMITS.RULES_AST_MAX_DEPTH + 2;
const MAX_IN_OPERAND_ELEMENTS = 256;
const MAX_RULES_PER_RULESET = 200;
const MAX_PATTERN_LENGTH = 2_048;
const MAX_TARGET_PATH_LENGTH = 4_096;

const ALLOWED_RULE_OPS = new Set<string>(["get", "list", "create", "update", "delete", "read", "write"]);
const ALLOWED_COMPARISON_OPS = new Set<string>(["==", "!=", "<", "<=", ">", ">=", "in", "hasKey", "isType"]);
const ALLOWED_AUTH_OPERATIONS = new Set<string>(["get", "list", "create", "update", "delete", "indexes:manage"]);

interface CompiledPatternSegment {
  kind: "literal" | "param" | "recursive";
  value: string;
}

/** Bounded LRU cache for pre-parsed rule match patterns (high-throughput hot path). */
const PATTERN_CACHE_MAX = 4_096;
const PATTERN_CACHE = new Map<string, readonly CompiledPatternSegment[] | null>();

function compileRulePattern(pattern: string): readonly CompiledPatternSegment[] | null {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
    return null;
  }
  const cached = PATTERN_CACHE.get(pattern);
  if (cached !== undefined) {
    PATTERN_CACHE.delete(pattern);
    PATTERN_CACHE.set(pattern, cached);
    return cached;
  }
  const rawSegments = pattern.split("/");
  const compiled: CompiledPatternSegment[] = [];
  let valid = true;
  for (let i = 0; i < rawSegments.length; i += 1) {
    const pSeg = rawSegments[i]!;
    if (pSeg.startsWith("{") && pSeg.endsWith("=**}")) {
      const wildcardName = pSeg.slice(1, -4);
      if (wildcardName.length === 0 || DANGEROUS_KEYS.has(wildcardName)) {
        valid = false;
        break;
      }
      compiled.push({ kind: "recursive", value: wildcardName });
    } else if (pSeg.startsWith("{") && pSeg.endsWith("}")) {
      const paramName = pSeg.slice(1, -1);
      if (paramName.length === 0 || DANGEROUS_KEYS.has(paramName)) {
        valid = false;
        break;
      }
      compiled.push({ kind: "param", value: paramName });
    } else {
      compiled.push({ kind: "literal", value: pSeg });
    }
  }
  const entry = valid ? compiled : null;
  if (PATTERN_CACHE.size >= PATTERN_CACHE_MAX) {
    const oldest = PATTERN_CACHE.keys().next();
    if (oldest.done !== true) PATTERN_CACHE.delete(oldest.value);
  }
  PATTERN_CACHE.set(pattern, entry);
  return entry;
}

function hasDangerousPathSegment(dottedPath: string): boolean {
  if (
    !dottedPath.includes("__proto__") &&
    !dottedPath.includes("constructor") &&
    !dottedPath.includes("prototype")
  ) {
    return false;
  }
  const parts = dottedPath.split(".");
  for (let i = 0; i < parts.length; i += 1) {
    if (DANGEROUS_KEYS.has(parts[i]!)) return true;
  }
  return false;
}

export interface AstOperandVal {
  val: unknown;
}

export interface AstOperandVar {
  var: string;
}

/**
 * Reads another document. `exists` yields true/false; otherwise the value is the field at `field`
 * (dotted path inside the document's data, empty for the whole data map). A missing document, an
 * invalid id or a lookup that was not prefetched makes the whole rule deny.
 */
export interface AstOperandDoc {
  doc: { collection: string; id: unknown; field?: string; exists?: boolean };
}

export type AstOperand = AstOperandVal | AstOperandVar | AstOperandDoc | unknown;

/** Documents a rule may read, keyed by full path. `null` means the document does not exist. */
export type RuleLookups = ReadonlyMap<string, Record<string, unknown> | null>;

/** At most this many documents are read per authorization check. */
export const MAX_RULE_LOOKUPS = 10;

export interface AstExpressionNode {
  op: string;
  conditions?: AstExpressionNode[];
  condition?: AstExpressionNode;
  left?: AstOperand;
  right?: AstOperand;
}

export type AstExpression = boolean | AstExpressionNode;

export interface SecurityRuleDefinition {
  match: string;
  allow: {
    get?: AstExpression;
    list?: AstExpression;
    create?: AstExpression;
    update?: AstExpression;
    delete?: AstExpression;
    read?: AstExpression;
    write?: AstExpression;
    [key: string]: AstExpression | undefined;
  };
}

export interface SecurityRulesetAst {
  version: number;
  rules: SecurityRuleDefinition[];
}

export interface RuleEvaluationContext {
  auth: AuthContext;
  pathParams: Record<string, string>;
  resourceData: Record<string, unknown> | null;
  requestData: Record<string, unknown> | null;
  requestTimeMs: number;
  lookups?: RuleLookups | undefined;
  /** Set when a rule needed a document it could not read; the rule is then denied. */
  lookupState?: { failed: boolean } | undefined;
}

const LOOKUP_COLLECTION = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)*$/;

function isDocOperand(operand: unknown): operand is AstOperandDoc {
  return Boolean(operand) && typeof operand === "object" && hasOwn.call(operand as object, "doc");
}

/** The document path an operand reads, or null when its id is not a usable string right now. */
function docOperandPath(operand: AstOperandDoc, context: RuleEvaluationContext): string | null {
  const spec = operand.doc;
  if (!spec || typeof spec.collection !== "string" || !LOOKUP_COLLECTION.test(spec.collection)) return null;
  const id = resolveOperand(spec.id, context);
  if (typeof id !== "string" || id.length === 0 || id.length > 1500) return null;
  if (id.includes("/") || id === "." || id === ".." || /^__.*__$/.test(id)) return null;
  for (let i = 0; i < id.length; i += 1) if (id.charCodeAt(i) < 0x20) return null;
  return `${spec.collection}/${id}`;
}

/**
 * Validates a Security Ruleset AST and enforces max depth <= 10 and max nodes <= 100 per rule.
 */
export function validateSecurityRulesetAst(rulesetAst: unknown): boolean {
  if (
    !rulesetAst ||
    typeof rulesetAst !== "object" ||
    (rulesetAst as Record<string, unknown>)["version"] !== 1 ||
    !Array.isArray((rulesetAst as Record<string, unknown>)["rules"])
  ) {
    throw new VellumError("INVALID_ARGUMENT", "Security ruleset AST must have version: 1 and a 'rules' array");
  }

  const typed = rulesetAst as SecurityRulesetAst;
  if (typed.rules.length > MAX_RULES_PER_RULESET) {
    throw new VellumError(
      "QUERY_TOO_COMPLEX",
      `Security ruleset exceeds maximum of ${MAX_RULES_PER_RULESET} rules`
    );
  }

  for (const rule of typed.rules) {
    if (!rule || typeof rule.match !== "string" || !rule.allow || typeof rule.allow !== "object") {
      throw new VellumError("INVALID_ARGUMENT", "Each rule requires a 'match' pattern string and 'allow' object");
    }
    if (compileRulePattern(rule.match) === null) {
      throw new VellumError("INVALID_ARGUMENT", `Invalid or unsafe rule match pattern '${rule.match.slice(0, 128)}'`);
    }
    for (const [opName, expr] of Object.entries(rule.allow)) {
      if (expr === undefined || expr === null || expr === false) {
        if (!ALLOWED_RULE_OPS.has(opName)) {
          throw new VellumError("INVALID_ARGUMENT", `Unsupported rule operation '${opName}'`);
        }
        continue;
      }
      if (!ALLOWED_RULE_OPS.has(opName)) {
        throw new VellumError("INVALID_ARGUMENT", `Unsupported rule operation '${opName}'`);
      }
      const stats = { nodes: 0 };
      validateAstExpression(expr, 1, stats);
    }
  }
  return true;
}

function validateAstOperand(operand: unknown): void {
  if (isDocOperand(operand)) {
    const spec = operand.doc;
    if (
      !spec ||
      typeof spec !== "object" ||
      typeof spec.collection !== "string" ||
      !LOOKUP_COLLECTION.test(spec.collection) ||
      spec.collection.length > 500 ||
      (spec.field !== undefined && (typeof spec.field !== "string" || spec.field.length > 512 || hasDangerousPathSegment(spec.field)))
    ) {
      throw new VellumError("INVALID_ARGUMENT", "Invalid document lookup in security rule AST");
    }
    validateAstOperand(spec.id);
    return;
  }
  if (operand && typeof operand === "object" && hasOwn.call(operand, "var")) {
    const varPath = (operand as AstOperandVar).var;
    if (typeof varPath !== "string" || varPath.length === 0 || varPath.length > 512 || hasDangerousPathSegment(varPath)) {
      throw new VellumError("INVALID_ARGUMENT", "Invalid or unsafe variable path in security rule AST");
    }
  }
}

function validateAstExpression(
  expr: unknown,
  depth: number,
  stats: { nodes: number },
  visited = new Set<object>()
): void {
  if (expr && typeof expr === "object") {
    if (visited.has(expr)) {
      throw new VellumError("INVALID_ARGUMENT", "Circular reference detected in security rules AST");
    }
    visited.add(expr);
  }

  if (depth > SYSTEM_LIMITS.RULES_AST_MAX_DEPTH) {
    throw new VellumError(
      "QUERY_TOO_COMPLEX",
      `Security rule AST exceeds maximum depth of ${SYSTEM_LIMITS.RULES_AST_MAX_DEPTH}`
    );
  }
  stats.nodes += 1;
  if (stats.nodes > SYSTEM_LIMITS.RULES_AST_MAX_NODES) {
    throw new VellumError(
      "QUERY_TOO_COMPLEX",
      `Security rule AST exceeds maximum node count of ${SYSTEM_LIMITS.RULES_AST_MAX_NODES}`
    );
  }

  if (typeof expr === "boolean") return;
  if (!expr || typeof expr !== "object") {
    throw new VellumError("INVALID_ARGUMENT", "Invalid AST expression node");
  }

  const node = expr as AstExpressionNode;
  if (node.op === "all" || node.op === "any") {
    if (!Array.isArray(node.conditions) || node.conditions.length === 0) {
      throw new VellumError("INVALID_ARGUMENT", `Combinator '${node.op}' requires a non-empty 'conditions' array`);
    }
    for (const child of node.conditions) {
      validateAstExpression(child, depth + 1, stats, visited);
    }
    return;
  }
  if (node.op === "not") {
    if (node.condition === undefined || node.condition === null) {
      throw new VellumError("INVALID_ARGUMENT", "Operator 'not' requires a 'condition'");
    }
    validateAstExpression(node.condition, depth + 1, stats, visited);
    return;
  }
  if (ALLOWED_COMPARISON_OPS.has(node.op)) {
    if (node.left === undefined || node.right === undefined) {
      throw new VellumError("INVALID_ARGUMENT", `Comparison operator '${node.op}' requires 'left' and 'right' operands`);
    }
    validateAstOperand(node.left);
    validateAstOperand(node.right);
    return;
  }
  throw new VellumError("INVALID_ARGUMENT", `Unsupported AST operator '${node.op}'`);
}

/**
 * Matches a rule pattern (e.g. `users/{userId}` or `orgs/{orgId}/docs/{doc=**}`) against a target path.
 * Returns extracted wildcard bindings `{ userId: "u_123" }` or `null` if not matched.
 */
export function matchRulePathPattern(pattern: string, targetPath: string): Record<string, string> | null {
  if (typeof targetPath !== "string" || targetPath.length > MAX_TARGET_PATH_LENGTH) return null;
  // Canonical form has NO leading slash (document paths are `users/u1`). The DSL
  // compiler emits `/users/{userId}`, so strip one leading slash from both sides
  // here, at the single matching boundary, instead of trusting every caller.
  const compiled = compileRulePattern(pattern.startsWith("/") ? pattern.slice(1) : pattern);
  if (compiled === null) return null;

  const targetSegments = (targetPath.startsWith("/") ? targetPath.slice(1) : targetPath).split("/");
  const bindings: Record<string, string> = {};

  for (let i = 0; i < compiled.length; i += 1) {
    const seg = compiled[i]!;
    if (seg.kind === "recursive") {
      if (i >= targetSegments.length) return null;
      bindings[seg.value] = targetSegments.slice(i).join("/");
      return bindings;
    }
    if (i >= targetSegments.length) return null;
    const tSeg = targetSegments[i]!;
    if (seg.kind === "param") {
      bindings[seg.value] = tSeg;
    } else if (seg.value !== tSeg) {
      return null;
    }
  }

  if (compiled.length !== targetSegments.length) {
    return null;
  }
  return bindings;
}

function resolveOperand(operand: unknown, context: RuleEvaluationContext): unknown {
  if (operand === null || typeof operand !== "object") return operand;
  if (isDocOperand(operand)) {
    const path = docOperandPath(operand, context);
    const lookup = path !== null && context.lookups ? context.lookups.get(path) : undefined;
    if (operand.doc.exists === true) {
      if (path === null || lookup === undefined) {
        if (context.lookupState) context.lookupState.failed = true;
        return undefined;
      }
      return lookup !== null;
    }
    if (lookup === undefined || lookup === null) {
      if (context.lookupState) context.lookupState.failed = true;
      return undefined;
    }
    const field = operand.doc.field ?? "";
    if (field === "") return lookup;
    if (hasDangerousPathSegment(field)) return undefined;
    return getFieldByPath(lookup, field);
  }
  if (hasOwn.call(operand, "val")) return (operand as AstOperandVal).val;
  if (hasOwn.call(operand, "var") && typeof (operand as AstOperandVar).var === "string") {
    const varPath = (operand as AstOperandVar).var;
    if (varPath.length === 0 || varPath.length > 512 || hasDangerousPathSegment(varPath)) {
      return undefined;
    }
    // `auth.*` and `request.auth.*` are aliases of the same AuthContext object.
    if (varPath === "auth" || varPath === "request.auth") return context.auth ?? null;
    if (varPath === "auth.uid" || varPath === "request.auth.uid") return context.auth?.uid ?? null;
    if (varPath === "auth.email" || varPath === "request.auth.email") return context.auth?.email ?? null;
    if (varPath === "auth.email_verified" || varPath === "request.auth.email_verified") {
      return context.auth?.email_verified ?? null;
    }
    if (varPath === "auth.is_anonymous" || varPath === "request.auth.is_anonymous") {
      return context.auth?.is_anonymous ?? null;
    }
    if (varPath.startsWith("auth.claims.") || varPath.startsWith("request.auth.claims.")) {
      const prefixLen = varPath.startsWith("request.auth.claims.") ? 20 : 12;
      return getFieldByPath(context.auth?.claims ?? {}, varPath.slice(prefixLen));
    }
    if (varPath.startsWith("path.")) {
      const param = varPath.slice(5);
      if (
        !param ||
        DANGEROUS_KEYS.has(param) ||
        !context.pathParams ||
        !hasOwn.call(context.pathParams, param)
      ) {
        return null;
      }
      return context.pathParams[param] ?? null;
    }
    if (varPath === "resource.data") return context.resourceData ?? null;
    if (varPath.startsWith("resource.data.")) {
      return getFieldByPath(context.resourceData ?? {}, varPath.slice(14));
    }
    if (varPath === "request.data") return context.requestData ?? null;
    if (varPath.startsWith("request.data.")) {
      return getFieldByPath(context.requestData ?? {}, varPath.slice(13));
    }
    if (varPath === "request.time") return context.requestTimeMs;
  }
  return undefined;
}

/**
 * `auth.uid` / `auth.email` resolve to null for unauthenticated callers. If such
 * an operand is compared with another null (a document field set to null or an
 * unset path parameter), `==` would be true and an anonymous caller would match
 * "owner == auth.uid". An unauthenticated identity never equals anything.
 */
function isAuthIdentityOperand(operand: unknown): boolean {
  if (operand === null || typeof operand !== "object" || !hasOwn.call(operand, "var")) return false;
  const v = (operand as AstOperandVar).var;
  return (
    v === "auth.uid" || v === "request.auth.uid" || v === "auth.email" || v === "request.auth.email"
  );
}

interface EvalBudget {
  steps: number;
}

function evaluateAstNodeInternal(
  expr: AstExpression,
  context: RuleEvaluationContext,
  depth: number,
  budget: EvalBudget
): boolean {
  if (typeof expr === "boolean") return expr;
  if (!expr || typeof expr !== "object") return false;
  if (depth > MAX_EVAL_DEPTH) return false;
  budget.steps += 1;
  if (budget.steps > MAX_EVAL_STEPS) return false;

  switch (expr.op) {
    case "all": {
      const conditions = expr.conditions;
      if (!Array.isArray(conditions)) return false;
      for (let i = 0; i < conditions.length; i += 1) {
        if (!evaluateAstNodeInternal(conditions[i]!, context, depth + 1, budget)) return false;
      }
      return true;
    }
    case "any": {
      const conditions = expr.conditions;
      if (!Array.isArray(conditions)) return false;
      for (let i = 0; i < conditions.length; i += 1) {
        if (evaluateAstNodeInternal(conditions[i]!, context, depth + 1, budget)) return true;
      }
      return false;
    }
    case "not":
      return expr.condition !== undefined ? !evaluateAstNodeInternal(expr.condition, context, depth + 1, budget) : false;
    case "==": {
      const l = resolveOperand(expr.left, context);
      const r = resolveOperand(expr.right, context);
      if (l === null && r === null && (isAuthIdentityOperand(expr.left) || isAuthIdentityOperand(expr.right))) {
        return false;
      }
      return l !== undefined && r !== undefined && wireValuesEqual(l, r);
    }
    case "!=": {
      const l = resolveOperand(expr.left, context);
      const r = resolveOperand(expr.right, context);
      return l !== undefined && r !== undefined && !wireValuesEqual(l, r);
    }
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const l = resolveOperand(expr.left, context);
      const r = resolveOperand(expr.right, context);
      if (l === undefined || r === undefined || l === null || r === null) return false;
      const cmp = compareWireValues(l, r, "asc");
      if (expr.op === "<") return cmp < 0;
      if (expr.op === "<=") return cmp <= 0;
      if (expr.op === ">") return cmp > 0;
      return cmp >= 0;
    }
    case "in": {
      const l = resolveOperand(expr.left, context);
      const r = resolveOperand(expr.right, context);
      if (!Array.isArray(r) || r.length > MAX_IN_OPERAND_ELEMENTS) return false;
      // An unauthenticated identity (null) never matches a null entry in the list.
      if (l === null && isAuthIdentityOperand(expr.left)) return false;
      for (let i = 0; i < r.length; i += 1) {
        budget.steps += 1;
        if (budget.steps > MAX_EVAL_STEPS) return false;
        if (wireValuesEqual(l, r[i])) return true;
      }
      return false;
    }
    case "hasKey": {
      const l = resolveOperand(expr.left, context);
      const r = resolveOperand(expr.right, context);
      return Boolean(
        l &&
          typeof l === "object" &&
          !Array.isArray(l) &&
          typeof r === "string" &&
          !DANGEROUS_KEYS.has(r) &&
          hasOwn.call(l, r)
      );
    }
    case "isType": {
      const l = resolveOperand(expr.left, context);
      const expectedType = resolveOperand(expr.right, context);
      if (expectedType === "null") return l === null;
      if (expectedType === "bool" || expectedType === "boolean") return typeof l === "boolean";
      if (expectedType === "string") return typeof l === "string";
      if (expectedType === "number") return typeof l === "number";
      if (expectedType === "array") return Array.isArray(l);
      if (expectedType === "map") {
        return Boolean(l && typeof l === "object" && !Array.isArray(l) && !hasOwn.call(l, "$t"));
      }
      if (typeof l === "object" && l !== null && hasOwn.call(l, "$t")) {
        return (l as Record<string, unknown>)["$t"] === expectedType;
      }
      return false;
    }
    default:
      return false;
  }
}

export function evaluateAstNode(expr: AstExpression, context: RuleEvaluationContext): boolean {
  if (typeof expr === "boolean") return expr;
  return evaluateAstNodeInternal(expr, context, 1, { steps: 0 });
}

function mentionsResource(node: unknown, depth = 0): boolean {
  if (depth > 64 || node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((n) => mentionsResource(n, depth + 1));
  const rec = node as Record<string, unknown>;
  if (typeof rec["var"] === "string" && (rec["var"].startsWith("resource") || rec["var"].startsWith("request.resource"))) return true;
  return Object.values(rec).some((v) => mentionsResource(v, depth + 1));
}

/** True when the expression can become true only because `resource` is empty (negation or type test on it). */
function isNonMonotoneOnResource(node: unknown, depth = 0): boolean {
  if (depth > 64 || node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((n) => isNonMonotoneOnResource(n, depth + 1));
  const rec = node as Record<string, unknown>;
  if ((rec["op"] === "not" || rec["op"] === "isType") && mentionsResource(rec)) return true;
  return Object.values(rec).some((v) => isNonMonotoneOnResource(v, depth + 1));
}

export type { ApiKeyRecord, SecurityRulesetRecord } from "@vellum/database-control";

export interface AuthorizeOperationParams {
  apiKeyRecord: ApiKeyRecord | null;
  rulesetRecord: SecurityRulesetRecord | null;
  operation: "get" | "list" | "create" | "update" | "delete" | "indexes:manage";
  path: string;
  authContext?: AuthContext | undefined;
  resourceData?: Record<string, unknown> | null | undefined;
  requestData?: Record<string, unknown> | null | undefined;
  requestTimeMs?: number | undefined;
  /**
   * Internal system bypass. Only ever set by trusted in-process services (e.g.
   * the auth DocumentProjector); it is never derived from request headers.
   */
  bypassRules?: boolean | undefined;
  /**
   * The check happens before any document is read (collection list, query, aggregate,
   * export), so there is no `resource` yet and it is evaluated as empty. A rule that
   * negates or type-tests `resource` would then pass for an empty resource and expose
   * every row (for example `!(resource.data.private == true)`). With this flag such
   * rules do not count as a collection-level allow.
   */
  collectionLevel?: boolean | undefined;
  /** Documents read for `get()` / `exists()` in rules (see `collectRuleLookups`). */
  lookups?: RuleLookups | undefined;
}

export interface AuthorizationResult {
  allowed: boolean;
  mode: "server_key_scope" | "security_rules_ast" | "system_bypass";
  matchedRule?: string;
}

/**
 * True when some rule for this path defines a per-document `get` (or `read`). Bulk reads use it to decide
 * whether rows need their own `get` check on top of the collection-level `list` check: a path whose rules
 * only grant `list` has no row-level rule to apply.
 */
export function hasRowLevelGetRule(rulesetRecord: { rulesAst?: unknown } | null | undefined, path: string): boolean {
  const rulesAst = rulesetRecord?.rulesAst as SecurityRulesetAst | undefined;
  if (!rulesAst || !Array.isArray(rulesAst.rules)) return false;
  const max = Math.min(rulesAst.rules.length, MAX_RULES_PER_RULESET);
  for (let i = 0; i < max; i += 1) {
    const rule = rulesAst.rules[i];
    if (!rule || typeof rule.match !== "string" || !rule.allow || typeof rule.allow !== "object") continue;
    if (!matchRulePathPattern(rule.match, path)) continue;
    if (hasOwn.call(rule.allow, "get") || hasOwn.call(rule.allow, "read")) return true;
  }
  return false;
}

/**
 * Evaluates authorization for an operation (`get`, `list`, `create`, `update`, `delete`, `indexes:manage`).
 * - Server keys (`sk_`) bypass Security Rules AST if they hold the required scope.
 * - Public keys (`pk_`) unconditionally evaluate the active Security Rules AST.
 */
export function authorizeOperation({
  apiKeyRecord,
  rulesetRecord,
  operation,
  path,
  authContext = { uid: null, claims: {} },
  resourceData = null,
  requestData = null,
  requestTimeMs = Date.now(),
  bypassRules = false,
  collectionLevel = false,
  lookups,
}: AuthorizeOperationParams): AuthorizationResult {
  // Explicit, auditable system bypass. Must be strictly boolean `true`.
  if (bypassRules === true) {
    return { allowed: true, mode: "system_bypass" };
  }

  if (!ALLOWED_AUTH_OPERATIONS.has(operation)) {
    throw new VellumError("PERMISSION_DENIED", `Unsupported operation '${String(operation)}'`, {
      operation,
    });
  }

  // Defense-in-depth: fail closed if API key is missing, revoked, or expired
  if (!apiKeyRecord || apiKeyRecord.revokedAt) {
    throw new VellumError("UNAUTHENTICATED", "Invalid or revoked API key");
  }
  if (apiKeyRecord.expiresAt) {
    const expMs = Date.parse(apiKeyRecord.expiresAt);
    if (!Number.isFinite(expMs) || expMs <= requestTimeMs) {
      throw new VellumError("UNAUTHENTICATED", "API key has expired");
    }
  }

  if (apiKeyRecord.keyType === "server") {
    const requiredScope =
      operation === "get" || operation === "list"
        ? "documents:read"
        : operation === "indexes:manage"
        ? "indexes:manage"
        : "documents:write";
    const scopes = Array.isArray(apiKeyRecord.scopes) ? apiKeyRecord.scopes : [];
    if (!scopes.includes(requiredScope) && !scopes.includes("*")) {
      throw new VellumError(
        "PERMISSION_DENIED",
        `Server API key lacks required scope '${requiredScope}' for operation '${operation}'`,
        { operation, requiredScope }
      );
    }
    return { allowed: true, mode: "server_key_scope" };
  }

  if (apiKeyRecord.keyType !== "public") {
    throw new VellumError("PERMISSION_DENIED", "Unsupported API key type", { operation });
  }

  // Public key cannot manage composite indexes
  if (operation === "indexes:manage") {
    throw new VellumError("PERMISSION_DENIED", "Public API keys cannot manage composite indexes", {
      operation,
    });
  }

  // Collection-level checks use an internal placeholder document id; never show it to callers.
  const shownPath = path.replace(/\/__collection_check__$/, "");
  const rulesAst = rulesetRecord?.rulesAst as SecurityRulesetAst | undefined;
  if (!rulesAst || !Array.isArray(rulesAst.rules)) {
    throw new VellumError(
      "PERMISSION_DENIED",
      `Security rules denied '${operation}' on path '${shownPath}' (no active ruleset configured).`,
      { path: shownPath, operation }
    );
  }

  const rules = rulesAst.rules;
  const maxRules = Math.min(rules.length, MAX_RULES_PER_RULESET);
  for (let i = 0; i < maxRules; i += 1) {
    const rule = rules[i]!;
    if (!rule || typeof rule.match !== "string" || !rule.allow || typeof rule.allow !== "object") continue;
    const pathParams = matchRulePathPattern(rule.match, path);
    if (!pathParams) continue;

    const allowObj = rule.allow;
    const expr =
      (hasOwn.call(allowObj, operation) ? allowObj[operation] : undefined) ??
      ((operation === "get" || operation === "list") && hasOwn.call(allowObj, "read") ? allowObj.read : undefined) ??
      ((operation === "create" || operation === "update" || operation === "delete") && hasOwn.call(allowObj, "write")
        ? allowObj.write
        : undefined);

    if (expr !== undefined && collectionLevel && typeof expr !== "boolean" && isNonMonotoneOnResource(expr)) {
      continue;
    }
    if (expr !== undefined) {
      const lookupState = { failed: false };
      const allowed =
        typeof expr === "boolean"
          ? expr
          : evaluateAstNode(expr, {
              auth: authContext,
              pathParams,
              resourceData,
              requestData,
              requestTimeMs,
              lookups,
              lookupState,
            });
      // A rule that needed a document it could not read never allows, even through `not`.
      if (allowed && !lookupState.failed) {
        return { allowed: true, mode: "security_rules_ast", matchedRule: rule.match };
      }
    }
  }

  throw new VellumError("PERMISSION_DENIED", `Security rules denied '${operation}' on path '${shownPath}'.`, {
    path: shownPath,
    operation,
  });
}


function rulesExpressionFor(allowObj: Record<string, AstExpression | undefined>, operation: string): AstExpression | undefined {
  return (
    (hasOwn.call(allowObj, operation) ? allowObj[operation] : undefined) ??
    ((operation === "get" || operation === "list") && hasOwn.call(allowObj, "read") ? allowObj["read"] : undefined) ??
    ((operation === "create" || operation === "update" || operation === "delete") && hasOwn.call(allowObj, "write")
      ? allowObj["write"]
      : undefined)
  );
}

function containsDocOperand(node: unknown, depth = 0): boolean {
  if (!node || typeof node !== "object" || depth > 40) return false;
  if (isDocOperand(node)) return true;
  for (const value of Object.values(node as Record<string, unknown>)) {
    if (value && typeof value === "object" && containsDocOperand(value, depth + 1)) return true;
  }
  return false;
}

const LOOKUP_USE_CACHE = new WeakMap<object, boolean>();

/** True when any rule in the ruleset reads another document. Cached per ruleset object. */
export function rulesetUsesLookups(rulesetRecord: { rulesAst?: unknown } | null | undefined): boolean {
  const ast = rulesetRecord?.rulesAst;
  if (!ast || typeof ast !== "object") return false;
  const cached = LOOKUP_USE_CACHE.get(ast);
  if (cached !== undefined) return cached;
  const result = containsDocOperand(ast);
  LOOKUP_USE_CACHE.set(ast, result);
  return result;
}

function collectDocPaths(node: unknown, context: RuleEvaluationContext, out: Set<string>, depth = 0): void {
  if (!node || typeof node !== "object" || depth > 40 || out.size >= MAX_RULE_LOOKUPS) return;
  if (isDocOperand(node)) {
    const path = docOperandPath(node, context);
    if (path !== null) out.add(path);
    return;
  }
  for (const value of Object.values(node as Record<string, unknown>)) {
    if (value && typeof value === "object") collectDocPaths(value, context, out, depth + 1);
  }
}

/**
 * The documents the matching rules will ask for, so the caller can read them (one batched read) before
 * the synchronous check. At most `MAX_RULE_LOOKUPS` paths; anything beyond that is not read and denies.
 */
export function collectRuleLookups(params: {
  rulesetRecord: { rulesAst?: unknown } | null | undefined;
  operation: string;
  path: string;
  authContext?: AuthContext | undefined;
  resourceData?: Record<string, unknown> | null | undefined;
  requestData?: Record<string, unknown> | null | undefined;
  requestTimeMs?: number | undefined;
}): string[] {
  const ast = params.rulesetRecord?.rulesAst as SecurityRulesetAst | undefined;
  if (!ast || !Array.isArray(ast.rules) || !rulesetUsesLookups(params.rulesetRecord)) return [];
  const out = new Set<string>();
  const maxRules = Math.min(ast.rules.length, MAX_RULES_PER_RULESET);
  for (let i = 0; i < maxRules; i += 1) {
    const rule = ast.rules[i];
    if (!rule || typeof rule.match !== "string" || !rule.allow || typeof rule.allow !== "object") continue;
    const pathParams = matchRulePathPattern(rule.match, params.path);
    if (!pathParams) continue;
    const expr = rulesExpressionFor(rule.allow, params.operation);
    if (expr === undefined || typeof expr === "boolean") continue;
    collectDocPaths(
      expr,
      {
        auth: params.authContext ?? { uid: null, claims: {} },
        pathParams,
        resourceData: params.resourceData ?? null,
        requestData: params.requestData ?? null,
        requestTimeMs: params.requestTimeMs ?? Date.now(),
      },
      out
    );
  }
  return [...out];
}
