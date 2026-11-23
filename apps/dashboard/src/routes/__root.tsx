import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

export interface RouterContext {
  queryClient: QueryClient;
}

/**
 * Root route. All application providers (theme, direction, i18n, query and
 * auth) are installed once in `main.tsx` around the RouterProvider so they are
 * shared by every route and the single global Toaster cannot be duplicated.
 */
export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
});

function RootComponent() {
  return <Outlet />;
}
