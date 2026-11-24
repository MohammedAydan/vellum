import { describe, expect, it } from "vitest";
import { MemoryThrottleRepository } from "../throttle-repository.js";

describe("MemoryThrottleRepository", () => {
  it("reserves up to max slots inside the window, then refuses", async () => {
    const t = new MemoryThrottleRepository();
    for (let i = 0; i < 3; i += 1) {
      const slot = await t.acquireThrottleSlot("login", "id-1", 60_000, 3);
      expect(slot.acquired).toBe(true);
      expect(slot.countBefore).toBe(i);
    }
    const blocked = await t.acquireThrottleSlot("login", "id-1", 60_000, 3);
    expect(blocked.acquired).toBe(false);
    expect(blocked.eventId).toBeNull();
    expect(blocked.countBefore).toBe(3);
  });

  it("keeps scopes and subjects isolated", async () => {
    const t = new MemoryThrottleRepository();
    await t.acquireThrottleSlot("login", "id-1", 60_000, 1);
    expect((await t.acquireThrottleSlot("login", "id-2", 60_000, 1)).acquired).toBe(true);
    expect((await t.acquireThrottleSlot("signup", "id-1", 60_000, 1)).acquired).toBe(true);
  });

  it("a released slot frees capacity again", async () => {
    const t = new MemoryThrottleRepository();
    const first = await t.acquireThrottleSlot("login", "id-1", 60_000, 1);
    expect(first.acquired).toBe(true);
    expect((await t.acquireThrottleSlot("login", "id-1", 60_000, 1)).acquired).toBe(false);
    await t.releaseThrottleSlot(first.eventId!);
    expect((await t.acquireThrottleSlot("login", "id-1", 60_000, 1)).acquired).toBe(true);
  });

  it("expires slots after the window", async () => {
    const t = new MemoryThrottleRepository();
    await t.acquireThrottleSlot("login", "id-1", 30, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await t.acquireThrottleSlot("login", "id-1", 30, 1)).acquired).toBe(true);
  });

  it("counts failures with a cap and reports the live count", async () => {
    const t = new MemoryThrottleRepository();
    for (let i = 1; i <= 5; i += 1) {
      expect(await t.incrementFailureCounter("mfa", "subj", 60_000, 5)).toBe(i);
    }
    // Capped at max: the lockout signal persists until the TTL expires.
    expect(await t.incrementFailureCounter("mfa", "subj", 60_000, 5)).toBe(5);
    expect(await t.getFailureCounter("mfa", "subj")).toBe(5);
  });

  it("resets the failure count after the TTL expires", async () => {
    const t = new MemoryThrottleRepository();
    expect(await t.incrementFailureCounter("mfa", "subj", 30, 5)).toBe(1);
    expect(await t.incrementFailureCounter("mfa", "subj", 30, 5)).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await t.getFailureCounter("mfa", "subj")).toBe(0);
    expect(await t.incrementFailureCounter("mfa", "subj", 30, 5)).toBe(1);
  });

  it("clears a failure counter", async () => {
    const t = new MemoryThrottleRepository();
    await t.incrementFailureCounter("mfa", "subj", 60_000, 5);
    await t.incrementFailureCounter("mfa", "subj", 60_000, 5);
    await t.clearFailureCounter("mfa", "subj");
    expect(await t.getFailureCounter("mfa", "subj")).toBe(0);
    expect(await t.incrementFailureCounter("mfa", "subj", 60_000, 5)).toBe(1);
  });

  it("prunes expired state and clearAll resets everything", async () => {
    const t = new MemoryThrottleRepository();
    await t.acquireThrottleSlot("login", "id-1", 30, 1);
    await t.incrementFailureCounter("mfa", "subj", 30, 5);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await t.pruneExpiredThrottleState(10);
    expect(await t.getFailureCounter("mfa", "subj")).toBe(0);

    await t.acquireThrottleSlot("login", "id-1", 60_000, 1);
    t.clearAll();
    expect((await t.acquireThrottleSlot("login", "id-1", 60_000, 1)).acquired).toBe(true);
  });

  it("reservations made concurrently are all counted", async () => {
    const t = new MemoryThrottleRepository();
    const slots = await Promise.all(
      Array.from({ length: 10 }, () => t.acquireThrottleSlot("login", "id-1", 60_000, 3))
    );
    expect(slots.filter((s) => s.acquired)).toHaveLength(3);
    expect(slots.filter((s) => !s.acquired)).toHaveLength(7);
  });
});
