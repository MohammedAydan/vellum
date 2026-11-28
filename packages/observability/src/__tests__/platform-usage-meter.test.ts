import { describe, it, expect, vi } from "vitest";
import { PlatformUsageMeter, PLATFORM_SCOPE, type PlatformUsageBucket } from "../platform-usage-meter.js";

const MINUTE = 60_000;

function fixedClock(start = Date.UTC(2026, 10, 28, 12, 0, 0)) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("PlatformUsageMeter", () => {
  it("adds counters into one minute bucket per project", () => {
    const clock = fixedClock();
    const meter = new PlatformUsageMeter({ now: clock.now });
    meter.record("project-a", "requests_read", 2);
    meter.record("project-a", "requests_read", 3);
    meter.record("project-a", "cpu_ms", 120);
    meter.record("project-b", "bytes_out", 2048);

    const snapshot = meter.snapshot();
    expect(snapshot).toHaveLength(2);
    const a = snapshot.find((bucket) => bucket.projectId === "project-a");
    expect(a?.counts.requests_read).toBe(5);
    expect(a?.counts.cpu_ms).toBe(120);
    const b = snapshot.find((bucket) => bucket.projectId === "project-b");
    expect(b?.counts.bytes_out).toBe(2048);
  });

  it("keeps separate buckets per minute and sorts them oldest first", () => {
    const clock = fixedClock();
    const meter = new PlatformUsageMeter({ now: clock.now });
    meter.record("project-a", "requests_read", 1);
    clock.advance(MINUTE);
    meter.record("project-a", "requests_read", 1);

    const snapshot = meter.snapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]!.bucketStartMs).toBeLessThan(snapshot[1]!.bucketStartMs);
  });

  it("falls back to the platform scope for a missing or oversized project id", () => {
    const meter = new PlatformUsageMeter({ now: fixedClock().now });
    meter.record("", "requests_read", 1);
    meter.record("x".repeat(200), "requests_read", 1);
    const scopes = meter.snapshot().map((bucket) => bucket.projectId);
    expect(scopes).toEqual([PLATFORM_SCOPE]);
    expect(meter.snapshot()[0]!.counts.requests_read).toBe(2);
  });

  it("drops non-finite, negative and unknown metrics without throwing", () => {
    const meter = new PlatformUsageMeter({ now: fixedClock().now });
    meter.record("project-a", "cpu_ms", Number.NaN);
    meter.record("project-a", "cpu_ms", -5);
    meter.record("project-a", "cpu_ms", Number.POSITIVE_INFINITY);
    // @ts-expect-error unknown metric is rejected at runtime
    meter.record("project-a", "not_a_metric", 1);
    expect(meter.size).toBe(0);
  });

  it("hands the batch to the flush handler once and clears the meter", async () => {
    const clock = fixedClock();
    const batches: PlatformUsageBucket[][] = [];
    const meter = new PlatformUsageMeter({
      now: clock.now,
      onFlush: (buckets) => {
        batches.push(buckets);
      },
    });
    meter.record("project-a", "requests_write", 4);

    await expect(meter.flush()).resolves.toBe(1);
    expect(meter.size).toBe(0);
    expect(batches).toHaveLength(1);
    expect(batches[0]![0]!.counts.requests_write).toBe(4);
    // Nothing pending: a second flush is a no-op.
    await expect(meter.flush()).resolves.toBe(0);
  });

  it("keeps the batch for the next cycle when the flush fails", async () => {
    const meter = new PlatformUsageMeter({
      now: fixedClock().now,
      onFlush: () => {
        throw new Error("database unavailable");
      },
    });
    meter.record("project-a", "bytes_in", 512);
    await expect(meter.flush()).resolves.toBe(0);
    expect(meter.size).toBe(1);
    expect(meter.snapshot()[0]!.counts.bytes_in).toBe(512);
  });

  it("evicts the oldest bucket instead of growing without bound", () => {
    const clock = fixedClock();
    const meter = new PlatformUsageMeter({ now: clock.now, maxBuckets: 2 });
    meter.record("project-a", "requests_read", 1);
    clock.advance(MINUTE);
    meter.record("project-b", "requests_read", 1);
    clock.advance(MINUTE);
    meter.record("project-c", "requests_read", 1);
    expect(meter.size).toBe(2);
    const projects = meter.snapshot().map((bucket) => bucket.projectId);
    expect(projects).toEqual(["project-b", "project-c"]);
  });

  it("flushes pending buckets on stop", async () => {
    const flushed = vi.fn();
    const meter = new PlatformUsageMeter({ now: fixedClock().now, onFlush: flushed });
    meter.start(1_000);
    meter.record("project-a", "requests_read", 1);
    await meter.stop();
    expect(flushed).toHaveBeenCalledTimes(1);
  });
});
