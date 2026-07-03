ALTER TABLE saved_reports
  ADD COLUMN IF NOT EXISTS bar_metric_ids text[] NOT NULL DEFAULT '{}';
