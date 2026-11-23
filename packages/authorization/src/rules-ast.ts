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

export type AstOperand = AstOperandVal | AstOperandVar | unknown;

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

export type { ApiKeyRecord, SecurityRulesetRecord } from "@vellum/database-control";

export interface AuthorizeOperationParams {
  apiKeyRecord: ApiKeyRecord;
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
}

export interface AuthorizationResult {
  allowed: boolean;
  mode: "server_key_scope" | "security_rules_ast" | "system_bypass";
  matchedRule?: string;
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

  const rulesAst = rulesetRecord?.rulesAst as SecurityRulesetAst | undefined;
  if (!rulesAst || !Array.isArray(rulesAst.rules)) {
    throw new VellumError(
      "PERMISSION_DENIED",
      `Security rules denied '${operation}' on path '${path}' (no active ruleset configured).`,
      { path, operation }
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

    if (expr !== undefined) {
      const allowed =
        typeof expr === "boolean"
          ? expr
          : evaluateAstNode(expr, {
              auth: authContext,
              pathParams,
              resourceData,
              requestData,
              requestTimeMs,
            });
      if (allowed) {
        return { allowed: true, mode: "security_rules_ast", matchedRule: rule.match };
      }
    }
  }

  throw new VellumError("PERMISSION_DENIED", `Security rules denied '${operation}' on path '${path}'.`, {
    path,
    operation,
  });
}
