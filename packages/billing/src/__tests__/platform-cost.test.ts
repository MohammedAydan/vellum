import { describe, it, expect } from "vitest";
import {
  DEFAULT_PLATFORM_PRICE_BOOK,
  priceUsage,
  quantitiesFromCounters,
  usdFromMicros,
  type PriceBookEntry,
} from "../platform-cost.js";

const priceBook: PriceBookEntry[] = [
  { provider: "vercel", sku: "cdn_requests", unit: "request", unitSize: 1_000_000, priceMicros: 2_000_000, includedUnits: 10_000_000 },
  { provider: "vercel", sku: "fast_data_transfer", unit: "byte", unitSize: 1_000_000_000, priceMicros: 150_000, includedUnits: 1_000_000_000 },
  { provider: "vercel", sku: "fluid_active_cpu", unit: "cpu_ms", unitSize: 3_600_000, priceMicros: 128_000, includedUnits: 14_400_000 },
];

describe("priceUsage", () => {
  it("charges nothing while usage stays inside the included allowance", () => {
    const result = priceUsage({ cdn_requests: 9_500_000 }, priceBook);
    expect(result.totalMicros).toBe(0);
    expect(result.lines[0]).toMatchObject({ sku: "cdn_requests", billableQuantity: 0, costMicros: 0 });
  });

  it("charges whole per-million blocks with ceiling division", () => {
    // One request past the allowance still bills one $2 block.
    const result = priceUsage({ cdn_requests: 10_000_001 }, priceBook);
    expect(result.lines[0]!.costMicros).toBe(2_000_000);
    // A full extra block plus one request bills two blocks.
    expect(priceUsage({ cdn_requests: 11_000_001 }, priceBook).lines[0]!.costMicros).toBe(4_000_000);
  });

  it("prices gigabytes from raw bytes", () => {
    const twoGbOver = 3_000_000_000;
    const result = priceUsage({ fast_data_transfer: twoGbOver }, priceBook);
    // 3 GB total, 1 GB included, so 2 GB bill at $0.15.
    expect(result.lines[0]!.billableQuantity).toBe(2_000_000_000);
    expect(result.lines[0]!.costMicros).toBe(300_000);
  });

  it("prices CPU hours from milliseconds", () => {
    // 4 hours included; 5 hours of CPU bills one hour at $0.128.
    const fiveHoursMs = 5 * 3_600_000;
    const result = priceUsage({ fluid_active_cpu: fiveHoursMs }, priceBook);
    expect(result.lines[0]!.costMicros).toBe(128_000);
  });

  it("reports SKUs that have usage but no price instead of hiding them", () => {
    const result = priceUsage({ neon_compute: 12 }, priceBook);
    expect(result.unpricedSkus).toEqual(["neon_compute"]);
    expect(result.totalMicros).toBe(0);
  });

  it("ignores zero, negative and non-finite quantities", () => {
    const result = priceUsage({ cdn_requests: 0, fast_data_transfer: -10, fluid_active_cpu: Number.NaN }, priceBook);
    expect(result.lines).toEqual([]);
    expect(result.totalMicros).toBe(0);
  });

  it("sums every line into the total and sorts by cost", () => {
    const result = priceUsage({ cdn_requests: 20_000_000, fast_data_transfer: 2_000_000_000 }, priceBook);
    // 10M extra requests = $20, 1 GB extra transfer = $0.15.
    expect(result.totalMicros).toBe(20_000_000 + 150_000);
    expect(result.lines.map((line) => line.sku)).toEqual(["cdn_requests", "fast_data_transfer"]);
  });
});

describe("quantitiesFromCounters", () => {
  it("maps request classes, CPU and egress onto price-book SKUs", () => {
    const { quantities, basis } = quantitiesFromCounters({
      requestsRead: 10,
      requestsWrite: 5,
      requestsOther: 1,
      cpuMs: 900,
      bytesIn: 1_000,
      bytesOut: 4_000,
      realtimeFrames: 3,
    });
    expect(quantities).toMatchObject({
      cdn_requests: 16,
      function_invocations: 16,
      fluid_active_cpu: 900,
      fast_data_transfer: 4_000,
    });
    expect(basis["cdn_requests"]).toBe("meter");
    expect(quantities["neon_storage"]).toBeUndefined();
  });

  it("labels storage as an estimate when it is supplied", () => {
    const { quantities, basis } = quantitiesFromCounters({
      requestsRead: 0,
      requestsWrite: 0,
      requestsOther: 0,
      cpuMs: 0,
      bytesIn: 0,
      bytesOut: 0,
      realtimeFrames: 0,
      storageBytes: 5_000_000_000,
    });
    expect(quantities["neon_storage"]).toBe(5_000_000_000);
    expect(basis["neon_storage"]).toBe("estimate");
  });
});

describe("usdFromMicros", () => {
  it("formats micro-USD without floating point", () => {
    expect(usdFromMicros(0)).toBe("0.00");
    expect(usdFromMicros(20_000_000)).toBe("20.00");
    expect(usdFromMicros(20_150_000)).toBe("20.15");
    expect(usdFromMicros(10_600)).toBe("0.0106");
    expect(usdFromMicros(-5)).toBe("0.00");
  });
});

describe("DEFAULT_PLATFORM_PRICE_BOOK", () => {
  it("carries every SKU the cost model asks for, with the vendor page as its source", () => {
    const skus = DEFAULT_PLATFORM_PRICE_BOOK.map((entry) => entry.sku);
    for (const sku of ["pro_seat", "cdn_requests", "fast_data_transfer", "function_invocations", "fluid_active_cpu", "neon_compute", "neon_storage"]) {
      expect(skus).toContain(sku);
    }
    expect(DEFAULT_PLATFORM_PRICE_BOOK.every((entry) => entry.unitSize > 0)).toBe(true);
  });
});
