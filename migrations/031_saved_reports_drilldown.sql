ALTER TABLE saved_reports
  ADD COLUMN IF NOT EXISTS drilldown_duplicate_metrics boolean,
  ADD COLUMN IF NOT EXISTS drilldown_metric_ids text[],
  ADD COLUMN IF NOT EXISTS deal_fields text[];
