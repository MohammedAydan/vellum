import { describe, expect, it } from "vitest";
import { stripVercelFunctionPrefix, VERCEL_FUNCTION_PREFIX } from "../vercel-path.js";

describe("Vercel runtime - rewrite prefix handling", () => {
  it("strips the function mount prefix from rewritten URLs", () => {
    expect(stripVercelFunctionPrefix("/api/server/v1/health/live")).toBe("/v1/health/live");
    expect(stripVercelFunctionPrefix("/api/server/v1/realtime")).toBe("/v1/realtime");
    expect(stripVercelFunctionPrefix(VERCEL_FUNCTION_PREFIX)).toBe("/");
  });

  it("leaves canonical and unrelated URLs untouched", () => {
    expect(stripVercelFunctionPrefix("/v1/health/live")).toBe("/v1/health/live");
    expect(stripVercelFunctionPrefix("/v1/realtime")).toBe("/v1/realtime");
    expect(stripVercelFunctionPrefix("/api/other/v1/realtime")).toBe("/api/other/v1/realtime");
    expect(stripVercelFunctionPrefix(undefined)).toBeUndefined();
  });
});
