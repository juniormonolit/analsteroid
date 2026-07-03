-- Метрики отказов: Бронь → отказ, Подтв. бронь → отказ, Продажа → отказ
-- × (перв. / повт. / все) × (кол-во / сумма / конверсия) = 27 метрик
-- + 5 недостающих базовых знаменателей.
--
-- Семантика: отказ попадает в период по lost_at. Условие перехода — lost_at > x_at
-- (строго после стадии: сделки, вернувшиеся из отказа обратно, не считаются).
-- Оператор gt_field (колонка > колонка) добавлен в lib/metrics/sqlGen.ts.
-- БД: YC analytics (run_analytics.mjs).

-- ── Недостающие базовые знаменатели ─────────────────────────────────────────
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('sales_count', 'Кол-во продаж (все)', 'Продажи (все)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'sold_at',
   '[]'::jsonb, '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'sales', 325, NULL),
  ('repeat_reservations_count', 'Кол-во броней (повт.)', 'Брони (повт.)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'reserved_at',
   '[{"field":"funnel_type","op":"eq","value":"repeat"}]'::jsonb, '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'reservations', 405, NULL),
  ('reservations_count', 'Кол-во броней (все)', 'Брони (все)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'reserved_at',
   '[]'::jsonb, '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'reservations', 406, NULL),
  ('repeat_confirmed_count', 'Кол-во подтв. броней (повт.)', 'Подтв. (повт.)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'confirmed_at',
   '[{"field":"funnel_type","op":"eq","value":"repeat"}]'::jsonb, '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'reservations', 425, NULL),
  ('confirmed_reservations_count', 'Кол-во подтв. броней (все)', 'Подтв. (все)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'confirmed_at',
   '[]'::jsonb, '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'reservations', 426, NULL)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok;

-- ── Отказы: количество (count_distinct deal_id по lost_at) ──────────────────
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('primary_reservation_to_lost_count', 'Бронь → отказ (перв.)', 'Бр→отк (перв.)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"reserved_at"},{"field":"funnel_type","op":"eq","value":"primary"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 700, 'Сделки с бронью, ушедшие в отказ в периоде (lost_at > reserved_at)'),
  ('repeat_reservation_to_lost_count', 'Бронь → отказ (повт.)', 'Бр→отк (повт.)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"reserved_at"},{"field":"funnel_type","op":"eq","value":"repeat"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 701, NULL),
  ('reservation_to_lost_count', 'Бронь → отказ (все)', 'Бр→отк (все)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"reserved_at"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 702, NULL),
  ('primary_confirmed_to_lost_count', 'Подтв. бронь → отказ (перв.)', 'Подтв→отк (перв.)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"confirmed_at"},{"field":"funnel_type","op":"eq","value":"primary"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 703, 'Сделки с подтв. бронью, ушедшие в отказ в периоде (lost_at > confirmed_at)'),
  ('repeat_confirmed_to_lost_count', 'Подтв. бронь → отказ (повт.)', 'Подтв→отк (повт.)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"confirmed_at"},{"field":"funnel_type","op":"eq","value":"repeat"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 704, NULL),
  ('confirmed_to_lost_count', 'Подтв. бронь → отказ (все)', 'Подтв→отк (все)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"confirmed_at"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 705, NULL),
  ('primary_sale_to_lost_count', 'Продажа → отказ (перв.)', 'Прод→отк (перв.)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"sold_at"},{"field":"funnel_type","op":"eq","value":"primary"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 706, 'Проданные сделки, ушедшие в отказ в периоде (lost_at > sold_at)'),
  ('repeat_sale_to_lost_count', 'Продажа → отказ (повт.)', 'Прод→отк (повт.)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"sold_at"},{"field":"funnel_type","op":"eq","value":"repeat"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 707, NULL),
  ('sale_to_lost_count', 'Продажа → отказ (все)', 'Прод→отк (все)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"sold_at"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 708, NULL)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok,
  description = EXCLUDED.description;

-- ── Отказы: суммы (sum(amount) по lost_at) ──────────────────────────────────
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('primary_reservation_to_lost_amount', 'Бронь → отказ, сумма (перв.)', 'Бр→отк ₽ (перв.)', 'collected', 'money', 'deals', 'sum', 'amount', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"reserved_at"},{"field":"funnel_type","op":"eq","value":"primary"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 710, NULL),
  ('repeat_reservation_to_lost_amount', 'Бронь → отказ, сумма (повт.)', 'Бр→отк ₽ (повт.)', 'collected', 'money', 'deals', 'sum', 'amount', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"reserved_at"},{"field":"funnel_type","op":"eq","value":"repeat"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 711, NULL),
  ('reservation_to_lost_amount', 'Бронь → отказ, сумма (все)', 'Бр→отк ₽ (все)', 'collected', 'money', 'deals', 'sum', 'amount', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"reserved_at"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 712, NULL),
  ('primary_confirmed_to_lost_amount', 'Подтв. бронь → отказ, сумма (перв.)', 'Подтв→отк ₽ (перв.)', 'collected', 'money', 'deals', 'sum', 'amount', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"confirmed_at"},{"field":"funnel_type","op":"eq","value":"primary"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 713, NULL),
  ('repeat_confirmed_to_lost_amount', 'Подтв. бронь → отказ, сумма (повт.)', 'Подтв→отк ₽ (повт.)', 'collected', 'money', 'deals', 'sum', 'amount', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"confirmed_at"},{"field":"funnel_type","op":"eq","value":"repeat"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 714, NULL),
  ('confirmed_to_lost_amount', 'Подтв. бронь → отказ, сумма (все)', 'Подтв→отк ₽ (все)', 'collected', 'money', 'deals', 'sum', 'amount', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"confirmed_at"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 715, NULL),
  ('primary_sale_to_lost_amount', 'Продажа → отказ, сумма (перв.)', 'Прод→отк ₽ (перв.)', 'collected', 'money', 'deals', 'sum', 'amount', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"sold_at"},{"field":"funnel_type","op":"eq","value":"primary"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 716, NULL),
  ('repeat_sale_to_lost_amount', 'Продажа → отказ, сумма (повт.)', 'Прод→отк ₽ (повт.)', 'collected', 'money', 'deals', 'sum', 'amount', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"sold_at"},{"field":"funnel_type","op":"eq","value":"repeat"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 717, NULL),
  ('sale_to_lost_amount', 'Продажа → отказ, сумма (все)', 'Прод→отк ₽ (все)', 'collected', 'money', 'deals', 'sum', 'amount', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"sold_at"}]'::jsonb,
   '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 718, NULL)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok;

-- ── Отказы: конверсии (отказы в периоде / входы в стадию в периоде × 100) ───
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('cr_reservation_to_lost_primary', 'CR бронь → отказ (перв.)', 'CR бр→отк (перв.)', 'calculated', 'percent',
   '[primary_reservation_to_lost_count] / [primary_reservations_count] * 100',
   ARRAY['primary_reservation_to_lost_count', 'primary_reservations_count'],
   '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Отказы', 720, NULL),
  ('cr_reservation_to_lost_repeat', 'CR бронь → отказ (повт.)', 'CR бр→отк (повт.)', 'calculated', 'percent',
   '[repeat_reservation_to_lost_count] / [repeat_reservations_count] * 100',
   ARRAY['repeat_reservation_to_lost_count', 'repeat_reservations_count'],
   '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Отказы', 721, NULL),
  ('cr_reservation_to_lost_all', 'CR бронь → отказ (все)', 'CR бр→отк (все)', 'calculated', 'percent',
   '[reservation_to_lost_count] / [reservations_count] * 100',
   ARRAY['reservation_to_lost_count', 'reservations_count'],
   '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Отказы', 722, NULL),
  ('cr_confirmed_to_lost_primary', 'CR подтв. бронь → отказ (перв.)', 'CR подтв→отк (перв.)', 'calculated', 'percent',
   '[primary_confirmed_to_lost_count] / [primary_confirmed_count] * 100',
   ARRAY['primary_confirmed_to_lost_count', 'primary_confirmed_count'],
   '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Отказы', 723, NULL),
  ('cr_confirmed_to_lost_repeat', 'CR подтв. бронь → отказ (повт.)', 'CR подтв→отк (повт.)', 'calculated', 'percent',
   '[repeat_confirmed_to_lost_count] / [repeat_confirmed_count] * 100',
   ARRAY['repeat_confirmed_to_lost_count', 'repeat_confirmed_count'],
   '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Отказы', 724, NULL),
  ('cr_confirmed_to_lost_all', 'CR подтв. бронь → отказ (все)', 'CR подтв→отк (все)', 'calculated', 'percent',
   '[confirmed_to_lost_count] / [confirmed_reservations_count] * 100',
   ARRAY['confirmed_to_lost_count', 'confirmed_reservations_count'],
   '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Отказы', 725, NULL),
  ('cr_sale_to_lost_primary', 'CR продажа → отказ (перв.)', 'CR прод→отк (перв.)', 'calculated', 'percent',
   '[primary_sale_to_lost_count] / [primary_sales_count] * 100',
   ARRAY['primary_sale_to_lost_count', 'primary_sales_count'],
   '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Отказы', 726, NULL),
  ('cr_sale_to_lost_repeat', 'CR продажа → отказ (повт.)', 'CR прод→отк (повт.)', 'calculated', 'percent',
   '[repeat_sale_to_lost_count] / [repeat_sales_count] * 100',
   ARRAY['repeat_sale_to_lost_count', 'repeat_sales_count'],
   '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Отказы', 727, NULL),
  ('cr_sale_to_lost_all', 'CR продажа → отказ (все)', 'CR прод→отк (все)', 'calculated', 'percent',
   '[sale_to_lost_count] / [sales_count] * 100',
   ARRAY['sale_to_lost_count', 'sales_count'],
   '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Отказы', 728, NULL)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  data_type = EXCLUDED.data_type, category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active,
  is_calc_ok = EXCLUDED.is_calc_ok;
