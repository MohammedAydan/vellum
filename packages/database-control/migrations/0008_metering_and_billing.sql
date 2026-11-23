-- Control Plane: tamper-proof usage metering & billing (Fortress/Billing Phase 1B).
--
-- Downstream of 0007_security_fortress.sql, which creates the shared
-- prevent_immutable_table_mutation() trigger function used by the ledger here.
-- All money is integer cents. No floating point. All DDL is idempotent.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Locked platform billing plans ----------------------------------------------
CREATE TABLE IF NOT EXISTS billing_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monthly_base_price_cents INTEGER NOT NULL,
  included_doc_reads BIGINT NOT NULL,
  included_doc_writes BIGINT NOT NULL,
  included_doc_deletes BIGINT NOT NULL,
  included_storage_bytes BIGINT NOT NULL,
  included_egress_bytes BIGINT NOT NULL,
  included_auth_mau INTEGER NOT NULL,
  max_concurrent_ws INTEGER NOT NULL,
  overage_read_per_100k_cents INTEGER NOT NULL DEFAULT 0,
  overage_write_per_100k_cents INTEGER NOT NULL DEFAULT 0,
  overage_delete_per_100k_cents INTEGER NOT NULL DEFAULT 0,
  overage_storage_per_gb_cents INTEGER NOT NULL DEFAULT 0,
  overage_egress_per_gb_cents INTEGER NOT NULL DEFAULT 0,
  overage_mau_per_1k_cents INTEGER NOT NULL DEFAULT 0,
  hard_limit_enforced BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO billing_plans (
  id, name, monthly_base_price_cents,
  included_doc_reads, included_doc_writes, included_doc_deletes,
  included_storage_bytes, included_egress_bytes, included_auth_mau, max_concurrent_ws,
  overage_read_per_100k_cents, overage_write_per_100k_cents, overage_delete_per_100k_cents,
  overage_storage_per_gb_cents, overage_egress_per_gb_cents, overage_mau_per_1k_cents,
  hard_limit_enforced
) VALUES
  ('free', 'Starter (Free)', 0,
    1500000, 600000, 600000, 1073741824, 10737418240, 10000, 50,
    0, 0, 0, 0, 0, 0, TRUE),
  ('pro', 'Pro (Pay-as-you-go)', 2500,
    5000000, 2000000, 1000000, 21474836480, 107374182400, 100000, 1000,
    6, 18, 2, 18, 12, 500, FALSE),
  ('enterprise', 'Enterprise', 29900,
    50000000, 20000000, 10000000, 214748364800, 1099511627776, 1000000, 10000,
    4, 12, 1, 14, 9, 300, FALSE)
ON CONFLICT (id) DO NOTHING;

-- 2. Organization subscriptions & hard spend cap --------------------------------
CREATE TABLE IF NOT EXISTS org_subscriptions (
  org_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL DEFAULT 'free' REFERENCES billing_plans(id),
  status TEXT NOT NULL DEFAULT 'active'
    CONSTRAINT org_subscriptions_status_check
      CHECK (status IN ('active','past_due','suspended','canceled')),
  monthly_spend_cap_cents INTEGER,
  billing_email TEXT,
  external_customer_id TEXT,
  external_subscription_id TEXT,
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
  current_period_end TIMESTAMPTZ NOT NULL DEFAULT (date_trunc('month', now()) + interval '1 month'),
  quota_override JSONB NOT NULL DEFAULT '{}'::jsonb,
  alert_80_sent_at TIMESTAMPTZ,
  alert_95_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Monthly & daily aggregated usage rollups (async flusher only) --------------
CREATE TABLE IF NOT EXISTS usage_monthly_rollups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  project_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  billing_month TEXT NOT NULL,
  doc_reads BIGINT NOT NULL DEFAULT 0,
  doc_writes BIGINT NOT NULL DEFAULT 0,
  doc_deletes BIGINT NOT NULL DEFAULT 0,
  storage_bytes BIGINT NOT NULL DEFAULT 0,
  egress_bytes BIGINT NOT NULL DEFAULT 0,
  auth_mau BIGINT NOT NULL DEFAULT 0,
  peak_concurrent_ws INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT usage_monthly_rollups_unique
    UNIQUE (org_id, project_id, environment_id, billing_month)
);
CREATE INDEX IF NOT EXISTS idx_usage_monthly_org
  ON usage_monthly_rollups (org_id, billing_month);

CREATE TABLE IF NOT EXISTS usage_daily_rollups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  project_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  usage_date TEXT NOT NULL,
  doc_reads BIGINT NOT NULL DEFAULT 0,
  doc_writes BIGINT NOT NULL DEFAULT 0,
  doc_deletes BIGINT NOT NULL DEFAULT 0,
  egress_bytes BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT usage_daily_rollups_unique
    UNIQUE (org_id, project_id, environment_id, usage_date)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_org_date
  ON usage_daily_rollups (org_id, usage_date DESC);

-- 4. Immutable hash-chained billing ledger (double-entry accounting) ------------
CREATE TABLE IF NOT EXISTS billing_ledger_entries (
  seq BIGSERIAL PRIMARY KEY,
  id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  billing_month TEXT NOT NULL,
  entry_type TEXT NOT NULL
    CONSTRAINT billing_ledger_entries_entry_type_check
      CHECK (entry_type IN (
        'usage_flush','plan_charge','overage_charge','credit_grant',
        'payment_received','refund','admin_adjustment'
      )),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  metric_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_ledger_org_month
  ON billing_ledger_entries (org_id, billing_month, seq DESC);

DROP TRIGGER IF EXISTS trg_immutable_billing_ledger ON billing_ledger_entries;
CREATE TRIGGER trg_immutable_billing_ledger
  BEFORE UPDATE OR DELETE ON billing_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

-- 5. Monthly invoices -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number TEXT NOT NULL UNIQUE,
  org_id UUID NOT NULL,
  billing_month TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  base_amount_cents INTEGER NOT NULL,
  overage_amount_cents INTEGER NOT NULL,
  credits_applied_cents INTEGER NOT NULL DEFAULT 0,
  total_amount_cents INTEGER NOT NULL,
  line_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft'
    CONSTRAINT billing_invoices_status_check
      CHECK (status IN ('draft','open','paid','void','uncollectible')),
  issued_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_invoices_org_month_unique UNIQUE (org_id, billing_month)
);

-- 6. Webhook replay protection --------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_webhook_events (
  event_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
