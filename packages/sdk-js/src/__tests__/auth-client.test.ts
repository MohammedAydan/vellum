import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserLocalStorage,
  MemoryAuthStorage,
  createClient,
  resolveAuthStorage,
  type AuthStorage,
  type StorageLike,
} from "../index.js";
import type { AuthState, WebSocketLike } from "../index.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

const FIRST_TOKEN = makeJwt({ sub: "usr_1", exp: Math.floor(Date.now() / 1000) + 3600 });
const ROTATED_TOKEN = makeJwt({ sub: "usr_1", exp: Math.floor(Date.now() / 1000) + 7200 });

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

function authState(accessToken = FIRST_TOKEN): AuthState {
  return {
    ...PUBLIC_USER,
    accessToken,
    refreshToken: "refresh_1",
    tokenType: "Bearer",
    sessionId: "sess_1",
    expiresAt: "2026-11-17T01:00:00.000Z",
  };
}

function session(accessToken = FIRST_TOKEN, refreshToken = "refresh_1") {
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
  body: unknown;
}

function recorder(handler: (call: RecordedCall) => Response): {
  calls: RecordedCall[];
  fetch: typeof globalThis.fetch;
} {
  const calls: RecordedCall[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const raw = init?.body;
    const body: unknown =
      typeof raw === "string"
        ? (() => {
            try {
              return JSON.parse(raw) as unknown;
            } catch {
              return undefined;
            }
          })()
        : undefined;
    const call: RecordedCall = { url: String(url), init, body };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

function headersOf(call: RecordedCall | undefined): Record<string, string> {
  return (call?.init?.headers ?? {}) as Record<string, string>;
}

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  return {
    data: initial,
    getItem(key: string) {
      return this.data[key] ?? null;
    },
    setItem(key: string, value: string) {
      this.data[key] = value;
    },
    removeItem(key: string) {
      delete this.data[key];
    },
  };
}

class FakeSocket implements WebSocketLike {
  public readyState = 1;
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public onclose: ((event: { code?: number; reason?: unknown }) => void) | null = null;
  public readonly sent: string[] = [];

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  public receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  public frames(type: string): Array<Record<string, unknown>> {
    return this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame["type"] === type);
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("@vellumdb/sdk-js - auth storage", () => {
  it("defaults to memory storage everywhere; persistence is opt-in (S7)", () => {
    vi.stubGlobal("window", undefined);
    expect(resolveAuthStorage(null)).toBeInstanceOf(MemoryAuthStorage);
    expect(resolveAuthStorage(undefined)).toBeInstanceOf(MemoryAuthStorage);

    // Even with browser localStorage available the default stays in memory.
    const storage = fakeStorage();
    vi.stubGlobal("window", { localStorage: storage });
    expect(resolveAuthStorage(null)).toBeInstanceOf(MemoryAuthStorage);

    const explicit = new MemoryAuthStorage();
    expect(resolveAuthStorage(explicit)).toBe(explicit);
  });

  it("authPersistence: 'local' opts into browser localStorage, explicit authStorage wins", async () => {
    const backing = fakeStorage();
    vi.stubGlobal("window", { localStorage: backing });
    const { fetch } = recorder(({ url }) => (url.endsWith("/auth/sign-up/email") ? json(session()) : json({})));

    const first = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch, authPersistence: "local" });
    await first.signUpWithEmailAndPassword("bob@example.com", "password123");
    const keys = Object.keys(backing.data);
    expect(keys.some((k) => k.startsWith("vellum.auth.session.v1:"))).toBe(true);

    // A second client hydrates from the persisted session without a network call.
    const second = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch, authPersistence: "local" });
    expect(second.currentUser?.id).toBe("usr_1");

    // Without the opt-in nothing is persisted.
    const fresh = fakeStorage();
    vi.stubGlobal("window", { localStorage: fresh });
    const third = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch });
    await third.signUpWithEmailAndPassword("carol@example.com", "password123");
    expect(Object.keys(fresh.data)).toHaveLength(0);
  });

  it("validates stored sessions and drops corrupt entries without logging", () => {
    const storage = fakeStorage({ "vellum.auth.session.v1": "{not-json" });
    const store = new BrowserLocalStorage("vellum.auth.session.v1", storage);
    expect(store.load()).toBeNull();
    expect(storage.data["vellum.auth.session.v1"]).toBeUndefined();

    store.save(authState());
    expect(store.load()).toMatchObject({ id: "usr_1", accessToken: FIRST_TOKEN });
    store.clear();
    expect(store.load()).toBeNull();
  });

  it("hydrates a new client from persisted session and hands it to a new listener once", async () => {
    const storage: AuthStorage = new MemoryAuthStorage();
    const { fetch } = recorder(({ url }) => (url.endsWith("/auth/sign-up/email") ? json(session()) : json({})));
    const first = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch, authStorage: storage });
    await first.signUpWithEmailAndPassword("alice@example.com", "password123", { displayName: "Alice" });

    const second = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch, authStorage: storage });
    const seen: unknown[] = [];
    second.onAuthStateChanged((user) => seen.push(user));

    expect(second.currentUser?.id).toBe("usr_1");
    expect(await second.getIdToken()).toBe(FIRST_TOKEN);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { id: string }).id).toBe("usr_1");
  });
});

