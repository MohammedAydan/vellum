import { createRoute, redirect } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root.js";
import { getStoredSession } from "../lib/auth.js";

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    const session = getStoredSession();
    if (session) {
      throw redirect({ to: "/app" });
    } else {
      throw redirect({ to: "/login" });
    }
  },
  component: () => null,
});
