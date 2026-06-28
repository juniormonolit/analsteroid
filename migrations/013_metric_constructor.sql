-- Metric constructor: add new columns, clear old metrics
ALTER TABLE metrics
  ADD COLUMN IF NOT EXISTS source       TEXT    NOT NULL DEFAULT 'deals',
  ADD COLUMN IF NOT EXISTS agg_fn       TEXT,
  ADD COLUMN IF NOT EXISTS agg_field    TEXT,
  ADD COLUMN IF NOT EXISTS date_field   TEXT,
  ADD COLUMN IF NOT EXISTS filters      JSONB   NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS tags         TEXT[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_collect_ok  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_calc_ok     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_test        BOOLEAN NOT NULL DEFAULT false;

-- Remove all existing broken metrics
DELETE FROM metrics;
