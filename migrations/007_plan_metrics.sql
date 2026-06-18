-- Add plan_amount and plan_pct metrics
INSERT INTO metrics
  (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies,
   decimal_places, aggregation_fn, category, sort_order, is_core, is_active, is_hidden_in_ui)
VALUES
  ('plan_amount', 'План продаж', 'План', 'collected', 'money', null, '{}',
   0, 'sum', 'primary', 55, true, true, false),

  ('plan_pct', '% плана', '% плана', 'calculated', 'percent',
   'primary_sales_amount / plan_amount * 100',
   '{primary_sales_amount,plan_amount}',
   1, 'none', 'primary', 56, true, true, false)

ON CONFLICT (id) DO UPDATE
  SET name_ru         = EXCLUDED.name_ru,
      name_short_ru   = EXCLUDED.name_short_ru,
      metric_type     = EXCLUDED.metric_type,
      data_type       = EXCLUDED.data_type,
      formula         = EXCLUDED.formula,
      dependencies    = EXCLUDED.dependencies,
      decimal_places  = EXCLUDED.decimal_places,
      aggregation_fn  = EXCLUDED.aggregation_fn,
      category        = EXCLUDED.category,
      sort_order      = EXCLUDED.sort_order,
      is_core         = EXCLUDED.is_core,
      is_active       = EXCLUDED.is_active,
      is_hidden_in_ui = EXCLUDED.is_hidden_in_ui;
