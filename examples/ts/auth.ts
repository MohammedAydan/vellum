/**
 * Authentication & API keys — full key lifecycle with immediate revocation.
 *
 * What you'll build: a sign-in, a session check, a server key creation, and a
 * verification that revoking that key takes effect on the very next request.
 * Real-world scenario: an operator rotates a leaked key. A freshly verified
 * key must stop authenticating immediately after it is revoked — no cache
 * window. All tokens/keys are kept out of output; only stable codes are logged.
 */
import { harness, check } from "./_harness.js";

const h = await harness("auth");
const keysPath = `/projects/${h.projectId}/api-keys`;

try {
  h.log("=== Authentication & API Keys ===");

  const login = await h.api.signIn();
  check(login.success === true && typeof login.token === "string" && login.token.length > 0, "sign-in returned a token");
  h.log({ signIn: { success: login.success, tokenLength: login.token.length, userRole: login.user["platformRole"] } });

  const session = await h.api.raw<{ session?: unknown }>(
    "GET",
    "/v1/auth/session",
    undefined,
    { authorization: `Bearer ${login.token}` }
  );
  check(session.status === 200, "session endpoint accepted the bearer token");
  h.log({ session: { status: session.status, hasSession: Boolean(session.body.session) } });

  const listed = await h.api.console<Array<{ id: string; keyType: string }>>("GET", keysPath);
  check(listed.ok && Array.isArray(listed.body) && listed.body.length > 0, "API keys are listable");
  h.log({ listKeys: { status: listed.status, nonEmpty: listed.body.length > 0, includesServerKey: listed.body.some((k) => k.keyType === "server") } });

  const created = await h.api.console<{
    apiKey?: { id: string; keyType: string };
    rawKey?: string;
  }>("POST", keysPath, { name: "examples:auth-ephemeral", keyType: "server" });
  check(created.status === 201 && Boolean(created.body.apiKey?.id) && Boolean(created.body.rawKey), "ephemeral key created");
  const ephemeralId = created.body.apiKey?.id;
  h.log({ createKey: { status: created.status, keyType: created.body.apiKey?.keyType, idReturned: Boolean(ephemeralId) } });

  const unauth = await h.api.raw(
    "GET",
    `/v1/projects/${h.projectId}/documents/${h.prefix}/probe`
  );
  const unauthCode = (unauth.body as { error?: { code?: string } })?.error?.code;
  check(unauth.status === 401 && unauthCode === "UNAUTHENTICATED", "missing key returns 401 UNAUTHENTICATED");
  h.log({ missingKey: { status: unauth.status, code: unauthCode } });

  const docProbe = `/v1/projects/${h.projectId}/documents/${h.prefix}/probe`;
  const whileActive = await h.api.raw("GET", docProbe, undefined, { "x-project-key": created.body.rawKey as string });
  check(whileActive.status !== 401, "freshly created key authenticates");

  const revoked = await h.api.console("DELETE", `${keysPath}/${ephemeralId}`);
  check(revoked.ok, "ephemeral key was revoked");
  h.log({ revokeKey: { status: revoked.status, success: (revoked.body as { success?: boolean } | null)?.success } });

  // Revocation must take effect immediately, even for a recently verified key.
  const afterRevoke = await h.api.raw("GET", docProbe, undefined, { "x-project-key": created.body.rawKey as string });
  const revokeCode = (afterRevoke.body as { error?: { code?: string } })?.error?.code;
  check(afterRevoke.status === 401 && revokeCode === "UNAUTHENTICATED", "revoked key is rejected immediately");
  h.log({ revokedKeyRejected: { status: afterRevoke.status, code: revokeCode } });
} finally {
  await h.cleanup();
}
