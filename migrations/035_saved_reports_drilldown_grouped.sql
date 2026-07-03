-- Тумблер «Группировка в drilldown»: true/NULL = группировать (по товарным группам /
-- менеджерам), false = плоский список всех сделок. БД: YC system (run_system.mjs).
ALTER TABLE saved_reports ADD COLUMN IF NOT EXISTS drilldown_grouped boolean;
