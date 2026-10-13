-- Миграция 225: «CR Сделка → Бронь (перв., физлица)» + два служебных числителя/знаменателя
-- БД: YC analytics (таблица metrics). Накат с ноутбука:
--   node migrations/run_local.mjs migrations/225_cr_deal_to_reservation_primary_b2c.sql --db=analytics
--
-- Просьба владельца 13.10: метрика «по аналогии» с «CR Сделка → Бронь (перв.)», но только по
-- физлицам. Фильтры collected-метрики складываются через AND: funnel_type=primary
-- (воронки is_repeat=false) И funnel_type=b2c (воронки 0 и 2, см. sqlGen.ts). Формула та же,
-- что у базовой: брони / сделки * 100. Вариантов «повт.»/«все»/юрлица пока нет —
-- «изначально только по физлицам»; тройку (naming rules) достроим, когда понадобится.
-- Накат безопасен повторно (ON CONFLICT DO UPDATE).

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('primary_b2c_deals_count', 'Кол-во сделок (перв., физлица)', 'Сделки перв. ФЛ', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'created_at',
   '[{"field":"funnel_type","op":"eq","value":"primary"},{"field":"funnel_type","op":"eq","value":"b2c"}]'::jsonb,
   '{}', false, true, true, false, 0, 'sum', false, false, true, false, 'Конверсии', 910,
   'Служебная: первичные сделки физлиц, созданные за период — знаменатель «CR Сделка → Бронь (перв., физлица)»'),
  ('primary_b2c_reservations_count', 'Кол-во броней (перв., физлица)', 'Брони перв. ФЛ', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'reserved_at',
   '[{"field":"funnel_type","op":"eq","value":"primary"},{"field":"funnel_type","op":"eq","value":"b2c"}]'::jsonb,
   '{}', false, true, true, false, 0, 'sum', false, false, true, false, 'Конверсии', 911,
   'Служебная: первичные брони физлиц за период — числитель «CR Сделка → Бронь (перв., физлица)»')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, filters = EXCLUDED.filters, date_field = EXCLUDED.date_field,
  is_active = EXCLUDED.is_active, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('cr_deal_to_reservation_primary_b2c', 'CR Сделка → Бронь (перв., физлица)', 'CR Сд→Бр перв. ФЛ', 'calculated', 'percent',
   '[primary_b2c_reservations_count] / [primary_b2c_deals_count] * 100', ARRAY['primary_b2c_reservations_count','primary_b2c_deals_count'],
   '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Конверсии', 525,
   'Какой % первичных сделок физлиц получил бронь')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  is_active = EXCLUDED.is_active, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order;

SELECT id, name_ru, metric_type, is_hidden_in_ui FROM metrics WHERE id LIKE '%primary_b2c%';
