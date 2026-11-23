import { createRoute, redirect } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root.js";
import { getStoredAdminSession } from "../lib/auth.js";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    const session = getStoredAdminSession();
    if (session) {
      // Route paths are relative to the router basepath `/admin`.
      throw redirect({ to: "/" });
    } else {
      // Resolves to /admin/login on the unified origin (basepath is prepended).
      throw redirect({ to: "/login" });
    }
  },
});
