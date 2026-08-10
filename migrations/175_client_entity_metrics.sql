-- Migration 175: сущность «Клиент» + клиентские, долевые и «покупательские» метрики
-- БД: YC analytics (таблица metrics). Накат с ноутбука:
--   node migrations/run_local.mjs migrations/175_client_entity_metrics.sql --db=analytics
--
-- Задачи владельца 10.08 (вечер): четвёртая стартовая сущность отчёта —
-- «По клиентам» (строка = contact_id, движок features/reports/engine/byClients.ts,
-- имена из кэша client_names) + три группы метрик:
--
-- 1. КЛИЕНТСКИЕ (client_*): в отчёте по клиентам — значение клиента, в остальных
--    разрезах — МЕДИАНА по клиентам строки (правило «метрика работает во всех
--    сущностях»). Движок — базовый запрос clientMetrics.ts.
--
--    ⚠ «Риск ухода» РАЗВЁРНУТ относительно формулы владельца. Он написал
--    «частота / прошло времени × 100», но тогда у давно пропавшего клиента
--    процент МАЛЕНЬКИЙ (частота 30 дн, молчит 60 → 50 %), а у здорового —
--    большой, что противоречит названию. Считаем «прошло / частота × 100»:
--    200 % = «просрочил два своих обычных цикла». Владельцу отписано; если
--    хотел буквально свою формулу — поменять числитель со знаменателем здесь
--    и в clientMetrics.ts (med_risk).
--
-- 2. ДОЛЕВЫЕ (client_share_*): доля строки от итога отчёта (пример владельца:
--    у Володи 5 компаний из 10 → 50 %). Формулы каталога не видят итог,
--    поэтому досчитываются в роутах (clientShareOf). В «Итого» всегда 100 %.
--
-- 3. group_buyers_count: уникальные клиенты, у которых группа «так или иначе
--    встречалась» в товарной отгрузке периода — по ПОЗИЦИЯМ сделки (шкала
--    by_max), а не по главной группе. На kc-шкале — по главной группе (в
--    позициях products только head_group_id). В остальных разрезах совпадает
--    с «Клиенты с отгрузкой».

BEGIN;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source,
  agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui,
  is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok,
  category, sort_order, description)
VALUES
  ('client_days_since_last', 'Прошло времени с последнего заказа, дни', 'Дней без заказа', 'external', 'decimal', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients,client_entity}', false, true, false, false, 1, 'none', false, false, false, false,
   'Клиенты', 1441,
   'Дни от последней товарной отгрузки клиента до сегодня. В отчёте по клиентам — значение клиента, в остальных разрезах — медиана по клиентам строки. Не суммируется в «Итого».'),
  ('client_order_frequency_days', 'Обычная частота заказов, дни', 'Частота заказов', 'external', 'decimal', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients,client_entity}', false, true, false, false, 1, 'none', false, false, false, false,
   'Клиенты', 1442,
   'Средний интервал клиента между отгрузками: (последняя − первая) / (N − 1). Пусто у клиентов с одной отгрузкой. В неклиентских разрезах — медиана по клиентам строки.'),
  ('client_ltv', 'LTV клиента', 'LTV клиента', 'external', 'money', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients,client_entity}', false, true, false, false, 0, 'none', false, false, false, false,
   'Клиенты', 1443,
   'Сумма всех товарных отгрузок клиента за всю историю. В неклиентских разрезах — медиана по клиентам строки (не сумма: она бы двоилась между менеджерами клиента).'),
  ('client_categories_count', 'Кол-во категорий', 'Категорий', 'external', 'decimal', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients,client_entity}', false, true, false, false, 1, 'none', false, false, false, false,
   'Клиенты', 1444,
   'Сколько разных товарных групп клиент покупал за всю историю (по позициям сделок, сервисные группы исключены). В неклиентских разрезах — медиана.'),
  ('client_churn_risk_pct', 'Риск ухода, %', 'Риск ухода', 'external', 'percent', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients,client_entity}', false, true, false, false, 0, 'none', false, false, false, false,
   'Клиенты', 1445,
   'Прошло времени с последнего заказа ÷ обычная частота заказов × 100. 100 % — молчит ровно свой обычный цикл, 200 % — просрочил два цикла, пора звонить. Формула развёрнута относительно исходной постановки — см. миграцию 175.'),
  ('client_share_count_pct', 'Доля клиентов по количеству, %', 'Доля клиентов', 'external', 'percent', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients}', false, true, false, false, 1, 'none', false, false, false, false,
   'Клиенты', 1446,
   'Доля уникальных клиентов строки от всех клиентов отчёта (пример: у менеджера 5 компаний из 10 → 50 %). В «Итого» всегда 100 %.'),
  ('client_share_amount_pct', 'Доля клиентов по сумме, %', 'Доля по сумме', 'external', 'percent', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients}', false, true, false, false, 1, 'none', false, false, false, false,
   'Клиенты', 1447,
   'Доля суммы товарных отгрузок строки от суммы всего отчёта. В «Итого» всегда 100 %.'),
  ('group_buyers_count', 'Количество купивших клиентов', 'Купивших', 'external', 'int', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients}', false, true, false, false, 0, 'none', false, false, false, false,
   'Клиенты', 1448,
   'Уникальные клиенты, у которых группа встречалась в товарной отгрузке периода — по ПОЗИЦИЯМ сделки («так или иначе»), а не по главной группе: клиент «утеплитель + доборы» пополняет обе. На kc-шкале — по главной группе. В неклиентских разрезах = «Клиенты с отгрузкой».')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  decimal_places = EXCLUDED.decimal_places, aggregation_fn = EXCLUDED.aggregation_fn,
  is_active = EXCLUDED.is_active, description = EXCLUDED.description;

COMMIT;
