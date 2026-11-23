/**
 * Local type bridge for the i18n exports of `@vellum/ui`.
 *
 * The admin build aliases `@vellum/ui` to `packages/ui/src` (see vite.config.ts)
 * where I18nProvider / useI18n / LanguageToggle already exist. The published
 * `dist/index.d.ts` is a generated artifact that can lag behind that source,
 * so we augment the module here instead of touching the shared package.
 */
import type * as React from "react";

declare module "@vellum/ui" {
  export type Locale = "en" | "ar";
  export type TranslationDictionary = Record<string, string>;

  export interface I18nProviderProps {
    children: React.ReactNode;
    dictionaries: Partial<Record<Locale, TranslationDictionary>>;
    defaultLocale?: Locale;
    storageKey?: string;
  }
  export function I18nProvider(props: I18nProviderProps): React.JSX.Element;

  export interface I18nContextValue {
    locale: Locale;
    setLocale: (locale: Locale) => void;
    toggleLocale: () => void;
    /** Translate a key; `{name}` placeholders are replaced from `vars`. */
    t: (key: string, vars?: Record<string, string | number>) => string;
    dir: "ltr" | "rtl";
  }
  export function useI18n(): I18nContextValue;
  export function LanguageToggle(props?: { showLabel?: boolean }): React.JSX.Element;
}
