"use client";

import * as React from "react";
import { Languages } from "lucide-react";

export type Locale = "en" | "ar";
export type TranslationDictionary = Record<string, string>;

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  /** Translate a key; `{name}` placeholders are replaced from `vars`. */
  t: (key: string, vars?: Record<string, string | number>) => string;
  dir: "ltr" | "rtl";
}

const I18nContext = React.createContext<I18nContextValue | null>(null);
const DEFAULT_STORAGE_KEY = "vellum.locale";

export interface I18nProviderProps {
  children: React.ReactNode;
  dictionaries: Partial<Record<Locale, TranslationDictionary>>;
  defaultLocale?: Locale;
  storageKey?: string;
}

function initialLocale(defaultLocale: Locale, storageKey: string): Locale {
  if (typeof window === "undefined") return defaultLocale;
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved === "en" || saved === "ar") return saved;
  } catch {
    // storage may be blocked; fall back to the default locale.
  }
  return defaultLocale;
}

/**
 * Framework-agnostic locale provider for the delivery apps. It keeps the
 * document `lang`/`dir` in sync so CSS logical properties flip automatically
 * for Arabic (RTL) without any per-component direction hacks.
 */
export function I18nProvider({
  children,
  dictionaries,
  defaultLocale = "en",
  storageKey = DEFAULT_STORAGE_KEY,
}: I18nProviderProps) {
  const [locale, setLocale] = React.useState<Locale>(() => initialLocale(defaultLocale, storageKey));

  React.useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === "ar" ? "rtl" : "ltr";
    try {
      window.localStorage.setItem(storageKey, locale);
    } catch {
      // non-fatal
    }
  }, [locale, storageKey]);

  const t = React.useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      const table = dictionaries[locale] ?? {};
      let value = table[key] ?? dictionaries.en?.[key] ?? key;
      if (vars) {
        for (const [name, replacement] of Object.entries(vars)) {
          value = value.split(`{${name}}`).join(String(replacement));
        }
      }
      return value;
    },
    [dictionaries, locale]
  );

  const value = React.useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      toggleLocale: () => setLocale(locale === "en" ? "ar" : "en"),
      t,
      dir: locale === "ar" ? "rtl" : "ltr",
    }),
    [locale, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = React.useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}

/** Compact EN/AR switcher suitable for a top bar or user menu. */
export function LanguageToggle({ showLabel = true }: { showLabel?: boolean }) {
  const { locale, toggleLocale, t } = useI18n();
  return (
    <button
      type="button"
      onClick={toggleLocale}
      className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`${t("i18n.switchLanguage")} — ${locale === "en" ? "EN" : "AR"}`}
      title={t("i18n.switchLanguage")}
      data-testid="language-toggle"
    >
      <Languages className="size-3.5" aria-hidden="true" />
      {showLabel ? <span>{locale === "en" ? "EN" : "AR"}</span> : null}
    </button>
  );
}
