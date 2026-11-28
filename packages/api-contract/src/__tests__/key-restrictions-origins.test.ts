import { describe, expect, it } from "vitest";
import { KeyRestrictionsSchema } from "../schemas/fortress.js";

describe("KeyRestrictionsSchema allowedOrigins", () => {
  it("accepts exact origins and the local-dev wildcard-port entries", () => {
    const r = KeyRestrictionsSchema.safeParse({ allowedOrigins: ["https://app.example", "http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"] });
    expect(r.success).toBe(true);
  });
  it("rejects other wildcards", () => {
    for (const bad of ["*", "https://*.example", "https://app.example:*", "http://localhost.evil.example:*", "not a url"]) {
      expect(KeyRestrictionsSchema.safeParse({ allowedOrigins: [bad] }).success, bad).toBe(false);
    }
  });
});
