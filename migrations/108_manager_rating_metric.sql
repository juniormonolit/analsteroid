-- Метрика «Рейтинг» в каталоге (задача владельца 30.07: «так же нужна метрика
-- Рейтинг»). Аналитическая БД (metrics).
--
-- metric_type = 'external': значение НЕ считается SQL-агрегатом по сделкам, а
-- приходит из движка рейтинга (features/manager-card/engine/ratings.ts) —
-- перцентильный скоринг по осям шаблона карточки требует пула ВСЕХ менеджеров,
-- поэтому инъекция живёт в app/api/reports/run (только отчёт «по менеджерам»,
-- как plan_*-метрики). В отчётах по товарам/источникам метрика неприменима и
-- останется пустой — это осознанно.
--
-- aggregation_fn = 'avg': в подытогах отдела/филиала и в «Итого» усреднять, а не
-- суммировать (рейтинг — шкала 0-10, сумма бессмысленна).

INSERT INTO metrics (
  id, name_ru, name_short_ru, description,
  metric_type, data_type, formula, dependencies,
  decimal_places, aggregation_fn, category, sort_order,
  is_core, is_hidden_in_ui, is_active, is_test,
  source, agg_fn, agg_field, date_field, filters, tags,
  fill_ok, calc_ok, is_collect_ok, is_calc_ok
) VALUES (
  'manager_rating', 'Рейтинг', 'Рейтинг',
  'Средневзвешенный балл 0-10 по осям шаблона карточки менеджера (перцентиль относительно менеджеров с продажами за период). Настройка осей и весов — Настройки → Шаблоны карточек.',
  'external', 'decimal', NULL, ARRAY[]::text[],
  1, 'avg', 'Рейтинг', 10,
  false, false, true, false,
  'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['rating']::text[],
  false, true, false, true
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru,
  name_short_ru = EXCLUDED.name_short_ru,
  description = EXCLUDED.description,
  metric_type = EXCLUDED.metric_type,
  data_type = EXCLUDED.data_type,
  decimal_places = EXCLUDED.decimal_places,
  aggregation_fn = EXCLUDED.aggregation_fn,
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  is_hidden_in_ui = EXCLUDED.is_hidden_in_ui;
