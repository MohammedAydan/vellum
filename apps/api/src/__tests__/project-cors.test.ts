import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createProjectCors, type ProjectCorsStore } from "../middleware/project-cors.js";

type Key = { projectId: string; allowedOrigins?: string[] | undefined; revokedAt: string | null; expiresAt: string | null };

function setup(keys: Key[], now = () => Date.now()) {
  const store: ProjectCorsStore = { apiKeysById: new Map(keys.map((k, i) => [String(i), k])) };
  const app = new Hono();
  app.use("*", createProjectCors(store, (o) => o === "https://console.example", now));
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
  it("picks up a revoked key after the cache window", async () => {
    let t = 1_000_000;
    const k = key();
    const { app } = setup([k], () => t);
    expect((await app.fetch(req("/v1/projects/p1/collections/a", "https://shop.example"))).headers.get("access-control-allow-origin")).toBe("https://shop.example");
    k.revokedAt = "2026-01-01T00:00:00Z";
    t += 6_000;
    expect((await app.fetch(req("/v1/projects/p1/collections/a", "https://shop.example"))).headers.get("access-control-allow-origin")).toBeNull();
  });
});
