/**
 * Fast deterministic unit coverage of OCC transforms
 * - prototype-pollution keys are rejected at every merge level
 * - normal nested merges / atomic transforms still work
 * - OCC lifecycle on the in-memory adapter (begin -> read -> commit / conflict)
 */
import { describe, expect, it } from "vitest";
import { VellumError } from "@vellum/core";
import { DataPlaneStore } from "@vellum/storage/adapters";
import { applyFieldTransforms, DocumentEngine } from "@vellum/document-engine";
import type { ControlStoreLike } from "@vellum/document-engine";

const TS = "2026-11-16T12:00:00.000Z";
// Internal system caller: the fail-closed DocumentEngine requires either an
// apiKeyRecord or `internal: true` (see docs/ENGINE-HARDENING-CONTRACT.md §2B).
const tenant = { projectId: "11111111-1111-1111-1111-111111111111", internal: true as const };

const controlStore: ControlStoreLike = {
  getActiveRuleset: () => null,
  incrementUsage: () => undefined,
};

function makeEngine(): DocumentEngine {
  return new DocumentEngine({ controlStore, dataStore: new DataPlaneStore(), txSecret: "unit_tx_secret" });
}

describe("- dangerous field keys are rejected in transforms and merge paths", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    it(`rejects '${key}' at the top level of a patch`, () => {
      const patch = JSON.parse(`{"${key}":{"polluted":true}}`) as Record<string, unknown>;
      try {
        applyFieldTransforms({}, patch, TS);
        throw new Error("expected rejection");
      } catch (err) {
        expect(err).toBeInstanceOf(VellumError);
        expect((err as VellumError).code).toBe("INVALID_FIELD_NAME");
      }
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
      expect(Object.prototype).not.toHaveProperty("polluted");
    });

    it(`rejects '${key}' in a nested merge path`, () => {
      const patch = JSON.parse(`{"profile":{"${key}":{"polluted":true}}}`) as Record<string, unknown>;
      expect(() => applyFieldTransforms({ profile: { safe: 1 } }, patch, TS)).toThrowError(VellumError);
      expect(Object.prototype).not.toHaveProperty("polluted");
    });
  }

  it("preserves normal deep merges and atomic transforms", () => {
    const merged = applyFieldTransforms(
      { profile: { name: "old", tags: ["a"] }, counter: 1, tags: ["a"] },
      {
        profile: { name: "new" },
        counter: { $op: "inc", by: 4 },
        tags: { $op: "arrayUnion", elements: ["b"] },
        stamped: { $op: "serverTimestamp" },
      },
      TS
    );
    expect(merged["profile"]).toEqual({ name: "new", tags: ["a"] });
    expect(merged["counter"]).toBe(5);
    expect(merged["tags"]).toEqual(["a", "b"]);
    expect(merged["stamped"]).toEqual({ $t: "ts", $v: TS, $ms: Date.parse(TS) });
  });
});

describe("OCC lifecycle on the in-memory adapter", () => {
  it("begins, records a read and commits a non-conflicting write", async () => {
    const engine = makeEngine();
    await engine.createDocument({ ...tenant, path: "accounts/a", data: { balance: 10 } });

    const begun = await engine.beginTransaction(tenant);
    expect(begun.transactionToken).toBeDefined();
    expect(Date.parse(begun.expiresAt) - Date.now()).toBeLessThanOrEqual(15000);

    const read = await engine.getDocument({
      ...tenant,
      path: "accounts/a",
      transactionToken: begun.transactionToken,
    });
    expect(read.version).toBe(1);

    const result = await engine.commitTransaction({
      ...tenant,
      transactionToken: begun.transactionToken,
      writes: [{ type: "set", path: "accounts/a", data: { balance: 20 } }],
    });
    expect((result.results[0] as { version: number }).version).toBe(2);
  });

  it("aborts with ABORTED_CONFLICT when the observed version changes", async () => {
    const engine = makeEngine();
    await engine.createDocument({ ...tenant, path: "accounts/b", data: { balance: 10 } });

    const begun = await engine.beginTransaction(tenant);
    await engine.getDocument({ ...tenant, path: "accounts/b", transactionToken: begun.transactionToken });
    await engine.updateDocument({ ...tenant, path: "accounts/b", data: { balance: 99 } });

    const err = await engine
      .commitTransaction({
        ...tenant,
        transactionToken: begun.transactionToken,
        writes: [{ type: "set", path: "accounts/b", data: { balance: 5 } }],
      })
      .then(
        () => null,
        (e: unknown) => e as VellumError
      );
    expect(err).toBeInstanceOf(VellumError);
    expect(err?.code).toBe("ABORTED_CONFLICT");
    expect(err?.details["expectedVersion"]).toBe(1);
    expect(err?.details["actualVersion"]).toBe(2);
  });

  it("rejects a tampered transaction token", async () => {
    const engine = makeEngine();
    const begun = await engine.beginTransaction(tenant);
    const payload = JSON.parse(Buffer.from(begun.transactionToken, "base64url").toString("utf8")) as Record<string, unknown>;
    payload["projectId"] = "33333333-3333-3333-3333-333333333333";
    const tampered = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

    const err = await engine
      .commitTransaction({
        ...tenant,
        transactionToken: tampered,
        writes: [{ type: "set", path: "accounts/c", data: { x: 1 } }],
      })
      .then(
        () => null,
        (e: unknown) => e as VellumError
      );
    expect(err?.code).toBe("INVALID_ARGUMENT");
  });
});
