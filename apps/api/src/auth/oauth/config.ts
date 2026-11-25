/**
 * OAuth configuration helpers: encrypted client secrets, the per-project
 * redirect allowlist and the signed flow state. No schema change is needed:
 * everything lives in the existing `oauthProviders` jsonb record.
 */

import { VellumError } from "@vellum/core";
import { createHash, timingSafeEqual } from "node:crypto";
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
 * Redirect-less (poll) sign-in is off unless the project turns it on in Auth Studio. It trades a little phishing
 * resistance for needing no deep link, so it is an explicit choice (see the social sign-in docs).
 */
export function pollSignInAllowed(oauthProviders: Rec): boolean {
  return asRec(oauthProviders[SETTINGS_KEY])["allowPollSignIn"] === true;
}

export const POLL_DISABLED_MESSAGE =
  "Redirect-less sign-in is turned off for this project. Enable it in Auth Studio (Providers > Redirect-less sign-in) or pass a redirectUri.";

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
      // Settings merge key by key: saving the redirect list must not switch redirect-less sign-in off, and vice versa.
      const incomingSettings = asRec(raw);
      const uris = "redirectUris" in incomingSettings ? redirectAllowlist({ [SETTINGS_KEY]: raw }) : redirectAllowlist(existing);
      for (const uri of uris) assertValidRedirectUri(uri);
      const next: Rec = { ...asRec(existing[SETTINGS_KEY]), ...incomingSettings, redirectUris: [...new Set(uris)] };
      if ("allowPollSignIn" in incomingSettings && typeof incomingSettings["allowPollSignIn"] !== "boolean") {
        throw new VellumError("INVALID_ARGUMENT", "allowPollSignIn must be true or false");
      }
      out[name] = next;
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

// ------------------------------------------------------------- confirmation code

export const CONFIRM_TTL_MS = 10 * 60 * 1000;
export const CONFIRM_MAX_ATTEMPTS = 5;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols, no I, O, 0 or 1
const CODE_LENGTH = 6;

/**
 * The code the app shows and the person types into the browser page. It is derived from the PKCE challenge, so the
 * app can compute it from its own verifier and the server from the challenge, and it never travels with the flow.
 * SDKs implement the same derivation: sha256("vellum-confirm:" + challenge), the first six bytes masked to 5 bits.
 */
export function confirmationCode(challenge: string): string {
  const digest = createHash("sha256").update(`vellum-confirm:${challenge}`).digest();
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[(digest[i] as number) & 31];
  return out;
}

/** Compares a typed code to the real one, ignoring case, spaces and dashes. */
export function codesMatch(typed: string, expected: string): boolean {
  const clean = typed.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const a = Buffer.from(clean.padEnd(CODE_LENGTH + 8, "_"));
  const b = Buffer.from(expected.padEnd(CODE_LENGTH + 8, "_"));
  return a.length === b.length && timingSafeEqual(a, b) && clean.length === expected.length;
}

export interface ConfirmTicket {
  kind: "oauth-confirm";
  p: string;
  provider: string;
  redirectUri: string;
  clientChallenge: string;
  clientState: string | null;
  linkUserId?: string;
  profile: { providerUserId: string; email: string | null; displayName: string | null; photoUrl: string | null };
  attempts: number;
  exp: number;
}

/** AES-GCM sealed JSON with an `exp` timestamp (ms). */
export function sealJson<T extends { exp: number }>(value: T, masterKey: string | undefined): string {
  return Buffer.from(encryptSecret(JSON.stringify(value), masterKey), "utf8").toString("base64url");
}

export function openJson<T extends { exp: number }>(token: string, masterKey: string | undefined): T {
  const value = JSON.parse(decryptSecret(Buffer.from(token, "base64url").toString("utf8"), masterKey)) as T;
  if (typeof value.exp !== "number" || value.exp < Date.now()) throw new Error("expired");
  return value;
}
