-- Migration 174: когортный LTV, времена и активность базы — в раздел «Клиенты»
-- БД: YC analytics (таблица metrics). Накат с ноутбука:
--   node migrations/run_local.mjs migrations/174_ltv_cohorts_and_activity.sql --db=analytics
--
-- Четвёртая и пятая пачки метрик владельца (10.08.2026). Как и раньше, бОльшая
-- часть семьи уже была в каталоге (cohort_*, ТЗ #1725) и была мертва: external
-- без движка. Теперь всё считает features/reports/engine/clientMetrics.ts.
--
-- ── РЕШЕНИЯ ВЛАДЕЛЬЦА (10.08, явные ответы) ─────────────────────────────────
--   1. КОГОРТА = клиенты, чья ПЕРВАЯ товарная отгрузка попала в период
--      (классика: клиент навсегда в одной когорте, месяцы сравнимы).
--   2. Популяция ВСЕХ сумм LTV-блока и знаменатель средних — ПОВТОРНЫЕ клиенты
--      когорты (2+ товарные отгрузки за всю историю).
--   3. Незрелые окна — NULL, пока окно не прожито всей когортой (иначе LTV 360
--      свежего месяца выглядит катастрофой рядом с прошлогодним и читается как
--      падение бизнеса). «За всё время» показывается всегда.
--
-- LTV-суммы накопительные и ВКЛЮЧАЮТ первый заказ (пример владельца: первая
-- отгрузка 100 тыс., всего миллион → коэффициент 10 = всё/первая).
--
-- «Клиентов в когорте» отдельно НЕ нужно: это ровно уже живая new_clients_count
-- (та же популяция) — cohort_clients гасится как дубль.
--
-- ДЕАКТИВАЦИИ (is_active=false, определения в metrics_backup_174):
--   * cohort_clients — дубль new_clients_count;
--   * cohort_return_rate_30..360 — владелец не заказывал, движка нет; вернуть
--     легко, если попросит (движок рядом, популяция та же);
--   * cohort_repeat_ratio_30..360 — владелец попросил ОДИН коэффициент
--     (всё время / первый заказ), пять оконных остаются в резерве.

BEGIN;

CREATE TABLE IF NOT EXISTS metrics_backup_174 AS SELECT * FROM metrics WHERE false;
INSERT INTO metrics_backup_174
  SELECT * FROM metrics
   WHERE (id LIKE 'cohort%' OR id IN ('median_cycle_time_days', 'median_client_lifetime_months'))
     AND NOT EXISTS (SELECT 1 FROM metrics_backup_174);

-- ── 1. Деактивации ───────────────────────────────────────────────────────────
UPDATE metrics SET is_active = false, is_hidden_in_ui = true
 WHERE id IN ('cohort_clients',
   'cohort_return_rate_30', 'cohort_return_rate_60', 'cohort_return_rate_90',
   'cohort_return_rate_180', 'cohort_return_rate_360',
   'cohort_repeat_ratio_30', 'cohort_repeat_ratio_60', 'cohort_repeat_ratio_90',
   'cohort_repeat_ratio_180', 'cohort_repeat_ratio_360');

-- ── 2. Пятая пачка: первая повторная + активные ──────────────────────────────
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source,
  agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui,
  is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok,
  category, sort_order, description)
VALUES
  ('first_repeat_clients', 'Повторно купившие впервые (кол-во)', 'Впервые повторно', 'external', 'int', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients}', false, true, false, false, 0, 'sum', false, false, false, false,
   'Клиенты', 1422,
   'Клиенты, чья ВТОРАЯ товарная отгрузка (первая повторная) попала в период. Не путать с «Купившие повторно»: там любая повторная отгрузка в периоде, здесь — именно момент, когда клиент впервые вернулся.'),
  ('active_clients_90d', 'Активные компании (отгрузка за 90 дней)', 'Активные 90 дн', 'external', 'int', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients}', false, true, false, false, 0, 'none', false, false, false, false,
   'Клиенты', 1423,
   'Клиенты с хотя бы одной товарной отгрузкой за 90 дней до конца периода (в отчёте по периодам — до конца каждого бакета). Снимок живой базы на дату, поэтому в «Итого» не суммируется — там своё окно от конца периода.')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui,
  aggregation_fn = EXCLUDED.aggregation_fn, description = EXCLUDED.description;

-- ── 3. Когортный блок: повторные, выручка первого, LTV-суммы ─────────────────
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source,
  agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui,
  is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok,
  category, sort_order, description)
