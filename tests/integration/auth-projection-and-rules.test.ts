/**
 * tests/integration/auth-projection-and-rules
 *
 * LIVE Neon + real HTTP server:
 *   1. Publish a ruleset that DENIES public writes to `users/{uid}`.
 *   2. Sign-up through the new API; the system projector must still create
 *      `users/{uid}` (bypassRules) with only public fields — never passwordHash.
 *   3. Set `customClaims={"role":"editor"}` via the customer-admin claims API.
 *   4. A freshly issued JWT carrying the editor claim can write to a collection
 *      guarded by `auth.claims.role == "editor"`; the pre-claim token cannot.
 *
 * Skipped unless PHASE5_REAL=1. No secrets are logged.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminUrl,
  authUrl,
  documentUrl,
  json,
  newPrefix,
  setupLiveAuthHarness,
  teardownLiveAuthHarness,
  userHeaders,
  withTenantData,
  type ErrorBody,
  type LiveAuthHarness,
} from "./auth-live-helpers.js";

const REAL_DATABASE_ENABLED = process.env.PHASE5_REAL === "1";
const prefix = newPrefix("authproj");
const EMAIL = `${prefix}editor@example.com`;
const PASSWORD = "Str0ng!Passw0rd";
const EDITOR_DOC = `editors/${prefix}doc1`;

interface SessionBody {
  user: { id: string; email: string; customClaims: Record<string, unknown> };
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}
interface DocBody {
  path?: string;
  data?: Record<string, unknown>;
  version?: number;
}

let h: LiveAuthHarness | undefined;
let userId = "";
let initialToken = "";

function decodeClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  expect(parts).toHaveLength(3);
  return JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
}

describe.skipIf(!REAL_DATABASE_ENABLED)("tests/integration/auth-projection-and-rules", () => {
  beforeAll(async () => {
    h = await setupLiveAuthHarness(prefix);
    const harness = h;

    const rulesAst = {
      version: 1,
      rules: [
        {
          // Public writes to the projected user document are forbidden.
          match: "users/{userId}",
          allow: { read: true, write: false },
        },
        {
          // This collection requires the editor claim carried in the end-user JWT.
          match: "editors/{docId}",
          allow: {
            read: true,
            write: {
              op: "==",
              left: { var: "auth.claims.role" },
              right: { val: "editor" },
            },
          },
        },
      ],
    };
    const published = await json<{ id: string; version: number }>(
      `${harness.baseUrl}/v1/projects/${harness.projectId}/rulesets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rulesAst }),
      }
    );
    expect(published.status).toBe(201);
    expect(published.body.version).toBe(1);
  }, 60_000);

  afterAll(async () => {
    if (h) await teardownLiveAuthHarness(h);
  }, 60_000);

  it("projects users/{uid} with public fields only, despite a deny-write rule", async () => {
    const harness = h as LiveAuthHarness;

    const signup = await json<SessionBody>(
      authUrl(harness.baseUrl, harness.projectId, "/sign-up/email"),
      {
        method: "POST",
        headers: userHeaders(harness.publicKey, null, true),
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, displayName: "Editor User" }),
      }
    );
    expect(signup.status).toBe(201);
    userId = signup.body.user.id;
    initialToken = signup.body.accessToken;
    expect(userId).toBeTruthy();

    // 1. The deny rule is real: a normal (non-system) write is rejected.
    const deniedWrite = await json<ErrorBody>(
      documentUrl(harness.baseUrl, harness.projectId, `users/${userId}`),
      {
        method: "PUT",
        headers: userHeaders(harness.publicKey, initialToken, true),
        body: JSON.stringify({ data: { displayName: "tampered" } }),
      }
    );
    expect(deniedWrite.status).toBe(403);
    expect(deniedWrite.body.error.code).toBe("PERMISSION_DENIED");

    // 2. The system projection still created the document.
    const read = await json<DocBody>(
      documentUrl(harness.baseUrl, harness.projectId, `users/${userId}`),
      { headers: userHeaders(harness.publicKey, initialToken) }
    );
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({
      uid: userId,
      email: EMAIL,
      displayName: "Editor User",
      emailVerified: false,
      isAnonymous: false,
    });
    expect(read.body.data).not.toHaveProperty("passwordHash");

    // 3. Durable DB assertion: the row exists with the projected fields and no
    //    passwordHash anywhere in the stored JSON.
    await withTenantData(harness.dataClient, harness.projectId, async (tx) => {
      const rows = await tx.query<{ data: Record<string, unknown> }>(
        "SELECT data FROM documents WHERE path = $1",
        [`users/${userId}`]
      );
      expect(rows.rows).toHaveLength(1);
      const stored = rows.rows[0]?.data as Record<string, unknown>;
      expect(stored.uid).toBe(userId);
      expect(stored.email).toBe(EMAIL);
      expect(stored).not.toHaveProperty("passwordHash");
      expect(JSON.stringify(stored)).not.toContain("passwordHash");
    });
  }, 60_000);

  it("a freshly issued JWT with the editor claim unlocks the guarded collection", async () => {
    const harness = h as LiveAuthHarness;
    expect(userId).toBeTruthy();

    // 1. Customer admin sets the claim via the dedicated claims endpoint.
    const claimRes = await json<{ user: { customClaims: Record<string, unknown> } }>(
      adminUrl(harness.baseUrl, harness.projectId, `/users/${userId}/claims`),
      {
        method: "PUT",
        headers: userHeaders(harness.serverKey, null, true),
        body: JSON.stringify({ claims: { role: "editor" } }),
      }
    );
    expect(claimRes.status).toBe(200);
    expect(claimRes.body.user.customClaims).toMatchObject({ role: "editor" });

    // 2. Re-sign-in so the minted JWT carries the updated custom claims.
    const signIn = await json<SessionBody>(
      authUrl(harness.baseUrl, harness.projectId, "/sign-in/email"),
      {
        method: "POST",
        headers: userHeaders(harness.publicKey, null, true),
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }
    );
    expect(signIn.status).toBe(200);
    const editorToken = signIn.body.accessToken;
    const claimsPayload = decodeClaims(editorToken);
    expect(claimsPayload.claims).toMatchObject({ role: "editor" });
    expect(claimsPayload.sub).toBe(userId);

    // 3. Pre-claim token (no editor role) is still denied by the ruleset.
    const denied = await json<ErrorBody>(documentUrl(harness.baseUrl, harness.projectId, EDITOR_DOC), {
      method: "PUT",
      headers: userHeaders(harness.publicKey, initialToken, true),
      body: JSON.stringify({ data: { title: "nope" } }),
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("PERMISSION_DENIED");

    // 4. The editor JWT succeeds on the same guarded path.
    const allowed = await json<DocBody>(documentUrl(harness.baseUrl, harness.projectId, EDITOR_DOC), {
      method: "PUT",
      headers: userHeaders(harness.publicKey, editorToken, true),
      body: JSON.stringify({ data: { title: "hello-editor" } }),
    });
    expect(allowed.status).toBe(200);

    const readBack = await json<DocBody>(documentUrl(harness.baseUrl, harness.projectId, EDITOR_DOC), {
      headers: userHeaders(harness.publicKey, editorToken),
    });
    expect(readBack.status).toBe(200);
    expect(readBack.body.data?.title).toBe("hello-editor");
  }, 60_000);
});