describe("@vellumdb/sdk-js - signOut and getUser", () => {
  it("revokes only the current session by default and clears local state", async () => {
    const storage: AuthStorage = new MemoryAuthStorage();
    const { calls, fetch } = recorder(({ url }) => {
      if (url.endsWith("/auth/sign-up/email")) return json(session());
      if (url.endsWith("/auth/sign-out")) return json({ success: true });
      return json({});
    });
    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch, authStorage: storage });
    const states: unknown[] = [];
    db.onAuthStateChanged((user) => states.push(user));
    await db.signUpWithEmailAndPassword({ email: "alice@example.com", password: "password123" });

    await db.signOut();

    const signOutCall = calls.find((call) => call.url.endsWith("/auth/sign-out"));
    expect(signOutCall?.body).toEqual({ refreshToken: "refresh_1" });
    expect(headersOf(signOutCall)["authorization"]).toBeUndefined();
    expect(db.currentUser).toBeNull();
    expect(storage.load()).toBeNull();
    // initial state (signed out), sign-in, sign-out
    expect(states).toHaveLength(3);
    expect(states[0]).toBeNull();
    expect(states[2]).toBeNull();
  });

  it("revokes all sessions when requested by sending the bearer without a refresh token", async () => {
    const { calls, fetch } = recorder(({ url }) => {
      if (url.endsWith("/auth/sign-in/email")) return json(session());
      if (url.endsWith("/auth/sign-out")) return json({ success: true });
      return json({});
    });
    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch });
    await db.signInWithEmailAndPassword("alice@example.com", "password123");

    await db.auth.signOut({ allSessions: true });

    const signOutCall = calls.find((call) => call.url.endsWith("/auth/sign-out"));
    expect(signOutCall?.body).toEqual({});
    expect(headersOf(signOutCall)["authorization"]).toBe(`Bearer ${FIRST_TOKEN}`);
    expect(db.currentUser).toBeNull();
  });

  it("keeps listeners registered across sign-out so the next sign-in is observed", async () => {
    const { fetch } = recorder(({ url }) => {
      if (url.endsWith("/auth/sign-in/email")) return json(session());
      if (url.endsWith("/auth/sign-out")) return json({ success: true });
      return json({});
    });
    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch });
    const seen: unknown[] = [];
    db.onAuthStateChanged((user) => seen.push(user));
    await db.signInWithEmailAndPassword("a@b.c", "password123");
    await db.signOut();
    await db.signInWithEmailAndPassword("a@b.c", "password123");

    expect(seen).toHaveLength(4);
    expect((seen[3] as { id: string }).id).toBe("usr_1");
  });

  it("getUser returns the public record and refreshes the local snapshot", async () => {
    const { calls, fetch } = recorder(({ url }) => {
      if (url.endsWith("/auth/sign-in/email")) return json(session());
      if (url.endsWith("/auth/user")) {
        return json({ user: { ...PUBLIC_USER, displayName: "Updated", emailVerified: true } });
      }
      return json({});
    });
    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch });
    await db.signInWithEmailAndPassword("a@b.c", "password123");

    const user = await db.getUser();

    expect(user.displayName).toBe("Updated");
    expect(db.currentUser?.displayName).toBe("Updated");
    expect(db.currentUser?.emailVerified).toBe(true);
    const userCall = calls.find((call) => call.url.endsWith("/auth/user"));
    expect(headersOf(userCall)["authorization"]).toBe(`Bearer ${FIRST_TOKEN}`);
  });
});