VALUES
  ('cohort_repeat_clients', 'Количество повторных клиентов (2+ заказов)', 'Повторных (2+)', 'external', 'int', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients,cohort}', false, true, false, false, 0, 'sum', false, false, false, false,
   'Клиенты', 1424,
   'Клиенты когорты (первая товарная отгрузка в периоде) с 2+ отгрузками за всю историю. Популяция всего LTV-блока: суммы и средние ниже считаются по этим клиентам.'),
  ('cohort_ltv_total_revenue', 'LTV за все время', 'LTV всё', 'external', 'money', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients,cohort}', false, true, false, false, 0, 'sum', false, false, false, false,
   'Клиенты', 1431,
   'Сумма всех товарных отгрузок повторных клиентов когорты за всю историю (включая первый заказ).')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, description = EXCLUDED.description;

UPDATE metrics SET category = 'Клиенты', sort_order = 1425, is_hidden_in_ui = false,
  name_ru = 'Выручка первого заказа', name_short_ru = 'Выручка 1-го',
  description = 'Сумма исторически первых товарных отгрузок повторных клиентов когорты (2+ заказов). Знаменатель «Коэффициента повторной выручки».'
  WHERE id = 'cohort_first_revenue';

-- LTV-суммы: прежние «Повторная выручка N дн» (после первой, мертвы) → «LTV за N дней»
-- (накопительно ОТ первой отгрузки, ВКЛЮЧАЯ её, по повторным клиентам когорты).
UPDATE metrics SET category = 'Клиенты', is_hidden_in_ui = false,
  name_ru = 'LTV за 30 дней', name_short_ru = 'LTV 30', sort_order = 1426,
  description = 'Сумма товарных отгрузок повторных клиентов когорты в течение 30 дней от их первой отгрузки (включая её). Пусто, пока окно не прожито всей когортой (конец периода + 30 дней ещё не наступил).'
  WHERE id = 'cohort_repeat_revenue_30';
UPDATE metrics SET category = 'Клиенты', is_hidden_in_ui = false,
  name_ru = 'LTV за 60 дней', name_short_ru = 'LTV 60', sort_order = 1427,
  description = 'То же, что LTV за 30 дней, окно 60 дней (накопительно).' WHERE id = 'cohort_repeat_revenue_60';
UPDATE metrics SET category = 'Клиенты', is_hidden_in_ui = false,
  name_ru = 'LTV за 90 дней', name_short_ru = 'LTV 90', sort_order = 1428,
  description = 'То же, что LTV за 30 дней, окно 90 дней (накопительно).' WHERE id = 'cohort_repeat_revenue_90';
UPDATE metrics SET category = 'Клиенты', is_hidden_in_ui = false,
  name_ru = 'LTV за 180 дней', name_short_ru = 'LTV 180', sort_order = 1429,
  description = 'То же, что LTV за 30 дней, окно 180 дней (накопительно).' WHERE id = 'cohort_repeat_revenue_180';
UPDATE metrics SET category = 'Клиенты', is_hidden_in_ui = false,
  name_ru = 'LTV за 360 дней', name_short_ru = 'LTV 360', sort_order = 1430,
  description = 'То же, что LTV за 30 дней, окно 360 дней (накопительно).' WHERE id = 'cohort_repeat_revenue_360';

-- ── 4. Коэффициент и средние — calculated от сумм движка ─────────────────────
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula,
  dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places,
  aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('cohort_repeat_ratio', 'Коэффициент повторной выручки', 'Коэфф. повт.', 'calculated', 'decimal',
   '[cohort_ltv_total_revenue] / [cohort_first_revenue]',
   ARRAY['cohort_ltv_total_revenue', 'cohort_first_revenue'],
   '{clients,cohort}', false, true, false, false, 2, 'avg', false, true, false, true, 'Клиенты', 1432,
   'Во сколько раз вся выручка повторных клиентов когорты превышает их первые заказы. Пример владельца: первый заказ 100 тыс., всего миллион — коэффициент 10.')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, description = EXCLUDED.description;

-- Прежние cohort_ltv_N (среднее на клиента, external, мертвы) → calculated от сумм.
UPDATE metrics SET metric_type = 'calculated', data_type = 'money', decimal_places = 0,
  category = 'Клиенты', is_hidden_in_ui = false, calc_ok = true, is_calc_ok = true,
  aggregation_fn = 'avg', agg_fn = NULL, agg_field = NULL, date_field = NULL, filters = '[]'::jsonb,
  name_ru = 'LTV за 30 дней (среднее)', name_short_ru = 'LTV 30 ср.', sort_order = 1433,
  formula = '[cohort_repeat_revenue_30] / [cohort_repeat_clients]',
  dependencies = ARRAY['cohort_repeat_revenue_30', 'cohort_repeat_clients'],
  description = 'LTV за 30 дней на одного повторного клиента когорты (решение владельца: делить именно на повторных 2+, суммы тоже по ним). Пусто, пока окно не прожито.'
  WHERE id = 'cohort_ltv_30';
