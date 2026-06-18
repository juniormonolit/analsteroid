-- Add is_hidden_in_ui column to metrics (analytics DB)
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS is_hidden_in_ui boolean NOT NULL DEFAULT false;