describe("@vellumdb/sdk-js - positional auth API", () => {
  it("accepts both object and positional forms for the required methods", async () => {
    const { calls, fetch } = recorder(({ url }) => {
      if (url.endsWith("/auth/sign-up/email")) return json(session());
      if (url.endsWith("/auth/sign-in/provider")) return json(session());
      if (url.endsWith("/auth/mfa/challenge")) return json(session());
      if (url.endsWith("/auth/password/reset")) return json({ success: true, sent: true });
      if (url.endsWith("/auth/password/confirm")) return json({ success: true });
      if (url.endsWith("/auth/email/verify/confirm")) return json({ success: true, user: PUBLIC_USER });
      if (url.endsWith("/auth/mfa/verify")) return json({ verified: true });
      return json({});
    });
    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch });

    await db.signUpWithEmailAndPassword("alice@example.com", "password123", { displayName: "Alice" });
    await db.signInWithOAuth("google", { idToken: "id-token" });
    await db.verifyMfaChallenge("mfa_ticket_1", "123456");
    await db.sendPasswordResetEmail("alice@example.com");
    await db.confirmPasswordReset("reset_token", "newPassword1");
    await db.confirmEmailVerification("verify_token");
    await db.confirmTotpMfa("123456");
    await db.disableMfa("654321");

    const signUp = calls.find((call) => call.url.endsWith("/auth/sign-up/email"));
    expect(signUp?.body).toMatchObject({ email: "alice@example.com", displayName: "Alice" });
    expect(calls.find((call) => call.url.endsWith("/auth/sign-in/provider"))?.body).toMatchObject({
      provider: "google",
      idToken: "id-token",
    });
    expect(calls.find((call) => call.url.endsWith("/auth/mfa/disable"))?.body).toEqual({ code: "654321" });
    expect(calls.find((call) => call.url.endsWith("/auth/mfa/challenge"))?.body).toEqual({
      mfaTicket: "mfa_ticket_1",
      code: "123456",
    });
    expect(calls.find((call) => call.url.endsWith("/auth/password/confirm"))?.body).toEqual({
      token: "reset_token",
      newPassword: "newPassword1",
    });
  });
});

describe("@vellumdb/sdk-js - realtime re-authentication after token rotation", () => {
  it("sends a fresh auth frame to test-hub connections when the token rotates", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const { fetch } = recorder(({ url }) => {
      if (url.endsWith("/auth/sign-in/email")) return json(session(FIRST_TOKEN));
      if (url.endsWith("/auth/token/refresh")) return json(session(ROTATED_TOKEN, "refresh_2"));
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
    await db.signInWithEmailAndPassword("a@b.c", "password123");
    const unsubscribe = db.collection("users").onSnapshot(() => undefined);
    await tick();

    expect(frames.filter((frame) => frame["type"] === "auth")).toHaveLength(1);
    expect(await db.getIdToken(true)).toBe(ROTATED_TOKEN);
    await tick();

    const authFrames = frames.filter((frame) => frame["type"] === "auth");
    expect(authFrames).toHaveLength(2);
    expect(authFrames[0]?.["authToken"]).toBe(FIRST_TOKEN);
    expect(authFrames[1]?.["authToken"]).toBe(ROTATED_TOKEN);
    expect(authFrames[1]?.["userToken"]).toBe(ROTATED_TOKEN);
    unsubscribe();
  });

  it("re-authenticates when an explicit getAuthToken provider rotates the bearer", async () => {
    let token = FIRST_TOKEN;
    const frames: Array<Record<string, unknown>> = [];
    const { fetch } = recorder(({ url }) => {
      if (url.includes("/documents/")) {
        return json({ documentId: "u1", path: "users/u1", version: 1, data: {} });
      }
      return json({});
    });
    const db = createClient({
      projectId: "p",
      apiKey: "pk_test",
      customFetch: fetch,
      getAuthToken: () => token,
      realtimeHub: {
        createConnectionSession: () => ({
          handleClientFrame: (frame: unknown) => {
            frames.push(frame as Record<string, unknown>);
          },
          close: () => undefined,
        }),
      },
    });
    const unsubscribe = db.collection("users").onSnapshot(() => undefined);
    await tick();
    expect(frames.filter((frame) => frame["type"] === "auth")).toHaveLength(1);

    token = ROTATED_TOKEN;
    await db.doc("users/u1").get();
    await tick();

    const authFrames = frames.filter((frame) => frame["type"] === "auth");
    expect(authFrames).toHaveLength(2);
    expect(authFrames[1]?.["authToken"]).toBe(ROTATED_TOKEN);
    unsubscribe();
  });

  it("re-sends the auth frame on the native transport after a forced refresh", async () => {
    const socket = new FakeSocket();
    const { fetch } = recorder(({ url }) => {
      if (url.endsWith("/auth/sign-in/email")) return json(session(FIRST_TOKEN));
      if (url.endsWith("/auth/token/refresh")) return json(session(ROTATED_TOKEN, "refresh_2"));
      return json({});
    });
    const db = createClient({
      projectId: "p",
      apiKey: "pk_test",
      customFetch: fetch,
      webSocketFactory: () => socket,
    });
    await db.signInWithEmailAndPassword("a@b.c", "password123");
    const unsubscribe = db.collection("users").onSnapshot(() => undefined);
    socket.onopen?.({});
    await tick();
    socket.receive({ type: "auth_ack", status: "authenticated" });
    await tick();

    expect(socket.frames("auth")).toHaveLength(1);
    expect(socket.frames("auth")[0]?.["authToken"]).toBe(FIRST_TOKEN);

    expect(await db.getIdToken(true)).toBe(ROTATED_TOKEN);
    await tick();

    expect(socket.frames("auth")).toHaveLength(2);
    expect(socket.frames("auth")[1]?.["authToken"]).toBe(ROTATED_TOKEN);
    unsubscribe();
  });
});

describe("@vellumdb/sdk-js - password change and account deletion", () => {
  it("changePassword sends both passwords with the bearer token and keeps the new session", async () => {
    const next = makeJwt({ sub: "usr_1", exp: Math.floor(Date.now() / 1000) + 9000 });
    const { calls, fetch } = recorder(({ url }) => {
      if (url.endsWith("/auth/sign-in/email")) return json(session());
      if (url.endsWith("/auth/password/change")) return json(session(next, "refresh_2"));
      return json({});
    });
    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch });
    await db.signInWithEmailAndPassword("a@b.c", "password123");
    const state = await db.changePassword("password123", "newPassword456");
    const call = calls.find((c) => c.url.endsWith("/auth/password/change"));
    expect(call?.body).toEqual({ currentPassword: "password123", newPassword: "newPassword456" });
    expect(headersOf(call)["authorization"]).toBe(`Bearer ${FIRST_TOKEN}`);
    expect(state.refreshToken).toBe("refresh_2");
    expect(db.currentUser?.accessToken).toBe(next);
  });

  it("deleteAccount calls DELETE /auth/user and signs out locally", async () => {
    const { calls, fetch } = recorder(({ url }) => {
      if (url.endsWith("/auth/sign-in/email")) return json(session());
      return json({ deleted: true });
    });
    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch });
    await db.signInWithEmailAndPassword("a@b.c", "password123");
    await db.deleteAccount({ password: "password123" });
    const call = calls.find((c) => c.url.endsWith("/auth/user") && c.init?.method === "DELETE");
    expect(call?.body).toEqual({ password: "password123" });
    expect(db.currentUser).toBeNull();
  });
});

