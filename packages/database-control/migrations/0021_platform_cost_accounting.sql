-- Platform cost accounting (P0).
--
-- Three control-plane tables that price what running the platform costs:
--   * platform_usage_minute  per-minute counters written by the O(1) meter
--   * platform_usage_daily   daily rollup the admin console reads
--   * platform_price_book    versioned, editable vendor rates (micro-USD)
--
-- Counters only: no document payload, no request body, no identifier beyond the
-- project UUID. The zero UUID is the platform-wide scope (console, admin, auth
-- and anything the platform does for itself).
--
-- Numbering: 0020 belongs to the auto-index engine's platform_settings table, so
-- this migration takes 0021.

CREATE TABLE IF NOT EXISTS platform_usage_minute (
  bucket_start TIMESTAMPTZ NOT NULL,
  project_id UUID NOT NULL,
  requests_read BIGINT NOT NULL DEFAULT 0,
  requests_write BIGINT NOT NULL DEFAULT 0,
  requests_other BIGINT NOT NULL DEFAULT 0,
  cpu_ms BIGINT NOT NULL DEFAULT 0,
  bytes_in BIGINT NOT NULL DEFAULT 0,
  bytes_out BIGINT NOT NULL DEFAULT 0,
  realtime_frames BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_start, project_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_usage_minute_project
  ON platform_usage_minute (project_id, bucket_start);

CREATE TABLE IF NOT EXISTS platform_usage_daily (
  usage_date DATE NOT NULL,
  project_id UUID NOT NULL,
  requests_read BIGINT NOT NULL DEFAULT 0,
  requests_write BIGINT NOT NULL DEFAULT 0,
  requests_other BIGINT NOT NULL DEFAULT 0,
  cpu_ms BIGINT NOT NULL DEFAULT 0,
  bytes_in BIGINT NOT NULL DEFAULT 0,
  bytes_out BIGINT NOT NULL DEFAULT 0,
  realtime_frames BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (usage_date, project_id)
);

CREATE TABLE IF NOT EXISTS platform_price_book (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  sku TEXT NOT NULL,
  unit TEXT NOT NULL,
  unit_size BIGINT NOT NULL DEFAULT 1 CHECK (unit_size > 0),
  price_micros BIGINT NOT NULL CHECK (price_micros >= 0),
  included_units BIGINT NOT NULL DEFAULT 0 CHECK (included_units >= 0),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_url TEXT NOT NULL,
  note TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_price_book_unique
  ON platform_price_book (provider, sku, effective_from);

-- Seed the rates published by the vendors on 2026-11-28. Every row carries the
-- page it came from so a rate can be re-checked instead of trusted.
-- Micro-USD: 1 USD = 1_000_000. unit_size turns per-million pricing into
-- integer math (a request costs price_micros / unit_size).
INSERT INTO platform_price_book (provider, sku, unit, unit_size, price_micros, included_units, effective_from, source_url, note)
VALUES
  ('vercel', 'pro_seat', 'seat_month', 1, 20000000, 0, '2026-11-28T00:00:00Z', 'https://vercel.com/pricing', 'Pro plan, per developer seat'),
  ('vercel', 'cdn_requests', 'request', 1000000, 2000000, 10000000, '2026-11-28T00:00:00Z', 'https://vercel.com/pricing', 'CDN requests, 10M included then $2 per 1M'),
  ('vercel', 'fast_data_transfer', 'byte', 1000000000, 150000, 1099511627776, '2026-11-28T00:00:00Z', 'https://vercel.com/pricing', 'Fast Data Transfer, 1TB included then $0.15 per GB'),
  ('vercel', 'function_invocations', 'invocation', 1000000, 600000, 1000000, '2026-11-28T00:00:00Z', 'https://vercel.com/pricing', 'Function invocations, 1M included then $0.60 per 1M'),
  ('vercel', 'fluid_active_cpu', 'cpu_ms', 3600000, 128000, 14400000, '2026-11-28T00:00:00Z', 'https://vercel.com/pricing', 'Fluid Active CPU, 4 hours included then $0.128 per hour'),
  ('vercel', 'provisioned_memory', 'gb_hour', 1, 10600, 360, '2026-11-28T00:00:00Z', 'https://vercel.com/pricing', 'Fluid Provisioned Memory, 360 GB-hrs included then $0.0106 per GB-hr'),
  ('neon', 'neon_compute', 'cu_hour', 1, 106000, 0, '2026-11-28T00:00:00Z', 'https://neon.com/pricing', 'Launch plan compute, $0.106 per CU-hour'),
  ('neon', 'neon_storage', 'byte_month', 1000000000, 350000, 0, '2026-11-28T00:00:00Z', 'https://neon.com/pricing', 'Launch plan database storage, $0.35 per GB-month'),
  ('neon', 'neon_history', 'byte_month', 1000000000, 200000, 0, '2026-11-28T00:00:00Z', 'https://neon.com/pricing', 'Instant restore history storage, $0.20 per GB-month'),
  ('neon', 'neon_network', 'byte', 1000000000, 100000, 500000000000, '2026-11-28T00:00:00Z', 'https://neon.com/pricing', 'Public network transfer, 500GB per project included then $0.10 per GB')
ON CONFLICT DO NOTHING;
