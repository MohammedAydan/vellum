import * as React from "react";
import { Languages, Monitor, Moon, Sun } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button } from "../../components/button.js";
import { useI18n } from "../../i18n/index.js";
import {
  useVellumTheme,
  type VellumTheme,
} from "../../providers/theme-provider.js";

const THEME_STORAGE_KEY = "vellum_theme";

export interface ThemeToggleProps {
  className?: string;
  showLabel?: boolean;
}

export interface LocaleToggleProps {
  showLabel?: boolean;
  className?: string;
  "data-testid"?: string;
}

/** Compact light/dark/system switcher backed by the shared Vellum theme. */
export function ThemeToggle({
  className,
  showLabel = false,
}: ThemeToggleProps): React.JSX.Element {
  const { theme, setTheme } = useVellumTheme();
  const next: VellumTheme =
    theme === "dark" ? "light" : theme === "light" ? "system" : "dark";

  const handleClick = React.useCallback((): void => {
    setTheme(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Persistence is best-effort; the provider keeps in-memory state.
      }
    }
  }, [next, setTheme]);

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className={cn(showLabel && "w-auto gap-1.5 px-2.5", className)}
      onClick={handleClick}
      aria-label={`Switch theme (current: ${theme})`}
    >
      {theme === "dark" ? (
        <Moon className="size-4" aria-hidden="true" />
      ) : theme === "light" ? (
        <Sun className="size-4" aria-hidden="true" />
      ) : (
        <Monitor className="size-4" aria-hidden="true" />
      )}
      {showLabel ? (
        <span className="text-xs">
          {theme === "dark" ? "Dark" : theme === "light" ? "Light" : "System"}
        </span>
      ) : null}
    </Button>
  );
}

/**
 * Compact EN/AR switcher. Renders exactly one `data-testid="language-toggle"`
 * element so QA can assert a single control per page.
 */
export function LocaleToggle({
  showLabel = true,
  className,
  "data-testid": testId = "language-toggle",
}: LocaleToggleProps): React.JSX.Element {
  const { locale, toggleLocale, t } = useI18n();
  const label = t("i18n.switchLanguage");
  const accessibleLabel = label === "i18n.switchLanguage" ? "Switch language" : label;

  return (
    <button
      type="button"
      onClick={toggleLocale}
      className={cn(
        "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      aria-label={`${accessibleLabel} — ${locale === "en" ? "EN" : "AR"}`}
      title={accessibleLabel}
      data-testid={testId}
    >
      <Languages className="size-3.5" aria-hidden="true" />
      {showLabel ? <span>{locale === "en" ? "EN" : "AR"}</span> : null}
    </button>
  );
}
