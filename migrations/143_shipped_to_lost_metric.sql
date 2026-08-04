-- Задача #2992, продолжение (владелец 04.08, дословно: «Заведи отгрузка отказ.
-- Пусть будет. В остальном пока ничего не трогаем (конверсии стадий)»).
--
-- Закрывает «дыру» из отчёта owners-inbox/otkaz-iz-broni-fix-2992.html: после
-- фикса миграции 141 (прямые переходы вместо «lost_at позже X») сделки, дошедшие
-- до ОТГРУЗКИ и только потом получившие отказ, не попадали ни в одну из трёх
-- метрик семейства «В отказ из X» (11 сделок за июль 2026). Своей метрики
-- «Отгрузка → отказ» не было — заводим её тем же принципом прямого перехода,
-- что и остальные три (migrations/034_refusal_metrics.sql,
-- migrations/141_refusal_metrics_direct_transition.sql), однородный набор:
-- кол-во/сумма × перв./повт./все + CR%.
--
-- Отгрузка (delivered_at) — ТЕРМИНАЛЬНАЯ стадия в этом семействе (после неё в
-- deals-колонках отслеживаемых стадий нет — см. STAGE_GROUPS в
-- features/reports/engine/stageConversions.ts, комментарий у STAGE_PAIRS:
-- «без "Отгрузка → Отказ" — терминальный успех»). Поэтому фильтр — ПРОСТОЙ
-- gt_field (lost_at > delivered_at), БЕЗ gt_field_or_null-проверок на более
-- позднюю стадию: проверять после отгрузки нечего, новый код в sqlGen.ts не
-- нужен — оператор gt_field уже существовал до задачи 2992.
--
-- Денежный знаменатель CR% — уже существующие shipments_count/
-- primary_shipments_count/repeat_shipments_count (категория «Отгрузки»,
-- date_field=delivered_at) — тот же паттерн, что cr_sale_to_lost_all делит на
-- sales_count.

-- ── Отгрузка → отказ: количество ────────────────────────────────────────────
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('primary_shipped_to_lost_count', 'Отгрузка → отказ (перв.)', 'Отгр→отк (перв.)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"delivered_at"},{"field":"funnel_type","op":"eq","value":"primary"}]'::jsonb,
   '{refusals,transitions}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 650, 'Отгруженные сделки, ушедшие в отказ в периоде (lost_at > delivered_at) — прямой переход, задача 2992'),
  ('repeat_shipped_to_lost_count', 'Отгрузка → отказ (повт.)', 'Отгр→отк (повт.)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"delivered_at"},{"field":"funnel_type","op":"eq","value":"repeat"}]'::jsonb,
   '{refusals,transitions}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 651, NULL),
  ('shipped_to_lost_count', 'Отгрузка → отказ (все)', 'Отгр→отк (все)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"delivered_at"}]'::jsonb,
   '{refusals,transitions}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 652, 'Отгруженные сделки, ушедшие в отказ в периоде (lost_at > delivered_at) — прямой переход, задача 2992')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters, tags = EXCLUDED.tags,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok,
  description = EXCLUDED.description;

-- ── Отгрузка → отказ: сумма ──────────────────────────────────────────────────
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('primary_shipped_to_lost_amount', 'Отгрузка → отказ, сумма (перв.)', 'Отгр→отк ₽ (перв.)', 'collected', 'money', 'deals', 'sum', 'amount', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"delivered_at"},{"field":"funnel_type","op":"eq","value":"primary"}]'::jsonb,
   '{refusals,transitions}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 653, NULL),
  ('repeat_shipped_to_lost_amount', 'Отгрузка → отказ, сумма (повт.)', 'Отгр→отк ₽ (повт.)', 'collected', 'money', 'deals', 'sum', 'amount', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"delivered_at"},{"field":"funnel_type","op":"eq","value":"repeat"}]'::jsonb,
   '{refusals,transitions}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 654, NULL),
  ('shipped_to_lost_amount', 'Отгрузка → отказ, сумма (все)', 'Отгр→отк ₽ (все)', 'collected', 'money', 'deals', 'sum', 'amount', 'lost_at',
   '[{"field":"lost_at","op":"gt_field","value":"delivered_at"}]'::jsonb,
   '{refusals,transitions}', false, true, false, false, 0, 'sum', false, false, true, false, 'Отказы', 655, NULL)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters, tags = EXCLUDED.tags,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok;

-- ── Отгрузка → отказ: конверсия (отказы в периоде / отгрузки в периоде × 100) ─
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('cr_shipped_to_lost_primary', 'CR отгрузка → отказ (перв.)', 'CR отгр→отк (перв.)', 'calculated', 'percent',
   '[primary_shipped_to_lost_count] / [primary_shipments_count] * 100',
   ARRAY['primary_shipped_to_lost_count', 'primary_shipments_count'],
   '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Отказы', 656, NULL),
  ('cr_shipped_to_lost_repeat', 'CR отгрузка → отказ (повт.)', 'CR отгр→отк (повт.)', 'calculated', 'percent',
   '[repeat_shipped_to_lost_count] / [repeat_shipments_count] * 100',
   ARRAY['repeat_shipped_to_lost_count', 'repeat_shipments_count'],
   '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Отказы', 657, NULL),
  ('cr_shipped_to_lost_all', 'CR отгрузка → отказ (все)', 'CR отгр→отк (все)', 'calculated', 'percent',
   '[shipped_to_lost_count] / [shipments_count] * 100',
   ARRAY['shipped_to_lost_count', 'shipments_count'],
   '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Отказы', 658, NULL)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  data_type = EXCLUDED.data_type, category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active,
  is_calc_ok = EXCLUDED.is_calc_ok;
