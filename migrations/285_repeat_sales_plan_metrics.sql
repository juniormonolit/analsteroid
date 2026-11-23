-- 285: метрики «План продаж (повт.)» — план повторных продаж как доля плана отдела.
-- Пара к миграции 284 (dept_repeat_plan_share). Задача владельца 23.11: план (повт.) =
-- план продаж × доля повторных продаж отдела менеджера («МСК ОС 40 %, план 100 → 40»).
--
-- Считаются в features/reports/engine/planMetrics.ts (external), как и обычные
-- «План продаж (…)»: только в отчёте «по менеджерам» и в «Моём отчёте»; итог — сумма
-- строк. Менеджер вне отделов с долей → пусто (не 0): доли нет — плана (повт.) нет.
-- Факт для % — «Сумма продаж (повт.)» (по воронке) в тех же фиксированных окнах
-- «сегодня» / «с 1 числа месяца по сегодня», что и у обычных % выполнения плана.
--
-- БД: analytics (таблица metrics) — на проде это та же БД monolitika. Накат под monolitik.
-- Идемпотентна (ON CONFLICT DO UPDATE). Откат: DELETE FROM metrics WHERE id IN (…ниже…);

INSERT INTO metrics (
  id, name_ru, name_short_ru, description, metric_type, data_type, formula, dependencies,
  decimal_places, aggregation_fn, category, sort_order,
  is_core, is_hidden_in_ui, is_active, is_test,
  source, agg_fn, agg_field, date_field, filters, tags, fill_ok, calc_ok, is_collect_ok, is_calc_ok
) VALUES
  ('plan_repeat_sales_month', 'План продаж (повт., месяц)', 'План прод. повт. (мес)',
   'План продаж на месяц × доля повторных продаж отдела менеджера (задаётся на странице «Планы»).',
   'external', 'money', NULL, ARRAY[]::text[], 0, 'sum', 'Планы', 850,
   false, false, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true),
  ('plan_repeat_sales_today', 'План продаж (повт., дневной)', 'План прод. повт. (день)',
   'Дневной план продаж (план месяца / 20) × доля повторных продаж отдела менеджера.',
   'external', 'money', NULL, ARRAY[]::text[], 0, 'sum', 'Планы', 851,
   false, false, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true),
  ('plan_repeat_sales_current_day', 'План продаж (повт., на текущий день)', 'План прод. повт. (тек)',
   'План продаж на текущий день (дневной × рабочие дни периода по сегодня) × доля повторных продаж отдела менеджера.',
   'external', 'money', NULL, ARRAY[]::text[], 0, 'sum', 'Планы', 852,
   false, false, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true),
  ('repeat_sales_fact_today', 'Факт продаж (повт.) за сегодня (служебная)', NULL, NULL,
   'external', 'money', NULL, ARRAY[]::text[], 0, 'sum', 'Планы', 856,
   false, true, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true),
  ('repeat_sales_fact_month', 'Факт продаж (повт.) с начала месяца (служебная)', NULL, NULL,
   'external', 'money', NULL, ARRAY[]::text[], 0, 'sum', 'Планы', 857,
   false, true, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true),
  ('plan_exec_pct_repeat_sales_daily', 'Выполнение плана продаж (повт.), % (дневной)', '% плана прод. повт. (день)',
   'Сумма повторных продаж (по воронке) за сегодня ÷ дневной план продаж (повт.).',
   'calculated', 'percent', '[repeat_sales_fact_today] / [plan_repeat_sales_today] * 100',
   ARRAY['repeat_sales_fact_today','plan_repeat_sales_today'], 1, 'avg', 'Планы', 853,
   false, false, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true),
  ('plan_exec_pct_repeat_sales_current_day', 'Выполнение плана продаж (повт.), % (на текущий день)', '% плана прод. повт. (тек)',
   'Сумма повторных продаж (по воронке) с 1 числа месяца по сегодня ÷ план продаж (повт.) на текущий день.',
   'calculated', 'percent', '[repeat_sales_fact_month] / [plan_repeat_sales_current_day] * 100',
   ARRAY['repeat_sales_fact_month','plan_repeat_sales_current_day'], 1, 'avg', 'Планы', 854,
   false, false, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, description = EXCLUDED.description,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  decimal_places = EXCLUDED.decimal_places, aggregation_fn = EXCLUDED.aggregation_fn,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, is_active = EXCLUDED.is_active;
