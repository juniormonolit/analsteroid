ALTER TABLE saved_reports
  ADD COLUMN IF NOT EXISTS pinned_metric_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS metric_decimal_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS metric_threshold_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS sort_by text,
  ADD COLUMN IF NOT EXISTS sort_dir text;
