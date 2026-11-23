"use client";

import * as React from "react";

/** The three values the Vellum theme can be set to. */
export type VellumTheme = "dark" | "light" | "system";

/** The value returned by {@link useVellumTheme}. */
export interface VellumThemeContextValue {
  theme: VellumTheme;
  setTheme: (theme: VellumTheme) => void;
  resolvedTheme: "dark" | "light";
}

export interface VellumThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: VellumTheme;
  storageKey?: string;
}

const DEFAULT_STORAGE_KEY = "vellum_theme";

const VellumThemeContext = React.createContext<VellumThemeContextValue | null>(null);

function isVellumTheme(value: unknown): value is VellumTheme {
  return value === "dark" || value === "light" || value === "system";
}

function readStoredTheme(storageKey: string): VellumTheme | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw: string | null = window.localStorage.getItem(storageKey);
    return isVellumTheme(raw) ? raw : null;
  } catch {
    // Storage can be unavailable (private mode / disabled cookies).
    return null;
  }
}

function prefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(resolved: "dark" | "light"): void {
  if (typeof document === "undefined") {
    return;
  }
  const root: HTMLElement = document.documentElement;
  // next-themes writes the same `light` / `dark` class names. Keeping both in
  // sync lets the two providers coexist on the same <html> element, so a change
  // to localStorage.vellum_theme is reflected in all three apps.
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle("light", resolved === "light");
}

/**
 * SSR-safe theme provider that persists to `localStorage["vellum_theme"]`,
 * resolves `"system"` via `prefers-color-scheme`, and reacts to both
 * cross-tab `storage` events and OS-level colour-scheme changes.
 */
export function VellumThemeProvider({
  children,
  defaultTheme = "dark",
  storageKey = DEFAULT_STORAGE_KEY,
}: VellumThemeProviderProps): React.JSX.Element {
  const [theme, setThemeState] = React.useState<VellumTheme>(
    () => readStoredTheme(storageKey) ?? defaultTheme,
  );
  const [systemDark, setSystemDark] = React.useState<boolean>(prefersDark);

  const resolvedTheme: "dark" | "light" =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;

  const setTheme = React.useCallback(
    (next: VellumTheme): void => {
      setThemeState(next);
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(storageKey, next);
        } catch {
          // Persistence is best-effort; in-memory state still updates.
        }
      }
      applyTheme(next === "system" ? (prefersDark() ? "dark" : "light") : next);
    },
    [storageKey],
  );

  React.useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  React.useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== storageKey) {
        return;
      }
      setThemeState(isVellumTheme(event.newValue) ? event.newValue : defaultTheme);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey, defaultTheme]);

  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query: MediaQueryList = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent): void => {
      setSystemDark(event.matches);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const value = React.useMemo<VellumThemeContextValue>(
    () => ({ theme, setTheme, resolvedTheme }),
    [theme, setTheme, resolvedTheme],
  );

  return <VellumThemeContext.Provider value={value}>{children}</VellumThemeContext.Provider>;
}

/** Read the current Vellum theme. Must be used inside a {@link VellumThemeProvider}. */
export function useVellumTheme(): VellumThemeContextValue {
  const context: VellumThemeContextValue | null = React.useContext(VellumThemeContext);
  if (context === null) {
    throw new Error("useVellumTheme must be used within a VellumThemeProvider");
  }
  return context;
}
