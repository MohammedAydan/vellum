import { describe, it, expect, vi } from "vitest";
import { createClient } from "../index.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

const FUTURE_TOKEN = makeJwt({ sub: "usr_1", exp: Math.floor(Date.now() / 1000) + 3600 });

const PUBLIC_USER = {
  id: "usr_1",
  email: "alice@example.com",
  emailVerified: false,
  displayName: "Alice",
  photoUrl: null,
  phoneNumber: null,
  phoneVerified: false,
  isDisabled: false,
  isAnonymous: false,
  customClaims: {},
  metadata: {},
  createdAt: "2026-11-17T00:00:00.000Z",
  updatedAt: "2026-11-17T00:00:00.000Z",
  lastSignInAt: null,
};

function session(accessToken: string, refreshToken = "refresh_1") {
  return {
    user: PUBLIC_USER,
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    sessionId: "sess_1",
    expiresAt: "2026-11-17T01:00:00.000Z",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RecordedCall {
  url: string;
  init?: RequestInit | undefined;
}

function recorder(handler: (call: RecordedCall) => Response): {
  calls: RecordedCall[];
  fetch: typeof globalThis.fetch;
} {
  const calls: RecordedCall[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = { url: String(url), init };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

function headersOf(call: RecordedCall | undefined): Record<string, string> {
  return (call?.init?.headers ?? {}) as Record<string, string>;
}

describe("@vellumdb/sdk-js - end-user auth", () => {
  it("sign-up returns tokens and establishes currentUser", async () => {
    const { calls, fetch } = recorder(({ url }) => {
      if (url.endsWith("/auth/sign-up/email")) return json(session(FUTURE_TOKEN));
      return json({});
    });
    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch });

    const signedIn = await db.signUpWithEmailAndPassword({
      email: "alice@example.com",
      password: "password123",
    });

    expect(signedIn.id).toBe("usr_1");
    expect(signedIn.accessToken).toBe(FUTURE_TOKEN);
    expect(signedIn.refreshToken).toBe("refresh_1");
    expect(await db.getIdToken()).toBe(FUTURE_TOKEN);
    expect(calls[0]?.url).toContain("/v1/projects/p/auth/sign-up/email");
    expect(headersOf(calls[0])["x-vellum-api-key"]).toBe("pk_test");
    expect(headersOf(calls[0])["x-project-key"]).toBe("pk_test");
  });

  it("does not set currentUser when MFA is required", async () => {
    const { fetch } = recorder(({ url }) => {
      if (url.endsWith("/auth/sign-in/email")) {
        return json({
          mfaRequired: true,
          mfaTicket: "mfa_ticket_1",
          factors: ["totp"],
          expiresAt: "2026-11-17T00:05:00.000Z",
        });
      }
      return json({});
    });
    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch });

    const result = await db.signInWithEmailAndPassword({
      email: "alice@example.com",
      password: "password123",
    });

    expect(result).toMatchObject({ mfaRequired: true, mfaTicket: "mfa_ticket_1", factors: ["totp"] });
    expect(await db.getIdToken()).toBeNull();
  });

  it("dedupes concurrent forced token refreshes into a single request", async () => {
    let refreshCalls = 0;
    const refreshedToken = makeJwt({ sub: "usr_1", exp: Math.floor(Date.now() / 1000) + 7200 });
    const { calls, fetch } = recorder(({ url }) => {
      if (url.endsWith("/auth/sign-up/email")) return json(session(FUTURE_TOKEN));
      if (url.endsWith("/auth/token/refresh")) {
        refreshCalls += 1;
        return json({
          accessToken: refreshedToken,
          refreshToken: "refresh_2",
          tokenType: "Bearer",
          sessionId: "sess_2",
          expiresAt: "2026-11-17T02:00:00.000Z",
        });
      }
      return json({});
    });
    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch });
    await db.signUpWithEmailAndPassword({ email: "alice@example.com", password: "password123" });

    const [first, second, third] = await Promise.all([
      db.getIdToken(true),
      db.getIdToken(true),
      db.getIdToken(true),
    ]);

    expect(refreshCalls).toBe(1);
    expect(first).toBe(refreshedToken);
    expect(second).toBe(refreshedToken);
    expect(third).toBe(refreshedToken);
    expect(calls.filter((call) => call.url.endsWith("/auth/token/refresh"))).toHaveLength(1);
  });

  it("notifies onAuthStateChanged listeners on sign-in and sign-out", async () => {
    const { fetch } = recorder(({ url }) => {
      if (url.endsWith("/auth/sign-up/email")) return json(session(FUTURE_TOKEN));
      if (url.endsWith("/auth/sign-out")) return json({ success: true });
      return json({});
    });
    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch });
    const states: Array<{ id: string } | null> = [];
    const unsubscribe = db.onAuthStateChanged((user) => {
      states.push(user === null ? null : { id: user.id });
    });

    await db.signUpWithEmailAndPassword({ email: "alice@example.com", password: "password123" });
    await db.signOut();

    expect(states).toEqual([{ id: "usr_1" }, null]);
    expect(await db.getIdToken()).toBeNull();
    unsubscribe();
  });

  it("injects the bearer token into subsequent document REST requests", async () => {
    const { calls, fetch } = recorder(({ url }) => {
      if (url.endsWith("/auth/sign-up/email")) return json(session(FUTURE_TOKEN));
      if (url.includes("/documents/")) {
        return json({ documentId: "u1", path: "users/u1", version: 1, data: { name: "Alice" } });
      }
      return json({});
    });
    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch });
    await db.signUpWithEmailAndPassword({ email: "alice@example.com", password: "password123" });

    const snap = await db.doc("users/u1").get();

    expect(snap.data()).toEqual({ name: "Alice" });
    const documentCall = calls.find((call) => call.url.includes("/documents/"));
    expect(headersOf(documentCall)["authorization"]).toBe(`Bearer ${FUTURE_TOKEN}`);
  });

  it("pre-flight refreshes a token expiring within 45 s before a REST call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T00:00:00.000Z"));
    try {
      const expiring = makeJwt({ sub: "usr_1", exp: Math.floor(Date.now() / 1000) + 20 });
      const refreshed = makeJwt({ sub: "usr_1", exp: Math.floor(Date.now() / 1000) + 3600 });
      const { calls, fetch } = recorder(({ url }) => {
        if (url.endsWith("/auth/sign-up/email")) return json(session(expiring));
        if (url.endsWith("/auth/token/refresh")) {
          return json(session(refreshed, "refresh_2"));
        }
        if (url.includes("/documents/")) {
          return json({ documentId: "u1", path: "users/u1", version: 1, data: { name: "Alice" } });
        }
        return json({});
      });
      const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch });
      await db.signUpWithEmailAndPassword({ email: "alice@example.com", password: "password123" });

      await db.doc("users/u1").get();

      expect(calls.filter((call) => call.url.endsWith("/auth/token/refresh"))).toHaveLength(1);
      const documentCall = calls.find((call) => call.url.includes("/documents/"));
      expect(headersOf(documentCall)["authorization"]).toBe(`Bearer ${refreshed}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays exactly once after a 401 using a single force refresh", async () => {
    const refreshed = makeJwt({ sub: "usr_1", exp: Math.floor(Date.now() / 1000) + 7200 });
    let refreshCalls = 0;
    let documentAttempts = 0;
    const { calls, fetch } = recorder(({ url }) => {
      if (url.endsWith("/auth/sign-up/email")) return json(session(FUTURE_TOKEN));
      if (url.endsWith("/auth/token/refresh")) {
        refreshCalls += 1;
        return json(session(refreshed, "refresh_2"));
      }
      if (url.includes("/documents/")) {
        documentAttempts += 1;
        if (documentAttempts === 1) {
          return json(
            { error: { code: "TOKEN_EXPIRED", message: "Invalid, expired, or revoked session token" } },
            401
          );
        }
        return json({ documentId: "u1", path: "users/u1", version: 1, data: { name: "Alice" } });
      }
      return json({});
    });
    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch });
    await db.signUpWithEmailAndPassword({ email: "alice@example.com", password: "password123" });

    const snap = await db.doc("users/u1").get();

    expect(snap.data()).toEqual({ name: "Alice" });
    expect(refreshCalls).toBe(1);
    const documentCalls = calls.filter((call) => call.url.includes("/documents/"));
    expect(documentCalls).toHaveLength(2);
    expect(headersOf(documentCalls[0])["authorization"]).toBe(`Bearer ${FUTURE_TOKEN}`);
    expect(headersOf(documentCalls[1])["authorization"]).toBe(`Bearer ${refreshed}`);
  });

  it("does not loop when the replayed request also returns 401", async () => {
    let refreshCalls = 0;
    let documentAttempts = 0;
    const { fetch } = recorder(({ url }) => {
      if (url.endsWith("/auth/sign-up/email")) return json(session(FUTURE_TOKEN));
      if (url.endsWith("/auth/token/refresh")) {
        refreshCalls += 1;
        return json(session(makeJwt({ exp: Math.floor(Date.now() / 1000) + 7200 }), "refresh_2"));
      }
      if (url.includes("/documents/")) {
        documentAttempts += 1;
        return json({ error: { code: "TOKEN_EXPIRED", message: "Invalid, expired, or revoked session token" } }, 401);
      }
      return json({});
    });
    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch });
    await db.signUpWithEmailAndPassword({ email: "alice@example.com", password: "password123" });

    await expect(db.doc("users/u1").get()).rejects.toMatchObject({ status: 401 });
    expect(refreshCalls).toBe(1);
    expect(documentAttempts).toBe(2);
  });

  it("injects the bearer token into test-hub auth frames", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const { fetch } = recorder(({ url }) => {
      if (url.endsWith("/auth/sign-up/email")) return json(session(FUTURE_TOKEN));
      return json({});
    });
    const db = createClient({
      projectId: "p",
      apiKey: "pk_test",
      customFetch: fetch,
      realtimeHub: {
        createConnectionSession: () => ({
          handleClientFrame: (frame: unknown) => {
            frames.push(frame as Record<string, unknown>);
          },
          close: () => undefined,
        }),
      },
    });
    await db.signUpWithEmailAndPassword({ email: "alice@example.com", password: "password123" });
    db.collection("users").onSnapshot(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const authFrame = frames.find((frame) => frame["type"] === "auth");
    expect(authFrame?.["authToken"]).toBe(FUTURE_TOKEN);
    expect(authFrame?.["userToken"]).toBe(FUTURE_TOKEN);
  });
});
