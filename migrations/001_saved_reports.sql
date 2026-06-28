-- Run this against the YC system DB (dbname=system)
CREATE TABLE IF NOT EXISTS saved_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_login TEXT NOT NULL,
  report_slug TEXT NOT NULL,
  name TEXT NOT NULL,
  metric_ids TEXT[] NOT NULL DEFAULT '{}',
  deal_scope TEXT NOT NULL DEFAULT 'primary',
  client_type TEXT NOT NULL DEFAULT 'all',
  grouping TEXT NOT NULL DEFAULT 'none',
  comparison_display TEXT NOT NULL DEFAULT 'full',
  product_group_mode TEXT NOT NULL DEFAULT 'kc',
  department_ids TEXT[] NOT NULL DEFAULT '{}',
  metric_highlights JSONB NOT NULL DEFAULT '{}',
  period_mode TEXT NOT NULL DEFAULT 'relative',
  relative_period JSONB,
  comparison_mode TEXT NOT NULL DEFAULT 'previous_tail',
  fixed_period JSONB,
  fixed_comparison JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_metric_highlights (
  user_login TEXT NOT NULL,
  metric_id TEXT NOT NULL,
  config JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_login, metric_id)
);
