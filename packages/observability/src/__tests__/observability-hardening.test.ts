import { describe, it, expect } from "vitest";
import {
  redactSensitiveData,
  StructuredLogger,
  SlidingWindowRateLimiter,
} from "../index.js";
import { VellumError } from "@vellum/core";

describe("@vellum/observability hardening", () => {
  describe("Deep secret & PII redaction with cycle safety", () => {
    it("redacts JWTs, API keys, Bearer tokens, DB URIs, cookies, and Errors", () => {
      const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOiJ1XzEifQ.signature123456";
      expect(redactSensitiveData(`Token: ${jwt}`)).toBe("Token: [REDACTED]");
      expect(redactSensitiveData("Bearer abc.def_123")).toBe("[REDACTED]");
      expect(redactSensitiveData("whsec_abcdef1234567890")).toBe("[REDACTED]");
      expect(redactSensitiveData("redis://:supersecret@localhost:6379/0")).toBe("[REDACTED]");

      const obj = redactSensitiveData({
        cookie: "session=abc123",
        "set-cookie": "vellum_refresh_token=xyz",
        privateKey: "-----BEGIN PRIVATE KEY-----",
        err: new Error("Failed connecting to postgres://u:p@host/db"),
      }) as Record<string, unknown>;

      expect(obj["cookie"]).toBe("[REDACTED]");
      expect(obj["set-cookie"]).toBe("[REDACTED]");
      expect(obj["privateKey"]).toBe("[REDACTED]");
      const errObj = obj["err"] as { message: string };
      expect(errObj.message).toBe("Failed connecting to [REDACTED]");
    });

    it("handles circular references without throwing", () => {
      const a: Record<string, unknown> = { ok: true };
      a["self"] = a;
      const redacted = redactSensitiveData(a) as Record<string, unknown>;
      expect(redacted["ok"]).toBe(true);
      expect(redacted["self"]).toBe("[Circular]");
    });
  });

  describe("Non-throwing StructuredLogger & bounded entries", () => {
    it("swallows throwing sinks and caps in-memory entries", () => {
      const logger = new StructuredLogger({
        service: "hardened-test",
        maxEntries: 10,
        sink: () => {
          throw new Error("sink down");
        },
      });
      for (let i = 0; i < 25; i++) {
        expect(() => logger.info(`msg ${i}`, { password: "secret" })).not.toThrow();
      }
      expect(logger.entries.length).toBeLessThanOrEqual(10);
      expect(logger.entries[logger.entries.length - 1]?.["password"]).toBe("[REDACTED]");
    });
  });

  describe("Bounded SlidingWindowRateLimiter", () => {
    it("caps key cardinality with O(1) LRU eviction and rejects non-positive limits", () => {
      const limiter = new SlidingWindowRateLimiter(50);
      for (let i = 0; i < 120; i++) {
        const res = limiter.checkAndConsume(`tenant_${i}`, 10, 10_000);
        expect(res.remaining).toBe(9);
      }
      expect(() => limiter.checkAndConsume("tenant_zero", 0, 10_000)).toThrow(VellumError);
    });
  });
});
