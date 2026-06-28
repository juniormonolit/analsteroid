ALTER TABLE saved_reports
  ADD COLUMN IF NOT EXISTS column_groups jsonb NOT NULL DEFAULT '[]'::jsonb;
