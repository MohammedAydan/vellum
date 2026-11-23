import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserLocalStorage,
  MemoryAuthStorage,
  RealtimeTransport,
  computeDecorrelatedJitterMs,
  createClient,
  decodeRealtimeFrame,
  encodePathSegment,
  encodeResourcePath,
  parseRetryAfterMs,
  safeJsonParse,
  type StorageLike,
  type WebSocketLike,
} from "../index.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

const TOKEN_A = makeJwt({ sub: "usr_1", exp: Math.floor(Date.now() / 1000) + 3600 });
const TOKEN_B = makeJwt({ sub: "usr_1", exp: Math.floor(Date.now() / 1000) + 7200 });

const PUBLIC_USER = {
  id: "usr_1",
  email: "alice@example.com",
  emailVerified: true,
  displayName: "Alice",
  photoUrl: null,
  phoneNumber: null,
  phoneVerified: false,
  isDisabled: false,
  isAnonymous: false,
  customClaims: { role: "member" },
  metadata: { tier: "pro" },
  createdAt: "2026-11-17T00:00:00.000Z",
  updatedAt: "2026-11-17T00:00:00.000Z",
  lastSignInAt: null,
};

function makeSession(accessToken: string, refreshToken = "refresh_1") {
  return {
    user: PUBLIC_USER,
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    sessionId: "sess_1",
    expiresAt: "2026-11-17T01:00:00.000Z",
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

class MockSocket implements WebSocketLike {
  public readyState = 1;
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public onclose: ((event: { code?: number; reason?: unknown }) => void) | null = null;
  public readonly sent: string[] = [];
  public closedWith: Array<{ code?: number; reason?: string }> = [];

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(code?: number, reason?: string): void {
    const closeInfo = {
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    this.closedWith.push(closeInfo);
    this.readyState = 3;
    this.onclose?.(closeInfo);
  }

  public receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  public parsedFrames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("@vellum/sdk-js hardening - HTTP transport resilience & path safety", () => {
  it("aborts hung requests with REQUEST_TIMEOUT via AbortController", async () => {
    const mockFetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      })) as unknown as typeof globalThis.fetch;

    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      customFetch: mockFetch,
      timeoutMs: 25,
      maxRetries: 0,
    });

    await expect(db.doc("users/u1").get()).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
  });

  it("retries idempotent GET on 429/503 with Retry-After and succeeds", async () => {
    let attempts = 0;
    const mockFetch = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({ error: { code: "RATE_LIMITED", message: "slow down" } }, 429, {
          "retry-after": "0",
        });
      }
      if (attempts === 2) {
        return jsonResponse({ error: { code: "UNAVAILABLE", message: "try again" } }, 503);
      }
      return jsonResponse({ documentId: "u1", path: "users/u1", version: 1, data: { ok: true } });
    }) as unknown as typeof globalThis.fetch;

    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      customFetch: mockFetch,
      maxRetries: 3,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 5,
      retryRandomFn: () => 0,
    });

    const snap = await db.doc("users/u1").get();
    expect(attempts).toBe(3);
    expect(snap.data()).toEqual({ ok: true });
  });

  it("never blindly retries non-idempotent POST writes on 503 without an idempotency key", async () => {
    let attempts = 0;
    const mockFetch = (async () => {
      attempts += 1;
      return jsonResponse({ error: { code: "UNAVAILABLE", message: "upstream down" } }, 503);
    }) as unknown as typeof globalThis.fetch;

    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      customFetch: mockFetch,
      maxRetries: 3,
      retryBaseDelayMs: 1,
      retryRandomFn: () => 0,
    });

    await expect(db.doc("users/u1").create({ name: "Alice" })).rejects.toMatchObject({ status: 503 });
    expect(attempts).toBe(1);
  });

  it("parses Retry-After delta-seconds and HTTP-date values safely", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("999999", 60_000)).toBe(60_000);
    expect(parseRetryAfterMs("invalid")).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
  });

  it("blocks path traversal, query injection, and control characters in paths", () => {
    expect(encodeResourcePath("users/doc_1")).toBe("users/doc_1");
    expect(encodeResourcePath("users/hello world")).toBe("users/hello%20world");
    expect(encodePathSegment("a b")).toBe("a%20b");

    expect(() => encodeResourcePath("users/../secrets/doc")).toThrow();
    expect(() => encodeResourcePath("users/%2e%2e/secrets")).toThrow();
    expect(() => encodeResourcePath("users/doc?admin=true")).toThrow();
    expect(() => encodeResourcePath("users/doc#frag")).toThrow();
    expect(() => encodeResourcePath("users/doc\x00")).toThrow();
    expect(() => encodePathSegment("..")).toThrow();

    const db = createClient({
      projectId: "proj_1",
      apiKey: "pk_test",
      customFetch: (async () => jsonResponse({})) as unknown as typeof globalThis.fetch,
    });
    expect(() => db.doc("users/../admin")).toThrow();
    expect(() => db.collection("users").doc("../admin")).toThrow();
  });
});

