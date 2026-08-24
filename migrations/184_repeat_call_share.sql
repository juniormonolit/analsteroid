-- Migration 184: «Доля прозвона повторных продаж» + автобраковка повторки
-- БД: YC analytics (таблица metrics). Накат с ноутбука:
--   node migrations/run_local.mjs migrations/184_repeat_call_share.sql --db=analytics
--
-- Задача владельца 24.08: при закрытии сделки в «Отгружено» автоматически
-- создаётся сделка в воронке повторных продаж — в каком проценте случаев
-- менеджер вообще связывается по ней с заказчиком (есть хотя бы 1 звонок)?
-- Плюс «смеха ради» — сколько повторных сделок бракуется в течение часа.
--
-- Замеры июля 2026 до постройки (гонялись с прод-сервера, локальный SA-туннель
-- лежал): создано 2 797, со звонком 1 322 (47,3 %); отказов 1 369, из них в
-- течение часа 290 (210 — в первые 5 минут), и лишь у 8 из 290 был звонок —
-- гипотеза владельца об автобраковке подтверждена с запасом.
--
-- РЕШЕНИЯ (согласованы с владельцем 24.08):
--   * числитель — ЛЮБОЙ звонок по сделке (дословно «есть хотя бы 1 звонок»);
--     «исходящий состоявшийся» дал бы 39,5 % — переключается одной правкой
--     _has_call в lib/metrics/sqlGen.ts;
--   * период — по created_at повторной сделки («из созданных в периоде —
--     скольких прозвонили»); хвост периода слегка занижен: свежим сделкам ещё
--     не успели позвонить;
--   * звонок именно ПО ЭТОЙ сделке (va.calls.deal_id) — звонок по другой
--     сделке того же клиента не засчитывается;
--   * знаменатель — существующая repeat_created_count (тот же created_at и те
--     же воронки: базы сходятся по построению).
--
-- Метрики через конструктор (виртуальные поля _has_call/_lost_within_1h в
-- sqlGen.ts) — работают во всех сущностях, графиках и доступны квестам.
-- Данные звонков существуют с 30.03.2026 — за более ранние периоды доля
-- будет ложным нулём (см. описания).

BEGIN;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source,
  agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui,
  is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok,
  category, sort_order, description)
VALUES
  ('repeat_deals_called_count', 'Прозвон повторных: сделок со звонком (кол-во)', 'Повт. со звонком', 'collected', 'int', 'deals',
   'count_distinct', 'deal_id', 'created_at',
   '[{"op":"eq","field":"funnel_type","value":"repeat"},{"op":"eq","field":"_has_call","value":""}]'::jsonb,
   '{calls,clients}', false, true, false, false, 0, 'sum', false, false, true, false,
   'Клиенты', 1449,
   'Сделки повторных воронок, созданные в периоде, по которым есть хотя бы один звонок (любое направление и результат, привязка va.calls.deal_id). Звонок по другой сделке того же клиента не считается. Данные звонков — с 30.03.2026: за более ранние периоды метрика ложно нулевая.'),
  ('repeat_fast_lost_count', 'Повторные: отказ в течение часа (кол-во)', 'Повт. автоотказ', 'collected', 'int', 'deals',
   'count_distinct', 'deal_id', 'created_at',
   '[{"op":"eq","field":"funnel_type","value":"repeat"},{"op":"eq","field":"_lost_within_1h","value":""}]'::jsonb,
   '{clients}', false, true, false, false, 0, 'sum', false, false, true, false,
   'Клиенты', 1451,
   'Сделки повторных воронок, забракованные в течение часа после создания (lost_at < created_at + 1 ч) — маркер автобраковки без попытки связаться. Июль 2026: 290 из 1 369 отказов, 210 из них — в первые 5 минут, звонок был лишь у 8. Период — по дате создания.')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  filters = EXCLUDED.filters, category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active,
  description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula,
  dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places,
  aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('repeat_called_share_pct', 'Доля прозвона повторных продаж, %', 'Прозвон повт.', 'calculated', 'percent',
   '[repeat_deals_called_count] / [repeat_created_count] * 100',
   ARRAY['repeat_deals_called_count', 'repeat_created_count'],
   '{calls,clients}', false, true, false, false, 1, 'avg', false, true, false, true, 'Клиенты', 1450,
   'Какая часть повторных сделок, созданных в периоде, получила хотя бы один звонок. Знаменатель — «Кол-во сделок (повт.)» (тот же created_at, те же воронки). Хвост периода слегка занижен: свежим сделкам ещё не успели позвонить.'),
  ('repeat_fast_lost_pct', 'Повторные: доля отказов в течение часа, %', 'Автоотказ повт. %', 'calculated', 'percent',
   '[repeat_fast_lost_count] / [repeat_created_count] * 100',
   ARRAY['repeat_fast_lost_count', 'repeat_created_count'],
   '{clients}', false, true, false, false, 1, 'avg', false, true, false, true, 'Клиенты', 1452,
   'Доля созданных в периоде повторных сделок, забракованных в течение часа после создания.')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, formula = EXCLUDED.formula,
  dependencies = EXCLUDED.dependencies, category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active,
  description = EXCLUDED.description;

COMMIT;
