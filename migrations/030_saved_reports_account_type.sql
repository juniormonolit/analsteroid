ALTER TABLE saved_reports
  ADD COLUMN IF NOT EXISTS account_type text;
