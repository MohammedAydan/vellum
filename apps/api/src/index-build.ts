/**
 * Request-scoped composite index building.
 *
 * Serverless runtimes (Vercel) have no long-lived process to run the periodic
 * maintenance worker, so an index created there would stay `building` forever.
 * These helpers build the index inside the request with a time budget and
 * finish any unfinished build when the index list is read. Builds are
 * resumable, so a build that outlasts the budget continues on the next read.
 */

import type { CompositeIndexRecord, StorageAdapter } from "@vellum/storage";
import type { StructuredLogger } from "@vellum/observability";

/** Time budget for one in-request build slice (well under serverless limits). */
export const INDEX_BUILD_BUDGET_MS = 8_000;

export interface IndexBuildDeps {
  dataStore: StorageAdapter;
  logger: StructuredLogger;
}

/** Runs one time-boxed build slice. Never throws; failures are logged and the index state stays authoritative. */
export async function buildIndexesForProject(
  { dataStore, logger }: IndexBuildDeps,
  projectId: string,
  indexId?: string,
  budgetMs: number = INDEX_BUILD_BUDGET_MS
): Promise<void> {
  try {
    await dataStore.runIndexBuilderWorker({ projectId, indexId, deadlineMs: budgetMs });
  } catch (err) {
    logger.warn("In-request index build failed", {
      projectId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Lists indexes; first advances any index still `building` so status reflects reality. */
export async function listIndexesReconciled(
  deps: IndexBuildDeps,
  projectId: string
): Promise<CompositeIndexRecord[]> {
  let indexes = await deps.dataStore.listCompositeIndexes({ projectId });
  if (indexes.some((idx) => idx.status === "building")) {
    await buildIndexesForProject(deps, projectId);
    indexes = await deps.dataStore.listCompositeIndexes({ projectId });
  }
  return indexes;
}

/** Creates-then-builds result: returns the freshest record for `created`. */
export async function refreshIndexRecord(
  deps: IndexBuildDeps,
  projectId: string,
  created: CompositeIndexRecord
): Promise<CompositeIndexRecord> {
  await buildIndexesForProject(deps, projectId, created.id);
  const indexes = await deps.dataStore.listCompositeIndexes({ projectId });
  return indexes.find((idx) => idx.id === created.id) ?? created;
}
