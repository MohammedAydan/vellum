import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiFetch,
  refreshSessionToken,
  resetApiClientState,
  sanitizeErrorMessage,
} from "../lib/api.js";
import {
  clearStoredSession,
  getSafeRedirectFromSearch,
  getSessionEpoch,
  getStoredSession,
  safeJsonParse,
  sanitizeRedirectPath,
  setStoredSession,
  type UserSession,
} from "../lib/auth.js";
import { queryRetryDelay, shouldRetryQuery } from "../lib/query-client.js";
import { computeVirtualWindow } from "../components/virtual-table.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function toBase64Url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function jwt(expSecondsFromNow: number): string {
  const header = toBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = toBase64Url(
    JSON.stringify({ sub: "user_1", exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })
  );
  return `${header}.${payload}.signature`;
}

function makeSession(token: string, refreshToken = "refresh_1"): UserSession {
  return {
    user: { id: "user_1", email: "dev@vellum.dev", name: "Dev" },
    token,
    refreshToken,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("apps/dashboard - frontend security, concurrency & performance hardening", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    resetApiClientState();
  });

  afterEach(() => {
    resetApiClientState();
    vi.unstubAllGlobals();
  });

  describe("open-redirect protection", () => {
    it("allows safe relative same-origin paths", () => {
      expect(sanitizeRedirectPath("/orgs/org_1/projects/proj_2")).toBe("/orgs/org_1/projects/proj_2");
      expect(sanitizeRedirectPath("/app/settings?tab=security#mfa")).toBe("/app/settings?tab=security#mfa");
      expect(getSafeRedirectFromSearch("?redirect=%2Fapp%2Forgs%2F123")).toBe("/app/orgs/123");
      expect(getSafeRedirectFromSearch("?returnTo=%2Fapp%2Fsettings")).toBe("/app/settings");
    });

    it("rejects protocol-relative, external, javascript:, backslash, and auth-loop targets", () => {
      const dangerous = [
        "//evil.com",
        "//evil.com/path",
        "https://evil.com/phish",
        "http://evil.com",
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "/\\evil.com",
        "/%2f/evil.com",
        "/app\r\nSet-Cookie: a=1",
        "/login",
        "/signup",
        "",
        null,
        undefined,
      ];
      for (const value of dangerous) {
        expect(sanitizeRedirectPath(value, "/app")).toBe("/app");
      }
      expect(getSafeRedirectFromSearch("?redirect=https%3A%2F%2Fevil.com", "/app")).toBe("/app");
      expect(getSafeRedirectFromSearch("?returnTo=%2F%2Fevil.com", "/app")).toBe("/app");
    });
  });

  describe("prototype-pollution safe JSON parsing", () => {
    it("strips __proto__, constructor, and prototype keys without polluting Object.prototype", () => {
      const payload = '{"ok":true,"__proto__":{"polluted":true},"nested":{"constructor":{"prototype":{"x":1}},"safe":42}}';
      const parsed = safeJsonParse<{ ok: boolean; nested: { safe: number } }>(payload);
      expect(parsed.ok).toBe(true);
      expect(parsed.nested.safe).toBe(42);
      expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(false);
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
      expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
    });

    it("hydrates storage safely even if localStorage contains __proto__ keys", () => {
      localStorage.setItem("vellum_console_access_token", jwt(3600));
      localStorage.setItem(
        "vellum_console_user",
        '{"user":{"id":"u1","email":"a@b.com","name":"A","__proto__":{"isAdmin":true}},"expiresAt":"2099-01-01T00:00:00.000Z"}'
      );
      const restored = getStoredSession();
      expect(restored?.user.id).toBe("u1");
      expect(({} as Record<string, unknown>)["isAdmin"]).toBeUndefined();
    });
  });

  describe("token redaction in error messages", () => {
    it("redacts Bearer tokens, JWTs, and secret parameters from errors", async () => {
      const fakeJwt = jwt(3600);
      const cleaned = sanitizeErrorMessage(
        `Upstream failed with Bearer secret_abc123 and jwt=${fakeJwt} refresh_token=rt_999`
      );
      expect(cleaned).not.toContain("secret_abc123");
      expect(cleaned).not.toContain(fakeJwt);
      expect(cleaned).not.toContain("rt_999");
      expect(cleaned).toContain("Bearer [REDACTED]");
      expect(cleaned).toContain("[REDACTED_TOKEN]");

      setStoredSession(makeSession(fakeJwt));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({ error: { message: `Auth rejected Bearer ${fakeJwt}` } }, 403)
        )
      );
      await expect(apiFetch("/v1/console/projects")).rejects.toThrow("Auth rejected Bearer [REDACTED]");
    });
  });

  describe("single-flight refresh coalescing & monotonic session epoch", () => {
    it("coalesces concurrent refresh calls and cancels persistence when logout races in-flight refresh", async () => {
      setStoredSession(makeSession(jwt(3600), "refresh_initial"));
      const epochBefore = getSessionEpoch();
      let refreshCalls = 0;
      let resolveRefresh!: (res: Response) => void;

      vi.stubGlobal(
        "fetch",
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              refreshCalls += 1;
              resolveRefresh = resolve;
            })
        )
      );

      const p1 = refreshSessionToken();
      const p2 = refreshSessionToken();
      expect(refreshCalls).toBe(1);

      // Logout occurs while refresh is in flight
      clearStoredSession();
      expect(getSessionEpoch()).toBeGreaterThan(epochBefore);

      resolveRefresh(
        jsonResponse({
          accessToken: jwt(7200),
          refreshToken: "refresh_stale",
          expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
        })
      );

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBeNull();
      expect(r2).toBeNull();
      expect(getStoredSession()).toBeNull();
    });
  });

  describe("request timeout & transient GET backoff retry", () => {
    it("retries transient 503/429 GET requests and succeeds without retrying POST", async () => {
      setStoredSession(makeSession(jwt(3600)));
      let getAttempts = 0;
      let postAttempts = 0;

      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
          const method = (init?.method ?? "GET").toUpperCase();
          if (method === "GET") {
            getAttempts += 1;
            if (getAttempts === 1) return jsonResponse({ error: { message: "busy" } }, 503);
            if (getAttempts === 2) return jsonResponse({ error: { message: "rate limited" } }, 429);
            return jsonResponse({ ok: true });
          }
          postAttempts += 1;
          return jsonResponse({ error: { message: "gateway down" } }, 503);
        })
      );

      const res = await apiFetch<{ ok: boolean }>("/v1/console/projects", {
        retryBaseDelayMs: 1,
      });
      expect(res.ok).toBe(true);
      expect(getAttempts).toBe(3);

      await expect(
        apiFetch("/v1/console/projects", {
          method: "POST",
          body: JSON.stringify({ name: "p" }),
          retryBaseDelayMs: 1,
        })
      ).rejects.toThrow("gateway down");
      expect(postAttempts).toBe(1);
    });

    it("aborts stalled requests when timeoutMs elapses", async () => {
      setStoredSession(makeSession(jwt(3600)));
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_input: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(init.signal?.reason ?? new Error("Aborted"));
              });
            })
        )
      );

      await expect(
        apiFetch("/v1/console/projects", { timeoutMs: 15, maxRetries: 0 })
      ).rejects.toThrow(/timed out/i);
    });
  });

  describe("React Query retry tuning", () => {
    it("avoids retrying 4xx client errors and caps transient retries at 2", () => {
      expect(shouldRetryQuery(0, new Error("Request failed with status 400"))).toBe(false);
      expect(shouldRetryQuery(0, new Error("Request failed with status 401"))).toBe(false);
      expect(shouldRetryQuery(0, new Error("Request failed with status 403"))).toBe(false);
      expect(shouldRetryQuery(0, new Error("Request failed with status 404"))).toBe(false);
      expect(shouldRetryQuery(0, new Error("Session expired, please sign in again"))).toBe(false);

      expect(shouldRetryQuery(0, new Error("Request failed with status 503"))).toBe(true);
      expect(shouldRetryQuery(1, new Error("Request failed with status 429"))).toBe(true);
      expect(shouldRetryQuery(2, new Error("Request failed with status 503"))).toBe(false);

      expect(queryRetryDelay(0)).toBe(1000);
      expect(queryRetryDelay(1)).toBe(2000);
      expect(queryRetryDelay(10)).toBe(10_000);
    });
  });

  describe("VirtualTable windowing guards", () => {
    it("handles 0 rows, negative/NaN dimensions, out-of-range scroll, and 100k rows safely", () => {
      const empty = computeVirtualWindow({
        rowCount: 0,
        rowHeight: 40,
        viewportHeight: 420,
        scrollTop: 500,
      });
      expect(empty.start).toBe(0);
      expect(empty.end).toBe(0);
      expect(empty.totalHeight).toBe(0);

      const invalid = computeVirtualWindow({
        rowCount: 50,
        rowHeight: Number.NaN,
        viewportHeight: -100,
        scrollTop: -250,
      });
      expect(invalid.safeRowHeight).toBe(40);
      expect(invalid.safeViewportHeight).toBe(420);
      expect(invalid.clampedScrollTop).toBe(0);
      expect(invalid.start).toBe(0);
      expect(invalid.end).toBeGreaterThan(0);

      const huge = computeVirtualWindow({
        rowCount: 100_000,
        rowHeight: 40,
        viewportHeight: 400,
        scrollTop: 2_000_000,
        overscan: 6,
      });
      expect(huge.totalHeight).toBe(4_000_000);
      expect(huge.end - huge.start).toBeLessThanOrEqual(22);
      expect(huge.start).toBeGreaterThan(49_000);
    });
  });
});
