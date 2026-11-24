/**
 * Server-side OAuth 2.0 / OIDC provider registry (Google, GitHub).
 *
 * The Vellum API is the OAuth client: it runs the authorization-code flow with
 * PKCE, verifies what the provider returns, and only then lets a user in. The
 * browser or app never asserts an identity on its own.
 *
 * Add a provider by adding one entry to PROVIDERS.
 */

import { createHash, createPublicKey, createVerify, randomBytes } from "node:crypto";

type JsonWebKey = Record<string, unknown>;
import { VellumError } from "@vellum/core";

export interface ProviderProfile {
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoUrl: string | null;
}

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export interface ProviderDefinition {
  id: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** OIDC providers return an ID token that is verified with the issuer keys. */
  oidc: boolean;
}

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export const PROVIDERS: Record<string, ProviderDefinition> = {
  google: {
    id: "google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["openid", "email", "profile"],
    oidc: true,
  },
  github: {
    id: "github",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["read:user", "user:email"],
    oidc: false,
  },
};

export function getProvider(id: string): ProviderDefinition {
  const provider = PROVIDERS[id];
  if (!provider) throw new VellumError("INVALID_ARGUMENT", `Unsupported OAuth provider '${id}'`);
  return provider;
}

export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function randomUrlToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function buildAuthorizeUrl(
  provider: ProviderDefinition,
  input: { clientId: string; callbackUrl: string; state: string; codeChallenge: string; nonce?: string }
): string {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.callbackUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", provider.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (provider.oidc && input.nonce) url.searchParams.set("nonce", input.nonce);
  if (provider.id === "google") url.searchParams.set("prompt", "select_account");
  return url.toString();
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await res.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function exchangeCode(
  provider: ProviderDefinition,
  creds: ProviderCredentials,
  input: { code: string; callbackUrl: string; codeVerifier: string }
): Promise<{ accessToken: string; idToken: string | null }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.callbackUrl,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    code_verifier: input.codeVerifier,
  });
  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const json = await readJson(res);
  const accessToken = typeof json["access_token"] === "string" ? json["access_token"] : null;
  if (!res.ok || !accessToken) {
    throw new VellumError("UNAUTHENTICATED", `The ${provider.id} sign-in could not be completed`);
  }
  const idToken = typeof json["id_token"] === "string" ? json["id_token"] : null;
  return { accessToken, idToken };
}

// ------------------------------------------------------------------ Google ID tokens

interface CachedKeys {
  keys: Map<string, JsonWebKey>;
  fetchedAt: number;
}
let googleKeys: CachedKeys | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 60 * 1000;

async function loadGoogleKeys(force: boolean): Promise<Map<string, JsonWebKey>> {
  const now = Date.now();
  if (googleKeys && !force && now - googleKeys.fetchedAt < JWKS_TTL_MS) return googleKeys.keys;
  if (googleKeys && force && now - googleKeys.fetchedAt < JWKS_MIN_REFETCH_MS) return googleKeys.keys;
  const res = await fetch(GOOGLE_JWKS_URL);
  const json = await readJson(res);
  const list = Array.isArray(json["keys"]) ? (json["keys"] as Array<Record<string, unknown>>) : [];
  const keys = new Map<string, JsonWebKey>();
  for (const key of list) {
    if (typeof key["kid"] === "string" && key["kty"] === "RSA") keys.set(key["kid"], key);
  }
  if (!res.ok || keys.size === 0) {
    throw new VellumError("SERVICE_UNAVAILABLE", "Could not load Google signing keys");
  }
  googleKeys = { keys, fetchedAt: now };
  return keys;
}

