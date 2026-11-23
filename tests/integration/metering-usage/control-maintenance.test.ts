/**
 * control-plane maintenance worker cadence + shutdown flush.
 * Uses fake timers so the 5s/30s schedule is exercised deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushOnShutdown,
  isControlMaintenanceRunning,
  startControlMaintenance,
  stopControlMaintenance,
  type ControlMaintenanceStore,
} from "../../../apps/api/src/workers/control-maintenance.js";

function fakeStore() {
  return {
    flush: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    refresh: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } satisfies ControlMaintenanceStore;
}

describe("control maintenance worker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stopControlMaintenance();
  });

  afterEach(() => {
    stopControlMaintenance();
    vi.useRealTimers();
  });

  it("flushes every 5 seconds and refreshes the mirror every 30 seconds", async () => {
    const store = fakeStore();
    startControlMaintenance(store);
    expect(isControlMaintenanceRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(store.flush).not.toHaveBeenCalled();
    expect(store.refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(store.flush).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(store.flush).toHaveBeenCalledTimes(6);
    expect(store.refresh).toHaveBeenCalledTimes(1);
  });

  it("stopControlMaintenance cancels both schedules", async () => {
    const store = fakeStore();
    startControlMaintenance(store);
    stopControlMaintenance();
    expect(isControlMaintenanceRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.flush).not.toHaveBeenCalled();
    expect(store.refresh).not.toHaveBeenCalled();
  });

  it("flushOnShutdown flushes pending usage from the active store", async () => {
    const store = fakeStore();
    startControlMaintenance(store);
    await flushOnShutdown();
    expect(store.flush).toHaveBeenCalledTimes(1);
  });

  it("flushOnShutdown accepts an explicit store after the timers stopped", async () => {
    const store = fakeStore();
    stopControlMaintenance();
    await flushOnShutdown(store);
    expect(store.flush).toHaveBeenCalledTimes(1);
  });

  it("a rejected flush/refresh never escapes the interval callback", async () => {
    const store: ControlMaintenanceStore = {
      flush: vi.fn<() => Promise<void>>().mockRejectedValue(new Error("flush boom")),
      refresh: vi.fn<() => Promise<void>>().mockRejectedValue(new Error("refresh boom")),
    };
    const errors: Array<{ phase: string; message: string }> = [];
    startControlMaintenance(store, {
      onError: (phase, error) => {
        errors.push({ phase, message: error instanceof Error ? error.message : String(error) });
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(errors.some((e) => e.phase === "flush" && e.message === "flush boom")).toBe(true);
    expect(errors.some((e) => e.phase === "refresh" && e.message === "refresh boom")).toBe(true);
  });
});