describe("@vellum/sdk-js hardening - Auth coalescing, redaction, and disposal", () => {
  it("coalesces parallel 401 responses into a single token refresh", async () => {
    let refreshCalls = 0;
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/auth/sign-in/email")) {
        return jsonResponse(makeSession(TOKEN_A, "refresh_1"));
      }
      if (urlStr.endsWith("/auth/token/refresh")) {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return jsonResponse(makeSession(TOKEN_B, "refresh_2"));
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers["authorization"] === `Bearer ${TOKEN_A}`) {
        return jsonResponse({ error: { code: "TOKEN_EXPIRED", message: "expired" } }, 401);
      }
      return jsonResponse({ documentId: "d1", path: "users/d1", version: 1, data: { ok: true } });
    }) as unknown as typeof globalThis.fetch;

    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: mockFetch });
    await db.signInWithEmailAndPassword("alice@example.com", "password123");

    const results = await Promise.all([
      db.doc("users/d1").get(),
      db.doc("users/d1").get(),
      db.doc("users/d1").get(),
    ]);

    expect(results).toHaveLength(3);
    expect(refreshCalls).toBe(1);
    db.dispose?.();
    expect(db.currentUser).toBeNull();
  });

  it("redacts tokens when auth client is serialized with JSON.stringify", async () => {
    const mockFetch = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/auth/sign-in/email")) return jsonResponse(makeSession(TOKEN_A, "refresh_secret"));
      return jsonResponse({});
    }) as unknown as typeof globalThis.fetch;

    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: mockFetch });
    await db.signInWithEmailAndPassword("alice@example.com", "password123");

    const serialized = JSON.stringify(db.auth);
    expect(serialized).not.toContain(TOKEN_A);
    expect(serialized).not.toContain("refresh_secret");
    expect(JSON.parse(serialized)).toEqual({ signedIn: true, userId: "usr_1" });
    db.dispose?.();
  });
});

