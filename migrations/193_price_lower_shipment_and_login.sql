-- Миграция 193: CR «Есть цена дешевле → Отгрузка» (тройка) + метрика «Логин»
-- БД: YC ANALYTICS (каталог метрик). Накат:
--   node migrations/run_local.mjs migrations/193_price_lower_shipment_and_login.sql --db=analytics
--
-- Правки владельца 31.08:
-- п.7 «Добавить 3 метрики конверсии из стадии "Есть цена дешевле" в продажу,
--     в бронь, в отгрузку» — Продажа и Бронь уже существуют с миграции 064
--     (cr_price_lower_to_sale/_reservation, тройки перв./повт./все); не хватало
--     ровно исхода «Отгрузка». Семантика та же: знаменатель — сделки, ВПЕРВЫЕ
--     попавшие в стадию в периоде; числитель — те из них, что когда-либо ПОСЛЕ
--     получили deals.delivered_at >= момента попадания. Движок:
--     features/reports/engine/priceObjectionConversion.ts (исход добавлен).
-- п.6 «Добавить метрику "Логин"… полный, например Manager2015» — псевдо-метрика
--     manager_login: значение НЕ число, сервер шлёт его отдельным полем строки
--     (ReportRow.managerLogin из system.employees.bitrix_login), ReportTable
--     рендерит текстом. В каталоге она нужна, чтобы выбираться в панели метрик.

-- ── служебные числители «→ Отгрузка» ─────────────────────────────────────────
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_price_lower_to_shipment_num_primary', 'Из «Есть цена дешевле» достигли «Отгрузка», первичные (служебная)', NULL, 'external', 'int', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, true, false, 'Конверсии стадий', 1073, 'Числитель CR «Есть цена дешевле → Отгрузка» (перв.). Из когорты stage_price_lower_denom_primary — сколько КОГДА-ЛИБО ПОСЛЕ первого попадания в стадию получили deals.delivered_at >= момента попадания (не только в периоде отчёта).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('stage_price_lower_to_shipment_num_repeat', 'Из «Есть цена дешевле» достигли «Отгрузка», повторные (служебная)', NULL, 'external', 'int', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, true, false, 'Конверсии стадий', 1074, 'Числитель CR «Есть цена дешевле → Отгрузка» (повт.). Повторная воронка (funnels.is_repeat=true) — стадий «Есть цена дешевле» в повторных воронках на момент миграции нет (как у 064), поэтому обычно 0; код запрашивает по-настоящему.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

-- ── видимая тройка CR «Есть цена дешевле → Отгрузка» ─────────────────────────
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description, formula_human)
VALUES ('cr_price_lower_to_shipment', 'CR Есть цена дешевле → Отгрузка (перв.)', 'CR Цена→Отгр (п)', 'calculated', 'percent', '[stage_price_lower_to_shipment_num_primary] / [stage_price_lower_denom_primary] * 100', ARRAY['stage_price_lower_to_shipment_num_primary','stage_price_lower_denom_primary'], '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Конверсии стадий', 1075, 'Знаменатель = сделки, впервые попавшие в стадию «Есть цена дешевле, запросил предложение лучше» в периоде отчёта (sa.deal_events, MIN(event_at); стадии объединены по названию across воронок). Числитель = те из них, что когда-либо ПОСЛЕ этого получили отгрузку (deals.delivered_at). Первичная воронка. Данные deal_events — с 03.04.2026, раньше — честный null.', 'сделки, впервые попавшие в «Есть цена дешевле» в периоде и позже отгруженные ÷ сделки, впервые попавшие в «Есть цена дешевле» в периоде × 100 (первичная воронка)')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, is_active = EXCLUDED.is_active, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, description = EXCLUDED.description, formula_human = EXCLUDED.formula_human;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description, formula_human)
VALUES ('cr_price_lower_to_shipment_repeat', 'CR Есть цена дешевле → Отгрузка (повт.)', 'CR Цена→Отгр (пв)', 'calculated', 'percent', '[stage_price_lower_to_shipment_num_repeat] / [stage_price_lower_denom_repeat] * 100', ARRAY['stage_price_lower_to_shipment_num_repeat','stage_price_lower_denom_repeat'], '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Конверсии стадий', 1076, 'То же, что «(перв.)», но по повторной воронке (funnels.is_repeat=true). Стадий «Есть цена дешевле» в повторных воронках на момент миграции нет — обычно пусто (как и у троек 064); если Bitrix заведёт стадию, заработает сама.', 'сделки, впервые попавшие в «Есть цена дешевле» в периоде и позже отгруженные ÷ сделки, впервые попавшие в «Есть цена дешевле» в периоде × 100 (повторная воронка)')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, is_active = EXCLUDED.is_active, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, description = EXCLUDED.description, formula_human = EXCLUDED.formula_human;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description, formula_human)
VALUES ('cr_price_lower_to_shipment_all', 'CR Есть цена дешевле → Отгрузка (все)', 'CR Цена→Отгр (вс)', 'calculated', 'percent', '([stage_price_lower_to_shipment_num_primary] + [stage_price_lower_to_shipment_num_repeat]) / ([stage_price_lower_denom_primary] + [stage_price_lower_denom_repeat]) * 100', ARRAY['stage_price_lower_to_shipment_num_primary','stage_price_lower_to_shipment_num_repeat','stage_price_lower_denom_primary','stage_price_lower_denom_repeat'], '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Конверсии стадий', 1077, 'Сумма первичных и повторных когорт (см. «(перв.)»); повторные структурно дают 0, поэтому численно совпадает с «(перв.)».', 'сделки, впервые попавшие в «Есть цена дешевле» в периоде и позже отгруженные ÷ сделки, впервые попавшие в «Есть цена дешевле» в периоде × 100 (обе воронки)')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, is_active = EXCLUDED.is_active, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, description = EXCLUDED.description, formula_human = EXCLUDED.formula_human;

-- ── п.6: псевдо-метрика «Логин» ──────────────────────────────────────────────
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES ('manager_login', 'Логин', 'Логин', 'external', 'int', NULL, '{}', '{}', false, true, false, false, 0, 'none', false, false, true, false, 'Сделки', 5, 'Полный битрикс-логин сотрудника (например Manager2015) из system.employees.bitrix_login. Текстовая колонка: значение инжектится сервером отдельным полем строки (ReportRow.managerLogin), а не числом; «Итого», сравнение и график для неё не считаются. Есть только в отчёте по менеджерам.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, is_active = EXCLUDED.is_active, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, description = EXCLUDED.description;

SELECT id, name_ru FROM metrics WHERE id IN ('cr_price_lower_to_shipment','cr_price_lower_to_shipment_repeat','cr_price_lower_to_shipment_all','stage_price_lower_to_shipment_num_primary','stage_price_lower_to_shipment_num_repeat','manager_login');
