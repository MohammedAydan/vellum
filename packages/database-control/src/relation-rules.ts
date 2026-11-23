/**
 * @vellum/database-control - Relation Rules validation
 * Shared by the in-memory and PostgreSQL control-plane stores so both
 * enforce identical constraints before persisting `project_relation_rules`.
 */

import { VellumError } from "@vellum/core";
import type { RelationRuleInput } from "./types.js";

/** Mirrors the document engine's hard cap on EngineContext.relationRules. */
export const MAX_RELATION_RULES_PER_PROJECT = 50;

const VALID_ON_DELETE: ReadonlySet<string> = new Set(["cascade", "set_null", "restrict"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Validates and normalizes a full-replacement rule set:
 *  - at most 50 rules;
 *  - non-empty collection / field, valid onDelete, optional non-empty targetCollection;
 *  - no duplicate (collection, field) pairs — the two define one dependent edge.
 */
export function validateRelationRuleInputs(rules: RelationRuleInput[]): RelationRuleInput[] {
  if (!Array.isArray(rules) || rules.length > MAX_RELATION_RULES_PER_PROJECT) {
    throw new VellumError(
      "INVALID_ARGUMENT",
      `rules must be an array of at most ${MAX_RELATION_RULES_PER_PROJECT} relation rules`
    );
  }
  const seen = new Set<string>();
  return rules.map((rule, index) => {
    if (
      !rule ||
      typeof rule !== "object" ||
      !isNonEmptyString(rule.collection) ||
      !isNonEmptyString(rule.field) ||
      !VALID_ON_DELETE.has(rule.onDelete) ||
      (rule.targetCollection !== undefined &&
        rule.targetCollection !== null &&
        !isNonEmptyString(rule.targetCollection))
    ) {
      throw new VellumError(
        "INVALID_ARGUMENT",
        `Relation rule at index ${index} requires non-empty 'collection' and 'field', a valid 'onDelete' (cascade | set_null | restrict), and an optional non-empty 'targetCollection'`
      );
    }
    const key = `${rule.collection}	${rule.field}`;
    if (seen.has(key)) {
      throw new VellumError(
        "INVALID_ARGUMENT",
        `Duplicate relation rule for collection '${rule.collection}' field '${rule.field}'`
      );
    }
    seen.add(key);
    return {
      collection: rule.collection,
      field: rule.field,
      onDelete: rule.onDelete,
      ...(rule.targetCollection !== undefined && rule.targetCollection !== null
        ? { targetCollection: rule.targetCollection }
        : {}),
    };
  });
}
