/**
 * `@vellum/api - Platform cost accounting routes` (`apps/api/src/routes/platform-cost.ts`)
 *
 * Read-only cost views for the master admin console, plus the one write that
 * changes money: a new price-book row.
 *
 * Sources:
 *   - `platform_usage_minute` / `platform_usage_daily` (control plane) → our own
 *     O(1) counters, flushed by `PlatformUsageMeter`
 *   - `platform_price_book` (control plane) → versioned vendor rates in micro-USD
 *   - `project_usage_daily` (control plane) → stored bytes, used only as a
 *     labelled estimate for Neon storage until vendor invoices are synced
 *
 * Nothing here reads `documents.data`. A cost number is always returned with the
 * basis it came from, so the console can show "estimate" instead of implying a
 * measured invoice.
 */

import { Hono } from "hono";
import type { Role, SessionService } from "@vellum/authorization";
import type { ControlPlaneRepository } from "@vellum/database-control";
import {
  DEFAULT_PLATFORM_PRICE_BOOK,
  priceUsage,
  quantitiesFromCounters,
  usdFromMicros,
  type CostBasis,
  type PlatformUsageCounters,
  type PriceBookEntry,
} from "@vellum/billing";
import { requireSession } from "../middleware/session.js";
import { getQueryPool } from "./usage.js";

const OPERATOR_ROLES: readonly Role[] = ["owner", "admin", "support_readonly"];
const OPERATOR_WRITE_ROLES: readonly Role[] = ["owner", "admin"];

const MAX_RANGE_DAYS = 400;
const MAX_SERIES_POINTS = 5_000;
const MAX_PROJECT_ROWS = 100;

export interface PlatformUsagePoint {
  /** ISO timestamp of the bucket start, or `YYYY-MM-DD` for daily granularity. */
  bucket: string;
  projectId: string;
  counters: PlatformUsageCounters;
}

export interface PlatformCostLineView {
  provider: string;
  sku: string;
  unit: string;
  quantity: number;
  billableQuantity: number;
  unitSize: number;
  priceMicros: number;
  costMicros: number;
  basis: CostBasis;
}

export interface PlatformCostSummary {
  from: string;
  to: string;
  generatedAt: string;
  source: "postgres" | "memory";
  counters: PlatformUsageCounters;
  lines: PlatformCostLineView[];
  totalMicros: number;
  totalUsd: string;
  unpricedSkus: string[];
  accuracy: {
    level: "estimate" | "reconciled";
    reasons: string[];
  };
}

function emptyCounters(): PlatformUsageCounters {
  return {
    requestsRead: 0,
    requestsWrite: 0,
    requestsOther: 0,
    cpuMs: 0,
    bytesIn: 0,
    bytesOut: 0,
    realtimeFrames: 0,
  };
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** `YYYY-MM-DD`, defaulting to `fallback` when absent or malformed. */
function parseDay(value: string | null, fallback: string): string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? fallback : value;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Clamp a range so one request can never scan years of minute buckets. */
function clampRange(from: string, to: string): { from: string; to: string } {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return { from: daysAgo(30), to: today() };
  }
  const maxStart = end - MAX_RANGE_DAYS * 86_400_000;
  const clampedStart = start < maxStart ? maxStart : start;
  return { from: new Date(clampedStart).toISOString().slice(0, 10), to };
}

function countersFromRow(row: Record<string, unknown>): PlatformUsageCounters {
  return {
    requestsRead: toNumber(row["requestsRead"]),
    requestsWrite: toNumber(row["requestsWrite"]),
    requestsOther: toNumber(row["requestsOther"]),
    cpuMs: toNumber(row["cpuMs"]),
    bytesIn: toNumber(row["bytesIn"]),
    bytesOut: toNumber(row["bytesOut"]),
    realtimeFrames: toNumber(row["realtimeFrames"]),
  };
}

function addCounters(target: PlatformUsageCounters, source: PlatformUsageCounters): void {
  target.requestsRead += source.requestsRead;
  target.requestsWrite += source.requestsWrite;
  target.requestsOther += source.requestsOther;
  target.cpuMs += source.cpuMs;
  target.bytesIn += source.bytesIn;
  target.bytesOut += source.bytesOut;
  target.realtimeFrames += source.realtimeFrames;
}

