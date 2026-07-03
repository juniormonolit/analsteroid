ALTER TABLE saved_reports
  ADD COLUMN IF NOT EXISTS heatmap_metric_ids text[] NOT NULL DEFAULT '{}';
