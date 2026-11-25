import { describe, expect, it } from "vitest";
import { createInMemoryBillingRepository } from "@vellum/database-control";
import { UsageMeteringEngine } from "../index.js";

const ORG = "00000000-0000-0000-0000-000000000001";
const PROJECT = "00000000-0000-0000-0000-000000000002";

describe("metering flush ledger lock", () => {
  it("appends flush ledger entries only while holding the cross-instance lock", async () => {
    const repo = createInMemoryBillingRepository();
    const events: string[] = [];
    let held = false;
    const origAppend = repo.appendLedgerEntry.bind(repo);
    repo.appendLedgerEntry = async (input) => {
      events.push(held ? "append-locked" : "append-unlocked");
      return origAppend(input);
    };
    repo.withLedgerLock = async (fn) => {
      held = true;
      events.push("lock");
      try {
        return await fn();
      } finally {
        events.push("unlock");
        held = false;
      }
    };
    const engine = new UsageMeteringEngine({ billing: repo, chainKey: Buffer.alloc(32, 7) });
    engine.recordWrites(ORG, PROJECT, 2, 100);
    await engine.flush();
    expect(events[0]).toBe("lock");
    expect(events).toContain("append-locked");
    expect(events).not.toContain("append-unlocked");
    expect(events[events.length - 1]).toBe("unlock");
  });

  it("two instances flushing concurrently keep one linear hash chain", async () => {
    const repo = createInMemoryBillingRepository();
    let tail: Promise<unknown> = Promise.resolve();
    repo.withLedgerLock = (fn) => {
      const run = tail.then(fn, fn);
      tail = run.catch(() => undefined);
      return run as never;
    };
    const key = Buffer.alloc(32, 7);
    const a = new UsageMeteringEngine({ billing: repo, chainKey: key });
    const b = new UsageMeteringEngine({ billing: repo, chainKey: key });
    for (let i = 0; i < 3; i++) {
      a.recordWrites(ORG, PROJECT, 1, 1);
      b.recordWrites(ORG, PROJECT, 1, 1);
      await Promise.all([a.flush(), b.flush()]);
    }
    const ledger = await repo.listLedger();
    for (let i = 1; i < ledger.length; i++) {
      expect(ledger[i]!.prevHash).toBe(ledger[i - 1]!.entryHash);
    }
  });
});
