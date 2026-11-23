import type { UnknownRecord, AuthConfigView, OAuthDraft } from "./types.js";

export function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function readOAuthDraft(config: AuthConfigView | null | undefined, provider: string): OAuthDraft {
  const entry = asRecord(config?.oauthProviders?.[provider]);
  return {
    enabled: asBoolean(entry["enabled"]),
    clientId: asString(entry["clientId"]),
    clientSecret: asString(entry["clientSecret"]),
  };
}

export function formatDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}
