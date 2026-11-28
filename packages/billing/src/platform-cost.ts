/**
 * `@vellum/billing/src/platform-cost.ts`
 *
 * Prices metered platform usage against a versioned price book. This is the
 * platform's own operating cost (Vercel + Neon), deliberately separate from the
 * customer plan quotas in `billing-calculator.ts`: the plan table is what a
 * customer is charged, this is what running the platform actually costs.
 *
 * All money is integer micro-USD (1 USD = 1_000_000 micros). Every division is
 * ceiling division on integers, so a cost is never silently rounded down and no
 * floating point ever touches a money value.
 */

export interface PriceBookEntry {
  provider: string;
  sku: string;
  /** Unit the quantity is counted in, e.g. `request`, `gb`, `cpu_hour`. */
  unit: string;
  /** How many raw units one priced block holds, e.g. 1_000_000 for per-million pricing. */
  unitSize: number;
  /** Price of one block, in micro-USD. */
  priceMicros: number;
  /** Units included before the price applies, in raw units. */
  includedUnits: number;
}

export interface CostLine {
  provider: string;
  sku: string;
  unit: string;
  /** Raw units consumed. */
  quantity: number;
  /** Raw units after the included allowance. */
  billableQuantity: number;
  unitSize: number;
  priceMicros: number;
  costMicros: number;
}

export interface PlatformCostResult {
  lines: CostLine[];
  totalMicros: number;
  /** SKUs that had a quantity but no price book entry, so the total is incomplete. */
  unpricedSkus: string[];
}

function safeQuantity(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.trunc(value);
}

/** Ceiling division for non-negative integers. */
function ceilDiv(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.floor((numerator + denominator - 1) / denominator);
}

/**
 * Price each SKU's quantity. `quantities` is keyed by SKU and counted in that
 * SKU's raw unit; the included allowance is subtracted first, then the rest is
 * charged in whole blocks of `unitSize`.
 */
export function priceUsage(
  quantities: Readonly<Record<string, number>>,
  prices: readonly PriceBookEntry[]
): PlatformCostResult {
  const lines: CostLine[] = [];
  const unpricedSkus: string[] = [];
  let totalMicros = 0;

  for (const [sku, rawQuantity] of Object.entries(quantities)) {
    const quantity = safeQuantity(rawQuantity);
    if (quantity === 0) continue;
    const price = prices.find((entry) => entry.sku === sku);
    if (price === undefined) {
      unpricedSkus.push(sku);
      continue;
    }
    const unitSize = Number.isFinite(price.unitSize) && price.unitSize > 0 ? Math.trunc(price.unitSize) : 1;
    const included = Number.isFinite(price.includedUnits) && price.includedUnits > 0 ? Math.trunc(price.includedUnits) : 0;
    const unitPrice = Number.isFinite(price.priceMicros) && price.priceMicros > 0 ? Math.trunc(price.priceMicros) : 0;
    const billableQuantity = Math.max(0, quantity - included);
    const blocks = ceilDiv(billableQuantity, unitSize);
    const costMicros = blocks * unitPrice;
    totalMicros += costMicros;
    lines.push({
      provider: price.provider,
      sku,
      unit: price.unit,
      quantity,
      billableQuantity,
      unitSize,
      priceMicros: unitPrice,
      costMicros,
    });
  }

  lines.sort((a, b) => b.costMicros - a.costMicros);
  return { lines, totalMicros, unpricedSkus };
}

/** Fixed monthly charges (seats, subscriptions) as their own priced line. */
export function priceFixedMonthly(
  seats: number,
  prices: readonly PriceBookEntry[]
): PlatformCostResult {
  return priceUsage({ pro_seat: safeQuantity(seats) }, prices);
}

/** Format micro-USD as a plain decimal string with up to six decimals. */
export function usdFromMicros(micros: number): string {
  const value = Number.isFinite(micros) ? Math.max(0, Math.trunc(micros)) : 0;
  const whole = Math.floor(value / 1_000_000);
  const fraction = value % 1_000_000;
  if (fraction === 0) return `${whole}.00`;
  const padded = fraction.toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${padded.length < 2 ? padded.padEnd(2, "0") : padded}`;
}

/**
 * The price book the platform starts with, mirroring the seed in control
 * migration 0021. Used for the in-memory control store (tests, offline mode);
 * PostgreSQL remains the source of truth in production.
 */
export const DEFAULT_PLATFORM_PRICE_BOOK: readonly PriceBookEntry[] = [
  { provider: "vercel", sku: "pro_seat", unit: "seat_month", unitSize: 1, priceMicros: 20_000_000, includedUnits: 0 },
  { provider: "vercel", sku: "cdn_requests", unit: "request", unitSize: 1_000_000, priceMicros: 2_000_000, includedUnits: 10_000_000 },
  { provider: "vercel", sku: "fast_data_transfer", unit: "byte", unitSize: 1_000_000_000, priceMicros: 150_000, includedUnits: 1_099_511_627_776 },
  { provider: "vercel", sku: "function_invocations", unit: "invocation", unitSize: 1_000_000, priceMicros: 600_000, includedUnits: 1_000_000 },
  { provider: "vercel", sku: "fluid_active_cpu", unit: "cpu_ms", unitSize: 3_600_000, priceMicros: 128_000, includedUnits: 14_400_000 },
  { provider: "vercel", sku: "provisioned_memory", unit: "gb_hour", unitSize: 1, priceMicros: 10_600, includedUnits: 360 },
  { provider: "neon", sku: "neon_compute", unit: "cu_hour", unitSize: 1, priceMicros: 106_000, includedUnits: 0 },
  { provider: "neon", sku: "neon_storage", unit: "byte_month", unitSize: 1_000_000_000, priceMicros: 350_000, includedUnits: 0 },
  { provider: "neon", sku: "neon_history", unit: "byte_month", unitSize: 1_000_000_000, priceMicros: 200_000, includedUnits: 0 },
  { provider: "neon", sku: "neon_network", unit: "byte", unitSize: 1_000_000_000, priceMicros: 100_000, includedUnits: 500_000_000_000 },
];

/** Where a number came from: our own counters, or a derived estimate. */
export type CostBasis = "meter" | "estimate";

export interface PlatformUsageCounters {
  requestsRead: number;
  requestsWrite: number;
  requestsOther: number;
  cpuMs: number;
  bytesIn: number;
  bytesOut: number;
  realtimeFrames: number;
  /** Latest observed stored bytes; omitted when the caller has no storage figure. */
  storageBytes?: number | undefined;
}

/**
 * Turn raw counters into price-book quantities. Each quantity is in its SKU's
 * raw unit, and each carries the basis the console must show beside it.
 */
export function quantitiesFromCounters(counters: PlatformUsageCounters): {
  quantities: Record<string, number>;
  basis: Record<string, CostBasis>;
} {
  const requests = Math.max(0, counters.requestsRead) + Math.max(0, counters.requestsWrite) + Math.max(0, counters.requestsOther);
  const quantities: Record<string, number> = {
    cdn_requests: requests,
    function_invocations: requests,
    fluid_active_cpu: Math.max(0, counters.cpuMs),
    fast_data_transfer: Math.max(0, counters.bytesOut),
  };
  const basis: Record<string, CostBasis> = {
    cdn_requests: "meter",
    function_invocations: "meter",
    fluid_active_cpu: "meter",
    fast_data_transfer: "meter",
  };
  if (counters.storageBytes !== undefined && counters.storageBytes > 0) {
    quantities["neon_storage"] = Math.trunc(counters.storageBytes);
    basis["neon_storage"] = "estimate";
  }
  return { quantities, basis };
}
