/**
 * @vellum/authorization - Canonical Authorization Port Contracts
 */

import type { ApiKeyRecord } from "@vellum/database-control";
import type { ApiKeyStore } from "../api-keys.js";
import type {
  AstExpression,
  AuthorizationResult,
  AuthorizeOperationParams,
  RuleEvaluationContext,
  SecurityRulesetAst,
} from "../rules-ast.js";
import type { RevocationStore } from "../session.js";

/** Outbound port for constant-time API key verification and cache invalidation. */
export interface ApiKeyVerifierPort {
  verifyApiKey(fullKey: unknown, controlStore: ApiKeyStore, pepper?: string): ApiKeyRecord;
  invalidateApiKeyCache(keyPrefix?: string): void;
}

/** Outbound port for declarative Security Rules AST validation and evaluation. */
export interface RulesEvaluatorPort {
  authorizeOperation(params: AuthorizeOperationParams): AuthorizationResult;
  validateSecurityRulesetAst(ast: unknown): SecurityRulesetAst;
  evaluateAstNode(node: AstExpression, ctx: RuleEvaluationContext): boolean;
}

/** Outbound port for JWT/session JTI revocation tracking. */
export type RevocationStorePort = RevocationStore;
