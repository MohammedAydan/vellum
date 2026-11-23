import { createRoute, Outlet } from "@tanstack/react-router";
import { Route as appRoute } from "../_app.js";

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/app/orgs/$orgId/projects/$projectId",
  component: ProjectLayout,
});

/**
 * Project pages layout. The sidebar owns project navigation (F1: the top tab
 * bar duplicated it item-for-item); this layout only provides the child
 * outlet.
 */
export function ProjectLayout() {
  return (
    <div className="min-h-[500px]">
      <Outlet />
    </div>
  );
}
