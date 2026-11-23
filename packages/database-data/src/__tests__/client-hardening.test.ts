import { describe, expect, it, vi } from "vitest";
import {
  checkDataDbHealth,
  createDataDb,
  isTransientPgError,
  withRetry,
} from "../client.js";

describe("@vellum/database-data / client reliability & concurrency", () => {
  it("classifies transient PostgreSQL and network errors accurately", () => {
    expect(isTransientPgError({ code: "40001" })).toBe(true);
    expect(isTransientPgError({ code: "40P01" })).toBe(true);
    expect(isTransientPgError({ code: "08006" })).toBe(true);
    expect(isTransientPgError({ code: "57P03" })).toBe(true);
    expect(isTransientPgError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientPgError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransientPgError({ cause: { code: "ETIMEDOUT" } })).toBe(true);

    // Non-transient SQL errors must NOT be retried
    expect(isTransientPgError({ code: "23505" })).toBe(false); // unique_violation
    expect(isTransientPgError({ code: "42501" })).toBe(false); // insufficient_privilege / RLS
    expect(isTransientPgError({ code: "22P02" })).toBe(false); // invalid_text_representation
    expect(isTransientPgError(null)).toBe(false);
  });

  it("retries transient errors with withRetry and immediately rethrows permanent errors", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("deadlock"), { code: "40P01" });
        }
        return "ok";
      },
      { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0 }
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);

    let permAttempts = 0;
    await expect(
      withRetry(
        async () => {
          permAttempts += 1;
          throw Object.assign(new Error("unique violation"), { code: "23505" });
        },
        { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0 }
      )
    ).rejects.toThrow("unique violation");
    expect(permAttempts).toBe(1);
  });

  it("rejects malformed connection strings and enforces production URL config", () => {
    expect(() => createDataDb({ connectionString: "http://example.com/db" })).toThrow(
      /protocol/i
    );
    expect(() => createDataDb({ connectionString: "not a url" })).toThrow(/malformed/i);
    expect(() => createDataDb({ max: 0 })).toThrow(RangeError);
  });

  it("makes close() idempotent and attaches an error listener to the pool", async () => {
    const onPoolError = vi.fn();
    const client = createDataDb({
      connectionString: "postgresql://user:pass@localhost:5433/data_db",
      driver: "pg",
      onPoolError,
    });

    // Triggering a pool error must invoke onPoolError instead of crashing Node.js
    const testErr = new Error("idle disconnect");
    client.pool.emit("error", testErr);
    expect(onPoolError).toHaveBeenCalledWith(testErr);

    // Concurrent/repeated close() calls must coalesce cleanly without throwing
    await Promise.all([client.close(), client.close()]);
    await client.close();
  });

  it("reports health status and handles timeouts cleanly in checkDataDbHealth", async () => {
    const healthy = await checkDataDbHealth({ query: async () => ({ rows: [{ "?column?": 1 }] }) });
    expect(healthy.ok).toBe(true);
    expect(healthy.latencyMs).toBeGreaterThanOrEqual(0);

    const unhealthy = await checkDataDbHealth({
      query: async () => {
        throw new Error("connection refused");
      },
    });
    expect(unhealthy.ok).toBe(false);
    expect(unhealthy.error).toContain("connection refused");
  });
});