UPDATE metrics SET metric_type = 'calculated', data_type = 'money', decimal_places = 0,
  category = 'Клиенты', is_hidden_in_ui = false, calc_ok = true, is_calc_ok = true,
  aggregation_fn = 'avg', agg_fn = NULL, agg_field = NULL, date_field = NULL, filters = '[]'::jsonb,
  name_ru = 'LTV за 60 дней (среднее)', name_short_ru = 'LTV 60 ср.', sort_order = 1434,
  formula = '[cohort_repeat_revenue_60] / [cohort_repeat_clients]',
  dependencies = ARRAY['cohort_repeat_revenue_60', 'cohort_repeat_clients'],
  description = 'То же, окно 60 дней.' WHERE id = 'cohort_ltv_60';
UPDATE metrics SET metric_type = 'calculated', data_type = 'money', decimal_places = 0,
  category = 'Клиенты', is_hidden_in_ui = false, calc_ok = true, is_calc_ok = true,
  aggregation_fn = 'avg', agg_fn = NULL, agg_field = NULL, date_field = NULL, filters = '[]'::jsonb,
  name_ru = 'LTV за 90 дней (среднее)', name_short_ru = 'LTV 90 ср.', sort_order = 1435,
  formula = '[cohort_repeat_revenue_90] / [cohort_repeat_clients]',
  dependencies = ARRAY['cohort_repeat_revenue_90', 'cohort_repeat_clients'],
  description = 'То же, окно 90 дней.' WHERE id = 'cohort_ltv_90';
UPDATE metrics SET metric_type = 'calculated', data_type = 'money', decimal_places = 0,
  category = 'Клиенты', is_hidden_in_ui = false, calc_ok = true, is_calc_ok = true,
  aggregation_fn = 'avg', agg_fn = NULL, agg_field = NULL, date_field = NULL, filters = '[]'::jsonb,
  name_ru = 'LTV за 180 дней (среднее)', name_short_ru = 'LTV 180 ср.', sort_order = 1436,
  formula = '[cohort_repeat_revenue_180] / [cohort_repeat_clients]',
  dependencies = ARRAY['cohort_repeat_revenue_180', 'cohort_repeat_clients'],
  description = 'То же, окно 180 дней.' WHERE id = 'cohort_ltv_180';
UPDATE metrics SET metric_type = 'calculated', data_type = 'money', decimal_places = 0,
  category = 'Клиенты', is_hidden_in_ui = false, calc_ok = true, is_calc_ok = true,
  aggregation_fn = 'avg', agg_fn = NULL, agg_field = NULL, date_field = NULL, filters = '[]'::jsonb,
  name_ru = 'LTV за 360 дней (среднее)', name_short_ru = 'LTV 360 ср.', sort_order = 1437,
  formula = '[cohort_repeat_revenue_360] / [cohort_repeat_clients]',
  dependencies = ARRAY['cohort_repeat_revenue_360', 'cohort_repeat_clients'],
  description = 'То же, окно 360 дней.' WHERE id = 'cohort_ltv_360';
UPDATE metrics SET metric_type = 'calculated', data_type = 'money', decimal_places = 0,
  category = 'Клиенты', is_hidden_in_ui = false, calc_ok = true, is_calc_ok = true,
  aggregation_fn = 'avg', agg_fn = NULL, agg_field = NULL, date_field = NULL, filters = '[]'::jsonb,
  name_ru = 'LTV за все время (среднее)', name_short_ru = 'LTV всё ср.', sort_order = 1438,
  formula = '[cohort_ltv_total_revenue] / [cohort_repeat_clients]',
  dependencies = ARRAY['cohort_ltv_total_revenue', 'cohort_repeat_clients'],
  description = 'Вся выручка повторных клиентов когорты на одного повторного клиента.'
  WHERE id = 'cohort_ltv_total';

-- ── 5. Времена: живой движок вместо замороженной таблицы / нового определения ─
UPDATE metrics SET category = 'Клиенты', sort_order = 1439, decimal_places = 1, is_hidden_in_ui = false,
  name_ru = 'Время от заявки до отгрузки, дни', name_short_ru = 'Заявка→отгрузка',
  description = 'Медиана дней между created_at и delivered_at по товарным отгрузкам периода. Раньше считалась по замороженной rop.analsteroid_deal_metrics и не имела движка — теперь живьём.'
  WHERE id = 'median_cycle_time_days';
UPDATE metrics SET category = 'Клиенты', sort_order = 1440, decimal_places = 1, is_hidden_in_ui = false,
  name_ru = 'Время жизни клиента, мес', name_short_ru = 'Жизнь клиента',
  description = 'Медиана по клиентам периода: от первой created_at любой сделки клиента до его последней товарной отгрузки, в месяцах (30,44 дня). Определение владельца 10.08; прежнее (до now() при открытой сделке) — в metrics_backup_174.'
  WHERE id = 'median_client_lifetime_months';

COMMIT;
