# 17 — Platform cost accounting (P0)

> **Status:** P0 of the admin cost console. Meters what the platform spends and
> prices it against a versioned price book. Nothing here changes what customers
> are charged: the plan table in [16](./16-metering-and-billing.md) stays the
> customer-facing contract.

## What this adds

| Piece | Where | What it does |
| :-- | :-- | :-- |
| `PlatformUsageMeter` | `packages/observability/src/platform-usage-meter.ts` | O(1) in-memory counters per minute bucket and project. Synchronous, allocation-bounded, never throws. |
| Request middleware | `apps/api/src/middleware/platform-usage.ts` | Counts every request by class (read/write/other), the handler's CPU time, and bytes in/out. Wraps the whole app, not just the document plane. |
| Persistence | `apps/api/src/platform-usage-flush.ts` | One batched `UNNEST` upsert per flush into `platform_usage_minute`; a daily rollup into `platform_usage_daily` plus 90-day retention on the maintenance tick. |
| Cost model | `packages/billing/src/platform-cost.ts` | Integer micro-USD pricing with ceiling division, included allowances and an explicit `unpricedSkus` list. |
| Routes | `apps/api/src/routes/platform-cost.ts` | `GET /v1/admin/cost/{usage,summary,projects,price-book}` and `POST /v1/admin/cost/price-book`. |
| Tables | `packages/database-control/migrations/0021_platform_cost_accounting.sql` | `platform_usage_minute`, `platform_usage_daily`, `platform_price_book` (seeded with the vendor rates published on 2026-11-28). |

## Invariants

- **Counters only.** No document payload, no request body, no header values. The
  only identifier stored is the project UUID; the zero UUID is the platform-wide
  scope (console, admin, auth and anything the platform does for itself).
- **No hot-path I/O.** Recording is a map mutation. Writes happen on the 60 s
  flush, outside any request.
- **Money is integer micro-USD.** Every division is ceiling division; floating
  point never touches a money value.
- **A cost always carries its basis.** Each line is `meter` (our own counters) or
  `estimate` (derived), and the summary carries an `accuracy` block with the
  reasons the number is not yet a reconciled invoice.
- **A missing price is visible.** Usage with no price-book entry comes back in
  `unpricedSkus` instead of being silently dropped from the total.

## Price book

Rates are rows, not constants: `(provider, sku, unit, unit_size, price_micros,
included_units, effective_from, source_url)`. Reads take the newest row per
`(provider, sku)` at or before the requested day, so a rate change never rewrites
history. Writes append a new effective-dated row and emit a
`platform.price_book.upsert` audit entry. `unit_size` turns per-million pricing
into integer math: a request costs `price_micros / unit_size`.

Seeded on 2026-11-28 from the vendors' own pages:
[vercel.com/pricing](https://vercel.com/pricing) (Pro seat $20, 10M CDN requests
then $2/1M, 1 TB transfer then $0.15/GB, 1M invocations then $0.60/1M, 4 CPU
hours then $0.128/hour, 360 GB-hrs memory then $0.0106/GB-hr) and
[neon.com/pricing](https://neon.com/pricing) (Launch: $0.106/CU-hour,
$0.35/GB-month storage, $0.20/GB-month history, 500 GB network per project then
$0.10/GB).

## What is still an estimate

- **Neon compute (CU-hours)** is not derivable from our counters. It arrives with
  the vendor consumption API in P1.
- **Neon network transfer** is not the same as our response bytes, so it is not
  priced yet.
- **Stored bytes** come from `project_usage_daily` and are labelled `estimate`.
- **Fixed cost** (the Vercel seat, the domain, console traffic) is priced as its
  own line; allocating it across projects by usage share is a console toggle, not
  a change to the model.

The summary therefore reports `accuracy.level = "estimate"` with its reasons. P1
replaces that with a daily reconciliation against the vendor invoices and moves
the level to `reconciled` only when the gap stays inside the configured
tolerance.
