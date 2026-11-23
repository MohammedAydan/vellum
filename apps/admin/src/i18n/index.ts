import type { TranslationDictionary } from "@vellum/ui";
import { en } from "./en.js";
import { ar } from "./ar.js";

export { en, ar };
export type { AdminDictionary } from "./en.js";

/**
 * Dictionaries handed to `@vellum/ui`'s <I18nProvider>. `ar` is typed against
 * the English key set, so a missing/extra key is a compile-time error.
 */
export const dictionaries: Record<"en" | "ar", TranslationDictionary> = {
  en,
  ar,
};
