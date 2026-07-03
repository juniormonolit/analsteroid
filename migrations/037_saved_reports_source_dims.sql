-- Маркетинговые отчёты «По источникам»: главная сущность и сущность дрилл-дауна.
-- БД: YC system (run_system.mjs).
ALTER TABLE saved_reports ADD COLUMN IF NOT EXISTS source_dimension text;
ALTER TABLE saved_reports ADD COLUMN IF NOT EXISTS drilldown_dimension text;
