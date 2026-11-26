import { afterEach, describe, expect, it } from "vitest";
import { createVellumPlatform } from "../index.js";

const platforms: ReturnType<typeof createVellumPlatform>[] = [];
afterEach(() => {
  for (const p of platforms.splice(0)) p.metering.stop();
});

describe("CORS credentials header", () => {
  it("is not sent to an origin that was not granted", async () => {
    const p = createVellumPlatform();
    platforms.push(p);
    const res = await p.fetch(new Request("http://localhost/v1/health/live", { headers: { origin: "https://evil.example" } }));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});
