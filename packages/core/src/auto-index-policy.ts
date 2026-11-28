/**
 * @vellum/core - Auto-index decision policy (pure, no I/O).
 *
 * Decides whether a recorded uncovered-query pattern should become an
 * auto-created composite index, and which auto-created indexes to retire.
 * Thresholds follow the 0.0.11 plan; every decision carries its evidence.
 */

export type AutoIndexMode = "off" | "observe" | "live";

export interface AutoIndexThresholds {
  minHits24h: number;
  minDistinctHours: number;
  minDocs: number;
  minP95Ms: number;
  maxFields: number;
  /** Percent of the plan composite-index cap usable by the engine. */
  budgetPct: number;
  maxBuildsPerProjectPerDay: number;
  cooldownDays: number;
  unusedDaysToRetire: number;
  minImprovementPct: number;
  /** Percent of project data size the auto indexes may add. */
  storageBudgetPct: number;
}

export const DEFAULT_AUTO_INDEX_THRESHOLDS: AutoIndexThresholds = {
  minHits24h: 50,
  minDistinctHours: 3,
  minDocs: 5_000,
  minP95Ms: 300,
  maxFields: 4,
  budgetPct: 40,
  maxBuildsPerProjectPerDay: 2,
  cooldownDays: 7,
  unusedDaysToRetire: 30,
  minImprovementPct: 30,
  storageBudgetPct: 20,
};

export interface AutoIndexCandidate {
  fingerprint: string;
  collectionPath: string;
  fields: Array<{ path: string; dir: "asc" | "desc" }>;
  hits24h: number;
  distinctHours24h: number;
  p95Ms: number;
  /** Live docs in the collection (counted up to a cap). */
  docCount: number;
  /** True when the query hit the unindexed-scan cap. */
  blockedByScanCap: boolean;
  dismissed: boolean;
  /** An existing ready/building index already covers the shape. */
  alreadyCovered: boolean;
  /** Last engine action on this fingerprint, ms epoch, if any. */
  lastActionAtMs?: number | undefined;
}

export interface AutoIndexProjectState {
  projectOptedOut: boolean;
  planCap: number;
  existingIndexCount: number;
  autoIndexCount: number;
  buildsToday: number;
  buildInProgress: boolean;
  estimatedNewEntries: number;
  estimatedAutoIndexBytes: number;
  estimatedNewIndexBytes: number;
  projectDataBytes: number;
  /** Admin hard cap on total auto-index bytes for the project, 0 = none. */
  hardStorageCapBytes: number;
  loadGuardBusy: boolean;
}

export type AutoIndexDecision =
  | { action: "create"; mode: AutoIndexMode; reason: string; evidence: Record<string, unknown> }
  | { action: "skip"; mode: AutoIndexMode; reason: string; evidence: Record<string, unknown> };

const SYSTEM_PATHS = new Set(["_id", "documentId", "__name__", "createdAt", "updatedAt"]);

export function isEligibleShape(
  fields: AutoIndexCandidate["fields"],
  maxFields: number
): string | null {
  if (fields.length === 0) return "no_fields";
  if (fields.length > maxFields) return "too_many_fields";
  const seen = new Set<string>();
  for (const f of fields) {
    if (!f.path || f.path.startsWith("_")) return "system_path";
    if (SYSTEM_PATHS.has(f.path)) return "system_path";
    if (seen.has(f.path)) return "repeated_field";
    seen.add(f.path);
  }
  return null;
}

export function decideAutoIndex(
  mode: AutoIndexMode,
  c: AutoIndexCandidate,
  p: AutoIndexProjectState,
  nowMs: number,
  t: AutoIndexThresholds = DEFAULT_AUTO_INDEX_THRESHOLDS
): AutoIndexDecision {
  const evidence: Record<string, unknown> = {
    hits24h: c.hits24h,
    distinctHours24h: c.distinctHours24h,
    p95Ms: c.p95Ms,
    docCount: c.docCount,
    blockedByScanCap: c.blockedByScanCap,
  };
  const skip = (reason: string): AutoIndexDecision => ({ action: "skip", mode, reason, evidence });
  if (mode === "off") return skip("engine_off");
  if (p.projectOptedOut) return skip("project_opted_out");
  if (c.dismissed) return skip("dismissed_by_owner");
  if (c.alreadyCovered) return skip("already_covered");
  const shape = isEligibleShape(c.fields, t.maxFields);
  if (shape) return skip(shape);
  if (c.hits24h < t.minHits24h) return skip("not_enough_hits");
  if (c.distinctHours24h < t.minDistinctHours) return skip("not_enough_distinct_hours");
  if (!(c.docCount >= t.minDocs || c.p95Ms >= t.minP95Ms || c.blockedByScanCap)) {
    return skip("query_not_costly");
  }
  if (c.lastActionAtMs !== undefined && nowMs - c.lastActionAtMs < t.cooldownDays * 86_400_000) {
    return skip("cooldown");
  }
  const autoBudget = Math.floor((p.planCap * t.budgetPct) / 100);
  if (p.autoIndexCount >= autoBudget) return skip("auto_budget_exhausted");
  if (p.existingIndexCount >= p.planCap) return skip("plan_cap_reached");
  if (p.buildsToday >= t.maxBuildsPerProjectPerDay) return skip("daily_build_limit");
  if (p.buildInProgress) return skip("build_in_progress");
  if (p.loadGuardBusy) return skip("load_guard_busy");
  const projected = p.estimatedAutoIndexBytes + p.estimatedNewIndexBytes;
  evidence["projectedAutoIndexBytes"] = projected;
  const pctCap = Math.floor((p.projectDataBytes * t.storageBudgetPct) / 100);
  if (projected > pctCap) return skip("storage_budget_exceeded");
  if (p.hardStorageCapBytes > 0 && projected > p.hardStorageCapBytes) {
    return skip("storage_hard_cap_exceeded");
  }
  return {
    action: "create",
    mode,
    reason: mode === "live" ? "repeated_costly_uncovered_query" : "would_create_dry_run",
    evidence,
  };
}

export interface AutoIndexUsage {
  autoCreated: boolean;
  pinned: boolean;
  lastUsedAtMs: number | null;
  createdAtMs: number;
  /** Measured improvement after build, percent; null when not measured yet. */
  improvementPct: number | null;
  indexUsedInAfterPlan: boolean | null;
}

export function decideAutoRetire(
  u: AutoIndexUsage,
  nowMs: number,
  t: AutoIndexThresholds = DEFAULT_AUTO_INDEX_THRESHOLDS
): { retire: boolean; reason: string } {
  if (!u.autoCreated) return { retire: false, reason: "not_auto_created" };
  if (u.pinned) return { retire: false, reason: "pinned" };
  if (
    u.improvementPct !== null &&
    (u.improvementPct < t.minImprovementPct || u.indexUsedInAfterPlan === false)
  ) {
    return { retire: true, reason: "ineffective" };
  }
  const last = u.lastUsedAtMs ?? u.createdAtMs;
  if (nowMs - last >= t.unusedDaysToRetire * 86_400_000) {
    return { retire: true, reason: "unused" };
  }
  return { retire: false, reason: "in_use" };
}
