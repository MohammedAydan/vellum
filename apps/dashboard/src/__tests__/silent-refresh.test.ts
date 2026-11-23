import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/api.js";
import { getStoredSession, setStoredSession, type UserSession } from "../lib/auth.js";

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

function jwt(expSecondsFromNow: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: "user_1", exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

function session(token: string, refreshToken = "refresh_1"): UserSession {
  return {
    user: { id: "user_1", email: "dev@vellum.dev", name: "Dev" },
    token,
    refreshToken,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface Recorded {
  url: string;
  authorization: string | null;
  body: unknown;
}

describe("apps/dashboard - silent session refresh", () => {
  let recorded: Recorded[];

  beforeEach(() => {
    recorded = [];
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function installFetch(handler: (call: Recorded) => Response): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        const call: Recorded = {
          url: String(input),
          authorization: headers.get("authorization"),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        };
        recorded.push(call);
        return handler(call);
      })
    );
  }

  const REFRESH_BODY = {
    token: "unused-legacy-token",
    accessToken: jwt(7200),
    refreshToken: "refresh_2",
    expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    user: { id: "user_1", email: "dev@vellum.dev", name: "Dev", platformRole: "admin" },
  };

  it("pre-flight refreshes a token expiring within 45 s before sending", async () => {
    const expiring = jwt(20);
    setStoredSession(session(expiring));
    installFetch((call) => {
      if (call.url.includes("/console/auth/refresh")) return json(REFRESH_BODY);
      return json({ ok: true });
    });

    await apiFetch<{ ok: boolean }>("/v1/console/projects");

    expect(recorded.filter((call) => call.url.includes("/console/auth/refresh"))).toHaveLength(1);
    const dataCall = recorded.find((call) => call.url.includes("/v1/console/projects"));
    expect(dataCall?.authorization).toBe(`Bearer ${REFRESH_BODY.accessToken}`);
    expect(getStoredSession()?.refreshToken).toBe("refresh_2");
  });

  it("replays the original request exactly once after a 401", async () => {
    const initial = jwt(3600);
    setStoredSession(session(initial));
    let attempts = 0;
    installFetch((call) => {
      if (call.url.includes("/console/auth/refresh")) return json({ ...REFRESH_BODY, accessToken: jwt(7200) });
      if (call.url.includes("/v1/console/projects")) {
        attempts += 1;
        if (attempts === 1) {
          return json(
            { error: { code: "TOKEN_EXPIRED", message: "Invalid, expired, or revoked session token" } },
            401
          );
        }
        return json({ ok: true });
      }
      return json({});
    });

    await apiFetch<{ ok: boolean }>("/v1/console/projects", { method: "POST", body: JSON.stringify({ a: 1 }) });

    expect(attempts).toBe(2);
    expect(recorded.filter((call) => call.url.includes("/console/auth/refresh"))).toHaveLength(1);
    const dataCalls = recorded.filter((call) => call.url.includes("/v1/console/projects"));
    expect(dataCalls[0]?.authorization).toBe(`Bearer ${initial}`);
    expect(dataCalls[1]?.authorization).not.toBe(`Bearer ${initial}`);
    expect(dataCalls[0]?.body).toEqual({ a: 1 });
    expect(dataCalls[1]?.body).toEqual({ a: 1 });
  });

  it("throws a friendly error and clears storage when refresh fails", async () => {
    setStoredSession(session(jwt(3600)));
    installFetch((call) => {
      if (call.url.includes("/console/auth/refresh")) return json({ error: { message: "nope" } }, 500);
      return json({ error: { code: "TOKEN_EXPIRED", message: "Invalid, expired, or revoked session token" } }, 401);
    });

    await expect(apiFetch("/v1/console/projects")).rejects.toThrow("Session expired, please sign in again");
    expect(getStoredSession()).toBeNull();
  });
});