const COUNTER_COLUMNS = `requests_read AS "requestsRead",
            requests_write AS "requestsWrite",
            requests_other AS "requestsOther",
            cpu_ms AS "cpuMs",
            bytes_in AS "bytesIn",
            bytes_out AS "bytesOut",
            realtime_frames AS "realtimeFrames"`;

/** Daily buckets for a range, optionally for one project. */
export async function readDailyPlatformUsage(
  controlStore: ControlPlaneRepository,
  from: string,
  to: string,
  projectId: string | null
): Promise<PlatformUsagePoint[]> {
  const pool = getQueryPool(controlStore);
  if (pool === null) return [];
  const { rows } = await pool.query(
    `SELECT usage_date::text AS "bucket",
            project_id::text AS "projectId",
            ${COUNTER_COLUMNS}
       FROM platform_usage_daily
      WHERE usage_date >= $1::date
        AND usage_date <= $2::date
        AND ($3::uuid IS NULL OR project_id = $3::uuid)
      ORDER BY usage_date ASC
      LIMIT ${MAX_SERIES_POINTS}`,
    [from, to, projectId]
  );
  return rows.map((row) => ({
    bucket: String(row["bucket"] ?? ""),
    projectId: String(row["projectId"] ?? ""),
    counters: countersFromRow(row),
  }));
}

/** Per-project totals for the range, biggest first. */
export async function readPlatformUsageByProject(
  controlStore: ControlPlaneRepository,
  from: string,
  to: string,
  limit = 20
): Promise<Array<{ projectId: string; counters: PlatformUsageCounters }>> {
  const pool = getQueryPool(controlStore);
  if (pool === null) return [];
  const capped = Math.min(Math.max(Math.trunc(limit), 1), MAX_PROJECT_ROWS);
  const { rows } = await pool.query(
    `SELECT project_id::text AS "projectId",
            COALESCE(SUM(requests_read), 0)::bigint AS "requestsRead",
            COALESCE(SUM(requests_write), 0)::bigint AS "requestsWrite",
            COALESCE(SUM(requests_other), 0)::bigint AS "requestsOther",
            COALESCE(SUM(cpu_ms), 0)::bigint AS "cpuMs",
            COALESCE(SUM(bytes_in), 0)::bigint AS "bytesIn",
            COALESCE(SUM(bytes_out), 0)::bigint AS "bytesOut",
            COALESCE(SUM(realtime_frames), 0)::bigint AS "realtimeFrames"
       FROM platform_usage_daily
      WHERE usage_date >= $1::date
        AND usage_date <= $2::date
      GROUP BY project_id
      ORDER BY (SUM(requests_read) + SUM(requests_write) + SUM(requests_other)) DESC
      LIMIT ${capped}`,
    [from, to]
  );
  return rows.map((row) => ({
    projectId: String(row["projectId"] ?? ""),
    counters: countersFromRow(row),
  }));
}

/** Latest stored bytes across all projects, used as a labelled storage estimate. */
export async function readLatestStorageBytes(
  controlStore: ControlPlaneRepository,
  to: string
): Promise<number | null> {
  const pool = getQueryPool(controlStore);
  if (pool === null) return null;
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(storage_bytes), 0)::bigint AS "storageBytes"
       FROM project_usage_daily
      WHERE usage_date = (
        SELECT MAX(usage_date) FROM project_usage_daily WHERE usage_date <= $1::date
      )`,
    [to]
  );
  const row = rows[0];
  if (row === undefined) return null;
  const value = toNumber(row["storageBytes"]);
  return value > 0 ? value : null;
}

/** Current price book: the newest row per (provider, sku) at `at`. */
export async function readPriceBook(
  controlStore: ControlPlaneRepository,
  at: string
): Promise<{ entries: PriceBookEntry[]; source: "postgres" | "memory" }> {
  const pool = getQueryPool(controlStore);
  if (pool === null) return { entries: [...DEFAULT_PLATFORM_PRICE_BOOK], source: "memory" };
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (provider, sku)
            provider,
            sku,
            unit,
            unit_size::bigint AS "unitSize",
            price_micros::bigint AS "priceMicros",
            included_units::bigint AS "includedUnits"
       FROM platform_price_book
      WHERE effective_from <= $1::timestamptz
      ORDER BY provider, sku, effective_from DESC`,
    [`${at}T23:59:59Z`]
  );
  if (rows.length === 0) return { entries: [...DEFAULT_PLATFORM_PRICE_BOOK], source: "memory" };
  return {
    entries: rows.map((row) => ({
      provider: String(row["provider"] ?? ""),
      sku: String(row["sku"] ?? ""),
      unit: String(row["unit"] ?? ""),
      unitSize: toNumber(row["unitSize"]),
      priceMicros: toNumber(row["priceMicros"]),
      includedUnits: toNumber(row["includedUnits"]),
    })),
    source: "postgres",
  };
}

