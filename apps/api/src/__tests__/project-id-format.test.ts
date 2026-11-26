import { describe, it, expect } from "vitest";
import { createVellumPlatform } from "../platform.js";

describe("project id in the path", () => {
  it("a value that is not a UUID is a 400 INVALID_ARGUMENT, not a 404", async () => {
    const platform = createVellumPlatform();
    const res = await platform.fetch(new Request("http://localhost/v1/projects/my-app/collections/posts", { headers: { "x-vellum-api-key": "pk_x" } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "INVALID_ARGUMENT", message: expect.stringContaining("UUID") } });
  });
  it("a UUID that does not exist still reaches the normal lookup", async () => {
    const platform = createVellumPlatform();
    const res = await platform.fetch(new Request("http://localhost/v1/projects/11111111-1111-4111-8111-111111111111/collections/posts"));
    expect(res.status).not.toBe(400);
  });
});
