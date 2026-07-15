-- Миграция 101: две новые план-метрики (задача Иосифа, 14.07).
-- «План продаж/отгрузок (на тек. день)» = «План (на сегодня)» × порядковый номер
-- рабочего дня СЕГОДНЯ (МСК) в текущем месяце по производственному календарю.
-- Сама «(на сегодня)» одновременно ПЕРЕОПРЕДЕЛЕНА в коде: теперь «План (месяц)» ÷ 20
-- (константный дневной план), а не накопление по периоду — см.
-- app/api/reports/run/route.ts (каталожные записи «(на сегодня)» не меняются).
-- БД: YC analytics (run_analytics.mjs). Идемпотентна.
INSERT INTO metrics (id, name_ru, metric_type, data_type, decimal_places, aggregation_fn, category, sort_order, is_active, is_hidden_in_ui)
VALUES
  ('plan_sales_current_day',     'План продаж (на тек. день)',   'external', 'money', 0, 'sum', 'Планы', 810, true, false),
  ('plan_shipments_current_day', 'План отгрузок (на тек. день)', 'external', 'money', 0, 'sum', 'Планы', 811, true, false)
ON CONFLICT (id) DO NOTHING;
