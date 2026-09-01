-- Миграция 197: «Скорость озвучивания цены» — CR Сделка → Цена озвучена и
-- медиана часов до цены, тройки перв./повт./все. БД: YC ANALYTICS. Накат:
--   node migrations/run_local.mjs migrations/197_price_speed_metrics.sql --db=analytics
--
-- Семантика (гипотеза владельца 01.09, подтверждена прототипом): «цена озвучена»
-- = первый вход сделки в стадию, размеченную 'has_price' в stage_price_markup
-- (БД system, «Настройки → Цена: разметка стадий»). Когорта — сделки, СОЗДАННЫЕ
-- в периоде (как у скорости первого касания, метрики сравнимы). Сделки, зашедшие
-- в 'unclear'-стадию ДО первой ценовой, исключаются из числителя И знаменателя
-- («Спорно не участвует в расчёте» — ТЗ владельца). Движок —
-- features/reports/engine/priceSpeed.ts (deal_events, MIN(event_at), гейт
-- 03.04.2026 — раньше честный null). Работает в отчёте «По менеджерам».

-- Скрытые external-счётчики (значения кладёт сервер, «Итого» бьётся суммой).
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('price_reached_primary', 'Сделок с озвученной ценой (перв., служебная)', 'Цена озвучена (п)', 'external', 'int', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, true, false, 'Конверсии стадий', 1077, 'Служебный числитель CR Сделка → Цена: первичные сделки, созданные в периоде и получившие вход в has_price-стадию (stage_price_markup). Спорные исключены.'),
  ('price_reached_repeat', 'Сделок с озвученной ценой (повт., служебная)', 'Цена озвучена (пв)', 'external', 'int', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, true, false, 'Конверсии стадий', 1078, 'То же по повторным воронкам (funnels.is_repeat=true).'),
  ('price_denom_primary', 'Сделок в расчёте цены (перв., служебная)', 'База цены (п)', 'external', 'int', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, true, false, 'Конверсии стадий', 1079, 'Служебный знаменатель: первичные сделки, созданные в периоде, МИНУС исключённые по спорным стадиям.'),
  ('price_denom_repeat', 'Сделок в расчёте цены (повт., служебная)', 'База цены (пв)', 'external', 'int', NULL, '{}', '{}', false, true, true, false, 0, 'sum', false, false, true, false, 'Конверсии стадий', 1080, 'То же по повторным воронкам.')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

-- Видимые CR (calculated поверх служебных — «Итого» пересчитывается из сумм).
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description, formula_human)
VALUES
  ('cr_deal_to_price', 'CR Сделка → Цена озвучена (перв.)', 'CR→Озвучил (п)', 'calculated', 'percent', '[price_reached_primary] / [price_denom_primary] * 100', ARRAY['price_reached_primary','price_denom_primary'], '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Конверсии стадий', 1081, 'Доля первичных сделок, созданных в периоде, по которым цена была озвучена (вход в has_price-стадию разметки, когда угодно после создания). Сделки, зашедшие в «Спорно»-стадию до ценовой, исключены из обеих частей. Разметка стадий — «Настройки → Цена: разметка стадий». Данные deal_events — с 03.04.2026.', 'сделки с озвученной ценой ÷ созданные сделки (без спорных) × 100'),
  ('cr_deal_to_price_repeat', 'CR Сделка → Цена озвучена (повт.)', 'CR→Озвучил (пв)', 'calculated', 'percent', '[price_reached_repeat] / [price_denom_repeat] * 100', ARRAY['price_reached_repeat','price_denom_repeat'], '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Конверсии стадий', 1082, 'То же по повторным воронкам.', 'повторные с ценой ÷ повторные созданные (без спорных) × 100'),
  ('cr_deal_to_price_all', 'CR Сделка → Цена озвучена (все)', 'CR→Озвучил (вс)', 'calculated', 'percent', '([price_reached_primary] + [price_reached_repeat]) / ([price_denom_primary] + [price_denom_repeat]) * 100', ARRAY['price_reached_primary','price_reached_repeat','price_denom_primary','price_denom_repeat'], '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Конверсии стадий', 1083, 'Обе воронки вместе.', 'все с ценой ÷ все созданные (без спорных) × 100')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, is_active = EXCLUDED.is_active, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, description = EXCLUDED.description, formula_human = EXCLUDED.formula_human;

-- Медиана часов до цены — прямые external (percentile_cont, «Итого» — настоящая
-- медиана по всей совокупности через GRAND_TOTAL, не сумма построчных).
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('price_speed_median_hours', 'Скорость до цены, медиана часов (перв.)', 'До цены, ч (п)', 'external', 'decimal', NULL, '{}', '{}', false, true, false, false, 1, 'none', false, false, true, false, 'Конверсии стадий', 1084, 'Медиана часов от создания первичной сделки до первого входа в стадию с озвученной ценой (разметка has_price). Считается по сделкам, созданным в периоде и получившим цену; спорные исключены. Меньше — лучше. Данные deal_events — с 03.04.2026.'),
  ('price_speed_median_hours_repeat', 'Скорость до цены, медиана часов (повт.)', 'До цены, ч (пв)', 'external', 'decimal', NULL, '{}', '{}', false, true, false, false, 1, 'none', false, false, true, false, 'Конверсии стадий', 1085, 'То же по повторным воронкам.'),
  ('price_speed_median_hours_all', 'Скорость до цены, медиана часов (все)', 'До цены, ч (вс)', 'external', 'decimal', NULL, '{}', '{}', false, true, false, false, 1, 'none', false, false, true, false, 'Конверсии стадий', 1086, 'Обе воронки вместе (общая медиана, не среднее двух медиан).')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, aggregation_fn = EXCLUDED.aggregation_fn, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active, description = EXCLUDED.description;

SELECT id, name_ru FROM metrics WHERE id LIKE 'price_%' OR id LIKE 'cr_deal_to_price%' ORDER BY sort_order;
