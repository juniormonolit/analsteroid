-- Collected metrics

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'repeat_created_count', 'Повторные по дате создания', 'Повт. создан.', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'created_at',
  '[{"field":"funnel_type","op":"eq","value":"repeat"}]'::jsonb,
  '{}', false, true, false, false, 0, 'sum', false, false, true, false,
  'Повторные', 150, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_collect_ok = EXCLUDED.is_collect_ok;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'ppp_count', 'ППП', 'ППП', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'sold_at',
  '[{"field":"stage_type","op":"eq","value":"sale"},{"field":"_ppp","op":"eq","value":""}]'::jsonb,
  '{}', false, true, false, false, 0, 'sum', false, false, true, false,
  'Продажи', 155, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_collect_ok = EXCLUDED.is_collect_ok;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'ppp_amount', 'Сумма ППП', 'Сумма ППП', 'collected', 'money', 'deals', 'sum', 'amount', 'sold_at',
  '[{"field":"stage_type","op":"eq","value":"sale"},{"field":"_ppp","op":"eq","value":""}]'::jsonb,
  '{}', false, true, false, false, 0, 'sum', false, false, true, false,
  'Продажи', 156, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_collect_ok = EXCLUDED.is_collect_ok;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'ppo_count', 'ППО', 'ППО', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'delivered_at',
  '[{"field":"stage_type","op":"eq","value":"shipment"},{"field":"_ppo","op":"eq","value":""}]'::jsonb,
  '{}', false, true, false, false, 0, 'sum', false, false, true, false,
  'Отгрузки', 160, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_collect_ok = EXCLUDED.is_collect_ok;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'ppo_amount', 'Сумма ППО', 'Сумма ППО', 'collected', 'money', 'deals', 'sum', 'amount', 'delivered_at',
  '[{"field":"stage_type","op":"eq","value":"shipment"},{"field":"_ppo","op":"eq","value":""}]'::jsonb,
  '{}', false, true, false, false, 0, 'sum', false, false, true, false,
  'Отгрузки', 161, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_collect_ok = EXCLUDED.is_collect_ok;

-- Calculated metrics

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'cr_deal_to_shipment', 'CR сделка → отгрузка', 'CR д→о', 'calculated', 'percent',
  '[primary_shipments_count] / [primary_deals_count] * 100',
  ARRAY['primary_shipments_count', 'primary_deals_count'],
  '{}', false, true, false, false, 1, 'avg', false, true, false, true,
  'Конверсии', 90, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  data_type = EXCLUDED.data_type, category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order, is_calc_ok = EXCLUDED.is_calc_ok;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'all_sales_amount', 'Всего сумма продаж', 'Всего продаж', 'calculated', 'money',
  '[primary_sales_amount] + [repeat_sales_amount]',
  ARRAY['primary_sales_amount', 'repeat_sales_amount'],
  '{}', false, true, false, false, 0, 'sum', false, true, false, true,
  'Суммы', 200, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  data_type = EXCLUDED.data_type, category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order, is_calc_ok = EXCLUDED.is_calc_ok;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'cr_primary_to_repeat_created', 'CR первичн. → повт. создан.', 'CR п→пов', 'calculated', 'percent',
  '[repeat_created_count] / [primary_sales_count] * 100',
  ARRAY['repeat_created_count', 'primary_sales_count'],
  '{}', false, true, false, false, 1, 'avg', false, true, false, true,
  'Конверсии', 95, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  data_type = EXCLUDED.data_type, category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order, is_calc_ok = EXCLUDED.is_calc_ok;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'cr_repeat_created_to_sale', 'CR повт. создан. → продажа', 'CR пов→прод', 'calculated', 'percent',
  '[repeat_sales_count] / [repeat_created_count] * 100',
  ARRAY['repeat_sales_count', 'repeat_created_count'],
  '{}', false, true, false, false, 1, 'avg', false, true, false, true,
  'Конверсии', 96, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  data_type = EXCLUDED.data_type, category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order, is_calc_ok = EXCLUDED.is_calc_ok;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'ppp_conversion', 'Конверсия ППП', 'CR ППП', 'calculated', 'percent',
  '[ppp_count] / [primary_sales_count] * 100',
  ARRAY['ppp_count', 'primary_sales_count'],
  '{}', false, true, false, false, 1, 'avg', false, true, false, true,
  'Продажи', 157, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  data_type = EXCLUDED.data_type, category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order, is_calc_ok = EXCLUDED.is_calc_ok;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'ppo_conversion', 'Конверсия ППО', 'CR ППО', 'calculated', 'percent',
  '[ppo_count] / [primary_shipments_count] * 100',
  ARRAY['ppo_count', 'primary_shipments_count'],
  '{}', false, true, false, false, 1, 'avg', false, true, false, true,
  'Отгрузки', 162, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  data_type = EXCLUDED.data_type, category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order, is_calc_ok = EXCLUDED.is_calc_ok;

-- External / Plan metrics

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'plan_sales_month', 'План продаж (месяц)', 'План прод.', 'external', 'money',
  NULL, '{}',
  '{}', false, true, false, false, 0, 'sum', false, false, false, false,
  'Планы', 300, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'plan_shipments_month', 'План отгрузок (месяц)', 'План отгр.', 'external', 'money',
  NULL, '{}',
  '{}', false, true, false, false, 0, 'sum', false, false, false, false,
  'Планы', 301, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'plan_sales_today', 'План продаж (на сегодня)', 'План прод. сег.', 'external', 'money',
  NULL, '{}',
  '{}', false, true, false, false, 0, 'sum', false, false, false, false,
  'Планы', 302, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'plan_shipments_today', 'План отгрузок (на сегодня)', 'План отгр. сег.', 'external', 'money',
  NULL, '{}',
  '{}', false, true, false, false, 0, 'sum', false, false, false, false,
  'Планы', 303, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'plan_execution_pct', 'Исполнение плана, %', 'Исп. плана', 'calculated', 'percent',
  '[primary_sales_amount] / [plan_sales_month] * 100',
  ARRAY['primary_sales_amount', 'plan_sales_month'],
  '{}', false, true, false, false, 1, 'avg', false, true, false, true,
  'Планы', 304, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  data_type = EXCLUDED.data_type, category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order, is_calc_ok = EXCLUDED.is_calc_ok;
