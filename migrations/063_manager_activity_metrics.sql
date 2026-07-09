-- БД: YC analytics (таблица metrics, run_analytics.mjs). НЕ применять локально —
-- накатывает Артём на проде (атомарно, одним запросом).
--
-- Спека: owners-inbox/analsteroid-edits-spec-20260709.md (правки собрания 09.07 +
-- допы), задача от 10.07. Три новые метрики активности менеджеров:
--   1. «Дней в работе»  — manager_worked_days_count
--   2. «% выхода»       — manager_attendance_pct
--   3. «Сделок/день»    — manager_deals_per_worked_day
-- + 2 скрытых служебных external-метрики (агрегирует/инжектит сервер отчётов,
--   app/api/reports/run/route.ts, см. features/reports/engine/managerActivity.ts):
--   manager_period_calendar_days, manager_primary_deals_activity.
--
-- «Рабочий день менеджера» (формула владельца): будний день, в который менеджер И
-- получил хотя бы одну первичную сделку (created_at, funnel_type=primary), И сделал
-- хотя бы одну смену стадии по любой сделке (deal_events, атрибуция —
-- deal_events.manager_id — есть и NOT NULL, проверено живым запросом 10.07, фолбэк на
-- current_manager_id из спеки НЕ понадобился).
--
-- Решение по «троице» (перв./повт./все): владелец просил троицу, но формула
-- «рабочего дня» завязана на первичные сделки + смены стадии — к ней троица
-- физически неприменима (день либо «рабочий», либо нет, без вариантов
-- перв./повт./все). Поэтому «Дней в работе» и «% выхода» — БЕЗ троицы, одна метрика.
-- «Сделок/день» тоже без троицы — по требованию владельца, всегда по ПЕРВИЧНЫМ
-- сделкам (не зависит от пилюли Первичные/Повторные/Все отчёта — числитель считается
-- отдельно от каталожной primary_deals_count, см. комментарий в managerActivity.ts).
-- Если владельцу утром захочется троица — переделать отдельной миграцией.
--
-- Ограничение данных: sa.deal_events собирается с 03.04.2026 (MIN(event_at), проверено
-- живым запросом 10.07). Если период целиком раньше — сервер отдаёт NULL (не 0!) для
-- manager_worked_days_count/manager_primary_deals_activity, и производные калькулируемые
-- метрики (attendance_pct/deals_per_worked_day) автоматически становятся NULL по цепочке
-- зависимостей (computeCalculated: null-зависимость → null).
--
-- Смысл метрик — ТОЛЬКО в разрезе менеджеров (deal_events атрибутируется на менеджера).
-- Для отчётов «по товарным группам»/«по источникам» сервер их не инжектит — там эти
-- id просто отсутствуют в row.metrics, что и есть требуемое «верни null / не показывай».

-- Скрытая служебная метрика: рабочих дней по производственному календарю (working_calendar)
-- за период отчёта — знаменатель «% выхода». Инжектится сервером, aggregation_fn='none'
-- (НЕ суммировать в «Итого» — это период-константа, одинаковая у всех менеджеров;
-- суммирование по N менеджерам исказило бы знаменатель в N раз).
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('manager_period_calendar_days', 'Рабочих дней за период (произв. календарь, служебная)', NULL, 'external', 'int', NULL, '{}', '{}', false, true, true, false, 0, 'none', false, false, false, false, 'Активность', 921, 'Служебное поле-знаменатель для «% выхода». working_calendar НАПРЯМУЮ (без тумблера divide20/calendar). Инжектится app/api/reports/run + features/reports/engine/managerActivity.ts.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

-- Скрытая служебная метрика: первичные сделки за период, СВОЯ копия (не переиспользует
-- каталожную primary_deals_count) — чтобы числитель «Сделок/день» НЕ зависел от пилюли
-- Первичные/Повторные/Все выбранной в отчёте (primary_deals_count по факту зануляется
-- пилюлей через funnel_id-группировку в byManagers.ts::aggregate(), см. WORKLOG 10.07).
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('manager_primary_deals_activity', 'Первичные сделки за период (для Сделок/день, служебная)', NULL, 'external', 'int', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, false, false, 'Активность', 922, 'Служебный числитель для «Сделок/день» — не зависит от пилюли Первичные/Повторные/Все. Инжектится app/api/reports/run + features/reports/engine/managerActivity.ts.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

-- 1. «Дней в работе» — видимая, external (считает сервер отчётов, не generic
--    buildCollectedSQL). aggregation_fn='sum' — в «Итого» суммируется (человеко-дни
--    команды), это осмысленная агрегация в отличие от календарного знаменателя выше.
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('manager_worked_days_count', 'Дней в работе', 'Дней в работе', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'sum', false, false, true, false, 'Активность', 920,
  'Будних дней в периоде, когда менеджер И получил первичную сделку, И сменил стадию хотя бы одной сделки (атрибуция — deal_events.manager_id). Данные deal_events с 03.04.2026 — до этой даты NULL, не 0.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- 2. «% выхода» — видимая, calculated: Дней в работе ÷ Рабочих дней по календарю × 100.
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('manager_attendance_pct', '% выхода', '% выхода', 'calculated', 'percent',
  '[manager_worked_days_count] / [manager_period_calendar_days] * 100',
  ARRAY['manager_worked_days_count', 'manager_period_calendar_days'],
  '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Активность', 923,
  'Дней в работе ÷ рабочих дней по производственному календарю за период × 100. В «Итого» — NULL (знаменатель не суммируется по менеджерам, честно, без фиктивного усреднения).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, data_type = EXCLUDED.data_type, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_calc_ok = EXCLUDED.is_calc_ok, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

-- 3. «Сделок/день» — видимая, calculated: первичные сделки за период ÷ дней в работе
--    (НЕ календарных). Числитель — служебная manager_primary_deals_activity (своя копия,
--    не зависит от пилюли Первичные/Повторные/Все — см. комментарий выше).
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('manager_deals_per_worked_day', 'Сделок/день', 'Сделок/день', 'calculated', 'decimal',
  '[manager_primary_deals_activity] / [manager_worked_days_count]',
  ARRAY['manager_primary_deals_activity', 'manager_worked_days_count'],
  '{}', false, true, false, false, 2, 'avg', false, true, false, true, 'Активность', 924,
  'Первичные сделки за период ÷ дней в работе (не календарных). Всегда по первичным, независимо от пилюли Первичные/Повторные/Все.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, data_type = EXCLUDED.data_type, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_calc_ok = EXCLUDED.is_calc_ok, is_active = EXCLUDED.is_active, description = EXCLUDED.description;