describe("@vellumdb/sdk-js - sessions and linked providers", () => {
  it("lists sessions, revokes one, lists and unlinks providers", async () => {
    const { calls, fetch } = recorder(({ url, init }) => {
      if (url.endsWith("/auth/sign-in/email")) return json(session());
      if (url.endsWith("/auth/sessions") && init?.method === "GET") {
        return json({ sessions: [{ id: "s1", userAgent: "ua", ipAddress: null, createdAt: "x", lastRefreshedAt: null, expiresAt: "y" }] });
      }
      if (url.endsWith("/auth/identities") && init?.method === "GET") {
        return json({ identities: [{ provider: "google", email: "a@b.c", lastSignInAt: "x", createdAt: "y" }], hasPassword: false });
      }
      return json({ success: true });
    });
    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: fetch });
    await db.signInWithEmailAndPassword("a@b.c", "password123");
    expect((await db.listSessions())[0]?.id).toBe("s1");
    await db.revokeSession("s1");
    const linked = await db.listLinkedProviders();
    expect(linked.providers[0]?.provider).toBe("google");
    expect(linked.hasPassword).toBe(false);
    await db.unlinkProvider("google");
    expect(calls.some((c) => c.url.endsWith("/auth/sessions/s1") && c.init?.method === "DELETE")).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/auth/identities/google") && c.init?.method === "DELETE")).toBe(true);
  });
});

describe("@vellumdb/sdk-js - onAuthStateChanged initial state", () => {
  it("fires right away with null when signed out, after the call returns, and not again after unsubscribe", async () => {
    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: (async () => json({})) as never });
    const seen: unknown[] = [];
    const stop = db.onAuthStateChanged((user) => seen.push(user));
    expect(seen).toEqual([]);
    await Promise.resolve();
    expect(seen).toEqual([null]);
    stop();
    const late: unknown[] = [];
    db.onAuthStateChanged((u) => late.push(u))();
    await Promise.resolve();
    expect(late).toEqual([]);
  });
});
