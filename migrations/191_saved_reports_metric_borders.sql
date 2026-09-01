-- Миграция 191: вертикальные границы колонок метрик (per-metric)
-- БД: YC system. Накат:
--   node migrations/run_local.mjs migrations/191_saved_reports_metric_borders.sql
--
-- Правка владельца 31.08 (скрин панели границ Google Sheets): «функционал
-- настройки границ для каждой метрики… только правая/левая граница и её
-- толщина». Формат значения: { "<metricId>": { "l": 1|2|3, "r": 1|2|3 } },
-- px; отсутствие ключа = граница не задана (работает общий borderMode).
-- DOWN: ALTER TABLE saved_reports DROP COLUMN IF EXISTS metric_borders;

ALTER TABLE saved_reports
  ADD COLUMN IF NOT EXISTS metric_borders jsonb NOT NULL DEFAULT '{}'::jsonb;
