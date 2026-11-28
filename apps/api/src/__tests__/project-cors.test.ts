import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createProjectCors, createProjectOriginChecker, type ProjectCorsStore } from "../middleware/project-cors.js";

type Key = { projectId: string; allowedOrigins?: string[] | undefined; revokedAt: string | null; expiresAt: string | null; isDev?: boolean | undefined };

let reads = 0;
function setup(keys: Key[]) {
  reads = 0;
  const store: ProjectCorsStore = {
    async listActiveApiKeyOrigins(projectId) {
      reads += 1;
      const now = Date.now();
      return keys
        .filter((k) => k.projectId === projectId && !k.revokedAt && !(k.expiresAt && Date.parse(k.expiresAt) <= now))
        .flatMap((k) => k.allowedOrigins ?? []);
    },
    async hasActiveDevKey(projectId) {
      const now = Date.now();
      return keys.some(
        (k) => k.projectId === projectId && !!k.isDev && !k.revokedAt && !(k.expiresAt && Date.parse(k.expiresAt) <= now)
      );
    },
  };
  const app = new Hono();
  app.use("*", createProjectCors(store, (o) => o === "https://console.example"));
  app.all("/v1/projects/:id/*", (c) => c.json({ ok: true }));
  app.all("/v1/health", (c) => c.json({ ok: true }));
  return { app, store };
}
const key = (over: Partial<Key> = {}): Key => ({ projectId: "p1", allowedOrigins: ["https://shop.example"], revokedAt: null, expiresAt: null, ...over });
const req = (path: string, origin: string, method = "GET") =>
  new Request("http://x" + path, { method, headers: { origin, "access-control-request-method": "POST" } });

