import { StrictMode, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { VellumThemeProvider, useVellumTheme } from "@vellum/ui";
import App from "./App";
// Shared Tailwind v4 entry + canonical tokens/base layer. The docs app keeps
// its bespoke stylesheet as an app-specific override layer after it.
import "@vellum/ui/index.css";
import "./styles.css";

/**
 * Docs used to own a private `vellum_docs_theme` key and a `data-theme`
 * attribute. Migrate that value once so the shared provider becomes the single
 * source of truth while existing readers keep working.
 */
function migrateLegacyTheme(): void {
  try {
    const legacy = window.localStorage.getItem("vellum_docs_theme");
    const shared = window.localStorage.getItem("vellum_theme");
    if (legacy === "dark" || legacy === "light") {
      if (shared === null) window.localStorage.setItem("vellum_theme", legacy);
    }
  } catch {
    // Storage may be blocked; the provider falls back to its default.
  }
}

/** Mirrors the shared theme onto the historical docs QA hooks. */
function DocsThemeBridge({ children }: { children: ReactNode }): React.JSX.Element {
  const { resolvedTheme } = useVellumTheme();
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    try {
      window.localStorage.setItem("vellum_docs_theme", resolvedTheme);
    } catch {
      // Best-effort; the provider remains authoritative.
    }
  }, [resolvedTheme]);
  return <>{children}</>;
}

migrateLegacyTheme();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(
  <StrictMode>
    <VellumThemeProvider defaultTheme="dark">
      <DocsThemeBridge>
        <App />
      </DocsThemeBridge>
    </VellumThemeProvider>
  </StrictMode>,
);
