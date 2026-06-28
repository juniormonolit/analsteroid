-- New collected: first-time sales that had confirmed_at (confirmed_at IS NOT NULL)
INSERT INTO metrics (
  id, name_ru, name_short_ru, metric_type, data_type,
  source, agg_fn, agg_field, date_field, filters, tags,
  is_core, is_active, is_hidden_in_ui, is_test,
  decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok,
  category, sort_order, description
) VALUES (
  'primary_confirmed_sales_count',
  'Кол-во продаж из подтв. броней (перв.)', 'Прод. из подтв.',
  'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'sold_at',
  '[{"field":"funnel_type","op":"eq","value":"primary"},{"field":"confirmed_at","op":"is_not_null","value":""}]'::jsonb,
  '{}', false, true, true, false,
  0, 'sum', false, false, true, false,
  'cr', 645, NULL
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn,
  agg_field = EXCLUDED.agg_field, date_field = EXCLUDED.date_field,
  filters = EXCLUDED.filters, is_collect_ok = EXCLUDED.is_collect_ok;

-- Fix cr_confirmed_to_sale: denominator = sales that went through confirmed, not all confirmed
UPDATE metrics
SET
  formula = '[primary_confirmed_sales_count] / [primary_confirmed_count] * 100',
  dependencies = ARRAY['primary_confirmed_sales_count', 'primary_confirmed_count']
WHERE id = 'cr_confirmed_to_sale';
