import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

export interface RouterContext {
  queryClient: QueryClient;
}

/**
 * Root route. Application providers (theme, direction, i18n, query, auth) and
 * the single global Toaster are installed once in `main.tsx` around the
 * RouterProvider, so no route can accidentally duplicate them.
 */
export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
});

function RootComponent() {
  return <Outlet />;
}
