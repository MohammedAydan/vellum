import { afterEach, describe, expect, it, vi } from "vitest";
import { sleepWithSignal } from "../core/backoff.js";

describe("retry sleeps keep a Node process alive", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not unref the backoff timer", async () => {
    const unref = vi.fn();
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const t = real(fn, ms);
      (t as unknown as { unref: () => void }).unref = unref;
      return t;
    }) as never);
    await sleepWithSignal(5);
    expect(unref).not.toHaveBeenCalled();
  });
});
