-- Migration 009: new metrics + unhide repeat metrics

-- Unhide repeat metrics
UPDATE metrics SET is_hidden_in_ui = false
WHERE id IN (
  'repeat_deals_count','repeat_sales_count','repeat_sales_amount',
  'repeat_shipments_count','repeat_shipments_amount'
);

-- New collected metrics
INSERT INTO metrics
  (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies,
   decimal_places, aggregation_fn, category, sort_order, is_core, is_active, is_hidden_in_ui)
VALUES
  ('changed_deals_count',  'Изменено сделок',         'Изменено',   'collected', 'int',    null, '{}', 0, 'sum', 'primary',  13, false, true, false),
  ('primary_deals_amount', 'Сумма перв. сделок',       'Сумма сд.',  'collected', 'money',  null, '{}', 0, 'sum', 'primary',  14, false, true, true),
  ('lost_count',           'Кол-во отказов',           'Отказы',     'collected', 'int',    null, '{}', 0, 'sum', 'primary',  16, true,  true, false),
  ('reservations_amount',  'Сумма броней (перв.)',      'Сумма бр.',  'collected', 'money',  null, '{}', 0, 'sum', 'primary',  21, false, true, false),
  ('confirmed_reservations_amount','Сумма подтв. броней','Сумма п.бр.','collected','money', null, '{}', 0, 'sum', 'primary',  31, false, true, false),
  ('total_reservations_count','Всего броней',           'Бр.все',     'collected', 'int',    null, '{}', 0, 'sum', 'primary',  22, false, true, true)

ON CONFLICT (id) DO UPDATE
  SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
      metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
      formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
      decimal_places = EXCLUDED.decimal_places, aggregation_fn = EXCLUDED.aggregation_fn,
      category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
      is_core = EXCLUDED.is_core, is_active = EXCLUDED.is_active,
      is_hidden_in_ui = EXCLUDED.is_hidden_in_ui;

-- New calculated metrics
INSERT INTO metrics
  (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies,
   decimal_places, aggregation_fn, category, sort_order, is_core, is_active, is_hidden_in_ui)
VALUES
  ('avg_primary_deal_amount',
   'Ср. чек перв. сделок', 'Ср.чек сд.', 'calculated', 'money',
   'primary_deals_amount / primary_deals_count',
   '{primary_deals_amount,primary_deals_count}',
   0, 'none', 'avg', 201, false, true, false),

  ('avg_all_sales_amount',
   'Ср. чек продаж (все)', 'Ср.чек все', 'calculated', 'money',
   '(primary_sales_amount + repeat_sales_amount) / (primary_sales_count + repeat_sales_count)',
   '{primary_sales_amount,repeat_sales_amount,primary_sales_count,repeat_sales_count}',
   0, 'none', 'avg', 202, false, true, false),

  ('repeat_sales_pct',
   '% сумма продаж (повт.)', '% повт.', 'calculated', 'percent',
   'repeat_sales_amount / (primary_sales_amount + repeat_sales_amount) * 100',
   '{repeat_sales_amount,primary_sales_amount}',
   1, 'none', 'repeat', 52, false, true, false),

  ('cr_deal_to_sale',
   'CR сделка/продажа (перв.)', 'CR сд→пр', 'calculated', 'percent',
   'primary_sales_count / primary_deals_count * 100',
   '{primary_sales_count,primary_deals_count}',
   1, 'none', 'cr', 101, true, true, false),

  ('cr_deal_to_reservation',
   'CR сделка/брони (перв.)', 'CR сд→бр', 'calculated', 'percent',
   'reservations_count / primary_deals_count * 100',
   '{reservations_count,primary_deals_count}',
   1, 'none', 'cr', 102, false, true, false),

  ('cr_reservation_to_sale_primary',
   'CR брони/продажи (перв.)', 'CR бр→пр', 'calculated', 'percent',
   'reservations_count / primary_sales_count * 100',
   '{reservations_count,primary_sales_count}',
   1, 'none', 'cr', 103, false, true, false),

  ('reservations_and_sales_amount',
   'Брони + продажи', 'Бр+Пр', 'calculated', 'money',
   'reservations_amount + primary_sales_amount',
   '{reservations_amount,primary_sales_amount}',
   0, 'none', 'primary', 23, false, true, false),

  ('cr_all_reservation_to_sale',
   'CR (брони/перв. продажи)', 'CR бр.все→пр', 'calculated', 'percent',
   'total_reservations_count / primary_sales_count * 100',
   '{total_reservations_count,primary_sales_count}',
   1, 'none', 'cr', 104, false, true, false),

  ('avg_confirmed_reservation_amount',
   'Ср. чек подтв. броней', 'Ср.чек п.бр.', 'calculated', 'money',
   'confirmed_reservations_amount / confirmed_reservations_count',
   '{confirmed_reservations_amount,confirmed_reservations_count}',
   0, 'none', 'avg', 203, false, true, false),

  ('cr_deal_to_confirmation',
   'CR сделка/подтв. брони (перв.)', 'CR сд→п.бр', 'calculated', 'percent',
   'confirmed_reservations_count / primary_deals_count * 100',
   '{confirmed_reservations_count,primary_deals_count}',
   1, 'none', 'cr', 105, false, true, false),

  ('cr_reservation_to_shipment',
   'CR брони → отгрузки (перв.)', 'CR бр→отгр', 'calculated', 'percent',
   'primary_shipments_count / reservations_count * 100',
   '{primary_shipments_count,reservations_count}',
   1, 'none', 'cr', 106, false, true, false),

  ('repeat_shipments_pct',
   '% повторных отгрузок (сумма)', '% повт.отгр', 'calculated', 'percent',
   'repeat_shipments_amount / (primary_shipments_amount + repeat_shipments_amount) * 100',
   '{repeat_shipments_amount,primary_shipments_amount}',
   1, 'none', 'repeat', 72, false, true, false)

ON CONFLICT (id) DO UPDATE
  SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
      metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
      formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
      decimal_places = EXCLUDED.decimal_places, aggregation_fn = EXCLUDED.aggregation_fn,
      category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
      is_core = EXCLUDED.is_core, is_active = EXCLUDED.is_active,
      is_hidden_in_ui = EXCLUDED.is_hidden_in_ui;
