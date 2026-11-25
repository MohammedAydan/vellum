/**
 * Server-side OAuth 2.0 / OIDC provider registry (Google, GitHub, Apple).
 *
 * The Vellum API is the OAuth client: it runs the authorization-code flow with
 * PKCE, verifies what the provider returns, and only then lets a user in. The
 * browser or app never asserts an identity on its own.
 *
 * Add a provider by adding one entry to PROVIDERS.
 */

import { createHash, createPrivateKey, createPublicKey, createSign, createVerify, randomBytes } from "node:crypto";

type JsonWebKey = Record<string, unknown>;
import { VellumError } from "@vellum/core";

export interface ProviderProfile {
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoUrl: string | null;
  /** Apple only: the token's audience (Services ID or app bundle ID). */
  audience?: string;
  /** Apple only: refresh token from the code exchange, needed to revoke the grant on account deletion. */
  refreshToken?: string;
}

export interface ProviderCredentials {
  clientId: string;
  /** For Apple this is the .p8 private key (PEM); the real client secret is a short-lived JWT signed with it. */
  clientSecret: string;
  /** Apple only. */
  teamId?: string;
  keyId?: string;
}

export interface ProviderDefinition {
  id: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** OIDC providers return an ID token that is verified with the issuer keys. */
  oidc: boolean;
  /** The provider POSTs the result to the callback (Apple, required when asking for name or email). */
  formPost?: boolean;
  /** Provider does not support PKCE on its token endpoint. Our own client PKCE still applies. */
  noPkce?: boolean;
}

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";

export const PROVIDERS: Record<string, ProviderDefinition> = {
  google: {
    id: "google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["openid", "email", "profile"],
    oidc: true,
  },
  apple: {
    id: "apple",
    authorizeUrl: "https://appleid.apple.com/auth/authorize",
    tokenUrl: APPLE_TOKEN_URL,
    scopes: ["name", "email"],
    oidc: true,
    formPost: true,
    noPkce: true,
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
  if (!provider.noPkce) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  if (provider.formPost) url.searchParams.set("response_mode", "form_post");
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

/**
 * Apple has no static client secret. It wants a JWT signed (ES256) with the team's .p8 key, with the Services ID or
 * app bundle ID as subject. We mint a fresh, short-lived one for every call, so the key never leaves the server.
 */
export function createAppleClientSecret(input: {
  teamId: string;
  keyId: string;
  clientId: string;
  privateKeyPem: string;
  now?: number;
}): string {
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const head = Buffer.from(JSON.stringify({ alg: "ES256", kid: input.keyId, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ iss: input.teamId, iat, exp: iat + 300, aud: APPLE_ISSUER, sub: input.clientId })
  ).toString("base64url");
  let signature: string;
  try {
    signature = createSign("SHA256")
      .update(`${head}.${body}`)
      .sign({ key: createPrivateKey(input.privateKeyPem), dsaEncoding: "ieee-p1363" })
      .toString("base64url");
  } catch {
    throw new VellumError("FAILED_PRECONDITION", "The Apple private key (.p8) stored for this project is invalid");
  }
  return `${head}.${body}.${signature}`;
}

/** The value sent as client_secret to the provider's token endpoint. */
function clientSecretFor(provider: ProviderDefinition, creds: ProviderCredentials, clientId = creds.clientId): string {
  if (provider.id !== "apple") return creds.clientSecret;
  if (!creds.teamId || !creds.keyId) {
    throw new VellumError("FAILED_PRECONDITION", "Apple sign-in needs a Team ID and Key ID");
  }
  return createAppleClientSecret({
    teamId: creds.teamId,
    keyId: creds.keyId,
    clientId,
    privateKeyPem: creds.clientSecret,
  });
}

async function exchangeCode(
  provider: ProviderDefinition,
  creds: ProviderCredentials,
  input: { code: string; callbackUrl: string; codeVerifier: string; clientId?: string }
): Promise<{ accessToken: string; idToken: string | null; refreshToken: string | null }> {
  const clientId = input.clientId ?? creds.clientId;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: clientId,
    client_secret: clientSecretFor(provider, creds, clientId),
  });
  // A native Apple authorizationCode has no redirect URI.
  if (input.callbackUrl) body.set("redirect_uri", input.callbackUrl);
  if (!provider.noPkce) body.set("code_verifier", input.codeVerifier);
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
  const refreshToken = typeof json["refresh_token"] === "string" ? json["refresh_token"] : null;
  return { accessToken, idToken, refreshToken };
}

