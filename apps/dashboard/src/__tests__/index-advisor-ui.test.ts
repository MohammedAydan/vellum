import { describe, expect, it } from "vitest";
import {
  decodeSuggestPayloadLocal,
  type SuggestPayload,
} from "../routes/_app/orgs.$orgId.projects.$projectId.indexes.js";

function encodeSuggest(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function validPayload(overrides: Partial<SuggestPayload> = {}): SuggestPayload {
  return {
    orgId: "org_1",
    projectId: "proj_1",
    collectionPath: "orders",
    fields: [
      { path: "status", dir: "asc" },
      { path: "createdAt", dir: "desc" },
    ],
    fingerprint: "sha256-fingerprint",
    reason: "Composite index needed for equality filter + sort",
    ...overrides,
  };
}

describe("indexes page - browser-safe ?suggest= decoder", () => {
  it("round-trips a valid project-scoped payload", () => {
    const payload = validPayload();
    const decoded = decodeSuggestPayloadLocal(encodeSuggest(payload));
    expect(decoded).toEqual(payload);
    // ESR order and directions must be preserved exactly.
    expect(decoded?.fields).toEqual([
      { path: "status", dir: "asc" },
      { path: "createdAt", dir: "desc" },
    ]);
  });

  it("decodes UTF-8 reasons and padded/unpadded base64url alphabets", () => {
    const payload = validPayload({ reason: "ترتيب حسب التاريخ — فهرس مركّب مطلوب ✓" });
    const base64url = encodeSuggest(payload);
    // base64url must not contain the standard + / alphabet.
    expect(base64url).not.toMatch(/[+/]/);
    expect(decodeSuggestPayloadLocal(base64url)).toEqual(payload);
  });

  it("returns null for an empty payload", () => {
    expect(decodeSuggestPayloadLocal("")).toBeNull();
  });

  it("returns null for malformed base64", () => {
    expect(decodeSuggestPayloadLocal("!!!not@@base64###")).toBeNull();
  });

  it("returns null for base64 that is not JSON", () => {
    expect(decodeSuggestPayloadLocal(Buffer.from("not json", "utf8").toString("base64url"))).toBeNull();
  });

  it("returns null when a required string field is missing", () => {
    const raw = validPayload() as unknown as Record<string, unknown>;
    delete raw["fingerprint"];
    expect(decodeSuggestPayloadLocal(encodeSuggest(raw))).toBeNull();
  });

  it("returns null for a non-string reason", () => {
    const raw = validPayload() as unknown as Record<string, unknown>;
    raw["reason"] = 42;
    expect(decodeSuggestPayloadLocal(encodeSuggest(raw))).toBeNull();
  });

  it("rejects fields with an invalid direction (not asc/desc)", () => {
    const raw = validPayload() as unknown as Record<string, unknown>;
    raw["fields"] = [{ path: "status", dir: "ASC" }];
    expect(decodeSuggestPayloadLocal(encodeSuggest(raw))).toBeNull();
  });

  it("rejects fields with an empty path or a non-object entry", () => {
    const emptyPath = validPayload() as unknown as Record<string, unknown>;
    emptyPath["fields"] = [{ path: "", dir: "asc" }];
    expect(decodeSuggestPayloadLocal(encodeSuggest(emptyPath))).toBeNull();

    const nonObject = validPayload() as unknown as Record<string, unknown>;
    nonObject["fields"] = ["status"];
    expect(decodeSuggestPayloadLocal(encodeSuggest(nonObject))).toBeNull();
  });

  it("rejects more than 64 fields", () => {
    const raw = validPayload() as unknown as Record<string, unknown>;
    raw["fields"] = Array.from({ length: 65 }, (_, i) => ({ path: `f${i}`, dir: "asc" }));
    expect(decodeSuggestPayloadLocal(encodeSuggest(raw))).toBeNull();
  });

  it("rejects an oversized (> 8 KiB) payload", () => {
    const huge = "x".repeat(9 * 1024);
    expect(decodeSuggestPayloadLocal(encodeSuggest(validPayload({ reason: huge })))).toBeNull();
  });

  it("rejects a JSON array at the top level", () => {
    expect(decodeSuggestPayloadLocal(encodeSuggest([validPayload()]))).toBeNull();
  });
});
