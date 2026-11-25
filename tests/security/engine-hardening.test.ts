/**
 * ENGINE-HARDENING — cross-cutting security regression suite.
 *
 * Exercises the hardened `DocumentEngine` directly (no HTTP) so the checks are
 * deterministic and do not need a live control/data plane.
 */
import { describe, it, expect } from "vitest";
import { VellumError } from "@vellum/core";
import {
  createFixture,
  OTHER_TENANT,
  publicKey,
  serverKey,
  TENANT,
} from "../../packages/document-engine/src/__tests__/_harness.js";

const NO_KEY = { projectId: TENANT.projectId };

describe("engine-hardening / security — fail-closed at every public entry point", () => {
  it("all public mutation/read entry points reject a missing API key", async () => {
    const { engine } = createFixture();
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["getDocument", () => engine.getDocument({ ...NO_KEY, path: "users/u1" })],
      ["createDocument", () => engine.createDocument({ ...NO_KEY, path: "users/u1", data: {} })],
      ["setDocument", () => engine.setDocument({ ...NO_KEY, path: "users/u1", data: {} })],
      ["updateDocument", () => engine.updateDocument({ ...NO_KEY, path: "users/u1", data: {} })],
      ["deleteDocument", () => engine.deleteDocument({ ...NO_KEY, path: "users/u1" })],
      ["batchWrite", () => engine.batchWrite({ ...NO_KEY, writes: [{ type: "create", path: "users/u1", data: {} }] })],
      ["executeQuery", () => engine.executeQuery({ ...NO_KEY, querySpec: { collection: "users" } })],
      ["aggregateDocuments", () => engine.aggregateDocuments({ ...NO_KEY, request: { collectionPath: "users", metrics: { c: { op: "count" } } } })],
      ["deleteWhere", () => engine.deleteWhere({ ...NO_KEY, collectionPath: "users" })],
      ["getDocuments", () => engine.getDocuments({ ...NO_KEY, paths: ["users/u1"] })],
      ["exportCollectionDocuments", () => engine.exportCollectionDocuments(NO_KEY, "users")],
    ];
    const notFailClosed: string[] = [];
    for (const [name, call] of calls) {
      let rejected = false;
      try {
        await call();
      } catch (error) {
        rejected = (error as { code?: string }).code === "UNAUTHENTICATED";
      }
      if (!rejected) notFailClosed.push(name);
    }
    expect(notFailClosed).toEqual([]);
  });

  it("a bypassRules flag smuggled through ctx is rejected without internal", async () => {
    const { engine } = createFixture();
    const smuggled = { ...NO_KEY, path: "users/u1", bypassRules: true };
    await expect(engine.getDocument(smuggled)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

describe("engine-hardening / security — tenant isolation", () => {
  it("a document in tenant A is invisible to tenant B on read/query/delete", async () => {
    const { engine } = createFixture();
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { secret: "A-only" } });

    // OTHER_TENANT is an internal test caller, so it is authenticated but the
    // row lives in a different tenant and must be invisible.
    await expect(
      engine.getDocument({ ...OTHER_TENANT, path: "users/u1" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // With an explicit key for tenant B, the row is simply not found.
    const keyB = { ...serverKey("sk_b"), projectId: OTHER_TENANT.projectId };
    await expect(
      engine.getDocument({ ...OTHER_TENANT, apiKeyRecord: keyB, path: "users/u1" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      engine.deleteDocument({ ...OTHER_TENANT, apiKeyRecord: keyB, path: "users/u1" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const result = await engine.executeQuery({
      ...OTHER_TENANT,
      apiKeyRecord: keyB,
      querySpec: { collection: "users" },
    });
    expect(result.documents).toHaveLength(0);
  });
});

describe("engine-hardening / security — cursor tampering & AST bypass", () => {
  it("a tampered cursor is rejected instead of silently skipping rows", async () => {
    const { engine } = createFixture();
    for (let i = 0; i < 8; i += 1) {
      await engine.createDocument({ ...TENANT, path: `users/u${i}`, data: { n: i } });
    }
    const first = await engine.executeQuery({
      ...TENANT,
      querySpec: { collection: "users", orderBy: [{ field: "documentId", dir: "asc" }], limit: 2 },
    });
    expect(first.nextCursor).toBeTruthy();
    const tampered = `${first.nextCursor?.slice(0, -2)}XX`;
    await expect(
      engine.executeQuery({
        ...TENANT,
        querySpec: { collection: "users", orderBy: [{ field: "documentId", dir: "asc" }], limit: 2, startAfter: tampered },
      })
    ).rejects.toThrow(VellumError);
  });

  it("bypassRules inside a querySpec cannot disable Security Rules", async () => {
    const ruleset = {
      rulesAst: { version: 1, rules: [{ match: "users/{uid}", allow: { list: false } }] },
    };
    const { engine } = createFixture({ ruleset });
    await engine.createDocument({ ...TENANT, path: "users/u1", data: { n: 1 } });
    await expect(
      engine.executeQuery({
        ...TENANT,
        apiKeyRecord: publicKey(),
        querySpec: { collection: "users", bypassRules: true } as never,
      })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" }); // unknown keys are rejected before rules, bypassRules is never honoured
  });
});

describe("engine-hardening / security — secret hygiene", () => {
  it("error details never echo raw expiry strings or API keys", async () => {
    const { engine } = createFixture();
    const secret = "super-secret-key-material";
    let thrown: unknown;
    try {
      await engine.createDocument({
        ...TENANT,
        apiKeyRecord: { ...serverKey("sk_hygiene"), secretHash: secret },
        path: "sessions/s1",
        data: {},
        expiresAt: "definitely-not-a-date-" + secret,
      });
    } catch (error) {
      thrown = error;
    }
    const asError = thrown as { code?: string; details?: Record<string, unknown> };
    expect(asError.code).toBe("INVALID_ARGUMENT");
    expect(JSON.stringify(asError.details ?? {})).not.toContain(secret);
  });
});