/**
 * Revoke an Apple grant (App Store rule 5.1.1(v): deleting an account must also revoke Sign in with Apple).
 * Returns true when Apple accepted the revocation.
 */
export async function revokeAppleToken(creds: ProviderCredentials, refreshToken: string, clientId = creds.clientId): Promise<boolean> {
  try {
    const res = await fetch(APPLE_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecretFor(PROVIDERS["apple"] as ProviderDefinition, creds, clientId),
        token: refreshToken,
        token_type_hint: "refresh_token",
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ Google ID tokens

interface CachedKeys {
  keys: Map<string, JsonWebKey>;
  fetchedAt: number;
}
const keyCache = new Map<string, CachedKeys>();
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 60 * 1000;

async function loadKeys(url: string, force: boolean): Promise<Map<string, JsonWebKey>> {
  const now = Date.now();
  const cached = keyCache.get(url);
  if (cached && !force && now - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  if (cached && force && now - cached.fetchedAt < JWKS_MIN_REFETCH_MS) return cached.keys;
  const res = await fetch(url);
  const json = await readJson(res);
  const list = Array.isArray(json["keys"]) ? (json["keys"] as Array<Record<string, unknown>>) : [];
  const keys = new Map<string, JsonWebKey>();
  for (const key of list) {
    if (typeof key["kid"] === "string" && key["kty"] === "RSA") keys.set(key["kid"], key);
  }
  if (!res.ok || keys.size === 0) {
    throw new VellumError("SERVICE_UNAVAILABLE", "Could not load the provider's signing keys");
  }
  keyCache.set(url, { keys, fetchedAt: now });
  return keys;
}

/** Test helper. */
export function clearOAuthKeyCache(): void {
  keyCache.clear();
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

/**
 * Verify an RS256 OIDC ID token: signature against the issuer's published keys, issuer, audience, expiry and
 * subject. The nonce is checked by the caller because providers differ in how they echo it.
 */
async function verifyOidcToken(
  idToken: string,
  opts: { jwksUrl: string; issuers: Set<string>; audiences: string[]; label: string }
): Promise<Record<string, unknown>> {
  const fail = (): never => {
    throw new VellumError("UNAUTHENTICATED", `Invalid ${opts.label} ID token`);
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
  let keys = await loadKeys(opts.jwksUrl, false);
  let jwk = keys.get(header["kid"]);
  if (!jwk) {
    keys = await loadKeys(opts.jwksUrl, true);
    jwk = keys.get(header["kid"]);
  }
  if (!jwk) return fail();
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  const valid = verifier.verify(createPublicKey({ key: jwk as never, format: "jwk" }), Buffer.from(signatureB64, "base64url"));
  if (!valid) return fail();

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims["iss"] !== "string" || !opts.issuers.has(claims["iss"])) return fail();
  const aud = claims["aud"];
  if (typeof aud !== "string" || !opts.audiences.includes(aud)) return fail();
  if (typeof claims["exp"] !== "number" || claims["exp"] + 60 < now) return fail();
  if (typeof claims["sub"] !== "string" || claims["sub"].length === 0) return fail();
  return claims;
}

/**
 * Verify a Google ID token: RS256 signature against Google's published keys,
 * issuer, audience, expiry and (when supplied) nonce.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  expected: { audiences: string[]; nonce?: string }
): Promise<ProviderProfile> {
  const claims = await verifyOidcToken(idToken, {
    jwksUrl: GOOGLE_JWKS_URL,
    issuers: GOOGLE_ISSUERS,
    audiences: expected.audiences,
    label: "Google",
  });
  if (expected.nonce !== undefined && claims["nonce"] !== expected.nonce) {
    throw new VellumError("UNAUTHENTICATED", "Invalid Google ID token");
  }
  const verified = claims["email_verified"] === true || claims["email_verified"] === "true";
  return {
    providerUserId: claims["sub"] as string,
    email: typeof claims["email"] === "string" ? claims["email"].toLowerCase() : null,
    emailVerified: verified,
    displayName: typeof claims["name"] === "string" ? claims["name"] : null,
    photoUrl: typeof claims["picture"] === "string" ? claims["picture"] : null,
  };
}

/**
 * Verify a Sign in with Apple ID token (web flow or the native identityToken).
 *
 * Nonce: the native Apple sheet is normally given SHA-256(nonce), so the token carries the hash; the web flow
 * carries the nonce as sent. Both are accepted. A token that carries a nonce when the caller supplied none is
 * refused, so a token minted for a nonce-bound flow cannot be replayed into one that skips the check.
 * Apple only returns the user's name on the first authorization, so the caller passes it separately.
 */
export async function verifyAppleIdToken(
  idToken: string,
  expected: { audiences: string[]; nonce?: string }
): Promise<ProviderProfile> {
  const claims = await verifyOidcToken(idToken, {
    jwksUrl: APPLE_JWKS_URL,
    issuers: new Set([APPLE_ISSUER]),
    audiences: expected.audiences,
    label: "Apple",
  });
  const claimNonce = claims["nonce"];
  if (expected.nonce !== undefined) {
    const hashed = createHash("sha256").update(expected.nonce).digest("hex");
    if (claimNonce !== expected.nonce && claimNonce !== hashed) {
      throw new VellumError("UNAUTHENTICATED", "Invalid Apple ID token");
    }
  } else if (claimNonce !== undefined) {
    throw new VellumError("UNAUTHENTICATED", "Invalid Apple ID token");
  }
  const verified = claims["email_verified"] === true || claims["email_verified"] === "true";
  return {
    providerUserId: claims["sub"] as string,
    email: typeof claims["email"] === "string" ? claims["email"].toLowerCase() : null,
    emailVerified: verified,
    displayName: null,
    photoUrl: null,
    audience: claims["aud"] as string,
  };
}

/** Apple posts the name once, as JSON in a `user` form field: {"name":{"firstName":"A","lastName":"B"}}. */
export function parseAppleUserField(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null;
  try {
    const parsed = JSON.parse(raw) as { name?: { firstName?: unknown; lastName?: unknown } };
    const parts = [parsed.name?.firstName, parsed.name?.lastName].filter(
      (v): v is string => typeof v === "string" && v.trim().length > 0
    );
    return parts.length > 0 ? parts.join(" ").trim().slice(0, 200) : null;
  } catch {
    return null;
  }
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
  if (provider.id === "apple") {
    if (!tokens.idToken) throw new VellumError("UNAUTHENTICATED", "The apple sign-in could not be completed");
    // The web flow always uses the Services ID, never an app bundle ID.
    const profile = await verifyAppleIdToken(tokens.idToken, {
      audiences: [creds.clientId],
      ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
    });
    return tokens.refreshToken ? { ...profile, refreshToken: tokens.refreshToken } : profile;
  }
  return fetchGitHubProfile(tokens.accessToken);
}

/**
 * Native Sign in with Apple: trade the app's authorizationCode for a refresh token (best effort) so the grant can
 * be revoked when the account is deleted. `clientId` is the app's bundle ID, the audience of its identity token.
 */
export async function exchangeAppleNativeCode(
  creds: ProviderCredentials,
  input: { authorizationCode: string; clientId: string }
): Promise<string | null> {
  try {
    const tokens = await exchangeCode(PROVIDERS["apple"] as ProviderDefinition, creds, {
      code: input.authorizationCode,
      callbackUrl: "",
      codeVerifier: "",
      clientId: input.clientId,
    });
    return tokens.refreshToken;
  } catch {
    return null;
  }
}
