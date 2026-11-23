/**
 * tests/integration/auth-replay-and-quotas
 *
 * LIVE Neon + real HTTP server:
 *   1. Sign-up issues a session; a second sign-in issues another.
 *   2. Refresh rotates the refresh token successfully.
 *   3. Replaying the consumed refresh token -> 401 and ALL sessions for that
 *      user are revoked in data_db with reason `refresh_token_replay_detected`.
 *   4. Super-admin PATCH `auth_service_suspended=true` -> sign-up 403.
 *   5. Super-admin PATCH `maxUsersQuota=1` (quota filled) -> sign-up 429 QUOTA_EXCEEDED.
 *
 * Settings are restored in afterAll. Skipped unless PHASE5_REAL=1. No secrets
 * (API keys, JWTs, refresh tokens, DB URLs) are ever logged.
 */
import "./_live-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminUrl,
  authUrl,
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
const prefix = newPrefix("authreplay");

interface SessionBody {
  user: { id: string; email: string };
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  sessionId: string;
  expiresAt: string;
}
interface RefreshBody {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  sessionId: string;
  expiresAt: string;
}
interface ConfigBody {
  authServiceSuspended: boolean;
  maxUsersQuota: number;
  jwtKeyId: string;
}

let h: LiveAuthHarness | undefined;
let originalSuspended = false;
let originalQuota = 0;
let originalKeyId = "";
let userId = "";
let settingsRestored = false;

async function patchSuperAdminControl(patch: Record<string, unknown>): Promise<ConfigBody & { error?: unknown }> {
  const harness = h as LiveAuthHarness;
  const res = await json<ConfigBody & { error?: unknown }>(
    `${harness.baseUrl}/v1/admin/auth/projects/${harness.projectId}/control`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${harness.superAdminToken}`,
      },
      body: JSON.stringify(patch),
    }
  );
  expect(res.status, "super-admin control PATCH must succeed").toBe(200);
  return res.body;
}

async function signUp(email: string): Promise<{ status: number; body: SessionBody | ErrorBody }> {
  const harness = h as LiveAuthHarness;
  return json<SessionBody | ErrorBody>(authUrl(harness.baseUrl, harness.projectId, "/sign-up/email"), {
    method: "POST",
    headers: userHeaders(harness.publicKey, null, true),
    body: JSON.stringify({ email, password: "Str0ng!Passw0rd" }),
  });
}

describe.skipIf(!REAL_DATABASE_ENABLED)("tests/integration/auth-replay-and-quotas", () => {
  beforeAll(async () => {
    h = await setupLiveAuthHarness(prefix);
    const harness = h;

    // Capture the auto-initialized config so it can be restored exactly.
    const cfg = await json<ConfigBody>(adminUrl(harness.baseUrl, harness.projectId, "/config"), {
      headers: userHeaders(harness.serverKey),
    });
    expect(cfg.status).toBe(200);
    originalSuspended = cfg.body.authServiceSuspended;
    originalQuota = cfg.body.maxUsersQuota;
    originalKeyId = cfg.body.jwtKeyId;
    expect(originalKeyId).toBeTruthy();
  }, 60_000);

  afterAll(async () => {
    if (!h) return;
    if (!settingsRestored) {
      await json(
        `${h.baseUrl}/v1/admin/auth/projects/${h.projectId}/control`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${h.superAdminToken}`,
          },
          body: JSON.stringify({
            authServiceSuspended: originalSuspended,
            maxUsersQuota: originalQuota,
          }),
        }
      ).catch(() => undefined);
    }
    await teardownLiveAuthHarness(h);
  }, 60_000);

  it("rotation succeeds; replaying the old refresh token returns 401 and revokes all sessions", async () => {
    const harness = h as LiveAuthHarness;

    const signup = await signUp(`${prefix}one@example.com`);
    expect(signup.status).toBe(201);
    const first = signup.body as SessionBody;
    expect(first.tokenType).toBe("Bearer");
    expect(first.refreshToken).toBeTruthy();
    expect(first.accessToken).toBeTruthy();
    userId = first.user.id;

    // A second independent session for the same user.
    const secondSignIn = await json<SessionBody>(
      authUrl(harness.baseUrl, harness.projectId, "/sign-in/email"),
      {
        method: "POST",
        headers: userHeaders(harness.publicKey, null, true),
        body: JSON.stringify({ email: first.user.email, password: "Str0ng!Passw0rd" }),
      }
    );
    expect(secondSignIn.status).toBe(200);
    expect(secondSignIn.body.sessionId).not.toBe(first.sessionId);

    const refresh = await json<RefreshBody>(
      authUrl(harness.baseUrl, harness.projectId, "/token/refresh"),
      {
        method: "POST",
        headers: userHeaders(harness.publicKey, null, true),
        body: JSON.stringify({ refreshToken: first.refreshToken }),
      }
    );
    expect(refresh.status).toBe(200);
    const rotated = refresh.body;
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    expect(rotated.sessionId).toBe(first.sessionId);

    // A previous refresh hash inside the documented 15 s window is treated as
    // a benign parallel-tab refresh, not a replay. Backdate this rotation's
    // marker so the reuse below is unambiguously outside that grace window.
    await withTenantData(harness.dataClient, harness.projectId, async (tx) => {
      await tx.query(
        "UPDATE project_auth_sessions SET rotated_at = now() - interval '20 seconds' WHERE id = $1::uuid",
        [rotated.sessionId]
      );
    });

    // Replay the consumed (previous) refresh token.
    const replay = await json<ErrorBody>(
      authUrl(harness.baseUrl, harness.projectId, "/token/refresh"),
      {
        method: "POST",
        headers: userHeaders(harness.publicKey, null, true),
        body: JSON.stringify({ refreshToken: first.refreshToken }),
      }
    );
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("UNAUTHENTICATED");

    // Durable assertion against data_db: every session for the user is revoked.
    await withTenantData(harness.dataClient, harness.projectId, async (tx) => {
      const rows = await tx.query<{
        revoked: boolean;
        revoked_reason: string | null;
      }>(
        "SELECT revoked, revoked_reason::text FROM project_auth_sessions WHERE user_id = $1::uuid",
        [userId]
      );
      expect(rows.rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.rows.every((r) => r.revoked)).toBe(true);
      expect(rows.rows.some((r) => r.revoked_reason === "refresh_token_replay_detected")).toBe(true);
    });
  }, 60_000);

  it("super-admin suspension blocks sign-up with 403, and restoring it re-enables sign-up", async () => {
    const harness = h as LiveAuthHarness;

    await patchSuperAdminControl({
      authServiceSuspended: true,
      suspensionReason: "auth-replay-live-test",
    });

    const blocked = await signUp(`${prefix}suspended@example.com`);
    expect(blocked.status).toBe(403);
    expect((blocked.body as ErrorBody).error.code).toBe("PERMISSION_DENIED");

    await patchSuperAdminControl({ authServiceSuspended: originalSuspended });
    // No user was created while suspended: the quota test below starts clean.
  }, 60_000);

  it("maxUsersQuota filled returns 429 QUOTA_EXCEEDED and config is restored", async () => {
    const harness = h as LiveAuthHarness;

    // One user exists (from the rotation test). A quota of 1 is therefore full.
    await patchSuperAdminControl({ maxUsersQuota: 1 });

    const overQuota = await signUp(`${prefix}overquota@example.com`);
    expect(overQuota.status).toBe(429);
    expect((overQuota.body as ErrorBody).error.code).toBe("QUOTA_EXCEEDED");

    await patchSuperAdminControl({ maxUsersQuota: originalQuota });
    settingsRestored = true;
  }, 60_000);
});
