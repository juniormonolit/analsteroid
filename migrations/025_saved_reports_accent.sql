ALTER TABLE saved_reports
  ADD COLUMN IF NOT EXISTS accented_metric_ids text[] NOT NULL DEFAULT '{}';