describe("per-project CORS", () => {
  it("allows an origin listed on an active key of the same project, without credentials", async () => {
    const { app } = setup([key()]);
    const res = await app.fetch(req("/v1/projects/p1/collections/a", "https://shop.example"));
    expect(res.headers.get("access-control-allow-origin")).toBe("https://shop.example");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("vary")).toContain("Origin");
  });
  it("answers the preflight for an allowed origin", async () => {
    const { app } = setup([key()]);
    const res = await app.fetch(req("/v1/projects/p1/auth/oauth/exchange", "https://shop.example", "OPTIONS"));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("X-Vellum-Api-Key");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
  it("does not allow the origin on another project", async () => {
    const { app } = setup([key()]);
    const res = await app.fetch(req("/v1/projects/p2/collections/a", "https://shop.example"));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("ignores keys without origins, revoked keys and expired keys", async () => {
    for (const k of [key({ allowedOrigins: [] }), key({ allowedOrigins: undefined }), key({ revokedAt: "2026-01-01T00:00:00Z" }), key({ expiresAt: "2020-01-01T00:00:00Z" })]) {
      const { app } = setup([k]);
      const res = await app.fetch(req("/v1/projects/p1/collections/a", "https://shop.example"));
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
  it("never accepts wildcard or null origins from key settings", async () => {
    const { app } = setup([key({ allowedOrigins: ["*", "null", "https://*.example"] })]);
    for (const o of ["*", "null", "https://a.example"]) {
      const res = await app.fetch(req("/v1/projects/p1/collections/a", o));
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
  it("matches the exact origin only", async () => {
    const { app } = setup([key()]);
    for (const o of ["https://shop.example.evil.test", "http://shop.example", "https://shop.example:8443"]) {
      const res = await app.fetch(req("/v1/projects/p1/collections/a", o));
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
  it("leaves admin and console routes and non-project routes alone", async () => {
    const { app } = setup([key()]);
    for (const p of ["/v1/projects/p1/auth/admin/config", "/v1/projects/p1/console/x", "/v1/health"]) {
      const res = await app.fetch(req(p, "https://shop.example"));
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
  it("leaves globally allowed origins to the global middleware", async () => {
    const { app } = setup([key({ allowedOrigins: ["https://console.example"] })]);
    const res = await app.fetch(req("/v1/projects/p1/collections/a", "https://console.example"));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("sees a revoke or an edit on the very next request (no cache)", async () => {
    const k = key();
    const { app } = setup([k]);
    const call = () => app.fetch(req("/v1/projects/p1/collections/a", "https://shop.example"));
    expect((await call()).headers.get("access-control-allow-origin")).toBe("https://shop.example");
    k.allowedOrigins = ["https://other.example"];
    expect((await call()).headers.get("access-control-allow-origin")).toBeNull();
    k.allowedOrigins = ["https://shop.example"];
    expect((await call()).headers.get("access-control-allow-origin")).toBe("https://shop.example");
    k.revokedAt = "2026-01-01T00:00:00Z";
    expect((await call()).headers.get("access-control-allow-origin")).toBeNull();
  });
  it("reads the store once per cross-origin request and never for same-origin or global origins", async () => {
    const { app } = setup([key()]);
    await app.fetch(new Request("http://x/v1/projects/p1/collections/a"));
    await app.fetch(req("/v1/projects/p1/collections/a", "https://console.example"));
    expect(reads).toBe(0);
    await app.fetch(req("/v1/projects/p1/collections/a", "https://shop.example"));
    expect(reads).toBe(1);
  });
});

describe("realtime stream and shared origin checker", () => {
  it("answers the SSE stream preflight for a well-formed origin, without credentials", async () => {
    const { app } = setup([]);
    app.all("/v1/realtime/stream", (c) => c.json({ ok: true }));
    const res = await app.fetch(req("/v1/realtime/stream", "https://shop.example", "OPTIONS"));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://shop.example");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toBe("POST,OPTIONS");
  });
  it("does not answer the stream preflight for null or wildcard origins", async () => {
    const { app } = setup([]);
    app.all("/v1/realtime/stream", (c) => c.json({ ok: true }));
    for (const o of ["null", "*"]) {
      const res = await app.fetch(req("/v1/realtime/stream", o, "OPTIONS"));
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
  it("the checker applies the same key rules (active, same project, exact origin)", async () => {
    const { store } = setup([key(), key({ projectId: "p3", revokedAt: "2026-01-01T00:00:00Z" })]);
    const allowed = createProjectOriginChecker(store);
    expect(await allowed("p1", "https://shop.example")).toBe(true);
    expect(await allowed("p1", "https://shop.example/")).toBe(true);
    expect(await allowed("p1", "https://evil.example")).toBe(false);
    expect(await allowed("p2", "https://shop.example")).toBe(false);
    expect(await allowed("p3", "https://shop.example")).toBe(false);
    expect(await allowed("p1", "null")).toBe(false);
  });
});

describe("localhost development bypass (dev-flagged keys)", () => {
  it("allows localhost origins for a project with an active dev-flagged key, without credentials", async () => {
    const { app } = setup([key({ isDev: true })]);
    const res = await app.fetch(req("/v1/projects/p1/documents/notes", "http://localhost:5173"));
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
  it("answers the localhost preflight for a dev-key project", async () => {
    const { app } = setup([key({ isDev: true })]);
    const res = await app.fetch(req("/v1/projects/p1/documents/notes", "http://127.0.0.1:3000", "OPTIONS"));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:3000");
  });
  it("does not allow localhost origins for ordinary keys", async () => {
    const { app } = setup([key()]);
    const res = await app.fetch(req("/v1/projects/p1/documents/notes", "http://localhost:5173"));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("does not extend the bypass to non-localhost origins or revoked dev keys", async () => {
    const { app } = setup([key({ isDev: true }), key({ projectId: "p4", isDev: true, revokedAt: "2026-01-01T00:00:00Z" })]);
    const evil = await app.fetch(req("/v1/projects/p1/documents/notes", "https://evil.example"));
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const revoked = await app.fetch(req("/v1/projects/p4/documents/notes", "http://localhost:5173"));
    expect(revoked.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("the shared checker (SSE/WS path) applies the same dev-key rule", async () => {
    const { store } = setup([key({ isDev: true })]);
    const allowed = createProjectOriginChecker(store);
    expect(await allowed("p1", "http://localhost:5173")).toBe(true);
    expect(await allowed("p1", "http://[::1]:8080")).toBe(true);
    expect(await allowed("p1", "https://evil.example")).toBe(false);
    expect(await allowed("p2", "http://localhost:5173")).toBe(false);
  });
  it("logs one server-side hint per project and origin when an origin is rejected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { app } = setup([key()]);
      for (let i = 0; i < 3; i += 1) await app.fetch(req("/v1/projects/p1/collections/a", "https://blocked.example"));
      const hints = warn.mock.calls.filter((c) => String(c[0]).includes("https://blocked.example"));
      expect(hints).toHaveLength(1);
      expect(String(hints[0]?.[0])).toContain("allowedOrigins");
    } finally {
      warn.mockRestore();
    }
  });
});
