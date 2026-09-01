-- Миграция 195: CR Сделка → «Есть цена дешевле» (тройка перв./повт./все)
-- БД: YC ANALYTICS (каталог метрик). Накат:
--   node migrations/run_local.mjs migrations/195_cr_deal_to_price_lower.sql --db=analytics
--
-- Правка владельца 31.08: «Добавь метрику конверсии из сделки в есть цена
-- дешевле. То есть кол-во сделок, побывавших в стадии "Есть цена дешевле" /
-- "Кол-во первичных сделок" * 100%».
--
-- Все компоненты уже существуют, кода не требуется:
--  * числитель — stage_price_lower_denom_primary/_repeat (064): сделки, ВПЕРВЫЕ
--    попавшие в стадию «Есть цена дешевле, запросил предложение лучше» в
--    периоде отчёта (sa.deal_events, MIN(event_at); стадии объединены по
--    названию across воронок). Инжектится сервером в by-managers
--    (priceObjectionConversion.ts) — с аудита 31.08 уважает все фильтры отчёта;
--  * знаменатель — обычные collected: primary_deals_count (перв.),
--    repeat_created_count (повт.), deals_count (все) — сделки, СОЗДАННЫЕ в
--    периоде.
-- Обе части считаются за один и тот же период, но по разным датам (вход в
-- стадию vs создание) — это обычная периодная конверсия, как и остальные CR.
-- Как всё семейство price_lower, метрика работает в отчёте «По менеджерам».

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description, formula_human)
VALUES ('cr_deal_to_price_lower', 'CR Сделка → Есть цена дешевле (перв.)', 'CR Сдел→Цена (п)', 'calculated', 'percent', '[stage_price_lower_denom_primary] / [primary_deals_count] * 100', ARRAY['stage_price_lower_denom_primary','primary_deals_count'], '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Конверсии стадий', 1068, 'Числитель = сделки, ВПЕРВЫЕ попавшие в стадию «Есть цена дешевле, запросил предложение лучше» в периоде отчёта (sa.deal_events, MIN(event_at); стадии объединены по названию across воронок; первичная воронка). Знаменатель = кол-во первичных сделок, созданных в периоде. Данные deal_events — с 03.04.2026, раньше — честный null. Работает в отчёте «По менеджерам».', 'сделки, впервые попавшие в «Есть цена дешевле» в периоде ÷ первичные сделки, созданные в периоде × 100')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, is_active = EXCLUDED.is_active, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, description = EXCLUDED.description, formula_human = EXCLUDED.formula_human;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description, formula_human)
VALUES ('cr_deal_to_price_lower_repeat', 'CR Сделка → Есть цена дешевле (повт.)', 'CR Сдел→Цена (пв)', 'calculated', 'percent', '[stage_price_lower_denom_repeat] / [repeat_created_count] * 100', ARRAY['stage_price_lower_denom_repeat','repeat_created_count'], '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Конверсии стадий', 1069, 'То же, что «(перв.)», но по повторной воронке (funnels.is_repeat=true). Стадий «Есть цена дешевле» в повторных воронках на момент миграции нет (как у 064) — обычно 0%; если Bitrix заведёт стадию, заработает сама.', 'сделки, впервые попавшие в «Есть цена дешевле» в периоде ÷ повторные сделки, созданные в периоде × 100')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, is_active = EXCLUDED.is_active, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, description = EXCLUDED.description, formula_human = EXCLUDED.formula_human;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, formula, dependencies, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description, formula_human)
VALUES ('cr_deal_to_price_lower_all', 'CR Сделка → Есть цена дешевле (все)', 'CR Сдел→Цена (вс)', 'calculated', 'percent', '([stage_price_lower_denom_primary] + [stage_price_lower_denom_repeat]) / [deals_count] * 100', ARRAY['stage_price_lower_denom_primary','stage_price_lower_denom_repeat','deals_count'], '{}', false, true, false, false, 1, 'avg', false, true, false, true, 'Конверсии стадий', 1070, 'Обе воронки: (первичные + повторные входы в стадию) ÷ все созданные сделки периода. Повторные структурно дают 0 (см. «(повт.)»), поэтому числитель совпадает с первичным.', 'сделки, впервые попавшие в «Есть цена дешевле» в периоде ÷ все сделки, созданные в периоде × 100')
ON CONFLICT (id) DO UPDATE SET name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies, is_active = EXCLUDED.is_active, is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, category = EXCLUDED.category, sort_order = EXCLUDED.sort_order, description = EXCLUDED.description, formula_human = EXCLUDED.formula_human;

SELECT id, name_ru, formula FROM metrics WHERE id LIKE 'cr_deal_to_price_lower%' ORDER BY sort_order;
