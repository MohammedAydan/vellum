import { createRoute, redirect } from "@tanstack/react-router";
import { Route as projectRoute } from "./orgs.$orgId.projects.$projectId.js";

/**
 * Index route for the project workspace: the bare project URL has no content
 * of its own, so land users on the Database Explorer instead of an empty
 * canvas under the tab bar.
 */
export const Route = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/app/orgs/$orgId/projects/$projectId/data",
      params: { orgId: params.orgId, projectId: params.projectId },
      replace: true,
    });
  },
});
