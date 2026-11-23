/**
 * ENGINE-HARDENING §1–§3 — injection resistance, fail-closed contexts, debug metadata.
 *
 * The `authorizeOperation` mock records every call but delegates to the real
 * implementation, so all assertions exercise the real authorization path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VellumError } from "@vellum/core";
import type * as AuthorizationModule from "@vellum/authorization";
import { assertSafeFieldKey, FORBIDDEN_FIELD_KEYS } from "../path-utils.js";

// `vi.mock` is hoisted above imports; declare the recorder with `vi.hoisted`.
interface AuthCall {
  operation: string;
  apiKeyId: string;
  scopes: string[];
  bypassRules: boolean;
}
const authCalls = vi.hoisted(() => [] as AuthCall[]);

vi.mock("@vellum/authorization", async (importOriginal) => {
  const actual = await importOriginal<typeof AuthorizationModule>();
  return {
    ...actual,
    authorizeOperation: (params: Parameters<typeof actual.authorizeOperation>[0]) => {
      const key = params.apiKeyRecord as { id?: string; scopes?: string[] };
      authCalls.push({
        operation: params.operation,
        apiKeyId: typeof key.id === "string" ? key.id : "",
        scopes: Array.isArray(key.scopes) ? [...key.scopes] : [],
        bypassRules: params.bypassRules === true,
      });
      return actual.authorizeOperation(params);
    },
  };
});

import { projectDocumentFields } from "../engine.js";
import { applyFieldTransforms } from "../transforms.js";
import { resolveIncludes } from "../relations.js";
import { createFixture, TENANT, serverKey } from "./_harness.js";

const NOW = "2026-11-19T12:00:00.000Z";

describe("hardening/security — prototype pollution & unsafe field names", () => {
  beforeEach(() => {
    authCalls.length = 0;
  });

  it("FORBIDDEN_FIELD_KEYS and assertSafeFieldKey cover every gadget segment", () => {
    expect(FORBIDDEN_FIELD_KEYS.has("__proto__")).toBe(true);
    expect(FORBIDDEN_FIELD_KEYS.has("constructor")).toBe(true);
    expect(FORBIDDEN_FIELD_KEYS.has("prototype")).toBe(true);

    for (const key of ["__proto__", "constructor", "prototype", "bad\u0000name"]) {
      expect(() => assertSafeFieldKey(key)).toThrow(VellumError);
    }
    expect(() => assertSafeFieldKey("safe_field")).not.toThrow();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("setPath rejects dotted gadget paths and never mutates Object.prototype", async () => {
    const { setPath } = await import("../path-utils.js");
    const vectors = [
      "__proto__.x",
      "constructor.prototype.x",
      "prototype.polluted",
      "profile.__proto__.x",
      "a\u0000b.x",
    ];
    for (const vector of vectors) {
      const target: Record<string, unknown> = {};
      expect(() => setPath(target, vector, true)).toThrow(VellumError);
      // Safe intermediate segments may be created, but the gadget segment and
      // any inherited key must never appear on the target.
      expect(Object.prototype.hasOwnProperty.call(target, "x")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(target, "attacker")).toBe(false);
      expect(JSON.stringify(target)).not.toContain("polluted");
    }
    expect(Object.prototype).not.toHaveProperty("x");
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });

  it("projectDocumentFields rejects a flat map that would write a gadget key", () => {
    const flat: Record<string, unknown> = { ["__proto__.x"]: 1, ["constructor.prototype.y"]: 2 };
    expect(() => projectDocumentFields(flat, ["__proto__.x"])).toThrow(VellumError);
    expect(() => projectDocumentFields(flat, ["constructor.prototype.y"])).toThrow(VellumError);
    expect(Object.prototype).not.toHaveProperty("x");
    expect(Object.prototype).not.toHaveProperty("y");
  });

  it("nested patch keys __proto__/constructor/prototype are rejected", () => {
    const existing = { profile: { name: "old" } };
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const patch = JSON.parse(
        JSON.stringify({ profile: { [key]: { polluted: true } } })
      ) as Record<string, unknown>;
      expect(() => applyFieldTransforms(existing, patch, NOW)).toThrow(VellumError);
    }
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("NUL bytes in patch field names are rejected", () => {
    expect(() =>
      applyFieldTransforms({}, { ["bad\u0000name"]: 1 }, NOW)
    ).toThrow(VellumError);
  });

  it("engine writes reject NUL-bearing field names before persistence", async () => {
    const { engine } = createFixture();
    await expect(
      engine.createDocument({ ...TENANT, path: "users/u1", data: { ["bad\u0000name"]: 1 } })
    ).rejects.toMatchObject({ code: "INVALID_FIELD_NAME" });
  });

  it("malicious select / include vectors cannot pollute Object.prototype", async () => {
    const { engine, store } = createFixture();
    await engine.createDocument({
      ...TENANT,
      path: "posts/p1",
      data: { title: "T", authorId: { $ref: "users/u1" }, profile: { city: "Cairo" } },
    });
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { name: "Ada" } });

    for (const field of ["__proto__.x", "constructor.prototype.x"]) {
      const fetched = await engine.getDocument({ ...TENANT, path: "posts/p1", select: [field] });
      // An unresolvable malicious path is ignored; a resolvable one is rejected
      // by setPath. Either way, no prototype key is ever created.
      expect(fetched.data).not.toHaveProperty("x");
    }

    const included = await engine.getDocument({
      ...TENANT,
      path: "posts/p1",
      include: [{ field: "__proto__", collection: "users", as: "attacker" }],
    });
    expect(Object.prototype).not.toHaveProperty("attacker");
    expect(Object.prototype).not.toHaveProperty("x");
    // `as: "attacker"` is attached to data by design, but with no resolvable
    // target it is a harmless null (never a prototype mutation).
    expect(included.data["attacker"]).toBeNull();
    expect(store.outbox.length).toBe(2);
  });

  it("resolveIncludes with a gadget include field never writes a prototype key", async () => {
    const parent = {
      path: "posts/p1",
      data: JSON.parse('{"__proto__":{"$ref":"users/u1"}}') as Record<string, unknown>,
    };
    await expect(
      resolveIncludes({
        docs: [parent],
        includes: [{ field: "__proto__", collection: "users", as: "attacker" }],
        getDocument: async () => null,
        canRead: () => true,
      })
    ).resolves.toBeDefined();
    expect(Object.prototype).not.toHaveProperty("attacker");
  });
});

describe("hardening/security — fail-closed resolveApiKey", () => {
  beforeEach(() => {
    authCalls.length = 0;
  });

  it("getDocument without apiKeyRecord and without internal throws UNAUTHENTICATED", async () => {
    const { engine } = createFixture();
    const ctx = { projectId: TENANT.projectId };
    await expect(engine.getDocument({ ...ctx, path: "users/u1" })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("batchWrite without apiKeyRecord and without internal throws UNAUTHENTICATED", async () => {
    const { engine } = createFixture();
    const ctx = { projectId: TENANT.projectId };
    await expect(
      engine.batchWrite({
        ...ctx,
        writes: [{ type: "create", path: "users/u1", data: { n: 1 } }],
      })
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("bypassRules without internal is PERMISSION_DENIED (privilege escalation)", async () => {
    const { engine } = createFixture();
    const ctx = { projectId: TENANT.projectId };
    const escalation = { ...ctx, path: "users/u1", bypassRules: true };
    await expect(engine.getDocument(escalation)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("internal synthetic key is scoped to exactly documents:read/write", async () => {
    const { engine } = createFixture();
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { n: 1 } });
    await engine.getDocument({ ...TENANT, path: "users/u1" });

    const syntheticCalls = authCalls.filter((c) => c.apiKeyId === "internal_system_key");
    expect(syntheticCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of syntheticCalls) {
      expect(call.scopes).toEqual(["documents:read", "documents:write"]);
      expect(call.scopes).not.toContain("*");
      expect(call.scopes).not.toContain("indexes:manage");
    }
  });

  it("an explicit server key is forwarded verbatim to authorization", async () => {
    const { engine } = createFixture();
    const key = serverKey("sk_explicit");
    await engine.createDocument({ ...TENANT, apiKeyRecord: key, path: "users/u2", data: { n: 1 } });
    const calls = authCalls.filter((c) => c.apiKeyId === "sk_explicit");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.operation).toBe("create");
  });

  it("internal bypassRules:true is honoured only with internal:true", async () => {
    const { engine } = createFixture();
    const internalBypass = { ...TENANT, path: "users/u3", bypassRules: true };
    await engine.createDocument({ ...TENANT, path: "users/u3", data: { n: 1 } });
    const doc = await engine.getDocument(internalBypass);
    expect(doc.path).toBe("users/u3");
    expect(authCalls.some((c) => c.bypassRules)).toBe(true);
  });
});

describe("hardening/security — debug metadata disclosure", () => {
  it("compiledSql is absent by default and present only with debug:true", async () => {
    const { engine } = createFixture();
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { n: 1 } });

    const plain = await engine.executeQuery({
      ...TENANT,
      querySpec: { collection: "users" },
    });
    expect(plain.meta.compiledSql).toBeUndefined();
    expect(plain.meta.executionTimeMs % 5).toBe(0);
    expect(Number.isFinite(plain.meta.executionTimeMs)).toBe(true);

    const debug = await engine.executeQuery({
      ...TENANT,
      debug: true,
      querySpec: { collection: "users" },
    });
    expect(typeof debug.meta.compiledSql).toBe("string");
    expect((debug.meta.compiledSql ?? "").length).toBeGreaterThan(0);
    expect(Number.isFinite(debug.meta.executionTimeMs)).toBe(true);
  });

  it("supplying startAfter and startAt together is rejected", async () => {
    const { engine } = createFixture();
    await expect(
      engine.executeQuery({
        ...TENANT,
        querySpec: {
          collection: "users",
          startAfter: "a",
          startAt: "b",
        } as never,
      })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
