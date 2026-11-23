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
