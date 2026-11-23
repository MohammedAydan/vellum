import { en } from "./en.js";
import { ar } from "./ar.js";

export { en } from "./en.js";
export { ar } from "./ar.js";

/**
 * Both dictionaries must expose exactly the same key set. The English table is
 * authoritative — a missing Arabic key silently falls back to English, which
 * would leave untranslated text in the RTL UI. Fail loudly during development
 * and in QA/CI runs instead of shipping a partial translation.
 */
function assertDictionaryParity(): void {
  const enKeys = Object.keys(en).sort();
  const arKeys = Object.keys(ar).sort();
  const missingInAr = enKeys.filter((key) => !arKeys.includes(key));
  const extraInAr = arKeys.filter((key) => !enKeys.includes(key));
  if (missingInAr.length === 0 && extraInAr.length === 0) return;

  const message =
    `[i18n] EN/AR dictionary key mismatch: ` +
    `missing in ar=${JSON.stringify(missingInAr)}, extra in ar=${JSON.stringify(extraInAr)}`;
  if (import.meta.env?.DEV) {
    throw new Error(message);
  }
  console.error(message);
}

assertDictionaryParity();

export const dictionaries = { en, ar } as const;
export const I18N_KEY_COUNT = Object.keys(en).length;
