/** Transaction-local referential integrity. This is not a public read API. */
import { VellumError, SYSTEM_LIMITS, getFieldByPath, parseDocumentPath } from "@vellum/core";
import type { DocumentRecord, TxHandle as StorageTxHandle } from "@vellum/storage";
import { MAX_RELATION_DEPTH, parseReference } from "./relations.js";
import type { RelationRule } from "./types.js";

type ParsedPath = ReturnType<typeof parseDocumentPath>;
const MAX_CASCADE_DEPENDENTS = SYSTEM_LIMITS.MAX_QUERY_LIMIT;
function compareByPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function groupRelationRulesByCollection(rules: readonly RelationRule[]): Map<string, RelationRule[]> {
  const grouped = new Map<string, RelationRule[]>();
  for (const rule of rules) {
    const existing = grouped.get(rule.collection);
    if (existing) {
      existing.push(rule);
    } else {
      grouped.set(rule.collection, [rule]);
    }
  }
  // Preserve the original deterministic collection order (ascending).
  return new Map(
    Array.from(grouped.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );
}

export async function evaluateRelationRulesForDelete(params: {
  deletedPath: string;
  depth: number;
  rulesByCollection: Map<string, RelationRule[]>;
  tenant: { projectId: string };
  parsedByPath: Map<string, ParsedPath>;
  pendingRows: Map<string, DocumentRecord>;
  tx: StorageTxHandle;
  stageSetNull: (row: DocumentRecord, field: string) => void | Promise<void>;
  stageCascadeDelete: (row: DocumentRecord, depth: number) => void | Promise<void>;
}): Promise<number> {
  const {
    deletedPath,
    depth,
    rulesByCollection,
    parsedByPath,
    pendingRows,
    tx,
    stageSetNull,
    stageCascadeDelete,
  } = params;
  // `tenant` is carried in `params` for parity with the other capability
  // call sites; the enclosing transaction already binds it for RLS.
  if (rulesByCollection.size === 0) return 0;

  const rowsBefore = pendingRows.size;
  let parsedDeleted = parsedByPath.get(deletedPath);
  if (!parsedDeleted) {
    parsedDeleted = parseDocumentPath(deletedPath);
    parsedByPath.set(deletedPath, parsedDeleted);
  }
  const deletedCollection = parsedDeleted.collectionPath;

  for (const [collection, rules] of rulesByCollection) {
    // A rule with targetCollection only fires when the DELETED document lives
    // in that collection; unscoped rules apply to every target collection.
    const scopedRules = rules.filter(
      (r) => r.targetCollection === undefined || r.targetCollection === deletedCollection
    );
    if (scopedRules.length === 0) continue;
    // Same-batch rows win over their DB counterparts: a staged set_null that
    // removed the reference must hide the stale DB row, and a staged create
    // must be visible before the final flush.
    const byPath = new Map<string, DocumentRecord>();
    for (const [path, row] of pendingRows) {
      if (row.deletedAt !== null || row.collectionPath !== collection) continue;
      byPath.set(path, row);
    }

    const dbRows: DocumentRecord[] = [];
    if (typeof tx.listDependentsByReference === "function") {
      for (const rule of scopedRules) {
        // Bare argument form: the enclosing transaction already binds the
        // tenant for RLS, and this also works with adapter test doubles that
        // only implement the four-argument shape.
        const matches = await tx.listDependentsByReference(
          collection,
          rule.field,
          deletedPath,
          MAX_CASCADE_DEPENDENTS + 1
        );
        if (matches.length > MAX_CASCADE_DEPENDENTS) {
          throw new VellumError("FAILED_PRECONDITION", "Relation operation exceeds the dependent limit; narrow the relation set before deleting");
        }
        dbRows.push(...matches);
      }
    }
    for (const row of dbRows) {
      if (row.deletedAt !== null || pendingRows.has(row.path)) continue;
      if (!byPath.has(row.path)) byPath.set(row.path, row);
    }

    const candidates = Array.from(byPath.values()).sort(compareByPath);
    for (const candidate of candidates) {
      for (const rule of scopedRules) {
        const rawRef = getFieldByPath(candidate.data, rule.field);
        const values: unknown[] = Array.isArray(rawRef) ? rawRef : [rawRef];
        const referencesDeleted = values.some(
          (value) =>
            parseReference(value, { field: rule.field, collection: deletedCollection }) === deletedPath
        );
        if (!referencesDeleted) continue;
        if (depth > MAX_RELATION_DEPTH) {
          throw new VellumError("FAILED_PRECONDITION", "Relation cascade exceeds the maximum depth; delete dependent documents first");
        }
        if (rule.onDelete === "restrict") {
          // G1.5 side-channel hardening: never echo the blocking document's
          // path, the deleted path, or the reference field. A caller without
          // read access to the dependent could otherwise probe for the mere
          // EXISTENCE of documents in collections they cannot read.
          throw new VellumError(
            "RELATION_RESTRICT_VIOLATION",
            "Delete rejected: a relation rule restricts deleting this document while dependents reference it"
          );
        }
        if (rule.onDelete === "set_null") {
          await stageSetNull(candidate, rule.field);
        } else {
          await stageCascadeDelete(candidate, depth);
        }
        break;
      }
    }
  }
  return pendingRows.size - rowsBefore;
}