/** Test helper. */
export function clearOAuthKeyCache(): void {
  googleKeys = null;
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

/**
 * Verify a Google ID token: RS256 signature against Google's published keys,
 * issuer, audience, expiry and (when supplied) nonce.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  expected: { audiences: string[]; nonce?: string }
): Promise<ProviderProfile> {
  const fail = (): never => {
    throw new VellumError("UNAUTHENTICATED", "Invalid Google ID token");
  };
  const parts = idToken.split(".");
  if (parts.length !== 3) return fail();
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeSegment(headerB64);
    claims = decodeSegment(payloadB64);
  } catch {
    return fail();
  }
  if (header["alg"] !== "RS256" || typeof header["kid"] !== "string") return fail();
  let keys = await loadGoogleKeys(false);
  let jwk = keys.get(header["kid"]);
  if (!jwk) {
    keys = await loadGoogleKeys(true);
    jwk = keys.get(header["kid"]);
  }
  if (!jwk) return fail();
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  const valid = verifier.verify(createPublicKey({ key: jwk as never, format: "jwk" }), Buffer.from(signatureB64, "base64url"));
  if (!valid) return fail();

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims["iss"] !== "string" || !GOOGLE_ISSUERS.has(claims["iss"])) return fail();
  const aud = claims["aud"];
  if (typeof aud !== "string" || !expected.audiences.includes(aud)) return fail();
  if (typeof claims["exp"] !== "number" || claims["exp"] + 60 < now) return fail();
  if (expected.nonce !== undefined && claims["nonce"] !== expected.nonce) return fail();
  if (typeof claims["sub"] !== "string" || claims["sub"].length === 0) return fail();

  const verified = claims["email_verified"] === true || claims["email_verified"] === "true";
  return {
    providerUserId: claims["sub"],
    email: typeof claims["email"] === "string" ? claims["email"].toLowerCase() : null,
    emailVerified: verified,
    displayName: typeof claims["name"] === "string" ? claims["name"] : null,
    photoUrl: typeof claims["picture"] === "string" ? claims["picture"] : null,
  };
}

// ------------------------------------------------------------------ GitHub

async function fetchGitHubProfile(accessToken: string): Promise<ProviderProfile> {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/vnd.github+json",
    "user-agent": "vellum-auth",
    "x-github-api-version": "2022-11-28",
  };
  const userRes = await fetch("https://api.github.com/user", { headers });
  const user = await readJson(userRes);
  if (!userRes.ok || (typeof user["id"] !== "number" && typeof user["id"] !== "string")) {
    throw new VellumError("UNAUTHENTICATED", "The github sign-in could not be completed");
  }
  // Only a primary AND verified address may be trusted. The public profile
  // email is never used: it is user-editable and unverified.
  let email: string | null = null;
  const emailsRes = await fetch("https://api.github.com/user/emails", { headers });
  if (emailsRes.ok) {
    const list: unknown = await emailsRes.json().catch(() => []);
    if (Array.isArray(list)) {
      const primary = (list as Array<Record<string, unknown>>).find(
        (e) => e["primary"] === true && e["verified"] === true && typeof e["email"] === "string"
      );
      if (primary) email = (primary["email"] as string).toLowerCase();
    }
  }
  const name = typeof user["name"] === "string" && user["name"] ? user["name"] : typeof user["login"] === "string" ? user["login"] : null;
  return {
    providerUserId: String(user["id"]),
    email,
    emailVerified: email !== null,
    displayName: name,
    photoUrl: typeof user["avatar_url"] === "string" ? user["avatar_url"] : null,
  };
}

/** Exchange an authorization code and return the verified provider profile. */
export async function completeAuthorization(
  provider: ProviderDefinition,
  creds: ProviderCredentials,
  input: { code: string; callbackUrl: string; codeVerifier: string; nonce?: string; audiences?: string[] }
): Promise<ProviderProfile> {
  const tokens = await exchangeCode(provider, creds, input);
  if (provider.id === "google") {
    if (!tokens.idToken) throw new VellumError("UNAUTHENTICATED", "The google sign-in could not be completed");
    return verifyGoogleIdToken(tokens.idToken, {
      audiences: input.audiences ?? [creds.clientId],
      ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
    });
  }
  return fetchGitHubProfile(tokens.accessToken);
}
