/**
 * OAuth configuration helpers: encrypted client secrets, the per-project
 * redirect allowlist and the signed flow state. No schema change is needed:
 * everything lives in the existing `oauthProviders` jsonb record.
 */

import { VellumError } from "@vellum/core";
import { decryptSecret, encryptSecret } from "@vellum/auth";

export const SETTINGS_KEY = "__settings";

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
}

export function redirectAllowlist(oauthProviders: Rec): string[] {
  const list = asRec(oauthProviders[SETTINGS_KEY])["redirectUris"];
  return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Merge an incoming oauthProviders patch into the stored record.
 * - clientSecret (plaintext from the dashboard) is encrypted and stored as
 *   clientSecretEncrypted; an empty or missing secret keeps the stored one.
 * - Providers absent from the patch are kept, so saving one card never wipes another.
 */
export function mergeOAuthProviders(existing: Rec, incoming: Rec, masterKey: string | undefined): Rec {
  const out: Rec = { ...existing };
  for (const [name, raw] of Object.entries(incoming)) {
    if (name === SETTINGS_KEY) {
      const uris = redirectAllowlist({ [SETTINGS_KEY]: raw });
      for (const uri of uris) assertValidRedirectUri(uri);
      out[name] = { ...asRec(raw), redirectUris: [...new Set(uris)] };
      continue;
    }
    if (raw === null) {
      delete out[name];
      continue;
    }
    const next: Rec = { ...asRec(raw) };
    const previous = asRec(existing[name]);
    const secret = next["clientSecret"];
    delete next["clientSecret"];
    delete next["hasClientSecret"]; // read-only flag from the public view
    if (typeof secret === "string" && secret.length > 0) {
      next["clientSecretEncrypted"] = encryptSecret(secret, masterKey);
    } else if (typeof previous["clientSecretEncrypted"] === "string") {
      next["clientSecretEncrypted"] = previous["clientSecretEncrypted"];
    }
    out[name] = next;
  }
  return out;
}

export interface ResolvedProvider {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  audiences: string[];
}

export function resolveProviderCredentials(
  oauthProviders: Rec,
  provider: string,
  masterKey: string | undefined
): ResolvedProvider {
  const entry = asRec(oauthProviders[provider]);
  const clientId = typeof entry["clientId"] === "string" ? entry["clientId"] : "";
  let clientSecret = "";
  if (typeof entry["clientSecretEncrypted"] === "string") {
    try {
      clientSecret = decryptSecret(entry["clientSecretEncrypted"], masterKey);
    } catch {
      clientSecret = "";
    }
  } else if (typeof entry["clientSecret"] === "string") {
    // Legacy rows saved before secrets were encrypted.
    clientSecret = entry["clientSecret"];
  }
  const extra = Array.isArray(entry["additionalClientIds"])
    ? (entry["additionalClientIds"] as unknown[]).filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
  return {
    enabled: entry["enabled"] === true,
    clientId,
    clientSecret,
    audiences: clientId ? [clientId, ...extra] : extra,
  };
}

/** https, loopback http, or a custom app scheme. Never javascript:, data: and friends. */
export function assertValidRedirectUri(uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new VellumError("INVALID_ARGUMENT", `Invalid redirect URI '${uri}'`);
  }
  const scheme = url.protocol.replace(":", "").toLowerCase();
  const blocked = ["javascript", "data", "file", "vbscript", "blob", "about", "ftp"];
  if (blocked.includes(scheme) || url.username || url.password || url.hash) {
    throw new VellumError("INVALID_ARGUMENT", `Redirect URI '${uri}' is not allowed`);
  }
  if (scheme === "http") {
    const host = url.hostname;
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
      throw new VellumError("INVALID_ARGUMENT", "http redirect URIs are only allowed for localhost");
    }
  }
}

export function isRedirectAllowed(allowlist: string[], uri: string): boolean {
  try {
    assertValidRedirectUri(uri);
  } catch {
    return false;
  }
  const target = new URL(uri);
  // RFC 8252: native apps receive the result on a loopback IP literal with an ephemeral port.
  // The code only ever reaches the user's own machine and is bound to the client's PKCE verifier.
  if (target.protocol === "http:" && (target.hostname === "127.0.0.1" || target.hostname === "[::1]")) return true;
  return allowlist.some((entry) => {
    let allowed: URL;
    try {
      allowed = new URL(entry);
    } catch {
      return false;
    }
    if (allowed.protocol !== target.protocol) return false;
    // Loopback: any port is fine, path must match.
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(allowed.hostname);
    if (allowed.host !== target.host && !(loopback && allowed.hostname === target.hostname)) return false;
    return allowed.pathname === target.pathname;
  });
}

// ----------------------------------------------------------------- flow state

export interface FlowState {
  p: string; // projectId
  provider: string;
  redirectUri: string;
  clientChallenge: string;
  clientState: string | null;
  verifier: string; // our PKCE verifier toward the provider
  nonce: string;
  /** Set when a signed-in user is linking this provider to their existing account. */
  linkUserId?: string;
  exp: number;
}

/** State is AES-GCM sealed, so it is both confidential (verifier) and tamper-proof. */
export function sealState(state: FlowState, masterKey: string | undefined): string {
  return Buffer.from(encryptSecret(JSON.stringify(state), masterKey), "utf8").toString("base64url");
}

export function openState(token: string, masterKey: string | undefined): FlowState {
  try {
    const state = JSON.parse(decryptSecret(Buffer.from(token, "base64url").toString("utf8"), masterKey)) as FlowState;
    if (typeof state.exp !== "number" || state.exp < Date.now()) throw new Error("expired");
    return state;
  } catch {
    throw new VellumError("UNAUTHENTICATED", "Sign-in session expired or invalid. Please try again.");
  }
}
