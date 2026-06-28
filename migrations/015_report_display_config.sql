-- 015_report_display_config.sql
-- Add per-metric display modes and comparison threshold to saved_reports

ALTER TABLE saved_reports
  ADD COLUMN IF NOT EXISTS metric_display_modes jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS comparison_threshold  int   NOT NULL DEFAULT 5;