describe("@vellum/sdk-js hardening - Realtime WebSocket resilience", () => {
  it("computes decorrelated jitter within [base, max]", () => {
    const d1 = computeDecorrelatedJitterMs(500, 500, 30_000, () => 1);
    expect(d1).toBe(1500);
    const d2 = computeDecorrelatedJitterMs(d1, 500, 30_000, () => 1);
    expect(d2).toBe(4500);
    const dCap = computeDecorrelatedJitterMs(20_000, 500, 30_000, () => 1);
    expect(dCap).toBe(30_000);
    const dMin = computeDecorrelatedJitterMs(5000, 500, 30_000, () => 0);
    expect(dMin).toBe(500);
  });

  it("tracks resumeSeqId, bounds outbound queue, detects dead sockets, and cleans up on close()", async () => {
    vi.useFakeTimers();
    const sockets: MockSocket[] = [];
    const received: Array<Record<string, unknown>> = [];

    const transport = new RealtimeTransport({
      url: "ws://localhost:8080/v1/realtime",
      auth: () => ({ projectId: "p", apiKey: "pk_test" }),
      onFrame: (frame) => received.push(frame),
      webSocketFactory: () => {
        const s = new MockSocket();
        sockets.push(s);
        return s;
      },
      heartbeatIntervalMs: 100,
      pongTimeoutMs: 250,
      maxOutboundQueueSize: 2,
      randomFn: () => 0,
    });

    // Queue 4 frames while offline — only the latest 2 should be retained.
    transport.send({ type: "custom", n: 1 });
    transport.send({ type: "custom", n: 2 });
    transport.send({ type: "custom", n: 3 });
    transport.send({ type: "custom", n: 4 });
    transport.subscribe("sub_1", { path: "users/u1" });

    expect(sockets).toHaveLength(1);
    const firstSocket = sockets[0]!;
    firstSocket.onopen?.({});
    await vi.advanceTimersByTimeAsync(0);
    firstSocket.receive({ type: "auth_ack" });

    const firstCustom = firstSocket.parsedFrames().filter((f) => f["type"] === "custom");
    expect(firstCustom.map((f) => f["n"])).toEqual([3, 4]);

    // Receive mutation with numeric-string seqId so resumeSeqId watermark advances to 42.
    firstSocket.receive({ type: "mutation", subId: "sub_1", seqId: "42", operation: "update", document: {} });
    expect(received).toHaveLength(1);

    // Advance past pongTimeoutMs without sending pong -> dead-socket reconnect.
    await vi.advanceTimersByTimeAsync(350);
    expect(firstSocket.onclose).toBeNull();
    expect(firstSocket.onmessage).toBeNull();

    // Decorrelated jitter with randomFn() => 0 schedules reconnect at base 500ms.
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
    const secondSocket = sockets[1]!;
    secondSocket.onopen?.({});
    await vi.advanceTimersByTimeAsync(0);
    secondSocket.receive({ type: "auth_ack" });

    const resub = secondSocket.parsedFrames().find((f) => f["type"] === "subscribe");
    expect(resub?.["subId"]).toBe("sub_1");
    expect(resub?.["resumeSeqId"]).toBe(42);

    transport.close();
    expect(transport.state).toBe("closed");
    expect(secondSocket.onmessage).toBeNull();
    expect(secondSocket.onclose).toBeNull();
  });
});

describe("@vellum/sdk-js hardening - Prototype-pollution safety & defensive copies", () => {
  it("strips __proto__, constructor, and prototype from parsed JSON and WS frames", () => {
    const payload = '{"name":"Alice","__proto__":{"polluted":true},"nested":{"constructor":{"x":1},"prototype":{"y":2},"ok":1}}';
    const parsed = safeJsonParse<Record<string, unknown>>(payload);
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    const nested = parsed["nested"] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(nested, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(nested, "prototype")).toBe(false);
    expect(nested["ok"]).toBe(1);

    const frame = decodeRealtimeFrame('{"type":"mutation","__proto__":{"evil":1},"data":{"safe":true}}');
    expect(frame?.type).toBe("mutation");
    expect(Object.prototype.hasOwnProperty.call(frame, "__proto__")).toBe(false);
  });

  it("returns defensive copies from DocumentSnapshot.data() and MemoryAuthStorage", async () => {
    const mockFetch = (async () =>
      jsonResponse({
        documentId: "d1",
        path: "users/d1",
        version: 1,
        data: { profile: { name: "Alice" } },
      })) as unknown as typeof globalThis.fetch;

    const db = createClient({ projectId: "p", apiKey: "pk_test", customFetch: mockFetch });
    const snap = await db.doc<{ profile: { name: string } }>("users/d1").get();
    const first = snap.data();
    first.profile.name = "MUTATED";
    expect(snap.data().profile.name).toBe("Alice");

    const mem = new MemoryAuthStorage();
    const state = { ...PUBLIC_USER, accessToken: TOKEN_A, refreshToken: "r1", tokenType: "Bearer", sessionId: "s1", expiresAt: "" };
    mem.save(state);
    state.customClaims["role"] = "admin";
    expect(mem.load()?.customClaims["role"]).toBe("member");

    const rawStore: Record<string, string> = {
      "vellum.auth.session.v1": JSON.stringify({ ...state, customClaims: { role: "member" } }).replace(
        '"role":"member"',
        '"role":"member","__proto__":{"pwned":true}'
      ),
    };
    const fakeLocal: StorageLike = {
      getItem: (k) => rawStore[k] ?? null,
      setItem: (k, v) => {
        rawStore[k] = v;
      },
      removeItem: (k) => {
        delete rawStore[k];
      },
    };
    const browserStore = new BrowserLocalStorage("vellum.auth.session.v1", fakeLocal);
    const loaded = browserStore.load();
    expect(loaded?.id).toBe("usr_1");
    expect(({} as Record<string, unknown>)["pwned"]).toBeUndefined();
  });
});
