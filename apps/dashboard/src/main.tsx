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

const router = createRouter({
  routeTree,
  // Served at `/`; kept explicit so the three frontends share one origin.
  basepath: "/",
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
if (rootElement && !rootElement.innerHTML) {
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
