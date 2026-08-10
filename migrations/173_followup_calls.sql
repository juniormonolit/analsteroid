-- Migration 173: обзвон после отгрузки — «должны были позвонить / позвонили / доля»
-- БД: YC analytics (таблица metrics). Накат с ноутбука:
--   node migrations/run_local.mjs migrations/173_followup_calls.sql --db=analytics
--
-- Третья пачка метрик владельца (10.08.2026). Гипотеза: клиенту надо позвонить
-- вскоре после отгрузки; хочется видеть, сколько таких звонков ДОЛЖНО было быть
-- и сколько фактически произошло.
--
-- Окно — ДВЕ НЕДЕЛИ от отгрузки, фиксированное. Изначально обсуждался
-- настраиваемый интервал 7–14 дней, но владелец в ходе работы решил проще:
-- «просто посчитаем сколько должны были получить звонок в течение 2х недель».
-- Константа живёт в коде одна — FOLLOWUP_WINDOW_DAYS в clientMetrics.ts.
--
-- `contactability_pct` уже существовала (ТЗ #1725) и, как весь этот раздел, была
-- мертва: external без движка, колонка всегда пустая. Её прежнее определение
-- считало окно от ПЕРВОЙ отгрузки клиента; теперь — от последней, и у неё
-- появились явные числитель со знаменателем вместо непрозрачного external.
--
-- ТРИ РЕШЕНИЯ ПО СМЫСЛУ (подробности — в шапке clientMetrics.ts):
--   1. «после ПОСЛЕДНЕЙ отгрузки» — если клиент сам вернулся до конца окна,
--      обязанности звонить нет и в знаменатель он не попадает;
--   2. обязанность относится к периоду, где окно ЗАКОНЧИЛОСЬ (иначе у отгрузки
--      25 июля окно целиком в августе, и в июле её не с чем сравнивать);
--   3. «позвонили» = исходящий состоявшийся звонок по любой сделке клиента внутри
--      окна; недозвон обязанность не закрывает.
--
-- Живая проверка (июль 2026, сверено независимым запросом): должны были 2 081,
-- позвонили 570, контактируемость 27,4 %.

BEGIN;

CREATE TABLE IF NOT EXISTS metrics_backup_173 AS SELECT * FROM metrics WHERE false;
INSERT INTO metrics_backup_173
  SELECT * FROM metrics WHERE id = 'contactability_pct'
     AND NOT EXISTS (SELECT 1 FROM metrics_backup_173);

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source,
  agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui,
  is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok,
  category, sort_order, description)
VALUES
  ('followup_clients_due', 'Должны были получить звонок (кол-во)', 'Должны звонка', 'external', 'int', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients,calls}', false, true, false, false, 0, 'sum', false, false, false, false,
   'Клиенты', 1419,
   'Клиенты, у которых в периоде истекли две недели с последней отгрузки, — им следовало позвонить. Если клиент успел отгрузиться снова до конца окна, обязанности нет и в счёт он не идёт. Обязанность относится к периоду, где окно ЗАКОНЧИЛОСЬ.'),
  ('followup_clients_called', 'Получили звонок (кол-во)', 'Получили звонок', 'external', 'int', 'deals',
   NULL, NULL, NULL, '[]'::jsonb, '{clients,calls}', false, true, false, false, 0, 'sum', false, false, false, false,
   'Клиенты', 1420,
   'Из тех, кому следовало позвонить, — кому реально дозвонились: исходящий состоявшийся звонок по любой сделке клиента внутри двухнедельного окна. Недозвон не считается.')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui,
  description = EXCLUDED.description;

UPDATE metrics SET
  metric_type = 'calculated', data_type = 'percent', decimal_places = 1,
  category = 'Клиенты', sort_order = 1421, is_hidden_in_ui = false,
  agg_fn = NULL, agg_field = NULL, date_field = NULL, filters = '[]'::jsonb,
  aggregation_fn = 'avg', calc_ok = true, is_calc_ok = true,
  name_ru = 'Контактируемость, %', name_short_ru = 'Контактируемость',
  formula = '[followup_clients_called] / [followup_clients_due] * 100',
  dependencies = ARRAY['followup_clients_called', 'followup_clients_due'],
  description = 'Доля клиентов, до кого дозвонились в течение двух недель после последней отгрузки, среди тех, кому следовало позвонить. Раньше метрика считала окно от ПЕРВОЙ отгрузки и не имела движка вовсе (колонка всегда была пустой).'
  WHERE id = 'contactability_pct';

COMMIT;