/**
 * Cost routes. Mount with `app.route("/v1", ...)`.
 *
 * `liveCounters` is the process's in-memory meter snapshot, used only when the
 * control store has no PostgreSQL pool (tests and offline mode) so the console
 * still shows the numbers this process actually observed.
 */
export function createPlatformCostRoutes(
  controlStore: ControlPlaneRepository,
  sessionService: SessionService,
  liveCounters: () => PlatformUsageCounters = emptyCounters
) {
  const routes = new Hono();
  const requireOperator = requireSession(sessionService, OPERATOR_ROLES);
  const requireOperatorWrite = requireSession(sessionService, OPERATOR_WRITE_ROLES);

  /** Shared read: totals for a range plus the counters the cost model needs. */
  async function readTotals(
    from: string,
    to: string,
    projectId: string | null
  ): Promise<{ counters: PlatformUsageCounters; source: "postgres" | "memory" }> {
    const points = await readDailyPlatformUsage(controlStore, from, to, projectId);
    if (points.length === 0) {
      return { counters: liveCounters(), source: getQueryPool(controlStore) === null ? "memory" : "postgres" };
    }
    const totals = emptyCounters();
    for (const point of points) addCounters(totals, point.counters);
    return { counters: totals, source: "postgres" };
  }

  // 1. Raw series (daily or minute) for charts and drill-down.
  routes.get("/admin/cost/usage", requireOperator, async (c) => {
    const url = new URL(c.req.url);
    const range = clampRange(
      parseDay(url.searchParams.get("from"), daysAgo(30)),
      parseDay(url.searchParams.get("to"), today())
    );
    const projectId = url.searchParams.get("projectId");
    const points = await readDailyPlatformUsage(controlStore, range.from, range.to, projectId);
    const totals = emptyCounters();
    for (const point of points) addCounters(totals, point.counters);
    return c.json({
      from: range.from,
      to: range.to,
      granularity: "day",
      source: getQueryPool(controlStore) === null ? "memory" : "postgres",
      totals: points.length > 0 ? totals : liveCounters(),
      series: points,
      note:
        points.length === 0
          ? "No durable buckets in this range. Totals show the counters this process has observed since it started."
          : null,
    });
  });

  // 2. Priced summary: the number the console puts at the top.
  routes.get("/admin/cost/summary", requireOperator, async (c) => {
    const url = new URL(c.req.url);
    const range = clampRange(
      parseDay(url.searchParams.get("from"), daysAgo(30)),
      parseDay(url.searchParams.get("to"), today())
    );
    const { counters, source } = await readTotals(range.from, range.to, null);
    const storageBytes = await readLatestStorageBytes(controlStore, range.to);
    const priceBook = await readPriceBook(controlStore, range.to);
    const { quantities, basis } = quantitiesFromCounters({
      ...counters,
      ...(storageBytes === null ? {} : { storageBytes }),
    });
    const priced = priceUsage(quantities, priceBook.entries);
    const lines: PlatformCostLineView[] = priced.lines.map((line) => ({
      ...line,
      basis: basis[line.sku] ?? "meter",
    }));
    const reasons = [
      "Metered requests, CPU time and response bytes come from this platform's own counters.",
      "Neon compute (CU-hours), Neon network transfer and the vendor invoices are not synced yet, so the total is an estimate until the reconciliation job runs.",
    ];
    if (priced.unpricedSkus.length > 0) {
      reasons.push(`No price book entry for: ${priced.unpricedSkus.join(", ")}.`);
    }
    const summary: PlatformCostSummary = {
      from: range.from,
      to: range.to,
      generatedAt: new Date().toISOString(),
      source,
      counters,
      lines,
      totalMicros: priced.totalMicros,
      totalUsd: usdFromMicros(priced.totalMicros),
      unpricedSkus: priced.unpricedSkus,
      accuracy: { level: "estimate", reasons },
    };
    return c.json(summary);
  });

  // 3. Cost per project, biggest first.
  routes.get("/admin/cost/projects", requireOperator, async (c) => {
    const url = new URL(c.req.url);
    const range = clampRange(
      parseDay(url.searchParams.get("from"), daysAgo(30)),
      parseDay(url.searchParams.get("to"), today())
    );
    const limit = Number(url.searchParams.get("limit") ?? "20");
    const rows = await readPlatformUsageByProject(
      controlStore,
      range.from,
      range.to,
      Number.isFinite(limit) ? limit : 20
    );
    const priceBook = await readPriceBook(controlStore, range.to);
    const projects = rows.map((row) => {
      const { quantities } = quantitiesFromCounters(row.counters);
      const priced = priceUsage(quantities, priceBook.entries);
      return {
        projectId: row.projectId,
        counters: row.counters,
        costMicros: priced.totalMicros,
        costUsd: usdFromMicros(priced.totalMicros),
      };
    });
    projects.sort((a, b) => b.costMicros - a.costMicros);
    return c.json({
      from: range.from,
      to: range.to,
      source: getQueryPool(controlStore) === null ? "memory" : "postgres",
      projects,
    });
  });

  // 4. Price book read.
  routes.get("/admin/cost/price-book", requireOperator, async (c) => {
    const url = new URL(c.req.url);
    const at = parseDay(url.searchParams.get("at"), today());
    const book = await readPriceBook(controlStore, at);
    return c.json({ at, source: book.source, entries: book.entries });
  });

  // 5. Price book write: a new effective-dated row, never an update in place.
  routes.post("/admin/cost/price-book", requireOperatorWrite, async (c) => {
    const pool = getQueryPool(controlStore);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null) {
      return c.json({ error: { code: "INVALID_ARGUMENT", message: "A JSON body is required" } }, 400);
    }
    const provider = typeof body["provider"] === "string" ? body["provider"].trim() : "";
    const sku = typeof body["sku"] === "string" ? body["sku"].trim() : "";
    const unit = typeof body["unit"] === "string" ? body["unit"].trim() : "";
    const unitSize = toNumber(body["unitSize"]);
    const priceMicros = toNumber(body["priceMicros"]);
    const includedUnits = toNumber(body["includedUnits"]);
    const sourceUrl = typeof body["sourceUrl"] === "string" ? body["sourceUrl"].trim() : "";
    const note = typeof body["note"] === "string" ? body["note"].slice(0, 500) : null;
    if (provider === "" || sku === "" || unit === "" || sourceUrl === "") {
      return c.json(
        { error: { code: "INVALID_ARGUMENT", message: "provider, sku, unit and sourceUrl are required" } },
        400
      );
    }
    if (unitSize <= 0 || priceMicros < 0 || includedUnits < 0) {
      return c.json(
        { error: { code: "INVALID_ARGUMENT", message: "unitSize must be positive; price and allowance cannot be negative" } },
        400
      );
    }
    if (pool === null) {
      return c.json(
        { error: { code: "FAILED_PRECONDITION", message: "Price book edits require the PostgreSQL control store" } },
        501
      );
    }
    const session = c.get("session");
    const { rows } = await pool.query(
      `INSERT INTO platform_price_book
         (provider, sku, unit, unit_size, price_micros, included_units, effective_from, source_url, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9::uuid)
       RETURNING id::text AS "id", effective_from AS "effectiveFrom"`,
      [provider, sku, unit, Math.trunc(unitSize), Math.trunc(priceMicros), Math.trunc(includedUnits), sourceUrl, note, session?.uid ?? null]
    );
    await controlStore.recordAuditLog({
      action: "platform.price_book.upsert",
      targetId: String(rows[0]?.["id"] ?? `${provider}:${sku}`),
      actorType: "operator",
      actorUserId: session?.uid ?? null,
      metadata: { provider, sku, unit, unitSize, priceMicros, includedUnits, sourceUrl },
    });
    return c.json({ created: true, id: rows[0]?.["id"] ?? null, effectiveFrom: rows[0]?.["effectiveFrom"] ?? null }, 201);
  });

  return routes;
}
