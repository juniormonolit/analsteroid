-- Цвета метрик: правила по категориям + точечные переопределения по метрике.
-- Используются для «Выделять показатели цветом» (бейджи заголовков колонок).
-- Редактируются в /settings/metric-colors. БД: YC analytics (run_analytics.mjs).
CREATE TABLE IF NOT EXISTS metric_colors (
  scope text NOT NULL CHECK (scope IN ('category', 'metric')),
  key   text NOT NULL,   -- название категории или id метрики
  color text NOT NULL,   -- hex, например #22c55e
  PRIMARY KEY (scope, key)
);

-- Дефолтные правила (пожелание пользователя 2026-07-03)
INSERT INTO metric_colors (scope, key, color) VALUES
  ('category', 'Продажи',  '#3b82f6'),
  ('category', 'Отгрузки', '#22c55e'),
  ('category', 'Брони',    '#93c5fd'),
  ('category', 'Отказы',   '#ef4444')
ON CONFLICT (scope, key) DO NOTHING;

-- Подтверждённые брони — голубым (переопределения поверх категории «Брони»)
INSERT INTO metric_colors (scope, key, color)
SELECT 'metric', id, '#22d3ee' FROM metrics WHERE name_ru ILIKE '%подтв%'
ON CONFLICT (scope, key) DO NOTHING;
