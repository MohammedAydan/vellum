import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminFetch,
  refreshAdminSessionToken,
  resetAdminApiClientState,
  sanitizeErrorMessage,
} from "../lib/api.js";
import {
  clearStoredAdminSession,
  getAdminSessionEpoch,
  getSafeRedirectFromSearch,
  getStoredAdminSession,
  safeJsonParse,
  sanitizeRedirectPath,
  setStoredAdminSession,
  type AdminSession,
} from "../lib/auth.js";
import { queryRetryDelay, shouldRetryQuery } from "../lib/query-client.js";

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
    JSON.stringify({ sub: "admin_1", exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })
  );
  return `${header}.${payload}.signature`;
}

function makeAdminSession(token: string, refreshToken = "refresh_1"): AdminSession {
  return {
    user: { id: "admin_1", email: "owner@vellum.internal", name: "Owner", platformRole: "owner" },
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

describe("apps/admin - frontend security & reliability hardening", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    resetAdminApiClientState();
  });

  afterEach(() => {
    resetAdminApiClientState();
    vi.unstubAllGlobals();
  });

  describe("open-redirect protection", () => {
    it("allows safe relative admin paths", () => {
      expect(sanitizeRedirectPath("/tenants/org_1")).toBe("/tenants/org_1");
      expect(sanitizeRedirectPath("/audit?page=2")).toBe("/audit?page=2");
      expect(getSafeRedirectFromSearch("?redirect=%2Fmetrics")).toBe("/metrics");
      expect(getSafeRedirectFromSearch("?returnTo=%2Fsecurity")).toBe("/security");
    });

    it("rejects external URLs, protocol-relative URLs, javascript:, and login loops", () => {
      const dangerous = [
        "//evil.com",
        "https://evil.com/admin",
        "http://evil.com",
        "javascript:alert(1)",
        "/\\evil.com",
        "/%2f/evil.com",
        "/login",
        "/admin/login",
        "",
        null,
      ];
      for (const value of dangerous) {
        expect(sanitizeRedirectPath(value, "/")).toBe("/");
      }
      expect(getSafeRedirectFromSearch("?redirect=https%3A%2F%2Fevil.com", "/")).toBe("/");
    });
  });

  describe("prototype-pollution safe JSON parsing", () => {
    it("strips __proto__, constructor, and prototype keys safely", () => {
      const payload = '{"healthy":true,"__proto__":{"pwned":1},"constructor":{"prototype":{"y":2}}}';
      const parsed = safeJsonParse<{ healthy: boolean }>(payload);
      expect(parsed.healthy).toBe(true);
      expect(({} as Record<string, unknown>)["pwned"]).toBeUndefined();
      expect(({} as Record<string, unknown>)["y"]).toBeUndefined();
    });

    it("clears invalid platform roles during storage hydration", () => {
      localStorage.setItem("vellum_super_admin_access_token", jwt(3600));
      localStorage.setItem(
        "vellum_super_admin_user",
        '{"user":{"id":"a1","email":"x@y.com","name":"X","platformRole":"customer"},"expiresAt":"2099-01-01T00:00:00.000Z"}'
      );
      expect(getStoredAdminSession()).toBeNull();
    });
  });

  describe("token redaction in error messages", () => {
    it("redacts Bearer tokens, JWTs, and secret parameters from admin errors", async () => {
      const fakeJwt = jwt(3600);
      const cleaned = sanitizeErrorMessage(`Failed with Bearer topsecret123 token=${fakeJwt}`);
      expect(cleaned).not.toContain("topsecret123");
      expect(cleaned).not.toContain(fakeJwt);
      expect(cleaned).toContain("Bearer [REDACTED]");

      setStoredAdminSession(makeAdminSession(fakeJwt));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({ error: { message: `Denied Bearer ${fakeJwt}` } }, 403)
        )
      );
      await expect(adminFetch("/v1/admin/tenants")).rejects.toThrow("Denied Bearer [REDACTED]");
    });
  });

  describe("single-flight refresh coalescing & monotonic session epoch", () => {
    it("coalesces concurrent refreshes and aborts persistence if logout happens mid-flight", async () => {
      setStoredAdminSession(makeAdminSession(jwt(3600), "admin_refresh_1"));
      const epochBefore = getAdminSessionEpoch();
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

      const p1 = refreshAdminSessionToken();
      const p2 = refreshAdminSessionToken();
      expect(refreshCalls).toBe(1);

      clearStoredAdminSession();
      expect(getAdminSessionEpoch()).toBeGreaterThan(epochBefore);

      resolveRefresh(
        jsonResponse({
          accessToken: jwt(7200),
          refreshToken: "admin_refresh_stale",
          expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
        })
      );

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBeNull();
      expect(r2).toBeNull();
      expect(getStoredAdminSession()).toBeNull();
    });
  });

  describe("request timeout & transient GET backoff retry", () => {
    it("retries transient 502/504 GET requests while never retrying POST", async () => {
      setStoredAdminSession(makeAdminSession(jwt(3600)));
      let getAttempts = 0;
      let postAttempts = 0;

      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
          const method = (init?.method ?? "GET").toUpperCase();
          if (method === "GET") {
            getAttempts += 1;
            if (getAttempts === 1) return jsonResponse({ error: { message: "bad gateway" } }, 502);
            if (getAttempts === 2) return jsonResponse({ error: { message: "timeout" } }, 504);
            return jsonResponse({ status: "ok" });
          }
          postAttempts += 1;
          return jsonResponse({ error: { message: "unavailable" } }, 503);
        })
      );

      const res = await adminFetch<{ status: string }>("/v1/admin/cluster/health", {
        retryBaseDelayMs: 1,
      });
      expect(res.status).toBe("ok");
      expect(getAttempts).toBe(3);

      await expect(
        adminFetch("/v1/admin/features", {
          method: "POST",
          body: JSON.stringify({ flag: "x" }),
          retryBaseDelayMs: 1,
        })
      ).rejects.toThrow("unavailable");
      expect(postAttempts).toBe(1);
    });

    it("aborts stalled admin requests on timeoutMs", async () => {
      setStoredAdminSession(makeAdminSession(jwt(3600)));
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
        adminFetch("/v1/admin/cluster/metrics", { timeoutMs: 15, maxRetries: 0 })
      ).rejects.toThrow(/timed out/i);
    });
  });

  describe("React Query retry tuning", () => {
    it("blocks 4xx and privacy invariant errors while capping transient retries at 2", () => {
      expect(shouldRetryQuery(0, new Error("Admin request failed with status 401"))).toBe(false);
      expect(shouldRetryQuery(0, new Error("Admin request failed with status 403"))).toBe(false);
      expect(shouldRetryQuery(0, new Error("[Vellum Admin Privacy Invariant] blocked"))).toBe(false);
      expect(shouldRetryQuery(0, new Error("Admin request failed with status 502"))).toBe(true);
      expect(shouldRetryQuery(2, new Error("Admin request failed with status 502"))).toBe(false);
      expect(queryRetryDelay(0)).toBe(1000);
      expect(queryRetryDelay(2)).toBe(4000);
    });
  });
});
