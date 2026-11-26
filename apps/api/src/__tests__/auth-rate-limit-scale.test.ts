import { describe, expect, it } from "vitest";
import { authRateLimitScale } from "../middleware/auth-rate-limit.js";

describe("AUTH_RATE_LIMIT_SCALE", () => {
  it("is off unless set to a number above 1", () => {
    expect(authRateLimitScale(undefined)).toBe(1);
    expect(authRateLimitScale("")).toBe(1);
    expect(authRateLimitScale("abc")).toBe(1);
    expect(authRateLimitScale("0.1")).toBe(1);
    expect(authRateLimitScale("-5")).toBe(1);
    expect(authRateLimitScale("1")).toBe(1);
  });
  it("scales up and is capped", () => {
    expect(authRateLimitScale("10")).toBe(10);
    expect(authRateLimitScale("999999")).toBe(1000);
  });
});
