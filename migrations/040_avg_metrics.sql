-- Средний чек отгрузок + фикс всех avg-метрик.
-- БАГ: collected-метрики с agg_fn='avg' ломались об funnel-breakdown — движок суммирует
-- строки по воронкам, т.е. складывал СРЕДНИЕ (июнь: реальный ср. чек продаж перв. 125 471 ₽,
-- движок отдавал 338 999 ₽). Фикс: все ср. чеки → calculated (сумма / количество),
-- корректно на любом уровне агрегации (строки, Итого, дрилл-дауны).
-- БД: YC analytics (run_analytics.mjs).

-- ── Недостающие collected-знаменатели/числители ─────────────────────────────
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('primary_deals_amount', 'Сумма перв. сделок', 'Сумма перв. сд.', 'collected', 'money', 'deals', 'sum', 'amount', 'created_at',
   '[{"field":"funnel_type","op":"eq","value":"primary"}]'::jsonb, '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'deals', 375, NULL),
  ('shipments_count', 'Кол-во отгрузок (все)', 'Отгрузки (все)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'delivered_at',
   '[]'::jsonb, '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'shipments', 505, NULL)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok;

-- ── Конвертация битых avg-метрик в calculated ───────────────────────────────
UPDATE metrics SET metric_type = 'calculated',
  formula = '[primary_sales_amount] / [primary_sales_count]',
  dependencies = ARRAY['primary_sales_amount', 'primary_sales_count'],
  agg_fn = NULL, agg_field = NULL, date_field = NULL, filters = '[]'::jsonb,
  is_calc_ok = true, is_collect_ok = false
WHERE id = 'primary_sales_avg_amount';

UPDATE metrics SET metric_type = 'calculated',
  formula = '([primary_sales_amount] + [repeat_sales_amount]) / [sales_count]',
  dependencies = ARRAY['primary_sales_amount', 'repeat_sales_amount', 'sales_count'],
  agg_fn = NULL, agg_field = NULL, date_field = NULL, filters = '[]'::jsonb,
  is_calc_ok = true, is_collect_ok = false
WHERE id = 'all_sales_avg_amount';

UPDATE metrics SET metric_type = 'calculated',
  formula = '[primary_deals_amount] / [primary_deals_count]',
  dependencies = ARRAY['primary_deals_amount', 'primary_deals_count'],
  agg_fn = NULL, agg_field = NULL, date_field = NULL, filters = '[]'::jsonb,
  is_calc_ok = true, is_collect_ok = false
WHERE id = 'primary_deals_avg_amount';

UPDATE metrics SET metric_type = 'calculated',
  formula = '[primary_confirmed_amount] / [primary_confirmed_count]',
  dependencies = ARRAY['primary_confirmed_amount', 'primary_confirmed_count'],
  agg_fn = NULL, agg_field = NULL, date_field = NULL, filters = '[]'::jsonb,
  is_calc_ok = true, is_collect_ok = false
WHERE id = 'primary_confirmed_avg_amount';

UPDATE metrics SET metric_type = 'calculated',
  formula = '[all_confirmed_amount] / [confirmed_reservations_count]',
  dependencies = ARRAY['all_confirmed_amount', 'confirmed_reservations_count'],
  agg_fn = NULL, agg_field = NULL, date_field = NULL, filters = '[]'::jsonb,
  is_calc_ok = true, is_collect_ok = false
WHERE id = 'all_confirmed_avg_amount';

-- ── Новые: средний чек отгрузок ─────────────────────────────────────────────
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('primary_shipments_avg_amount', 'Ср. чек отгрузок (перв.)', 'Ср. чек отгр. (перв.)', 'calculated', 'money',
   '[primary_shipments_amount] / [primary_shipments_count]',
   ARRAY['primary_shipments_amount', 'primary_shipments_count'],
   '{}', false, true, false, false, 0, 'avg', false, true, false, true, 'shipments', 520, NULL),
  ('all_shipments_avg_amount', 'Ср. чек отгрузок (все)', 'Ср. чек отгр. (все)', 'calculated', 'money',
   '([primary_shipments_amount] + [repeat_shipments_amount]) / [shipments_count]',
   ARRAY['primary_shipments_amount', 'repeat_shipments_amount', 'shipments_count'],
   '{}', false, true, false, false, 0, 'avg', false, true, false, true, 'shipments', 521, NULL)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  data_type = EXCLUDED.data_type, category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active,
  is_calc_ok = EXCLUDED.is_calc_ok;
