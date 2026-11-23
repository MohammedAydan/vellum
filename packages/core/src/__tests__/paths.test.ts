import { describe, it, expect } from "vitest";
import { VellumError, validateCollectionName } from "../index.js";

describe("@vellum/core - validateCollectionName", () => {
  it("trims and returns valid names", () => {
    expect(validateCollectionName("users")).toBe("users");
    expect(validateCollectionName("  users_2026  ")).toBe("users_2026");
    expect(validateCollectionName("orders.v2-old")).toBe("orders.v2-old");
    expect(validateCollectionName("a")).toBe("a");
    expect(validateCollectionName("A".repeat(128))).toBe("A".repeat(128));
  });

  it("rejects empty, slash-delimited and relative names", () => {
    for (const bad of ["", "   ", "/users", "users/", "users/orders", "users..orders", "..", "."]) {
      expect(() => validateCollectionName(bad)).toThrowError(VellumError);
    }
  });

  it("rejects whitespace and control characters", () => {
    for (const bad of ["user s", "user\ts", "user\ns", "user\u0000s"]) {
      expect(() => validateCollectionName(bad)).toThrowError(VellumError);
    }
  });

  it("rejects the reserved __internal__ prefix", () => {
    expect(() => validateCollectionName("__internal__cache")).toThrowError(VellumError);
    expect(() => validateCollectionName("__INTERNAL__cache")).toThrowError(VellumError);
  });

  it("rejects names that break the flat-name regex", () => {
    expect(() => validateCollectionName("_users")).toThrowError(VellumError);
    expect(() => validateCollectionName("-users")).toThrowError(VellumError);
    expect(() => validateCollectionName("users@x")).toThrowError(VellumError);
    expect(() => validateCollectionName("a".repeat(129))).toThrowError(VellumError);
  });

  it("raises INVALID_ARGUMENT (400) for all rejections", () => {
    try {
      validateCollectionName("bad name");
      throw new Error("expected validateCollectionName to throw");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(VellumError);
      const vellumError = error as VellumError;
      expect(vellumError.code).toBe("INVALID_ARGUMENT");
      expect(vellumError.status).toBe(400);
    }
  });
});
