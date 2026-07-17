-- Миграция 104: метрики «Доля прозвона броней / подтв. броней на следующий рабочий
-- день» (задача Иосифа 17.07). Регламент: менеджер обязан прозвонить клиента В
-- СЛЕДУЮЩИЙ рабочий день после перевода сделки в бронь/подтв. бронь (вариант Б —
-- строго в него). Движок features/reports/engine/bookingCallRate.ts, инжект в
-- app/api/reports/run (by-managers). БД: YC analytics (run_analytics.mjs). Идемпотентна.
--
-- 4 служебные external (числители/знаменатели, sum) + 2 итоговые calculated (percent,
-- num/denom*100, avg). Данные звонков — с 30.03.2026 (CALLS_DATA_START), раньше — null.
--
-- РЕГЛАМЕНТ КОМАНДЫ (WORKLOG #2059): метрики скрыты в ОБЩЕМ каталоге
-- (is_test=true + is_hidden_in_ui=true) до прод-деплоя кода-инжекта bookingCallRate.
-- ШАГ РАЗВОРОТА при общем прод-релизе: UPDATE metrics SET is_test=false,
-- is_hidden_in_ui=false WHERE id IN ('booking_call_rate_reserved','booking_call_rate_confirmed');

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('booking_call_reserved_denom', 'Броней за период (служебная)', NULL, 'external', 'int', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, true, false, 'Звонки', 1080, 'Знаменатель «Доли прозвона броней»: сделки с reserved_at в периоде (атрибуция current_manager_id), у которых следующий рабочий день уже завершился. Инжектится сервером (bookingCallRate.ts).'),
  ('booking_call_reserved_num', 'Прозвонённых броней на след. раб. день (служебная)', NULL, 'external', 'int', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, true, false, 'Звонки', 1081, 'Числитель «Доли прозвона броней»: из знаменателя те, где был исходящий звонок по сделке СТРОГО в следующий рабочий день. Инжектится сервером (bookingCallRate.ts).'),
  ('booking_call_confirmed_denom', 'Подтв. броней за период (служебная)', NULL, 'external', 'int', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, true, false, 'Звонки', 1082, 'Знаменатель «Доли прозвона подтв. броней»: сделки с confirmed_at в периоде (атрибуция current_manager_id), у которых следующий рабочий день уже завершился. Инжектится сервером (bookingCallRate.ts).'),
  ('booking_call_confirmed_num', 'Прозвонённых подтв. броней на след. раб. день (служебная)', NULL, 'external', 'int', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, true, false, 'Звонки', 1083, 'Числитель «Доли прозвона подтв. броней»: из знаменателя те, где был исходящий звонок по сделке СТРОГО в следующий рабочий день. Инжектится сервером (bookingCallRate.ts).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, is_calc_ok = EXCLUDED.is_calc_ok, description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('booking_call_rate_reserved', 'Доля прозвона броней на след. день', 'Прозвон броней', 'calculated', 'percent', '[booking_call_reserved_num] / [booking_call_reserved_denom] * 100', ARRAY['booking_call_reserved_num','booking_call_reserved_denom'], '{}', false, true, true, true, 1, 'avg', false, true, false, true, 'Звонки', 1084, 'Регламент: прозвонить клиента в следующий рабочий день после перевода в бронь. Знаменатель — брони периода (reserved_at, у которых след. раб. день завершился); числитель — из них с исходящим звонком СТРОГО в след. раб. день. Данные звонков с 30.03.2026.'),
  ('booking_call_rate_confirmed', 'Доля прозвона подтв. броней на след. день', 'Прозвон подтв.', 'calculated', 'percent', '[booking_call_confirmed_num] / [booking_call_confirmed_denom] * 100', ARRAY['booking_call_confirmed_num','booking_call_confirmed_denom'], '{}', false, true, true, true, 1, 'avg', false, true, false, true, 'Звонки', 1085, 'Регламент: прозвонить клиента в следующий рабочий день после перевода в подтв. бронь. Знаменатель — подтв. брони периода (confirmed_at, у которых след. раб. день завершился); числитель — из них с исходящим звонком СТРОГО в след. раб. день. Данные звонков с 30.03.2026.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, is_calc_ok = EXCLUDED.is_calc_ok, description = EXCLUDED.description;
