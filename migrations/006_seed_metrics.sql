-- Seed metrics catalog (analytics DB)
-- Based on v1 Смекалочная catalog

INSERT INTO metrics
  (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies,
   decimal_places, aggregation_fn, category, sort_order, is_core, is_active, is_hidden_in_ui)
VALUES
  -- === COLLECTED — первичные ===
  ('primary_deals_count',   'Первичных сделок',   'Сделки',   'collected', 'int',     null, '{}', 0, 'sum', 'primary',  10, true,  true, false),
  ('incoming_deals_count',  'Входящих сделок',    'Входящих', 'collected', 'int',     null, '{}', 0, 'sum', 'primary',  11, false, true, true),  -- alias, hidden
  ('called_deals_count',    'Созвонился',         'Созвонов', 'collected', 'int',     null, '{}', 0, 'sum', 'primary',  15, false, true, true),  -- technical
  ('reservations_count',    'Брони',              'Брони',    'collected', 'int',     null, '{}', 0, 'sum', 'primary',  20, true,  true, false),
  ('confirmed_reservations_count', 'Подтв. брони', 'Подтв.',  'collected', 'int',     null, '{}', 0, 'sum', 'primary',  30, true,  true, false),
  ('primary_sales_count',   'Продаж (шт)',        'Продажи',  'collected', 'int',     null, '{}', 0, 'sum', 'primary',  40, true,  true, false),
  ('primary_sales_amount',  'Сумма продаж',       'Сумма',    'collected', 'money',   null, '{}', 0, 'sum', 'primary',  50, true,  true, false),
  ('primary_shipments_count','Отгрузок (шт)',     'Отгрузки', 'collected', 'int',     null, '{}', 0, 'sum', 'primary',  60, true,  true, false),
  ('primary_shipments_amount','Сумма отгрузок',   'Отгр.',    'collected', 'money',   null, '{}', 0, 'sum', 'primary',  70, true,  true, false),

  -- === COLLECTED — повторные (hidden, via dealScope) ===
  ('repeat_deals_count',    'Повторных сделок',   'Повт.',    'collected', 'int',     null, '{}', 0, 'sum', 'repeat',   12, false, true, true),
  ('repeat_sales_count',    'Продаж повт. (шт)',  'Повт.',    'collected', 'int',     null, '{}', 0, 'sum', 'repeat',   41, false, true, true),
  ('repeat_sales_amount',   'Сумма продаж повт.', 'Повт.',    'collected', 'money',   null, '{}', 0, 'sum', 'repeat',   51, false, true, true),
  ('repeat_shipments_count','Отгрузок повт. (шт)','Повт.',    'collected', 'int',     null, '{}', 0, 'sum', 'repeat',   61, false, true, true),
  ('repeat_shipments_amount','Сумма отгр. повт.', 'Повт.',    'collected', 'money',   null, '{}', 0, 'sum', 'repeat',   71, false, true, true),

  -- === CALCULATED — CR и конверсии ===
  ('cr_called',        'CR обзвона',    'CR звон.',  'calculated', 'percent',
    'called_deals_count / primary_deals_count * 100',
    '{called_deals_count,primary_deals_count}',         1, 'none', 'cr',  100, true,  true, false),

  ('cr_reservation',   'CR брони',      'CR брони',  'calculated', 'percent',
    'reservations_count / called_deals_count * 100',
    '{reservations_count,called_deals_count}',          1, 'none', 'cr',  110, true,  true, false),

  ('cr_confirmation',  'CR подтв.',     'CR подтв.', 'calculated', 'percent',
    'confirmed_reservations_count / reservations_count * 100',
    '{confirmed_reservations_count,reservations_count}',1, 'none', 'cr',  120, true,  true, false),

  ('cr_sale',          'CR продажи',    'CR прод.',  'calculated', 'percent',
    'primary_sales_count / confirmed_reservations_count * 100',
    '{primary_sales_count,confirmed_reservations_count}',1,'none', 'cr',  130, true,  true, false),

  ('cr_shipment',      'CR отгрузки',   'CR отгр.',  'calculated', 'percent',
    'primary_shipments_count / primary_sales_count * 100',
    '{primary_shipments_count,primary_sales_count}',    1, 'none', 'cr',  140, false, true, false),

  ('avg_deal_amount',  'Средний чек',   'Ср. чек',   'calculated', 'money',
    'primary_sales_amount / primary_sales_count',
    '{primary_sales_amount,primary_sales_count}',       0, 'none', 'avg', 200, true,  true, false)

ON CONFLICT (id) DO UPDATE
  SET name_ru              = EXCLUDED.name_ru,
      name_short_ru        = EXCLUDED.name_short_ru,
      metric_type          = EXCLUDED.metric_type,
      data_type            = EXCLUDED.data_type,
      formula              = EXCLUDED.formula,
      dependencies         = EXCLUDED.dependencies,
      decimal_places       = EXCLUDED.decimal_places,
      aggregation_fn       = EXCLUDED.aggregation_fn,
      category             = EXCLUDED.category,
      sort_order           = EXCLUDED.sort_order,
      is_core              = EXCLUDED.is_core,
      is_active            = EXCLUDED.is_active,
      is_hidden_in_ui      = EXCLUDED.is_hidden_in_ui;
