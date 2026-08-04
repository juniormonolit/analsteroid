-- «План (на текущий день недели)» + проценты к нему (задача владельца 04.08,
-- продолжение миграции 146). БД: YC analytics (metrics).
--
-- Полная аналогия месячной пары, только окно — ТЕКУЩАЯ НЕДЕЛЯ (с понедельника):
--   План (на текущий день недели) = дневной план × порядковый рабочий день недели
--                                    по производственному календарю (working_calendar);
--   % выполнения = факт с начала недели ÷ этот план.
-- В понедельник значение совпадает с дневным планом — это ожидаемо (владелец
-- подтвердил: «да, в понедельник это то же число»).
--
-- Считается тем же getCalendarWorkingDaysInPeriod, что и месячный вариант (не
-- зависит от режима divide20/calendar) — окно только меняется на [понедельник, сегодня].

INSERT INTO metrics (
  id, name_ru, name_short_ru, description, metric_type, data_type, formula, dependencies,
  decimal_places, aggregation_fn, category, sort_order,
  is_core, is_hidden_in_ui, is_active, is_test,
  source, agg_fn, agg_field, date_field, filters, tags, fill_ok, calc_ok, is_collect_ok, is_calc_ok
) VALUES
  -- Планы
  ('plan_sales_current_week_day', 'План продаж (на текущий день недели)', 'План прод. (тек. нед)',
   'Дневной план продаж × порядковый рабочий день текущей недели по производственному календарю. В понедельник равен дневному плану.',
   'external', 'money', NULL, ARRAY[]::text[], 0, 'sum', 'Планы', 804,
   false, false, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true),
  ('plan_shipments_current_week_day', 'План отгрузок (на текущий день недели)', 'План отгр. (тек. нед)',
   'Дневной план отгрузок × порядковый рабочий день текущей недели по производственному календарю.',
   'external', 'money', NULL, ARRAY[]::text[], 0, 'sum', 'Планы', 814,
   false, false, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true),
  -- Служебные факты недели (числители процентов)
  ('sales_fact_week', 'Факт продаж с начала недели (служебная)', NULL, NULL,
   'external', 'money', NULL, ARRAY[]::text[], 0, 'sum', 'Планы', 844,
   false, true, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true),
  ('shipments_fact_week', 'Факт отгрузок с начала недели (служебная)', NULL, NULL,
   'external', 'money', NULL, ARRAY[]::text[], 0, 'sum', 'Планы', 845,
   false, true, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true),
  -- Проценты выполнения
  ('plan_exec_pct_sales_current_week_day', 'Выполнение плана продаж, % (на текущий день недели)', '% плана прод. (тек. нед)',
   'Факт продаж с начала недели ÷ план на текущий день недели.',
   'calculated', 'percent', '[sales_fact_week] / [plan_sales_current_week_day] * 100',
   ARRAY['sales_fact_week','plan_sales_current_week_day'], 1, 'avg', 'Планы', 824,
   false, false, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true),
  ('plan_exec_pct_shipments_current_week_day', 'Выполнение плана отгрузок, % (на текущий день недели)', '% плана отгр. (тек. нед)',
   'Факт отгрузок с начала недели ÷ план отгрузок на текущий день недели.',
   'calculated', 'percent', '[shipments_fact_week] / [plan_shipments_current_week_day] * 100',
   ARRAY['shipments_fact_week','plan_shipments_current_week_day'], 1, 'avg', 'Планы', 834,
   false, false, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, description = EXCLUDED.description,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  decimal_places = EXCLUDED.decimal_places, aggregation_fn = EXCLUDED.aggregation_fn,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, is_active = EXCLUDED.is_active;
