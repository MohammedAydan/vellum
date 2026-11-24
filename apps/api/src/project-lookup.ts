/**
 * @vellum/api - Project lookup bridge for the project-only control API.
 *
 * After the project-only cutover the control plane exposes a synchronous
 * `getProject(projectId)` returning a `{ project }` result. Some lightweight
 * test doubles return the bare project record instead, so unwrap defensively.
 */

import type { ProjectRecord, ProjectResult } from "@vellum/database-control";

/** Resolve a project from either the `{ project }` wrapper or a bare record. */
export function unwrapProject(result: ProjectResult | ProjectRecord): ProjectRecord {
  return "project" in result ? result.project : result;
}

type AsyncCapable = {
  getProject(id: string): ProjectResult | ProjectRecord;
  getProjectAsync?: (id: string) => Promise<ProjectResult | ProjectRecord>;
};

/**
 * Authoritative project read: PostgreSQL on every call when the store supports
 * it (production), the in-memory store otherwise (tests, local dev).
 */
export async function loadProject(store: AsyncCapable, projectId: string): Promise<ProjectRecord> {
  return unwrapProject(
    store.getProjectAsync ? await store.getProjectAsync(projectId) : store.getProject(projectId)
  );
}
