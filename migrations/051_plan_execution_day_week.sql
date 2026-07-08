-- Пункты 5 + 11 согласованной спеки (analsteroid-edits-spec-agreed-20260708.md):
-- метрики «Выполнение плана продаж/отгрузок, %» в вариантах (день)/(неделя)/(месяц).
-- БД: YC analytics (таблица metrics).
--
-- Формулы (period-relative, вариант «б»): as-of = конец периода отчёта, либо сегодня,
-- если период его включает. День/неделя считаются от сервера (app/api/reports/run) —
-- он инжектит per-row helper-поля (sales_fact_mtd/wtd, shipments_fact_mtd/wtd,
-- plan_sales_target_mtd/wtd, plan_shipments_target_mtd/wtd) в row.metrics ДО вызова
-- computeCalculated. Здесь регистрируем сами helper-поля как СКРЫТЫЕ external+sum
-- метрики — иначе строка «Итого» (computeTotals) не просуммирует их по менеджерам
-- и день/неделя в totals будут пустыми (как это уже работает для plan_sales_month
-- и plan_execution_pct).
--
-- Существующая 'plan_execution_pct' (id/ключ СОХРАНЁН — не ломает сохранённые отчёты)
-- переименовывается в "(месяц)"-вариант продаж; её formula/dependencies НЕ трогаем —
-- ядро существующего расчёта (только primary_sales_amount, без repeat — таково
-- фактическое поведение на проде сейчас) остаётся как есть.
-- Аддитивно: НЕ трогаем ничего, кроме name_ru/name_short_ru у plan_execution_pct.

UPDATE metrics SET
  name_ru       = 'Выполнение плана продаж, % (месяц)',
  name_short_ru = 'Вып.плана прод.(мес)'
WHERE id = 'plan_execution_pct';

-- Скрытые helper-метрики (external, agg='sum' — чтобы суммировались в totals).
-- Не показываются в панели метрик (is_hidden_in_ui=true), их считает сервер отчётов.
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('sales_fact_mtd', 'Факт продаж с начала месяца (служебная)', NULL, 'external', 'money', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, false, false, 'Планы', 810, 'Служебное поле для метрик «Выполнение плана продаж, % (день)». Инжектится app/api/reports/run.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('sales_fact_wtd', 'Факт продаж с начала недели (служебная)', NULL, 'external', 'money', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, false, false, 'Планы', 811, 'Служебное поле для метрик «Выполнение плана продаж, % (неделя)». Инжектится app/api/reports/run.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('shipments_fact_mtd', 'Факт отгрузок с начала месяца (служебная)', NULL, 'external', 'money', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, false, false, 'Планы', 812, 'Служебное поле для метрик «Выполнение плана отгрузок, % (день)». Инжектится app/api/reports/run.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('shipments_fact_wtd', 'Факт отгрузок с начала недели (служебная)', NULL, 'external', 'money', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, false, false, 'Планы', 813, 'Служебное поле для метрик «Выполнение плана отгрузок, % (неделя)». Инжектится app/api/reports/run.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('plan_sales_target_mtd', 'Таргет продаж MTD (служебная)', NULL, 'external', 'money', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, false, false, 'Планы', 814, 'Дневной_план × прошедшие будни месяца до as-of. Инжектится app/api/reports/run.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('plan_sales_target_wtd', 'Таргет продаж WTD (служебная)', NULL, 'external', 'money', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, false, false, 'Планы', 815, 'Дневной_план × прошедшие будни недели до as-of. Инжектится app/api/reports/run.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('plan_shipments_target_mtd', 'Таргет отгрузок MTD (служебная)', NULL, 'external', 'money', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, false, false, 'Планы', 816, 'Дневной_план × прошедшие будни месяца до as-of. Инжектится app/api/reports/run.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('plan_shipments_target_wtd', 'Таргет отгрузок WTD (служебная)', NULL, 'external', 'money', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, false, false, 'Планы', 817, 'Дневной_план × прошедшие будни недели до as-of. Инжектится app/api/reports/run.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active;

-- 5 новых видимых catalog-метрик, категория «Планы» (вместе с переименованной выше —
-- итого 6, как требует спека). Формула отгрузок (месяц) симметрична фактической формуле
-- продаж (месяц) — тот же паттерн "факт выбранного периода / план месяца", primary-only,
-- БЕЗ repeat (как реально работает существующая 'plan_execution_pct' на проде сейчас).

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('plan_execution_pct_shipments_month', 'Выполнение плана отгрузок, % (месяц)', 'Вып.плана отгр.(мес)', 'calculated', 'percent',
  '[primary_shipments_amount] / [plan_shipments_month] * 100',
  ARRAY['primary_shipments_amount', 'plan_shipments_month'],
  '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Планы', 805, NULL)
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, data_type = EXCLUDED.data_type, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_calc_ok = EXCLUDED.is_calc_ok, is_active = EXCLUDED.is_active;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('plan_execution_pct_sales_day', 'Выполнение плана продаж, % (день)', 'Вып.плана прод.(день)', 'calculated', 'percent',
  '[sales_fact_mtd] / [plan_sales_target_mtd] * 100',
  ARRAY['sales_fact_mtd', 'plan_sales_target_mtd', 'plan_sales_month'],
  '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Планы', 806, NULL)
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, data_type = EXCLUDED.data_type, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_calc_ok = EXCLUDED.is_calc_ok, is_active = EXCLUDED.is_active;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('plan_execution_pct_sales_week', 'Выполнение плана продаж, % (неделя)', 'Вып.плана прод.(нед)', 'calculated', 'percent',
  '[sales_fact_wtd] / [plan_sales_target_wtd] * 100',
  ARRAY['sales_fact_wtd', 'plan_sales_target_wtd', 'plan_sales_month'],
  '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Планы', 807, NULL)
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, data_type = EXCLUDED.data_type, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_calc_ok = EXCLUDED.is_calc_ok, is_active = EXCLUDED.is_active;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('plan_execution_pct_shipments_day', 'Выполнение плана отгрузок, % (день)', 'Вып.плана отгр.(день)', 'calculated', 'percent',
  '[shipments_fact_mtd] / [plan_shipments_target_mtd] * 100',
  ARRAY['shipments_fact_mtd', 'plan_shipments_target_mtd', 'plan_shipments_month'],
  '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Планы', 808, NULL)
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, data_type = EXCLUDED.data_type, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_calc_ok = EXCLUDED.is_calc_ok, is_active = EXCLUDED.is_active;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('plan_execution_pct_shipments_week', 'Выполнение плана отгрузок, % (неделя)', 'Вып.плана отгр.(нед)', 'calculated', 'percent',
  '[shipments_fact_wtd] / [plan_shipments_target_wtd] * 100',
  ARRAY['shipments_fact_wtd', 'plan_shipments_target_wtd', 'plan_shipments_month'],
  '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Планы', 809, NULL)
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, data_type = EXCLUDED.data_type, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_calc_ok = EXCLUDED.is_calc_ok, is_active = EXCLUDED.is_active;
