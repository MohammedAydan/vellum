import { describe, it, expect } from "vitest";
import {
  redactSensitiveData,
  createLogger,
  StructuredLogger,
  SlidingWindowRateLimiter,
  generateRequestId,
  type LogEntry,
} from "../index.js";
import { VellumError } from "@vellum/core";

describe("@vellum/observability", () => {
  describe("Secret Redaction", () => {
    it("redacts sensitive keys and values", () => {
      const payload = {
        username: "alice",
        password: "supersecretpassword",
        apiKey: "pk_1234567890abcdef1234567890abcdef",
        database_url: "postgres://user:pass@localhost:5432/db",
        nested: {
          authorization: "Bearer my-jwt-token-value",
          normal: "safe data",
        },
      };

      const redacted = redactSensitiveData(payload) as {
        username: string;
        password: string;
        apiKey: string;
        database_url: string;
        nested: { authorization: string; normal: string };
      };
      expect(redacted.password).toBe("[REDACTED]");
      expect(redacted.apiKey).toBe("[REDACTED]");
      expect(redacted.database_url).toBe("[REDACTED]");
      expect(redacted.nested.authorization).toBe("[REDACTED]");
      expect(redacted.username).toBe("alice");
      expect(redacted.nested.normal).toBe("safe data");
    });

    it("redacts string patterns", () => {
      expect(redactSensitiveData("Connecting to postgresql://admin:secret@host/db")).toBe(
        "Connecting to [REDACTED]"
      );
      expect(redactSensitiveData("Key is sk_abcdef1234567890")).toBe("Key is [REDACTED]");
    });
  });

  describe("StructuredLogger", () => {
    it("logs with redaction and delivers to sink", () => {
      const sinkLogs: LogEntry[] = [];
      const logger = new StructuredLogger({
        service: "test-service",
        sink: (entry) => sinkLogs.push(entry),
      });

      const entry = logger.info("User login", { password: "123", email: "a@b.com" });
      expect(entry.service).toBe("test-service");
      expect(entry.level).toBe("info");
      expect(entry["password"]).toBe("[REDACTED]");
      expect(entry["email"]).toBe("a@b.com");
      expect(sinkLogs.length).toBe(1);
    });

    it("creates real pino logger instance", () => {
      const pinoLogger = createLogger({ service: "api" });
      expect(pinoLogger).toBeDefined();
      expect(typeof pinoLogger.info).toBe("function");
    });
  });

  describe("SlidingWindowRateLimiter", () => {
    it("allows requests under the limit and tracks remaining", () => {
      const limiter = new SlidingWindowRateLimiter();
      const res = limiter.checkAndConsume("key1", 5);
      expect(res.remaining).toBe(4);
    });

    it("throws RATE_LIMITED when threshold exceeded", () => {
      const limiter = new SlidingWindowRateLimiter();
      for (let i = 0; i < 5; i++) {
        limiter.checkAndConsume("key2", 5);
      }
      expect(() => limiter.checkAndConsume("key2", 5)).toThrow(VellumError);
    });
  });

  describe("generateRequestId", () => {
    it("generates req_ prefixed unique string", () => {
      const id1 = generateRequestId();
      const id2 = generateRequestId();
      expect(id1.startsWith("req_")).toBe(true);
      expect(id2.startsWith("req_")).toBe(true);
      expect(id1).not.toBe(id2);
    });
  });
});
