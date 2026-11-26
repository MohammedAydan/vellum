import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createVellumPlatform } from "../index.js";
import { errorHandler } from "../middleware/error-handler.js";
import { requestId } from "../middleware/request-id.js";
import {
  assertSafeJsonStructure,
  bodyLimit,
  constantTimeEqual,
  createCorsOriginValidator,
  extractClientIp,
  mapWithConcurrency,
  normalizeStrictOrigin,
  parseAllowedOrigins,
  requestTimeout,
  safeJsonParse,
  securityHeaders,
} from "../middleware/security.js";
import { setShuttingDown } from "../routes/health.js";
import {
  isOriginAllowed,
  parseAllowedOrigins as parseWsAllowedOrigins,
  tryDecodeWsFrame,
  WsFrameTooLargeError,
} from "../ws-rfc6455.js";

describe("@vellum/api - production security, reliability & scale hardening", () => {
  const originalNodeEnv = process.env["NODE_ENV"];
  const originalTrustProxy = process.env["TRUST_PROXY_HOPS"];

  afterEach(() => {
    setShuttingDown(false);
    if (originalNodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = originalNodeEnv;
    if (originalTrustProxy === undefined) delete process.env["TRUST_PROXY_HOPS"];
    else process.env["TRUST_PROXY_HOPS"] = originalTrustProxy;
  });

  describe("security headers & request-id sanitization", () => {
    it("sets HSTS, nosniff, X-Frame-Options, Referrer-Policy, and Cache-Control: no-store", async () => {
      const app = new Hono();
      app.use("*", requestId());
      app.use("*", securityHeaders());
      app.get("/sensitive", (c) => c.json({ ok: true }));

      const res = await app.fetch(new Request("http://localhost/sensitive"));
      expect(res.status).toBe(200);
      expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("rejects unsafe incoming x-request-id values and mints a clean ID", async () => {
      const app = new Hono();
      app.use("*", requestId());
      app.get("/ping", (c) => c.json({ id: c.get("requestId") }));

      const res = await app.fetch(
        new Request("http://localhost/ping", {
          headers: { "x-request-id": "bad id with spaces; injected" },
        })
      );
      const id = res.headers.get("x-request-id") ?? "";
      expect(id.startsWith("req_")).toBe(true);
      expect(id).not.toContain("injected");
    });
  });

  describe("strict CORS origin validation", () => {
    it("strips wildcards, null, and non-http(s) origins and never allows * with credentials", () => {
      expect(normalizeStrictOrigin("*")).toBeNull();
      expect(normalizeStrictOrigin("null")).toBeNull();
      expect(normalizeStrictOrigin("https://*.example.com")).toBeNull();
      expect(normalizeStrictOrigin("javascript:alert(1)")).toBeNull();
      expect(normalizeStrictOrigin("https://App.Vellum.Dev/")).toBe("https://app.vellum.dev");

      const parsed = parseAllowedOrigins("*, null, https://app.example.com/, http://localhost:5173");
      expect(parsed).toEqual(["https://app.example.com", "http://localhost:5173"]);

      const validate = createCorsOriginValidator(parsed);
      expect(validate("https://app.example.com")).toBe("https://app.example.com");
      expect(validate("https://evil.example.com")).toBeUndefined();
      expect(validate("*")).toBeUndefined();
      expect(validate("null")).toBeUndefined();
    });

    it("does not emit Access-Control-Allow-Origin for untrusted origins on the platform app", async () => {
      const platform = createVellumPlatform({ corsOrigins: ["https://console.vellum.dev"] });
      const res = await platform.fetch(
        new Request("http://localhost:8080/v1/health", {
          headers: { origin: "https://evil.attacker.test" },
        })
      );
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  describe("body limits, JSON safety & request timeout", () => {
    it("enforces bodyLimit even when Content-Length is omitted (chunked stream)", async () => {
      const app = new Hono();
      app.onError(errorHandler);
      app.use("*", bodyLimit(64));
      app.post("/upload", async (c) => c.json({ len: (await c.req.text()).length }));

      const bigBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(128)));
          controller.close();
        },
      });
      const res = await app.fetch(
        new Request("http://localhost/upload", {
          method: "POST",
          body: bigBody,
          duplex: "half",
        } as RequestInit)
      );
      expect(res.status).toBe(413);
    });

    it("rejects prototype-polluting keys and deeply nested JSON payloads", () => {
      expect(() => safeJsonParse('{"__proto__":{"polluted":true}}')).toThrow();
      expect(() => safeJsonParse('{"nested":{"constructor":{"x":1}}}')).toThrow();
      expect(() => safeJsonParse('{"prototype":{"x":1}}')).toThrow();

      let deep: Record<string, unknown> = { leaf: 1 };
      for (let i = 0; i < 40; i += 1) deep = { child: deep };
      const outcome = assertSafeJsonStructure(deep, { maxDepth: 32 });
      expect(outcome.ok).toBe(false);
    });

    it("aborts slow handlers when requestTimeout is exceeded", async () => {
      const app = new Hono();
      app.onError(errorHandler);
      app.use("*", requestTimeout(25));
      app.get("/slow", async (c) => {
        await new Promise((r) => setTimeout(r, 120));
        return c.json({ ok: true });
      });

      const res = await app.fetch(new Request("http://localhost/slow"));
      expect(res.status).toBeGreaterThanOrEqual(500);
    });
  });

  describe("constant-time comparison, spoof-resistant IP extraction & production error hygiene", () => {
    it("performs constant-time string equality checks", () => {
      expect(constantTimeEqual("secret-token-123", "secret-token-123")).toBe(true);
      expect(constantTimeEqual("secret-token-123", "secret-token-124")).toBe(false);
      expect(constantTimeEqual("short", "much-longer-secret")).toBe(false);
    });

    it("uses x-vercel-forwarded-for on Vercel and ignores it elsewhere", async () => {
      const app = new Hono();
      app.get("/ip", (c) => c.json({ ip: extractClientIp(c) }));
      const headers = { "x-forwarded-for": "198.51.100.42, 76.76.21.9", "x-vercel-forwarded-for": "203.0.113.7" };
      process.env["TRUST_PROXY_HOPS"] = "1";
      delete process.env["VERCEL"];
      const off = await app.fetch(new Request("http://localhost/ip", { headers }));
      expect(((await off.json()) as { ip: string }).ip).toBe("76.76.21.9");
      process.env["VERCEL"] = "1";
      try {
        const on = await app.fetch(new Request("http://localhost/ip", { headers }));
        expect(((await on.json()) as { ip: string }).ip).toBe("203.0.113.7");
      } finally {
        delete process.env["VERCEL"];
      }
    });

    it("ignores a client-supplied cf-connecting-ip unless Cloudflare is explicitly trusted", async () => {
      const app = new Hono();
      app.get("/ip", (c) => c.json({ ip: extractClientIp(c) }));
      const headers = { "cf-connecting-ip": "10.9.9.9", "x-forwarded-for": "198.51.100.42", "x-vercel-forwarded-for": "203.0.113.7" };
      const ipOf = async (): Promise<string> => ((await (await app.fetch(new Request("http://localhost/ip", { headers }))).json()) as { ip: string }).ip;
      process.env["TRUST_PROXY_HOPS"] = "1";
      delete process.env["TRUST_CLOUDFLARE_IP"];
      delete process.env["VERCEL"];
      expect(await ipOf()).toBe("198.51.100.42");
      process.env["VERCEL"] = "1";
      try {
        expect(await ipOf()).toBe("203.0.113.7");
        process.env["TRUST_CLOUDFLARE_IP"] = "true";
        expect(await ipOf()).toBe("203.0.113.7");
        delete process.env["VERCEL"];
        expect(await ipOf()).toBe("10.9.9.9");
      } finally {
        delete process.env["VERCEL"];
        delete process.env["TRUST_CLOUDFLARE_IP"];
      }
    });

    it("prevents X-Forwarded-For leftmost spoofing and respects TRUST_PROXY_HOPS", async () => {
      const app = new Hono();
      app.get("/ip", (c) => c.json({ ip: extractClientIp(c) }));

      // Spoofed leftmost IP + trusted proxy appended real client IP on the right
      process.env["TRUST_PROXY_HOPS"] = "1";
      const spoofed = await app.fetch(
        new Request("http://localhost/ip", {
          headers: { "x-forwarded-for": "1.2.3.4, 198.51.100.42" },
        })
      );
      expect(((await spoofed.json()) as { ip: string }).ip).toBe("198.51.100.42");

      // Direct mode (TRUST_PROXY_HOPS=0) ignores X-Forwarded-For completely
      process.env["TRUST_PROXY_HOPS"] = "0";
      const direct = await app.fetch(
        new Request("http://localhost/ip", {
          headers: {
            "x-forwarded-for": "1.2.3.4",
            "x-vellum-remote-addr": "::ffff:203.0.113.9",
          },
        })
      );
      expect(((await direct.json()) as { ip: string }).ip).toBe("203.0.113.9");
    });

    it("never leaks internal DB details or error messages in production 500 responses", async () => {
      process.env["NODE_ENV"] = "production";
      const app = new Hono();
      app.onError(errorHandler);
      app.get("/boom", () => {
        throw new Error('relation "users" does not exist at postgres://admin:secret@db:5432/prod');
      });

      const res = await app.fetch(new Request("http://localhost/boom"));
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INTERNAL");
      expect(body.error.message).toBe("Internal Server Error");
      expect(JSON.stringify(body)).not.toContain("postgres://");
      expect(JSON.stringify(body)).not.toContain("relation");
    });
  });

  describe("production /health, /ready & drain behavior", () => {
    it("serves fast, non-leaking /health and /ready and returns 503 while draining", async () => {
      const platform = createVellumPlatform();

      const healthRes = await platform.fetch(new Request("http://localhost:8080/health"));
      expect(healthRes.status).toBe(200);
      expect(healthRes.headers.get("cache-control")).toBe("no-store");
      const healthBody = (await healthRes.json()) as { status: string };
      expect(healthBody.status).toBe("ok");

      const readyRes = await platform.fetch(new Request("http://localhost:8080/ready"));
      expect(readyRes.status).toBe(200);
      const readyBody = (await readyRes.json()) as { status: string; ready: boolean };
      expect(readyBody.status).toBe("ready");
      expect(readyBody.ready).toBe(true);

      setShuttingDown(true);
      const drainingRes = await platform.fetch(new Request("http://localhost:8080/ready"));
      expect(drainingRes.status).toBe(503);
      const drainingBody = (await drainingRes.json()) as { status: string; ready: boolean };
      expect(drainingBody.status).toBe("draining");
      expect(drainingBody.ready).toBe(false);
    });
  });

  describe("WebSocket hardening & bounded concurrency", () => {
    it("rejects wildcard/null WebSocket origins and oversized frames before allocation", () => {
      const allowed = parseWsAllowedOrigins("*, null, https://console.vellum.dev/");
      expect(allowed.has("*")).toBe(false);
      expect(allowed.has("null")).toBe(false);
      expect(isOriginAllowed("https://console.vellum.dev", allowed)).toBe(true);
      expect(isOriginAllowed("null", allowed)).toBe(false);
      expect(isOriginAllowed("https://evil.test", allowed)).toBe(false);

      // Craft a 126-extended header declaring 65535 bytes with a 1024-byte cap
      const header = Buffer.from([0x81, 0x7e, 0xff, 0xff]);
      expect(() => tryDecodeWsFrame(header, 1024)).toThrow(WsFrameTooLargeError);
    });

    it("bounds async fan-out concurrency with mapWithConcurrency", async () => {
      let active = 0;
      let peak = 0;
      const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return n * 2;
      });
      expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
      expect(peak).toBeLessThanOrEqual(3);
    });
  });
});
