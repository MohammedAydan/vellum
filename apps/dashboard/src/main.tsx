import * as React from "react";
import * as ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  VellumDirectionProvider,
  VellumThemeProvider,
  I18nProvider,
  Toaster,
  useI18n,
} from "@vellum/ui";
import { routeTree } from "./routeTree.js";
import { queryClient } from "./lib/query-client.js";
import { AuthProvider } from "./providers/auth-provider.js";
import { dictionaries } from "./i18n/index.js";
// Shared design-system stylesheet. `import "@vellum/ui/styles.css"` is the
// package-export spelling, but the dashboard's Vite source alias rewrites
// `@vellum/ui/*` onto packages/ui/src, where the canonical entry is index.css
// (the exact file the ./styles.css export points to).
import "@vellum/ui/index.css";
import "./index.css";

/** Shown while a route loads. Delayed so fast navigations do not flash. */
function RoutePending(): React.JSX.Element {
  return (
    <div role="status" aria-live="polite" className="flex min-h-[40vh] items-center justify-center gap-3 text-sm text-muted-foreground">
      <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" aria-hidden="true" />
      <span>Loading</span>
    </div>
  );
}

function RouteNotFound(): React.JSX.Element {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">This page does not exist or has moved.</p>
      <a href="/app" className="text-sm font-medium underline underline-offset-4">Go to the console</a>
    </div>
  );
}

const router = createRouter({
  routeTree,
  // Served at `/`; kept explicit so the three frontends share one origin.
  basepath: "/",
  defaultPendingComponent: RoutePending,
  defaultPendingMs: 200,
  defaultPendingMinMs: 300,
  defaultNotFoundComponent: RouteNotFound,
  context: {
    queryClient,
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/** Bridges the I18n locale to Radix/shared direction context for every Radix primitive. */
function DirectionFromLocale({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { locale } = useI18n();
  return <VellumDirectionProvider dir={locale === "ar" ? "rtl" : "ltr"}>{children}</VellumDirectionProvider>;
}

const rootElement = document.getElementById("root");
if (rootElement && (!rootElement.innerHTML || rootElement.hasAttribute("data-splash"))) {
  rootElement.removeAttribute("data-splash");
  rootElement.innerHTML = "";
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <VellumThemeProvider defaultTheme="dark">
        <QueryClientProvider client={queryClient}>
          <I18nProvider dictionaries={dictionaries} defaultLocale="en">
            <DirectionFromLocale>
              <AuthProvider>
                <RouterProvider router={router} />
              </AuthProvider>
              <Toaster position="bottom-right" richColors />
            </DirectionFromLocale>
          </I18nProvider>
        </QueryClientProvider>
      </VellumThemeProvider>
    </React.StrictMode>
  );
}
