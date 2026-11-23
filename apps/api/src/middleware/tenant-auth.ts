/**
 * Document-plane request authentication helpers.
 *
 * Resolves two independent credentials from every document-plane request:
 *  - the project API key (canonical `x-vellum-api-key`, legacy `x-project-key`)
 *  - an optional end-user JWT (`authorization: Bearer ...` or `x-vellum-user-token`)
 *
 * No credential value is ever logged; verification failures are normalised to a
 * generic UNAUTHENTICATED error so token material never leaks into error bodies.
 *
 * End-user access tokens are EdDSA-only (`vellum+enduser+jwt`). There is no HS256
 * fallback: a console/admin session token presented here is rejected.
 */

import type { Context } from "hono";
import { VellumError } from "@vellum/core";
import {
  generateEd25519KeyPair,
  verifyEndUserAccessToken,
  type EndUserJwtPayload,
} from "@vellum/auth";
import type { AuthContext } from "@vellum/authorization";
import type { VellumPlatformContext } from "../app.js";

export const API_KEY_HEADERS = ["x-vellum-api-key", "x-project-key"] as const;
export const USER_TOKEN_HEADERS = ["authorization", "x-vellum-user-token"] as const;

/** Strips an optional `Bearer ` prefix and returns undefined for blank values. */
function stripBearer(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^Bearer\s+/i.test(trimmed)) {
    const token = trimmed.slice(6).trim();
    return token || undefined;
  }
  return trimmed;
}

/**
 * First non-empty project API key header in `API_KEY_HEADERS` order.
 * A leading `Bearer ` prefix is removed when present.
 */
export function getApiKeyHeader(c: Context): string | undefined {
  for (const headerName of API_KEY_HEADERS) {
    const value = stripBearer(c.req.header(headerName));
    if (value) return value;
  }
  return undefined;
}

/**
 * End-user token: `authorization` (Bearer stripped) or the raw
 * `x-vellum-user-token` alias.
 */
export function getUserTokenHeader(c: Context): string | undefined {
  const bearer = stripBearer(c.req.header("authorization"));
  if (bearer) return bearer;
  const alias = c.req.header("x-vellum-user-token");
  return typeof alias === "string" && alias.length > 0 ? alias : undefined;
}

/**
 * Resolves the end-user AuthContext for a document-plane request.
 *
 * EdDSA-only: the token is always verified against the project's Ed25519
 * auth config. Projects without a config are auto-initialized on first use.
 * Requests without a token stay anonymous. There is no HS256 console/admin
 * fallback (see SECURITY-HARDENING-CONTRACT §2).
 */
export async function resolveEndUserAuth(
  c: Context,
  platform: VellumPlatformContext
): Promise<AuthContext> {
  const token = getUserTokenHeader(c);
  if (!token) return { uid: null, claims: {} };

  const projectId = c.req.param("projectId");
  if (!projectId) {
    throw new VellumError("UNAUTHENTICATED", "Cannot resolve end-user token without project context");
  }

  let config = platform.controlStore.getAuthConfig(projectId);
  if (!config) {
    // Local mirror of `ensureAuthConfig` (routes/auth-shared.ts) to avoid a
    // circular import. The private key is encrypted at rest with the master key.
    const keyPair = generateEd25519KeyPair(process.env["MASTER_ENCRYPTION_KEY"]);
    config = await platform.controlStore.upsertAuthConfig({
      projectId,
      jwtKeyId: keyPair.keyId,
      jwtPublicKeyPem: keyPair.publicKeyPem,
      jwtPrivateKeyEncrypted: keyPair.privateKeyEncrypted,
    });
  }

  let payload: EndUserJwtPayload;
  try {
    payload = verifyEndUserAccessToken(token, config.jwtPublicKeyPem, {
      projectId,
      issuer: `https://api.vellum.dev/v1/projects/${projectId}/auth`,
    });
  } catch (err) {
    // A signed-but-expired token is refreshable: preserve its canonical code so
    // the error handler can hoist `retryableWithRefresh`. Every other failure is
    // deliberately generic — never echo token contents or verifier internals.
    if (err instanceof VellumError && err.code === "TOKEN_EXPIRED") throw err;
    throw new VellumError("UNAUTHENTICATED", "Invalid end-user access token");
  }
  return {
    uid: payload.sub,
    claims: payload.claims ?? {},
    email: payload.email ?? null,
    email_verified: payload.email_verified === true,
    is_anonymous: payload.is_anonymous === true,
    token: { ...payload },
  };
}

/** Server API keys (`sk_`) are admin-level document-plane credentials. */
export function resolveIsAdminServer(apiKeyRecord: { keyType?: string }): boolean {
  return apiKeyRecord.keyType === "server";
}
