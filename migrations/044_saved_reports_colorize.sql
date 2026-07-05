-- «Выделять показатели цветом» (NULL/true = да) + инверсия градиента тепловой карты
-- по метрикам (меньше = лучше). БД: YC system (run_system.mjs).
ALTER TABLE saved_reports ADD COLUMN IF NOT EXISTS colorize_metrics boolean;
ALTER TABLE saved_reports ADD COLUMN IF NOT EXISTS heatmap_inverted_ids text[];
