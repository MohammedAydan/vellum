/**
 * Authentication & API keys (REST) — full key lifecycle with immediate revocation.
 *
 * What you'll build: email sign-in, session check, server key creation, a probe
 * with that key, revocation, and proof the revoked key is rejected at once.
 * Real-world scenario: rotating a leaked key must take effect on the next request
 * with no cache window. Tokens and raw keys never appear in output.
 */
import { harness, check } from "./_harness.mjs";

const h = await harness("auth");
const keysPath = `/projects/${h.projectId}/api-keys`;
const docProbe = `/v1/projects/${h.projectId}/documents/${h.prefix}/probe`;

try {
  h.log("=== Authentication & API Keys ===");

  const login = await h.api.signIn();
  check(login.success === true && typeof login.token === "string" && login.token.length > 0, "sign-in returned a token");
  h.log({ signIn: { success: login.success, tokenLength: login.token.length, userRole: login.user.platformRole } });

  const session = await h.api.raw("GET", "/v1/auth/session", undefined, {
    authorization: `Bearer ${login.token}`,
  });
  check(session.status === 200, "session endpoint accepted the bearer token");
  h.log({ session: { status: session.status, hasSession: Boolean(session.body.session) } });

  const listed = await h.api.console("GET", keysPath);
  check(listed.ok && Array.isArray(listed.body) && listed.body.length > 0, "API keys are listable");
  h.log({
    listKeys: {
      status: listed.status,
      nonEmpty: listed.body.length > 0,
      includesServerKey: listed.body.some((k) => k.keyType === "server"),
    },
  });

  const created = await h.api.console("POST", keysPath, { name: "examples:rest-auth:ephemeral", keyType: "server" });
  check(created.status === 201 && Boolean(created.body.apiKey?.id) && Boolean(created.body.rawKey), "ephemeral key created");
  const ephemeralId = created.body.apiKey.id;
  h.log({
    createKey: { status: created.status, keyType: created.body.apiKey.keyType, idReturned: Boolean(ephemeralId) },
  });

  const unauth = await h.api.raw("GET", docProbe);
  check(unauth.status === 401 && unauth.body?.error?.code === "UNAUTHENTICATED", "missing key returns 401");
  h.log({ missingKey: { status: unauth.status, code: unauth.body.error.code } });

  const whileActive = await h.api.raw("GET", docProbe, undefined, { "x-project-key": created.body.rawKey });
  check(whileActive.status !== 401, "freshly created key authenticates");

  const revoked = await h.api.console("DELETE", `${keysPath}/${ephemeralId}`);
  check(revoked.ok, "ephemeral key revoked");
  h.log({ revokeKey: { status: revoked.status, success: revoked.body?.success } });

  const afterRevoke = await h.api.raw("GET", docProbe, undefined, { "x-project-key": created.body.rawKey });
  check(afterRevoke.status === 401 && afterRevoke.body?.error?.code === "UNAUTHENTICATED", "revoked key rejected immediately");
  h.log({ revokedKeyRejected: { status: afterRevoke.status, code: afterRevoke.body.error.code } });
} finally {
  await h.cleanup();
}
