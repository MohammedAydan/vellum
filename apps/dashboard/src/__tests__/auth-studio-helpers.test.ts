import { describe, expect, it } from "vitest";
import { asBoolean, asNumber, asRecord, asString, errorMessage, formatDate, readOAuthDraft } from "../features/auth-studio/helpers.js";

describe("Auth Studio view helpers", () => {
  it("uses defaults rather than coercing invalid form values", () => {
    expect(asBoolean("true")).toBe(false);
    expect(asBoolean(false, true)).toBe(false);
    expect(asString(123, "empty")).toBe("empty");
    expect(asString("name")).toBe("name");
    expect(asNumber("30", 7)).toBe(7);
    expect(asNumber(Infinity, 7)).toBe(7);
    expect(asNumber(30, 7)).toBe(30);
  });
  it("rejects arrays and null as record values", () => {
    expect(asRecord(null)).toEqual({});
    expect(asRecord([1, 2])).toEqual({});
    const record = { enabled: true }; expect(asRecord(record)).toBe(record);
  });
  it("keeps empty OAuth drafts safe when configuration is not loaded", () => {
    expect(readOAuthDraft(null, "github")).toEqual({ enabled: false, clientId: "", clientSecret: "" });
    expect(readOAuthDraft(undefined, "google")).toEqual({ enabled: false, clientId: "", clientSecret: "" });
  });
  it("formats missing/invalid timestamps and preserves useful error messages", () => {
    expect(formatDate(null)).toBe("-");
    expect(formatDate("not a date")).toBe("-");
    expect(formatDate("2026-01-01T00:00:00Z")).not.toBe("-");
    expect(errorMessage(new Error("visible error"), "fallback")).toBe("visible error");
    expect(errorMessage({}, "fallback")).toBe("fallback");
  });
});
