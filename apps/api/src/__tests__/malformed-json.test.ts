import { describe, it, expect } from "vitest";
import { createVellumPlatform } from "../platform.js";

describe("malformed transport JSON", () => {
  it.each(["/v1/projects/p/rules/compile", "/v1/projects/p/rules/decompile", "/v1/projects/p/rules/simulate", "/v1/auth/sign-up/email", "/v1/console/projects/p/query"])("returns 400 INVALID_ARGUMENT for %s", async (path) => {
    const platform = createVellumPlatform();
    const result = await platform.fetch(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"source":"line1\nline2"}',
    }));
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ error: { code: "INVALID_ARGUMENT", message: expect.stringContaining("Malformed JSON") } });
  });
  it("accepts bodyless GET with a JSON content type", async () => {
    const platform = createVellumPlatform();
    const result = await platform.fetch(new Request("http://localhost/v1/health", { headers: { "content-type": "application/json" } }));
    expect(result.status).toBe(200);
  });
  it("does not parse a bodyless DELETE before authorization", async () => {
    const platform = createVellumPlatform();
    const result = await platform.fetch(new Request("http://localhost/v1/admin/security/blocklist/test", {
      method: "DELETE", headers: { "content-type": "application/json" },
    }));
    expect(result.status).toBe(401);
  });
  it("does not turn unrelated internal SyntaxErrors into client errors", async () => {
    const { errorHandler } = await import("../middleware/error-handler.js");
    const { Hono } = await import("hono");
    const app = new Hono(); app.onError(errorHandler);
    app.get("/internal", () => { throw new SyntaxError("internal bug"); });
    expect((await app.request("/internal")).status).toBe(500);
  });
});
