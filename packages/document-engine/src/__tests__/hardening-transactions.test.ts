/**
 * ENGINE-HARDENING §13 — durable OCC ledger cleanup, terminal states, token binding.
 *
 * All clock-sensitive cases use vitest fake timers: no real waiting.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { DataPlaneStore } from "@vellum/storage/adapters";
import {
  decodeAndVerifyTransactionToken,
  runExpiredTransactionCleanup,
  transactionTokenHash,
} from "../transactions.js";
import { createFixture, OTHER_TENANT, serverKey, TENANT } from "./_harness.js";

const T0 = Date.parse("2030-06-01T00:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
});

function installClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
}

describe("hardening/transactions — cleanupExpired", () => {
  it("honours the batch limit and drains only this tenant's expired rows", async () => {
    installClock();
    const { engine } = createFixture();
    for (let i = 0; i < 3; i += 1) {
      await engine.beginTransaction(TENANT);
    }
    await engine.beginTransaction(OTHER_TENANT);
    vi.setSystemTime(T0 + 16_000); // > MAX_TRANSACTION_DURATION_MS (15s)

    expect(await engine.transactions.cleanupExpired(TENANT, 2)).toBe(2);
    expect(await engine.transactions.cleanupExpired(TENANT, 2)).toBe(1);
    expect(await engine.transactions.cleanupExpired(TENANT, 2)).toBe(0);
    // The other tenant's active row is untouched by a tenant-scoped cleanup.
    expect(await engine.transactions.cleanupExpired(OTHER_TENANT, 10)).toBe(1);
  });

  it("purges terminal rows older than 7 days but keeps young ones", async () => {
    installClock();
    const { engine } = createFixture();
    const committed = await engine.beginTransaction(TENANT);
    await engine.commitTransaction({
      ...TENANT,
      transactionToken: committed.transactionToken,
      writes: [{ type: "create", path: "ledger/one", data: { n: 1 } }],
    });
    const rolled = await engine.beginTransaction(TENANT);
    await engine.rollbackTransaction({ ...TENANT, transactionToken: rolled.transactionToken });

    vi.setSystemTime(T0 + 8 * 24 * 60 * 60 * 1000);
    // Created AFTER the jump, so this active row is neither expired nor a
    // 7-day-old terminal row and must survive the sweep.
    const young = await engine.beginTransaction(TENANT);
    expect(await engine.transactions.cleanupExpired(TENANT, 1000)).toBe(2);
    expect(await engine.transactions.cleanupExpired(TENANT, 1000)).toBe(0);

    vi.setSystemTime(T0 + 8 * 24 * 60 * 60 * 1000 + 16_000);
    expect(await engine.transactions.cleanupExpired(TENANT, 1000)).toBe(1);
    expect(young.transactionToken).toBeTruthy();
  });

  it("runExpiredTransactionCleanup drains in bounded batches", async () => {
    installClock();
    const query = vi
      .fn<(sql: string, params?: unknown[]) => Promise<{ rowCount: number }>>()
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 0 });
    const client = { query };
    expect(await runExpiredTransactionCleanup(client, 1000)).toBe(4);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]?.[0]).toContain("DELETE FROM transactions");
  });
});

describe("hardening/transactions — distinct terminal error codes", () => {
  it("ALREADY_COMMITTED for a second commit/rollback of a committed token", async () => {
    const { engine } = createFixture();
    const tx = await engine.beginTransaction(TENANT);
    await engine.commitTransaction({
      ...TENANT,
      transactionToken: tx.transactionToken,
      writes: [{ type: "create", path: "ledger/a", data: {} }],
    });
    await expect(
      engine.commitTransaction({
        ...TENANT,
        transactionToken: tx.transactionToken,
        writes: [{ type: "create", path: "ledger/b", data: {} }],
      })
    ).rejects.toMatchObject({ code: "ALREADY_COMMITTED" });
    await expect(
      engine.rollbackTransaction({ ...TENANT, transactionToken: tx.transactionToken })
    ).rejects.toMatchObject({ code: "ALREADY_COMMITTED" });
  });

  it("ALREADY_ROLLED_BACK for a second rollback/use of a rolled-back token", async () => {
    const { engine } = createFixture();
    const tx = await engine.beginTransaction(TENANT);
    await engine.rollbackTransaction({ ...TENANT, transactionToken: tx.transactionToken });
    await expect(
      engine.rollbackTransaction({ ...TENANT, transactionToken: tx.transactionToken })
    ).rejects.toMatchObject({ code: "ALREADY_ROLLED_BACK" });
    await expect(
      engine.commitTransaction({
        ...TENANT,
        transactionToken: tx.transactionToken,
        writes: [{ type: "create", path: "ledger/c", data: {} }],
      })
    ).rejects.toMatchObject({ code: "ALREADY_ROLLED_BACK" });
  });

  it("NOT_FOUND for a token whose row was purged", async () => {
    installClock();
    const { engine } = createFixture();
    const tx = await engine.beginTransaction(TENANT);
    vi.setSystemTime(T0 + 16_000);
    await engine.transactions.cleanupExpired(TENANT, 100);
    await expect(
      engine.rollbackTransaction({ ...TENANT, transactionToken: tx.transactionToken })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("hardening/transactions — token binding", () => {
  it("rejects a token used from a different tenant", async () => {
    const { engine } = createFixture();
    const tx = await engine.beginTransaction(TENANT);
    await expect(
      engine.getDocument({ ...OTHER_TENANT, path: "users/u1", transactionToken: tx.transactionToken })
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("rejects a token bound to a different apiKeyId", async () => {
    const { engine } = createFixture();
    const tx = await engine.beginTransaction({ ...TENANT, apiKeyRecord: serverKey("keyA") });
    await expect(
      engine.getDocument({
        ...TENANT,
        apiKeyRecord: serverKey("keyB"),
        path: "users/u1",
        transactionToken: tx.transactionToken,
      })
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("accepts a token signed with txSecretPrev during rotation, rejects unknown secrets", async () => {
    const store = new DataPlaneStore();
    const control = { getActiveRuleset: () => null, incrementUsage: () => undefined };
    const oldEngine = createFixture({ dataStore: store, txSecret: "old_secret" }).engine;
    const newEngine = createFixture({
      dataStore: store,
      txSecret: "new_secret",
      txSecretPrev: "old_secret",
    }).engine;
    void control;

    const tx = await oldEngine.beginTransaction(TENANT);
    // Verification succeeds under the rotated engine (prev secret accepted).
    await newEngine.getDocument({
      ...TENANT,
      path: "users/u1",
      transactionToken: tx.transactionToken,
    }).catch((e: unknown) => {
      // NOT_FOUND is the expected outcome here (the document does not exist);
      // an INVALID_ARGUMENT would mean the signature check failed.
      expect((e as { code: string }).code).toBe("NOT_FOUND");
    });

    expect(
      decodeAndVerifyTransactionToken(tx.transactionToken, "new_secret", TENANT, "old_secret").txId
    ).toBe(tx.transactionId);
    expect(() => decodeAndVerifyTransactionToken(tx.transactionToken, "unknown_secret", TENANT)).toThrow();
    expect(transactionTokenHash(tx.transactionToken)).toMatch(/^[a-f0-9]{64}$/);
  });
});
