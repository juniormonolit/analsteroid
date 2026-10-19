-- Миграция 229: «Отгрузки без повторных продаж» — тройка перв./повт./все
-- БД: analytics (таблица metrics). Накат с прода (локальный контейнер, YC мёртв с 08.10):
--   ssh … docker exec -i analsteroid-sys-pg psql -U $POSTGRES_USER -d analytics -1 < migrations/229_shipments_no_repeat.sql
--
-- ПОРЯДОК: СНАЧАЛА выкатить код (виртуальное поле _no_repeat_after_deliv в
-- lib/metrics/sqlGen.ts), ПОТОМ накатывать. Старый код на незнакомом «_»-поле
-- бросает ошибку — отчёт с этой метрикой упадёт 500.
--
-- Задача владельца 19.10: «метрика „Отгрузки без повторных продаж“ — число сделок
-- (список), то есть отгрузок, по которым не случилось никакой повторной продажи или
-- отгрузки». Обычная collected-метрика (count_distinct deal_id по delivered_at), поэтому
-- сама работает по менеджерам, товарным группам и периодам, а клик по ячейке открывает
-- список сделок (generic-путь /api/reports/deals применяет те же фильтры).
-- Смысл фильтра — в комментарии к noRepeatAfterDeliverySubquery (sqlGen.ts).
-- Накат безопасен повторно (ON CONFLICT DO UPDATE).

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description, human_description)
VALUES
  ('primary_shipments_no_repeat', 'Отгрузки без повторных продаж (перв.)', 'Отгр. без повт. перв.', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'delivered_at',
   '[{"field":"funnel_type","op":"eq","value":"primary"},{"field":"_no_repeat_after_deliv","op":"eq","value":""}]'::jsonb,
   ARRAY['shipments','primary'], false, true, false, false, 0, 'sum', false, false, true, false, 'Отгрузки', 430,
   'Первичные отгрузки периода (delivered_at), после которых у заказчика (contact_id) не было ни одной новой покупки — ни отгрузки, ни продажи без отказа — до сегодняшнего дня. Дробление одной покупки (та же головная группа, < 7 дней от предыдущей отгрузки) повтором не считается (lib/metrics/repeatRule.ts).',
   'Сколько отгрузок «повисло»: после них клиент больше ничего не купил. 1) Берём первичные отгрузки периода. 2) Смотрим всё, что клиент купил после — отгрузки и продажи (продажа, ушедшая в отказ, не считается). 3) Если та же товарная группа и меньше 7 дней — это та же покупка (довоз машинами), а не повтор. 4) Считаем отгрузки, после которых новых покупок не было. Свежие отгрузки попадают сюда почти все — клиент ещё не успел вернуться.'),
  ('repeat_shipments_no_repeat', 'Отгрузки без повторных продаж (повт.)', 'Отгр. без повт. повт.', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'delivered_at',
   '[{"field":"funnel_type","op":"eq","value":"repeat"},{"field":"_no_repeat_after_deliv","op":"eq","value":""}]'::jsonb,
   ARRAY['shipments','repeat'], false, true, false, false, 0, 'sum', false, false, true, false, 'Отгрузки', 431,
   'Повторные (по воронке) отгрузки периода, после которых у заказчика не было ни одной новой покупки — ни отгрузки, ни продажи без отказа — до сегодняшнего дня. Правило склейки дробления — как у первичной.',
   'То же, что «Отгрузки без повторных продаж (перв.)», но по отгрузкам повторных воронок: клиент уже возвращался, и после этой отгрузки — снова тишина.'),
  ('shipments_no_repeat', 'Отгрузки без повторных продаж', 'Отгр. без повт.', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'delivered_at',
   '[{"field":"_no_repeat_after_deliv","op":"eq","value":""}]'::jsonb,
   ARRAY['shipments'], false, true, false, false, 0, 'sum', false, false, true, false, 'Отгрузки', 432,
   'Все отгрузки периода (любые воронки), после которых у заказчика не было ни одной новой покупки — ни отгрузки, ни продажи без отказа — до сегодняшнего дня. Правило склейки дробления — как у первичной.',
   'Сколько отгрузок «повисло»: после них клиент больше ничего не купил — ни отгрузки, ни продажи. Довоз той же группы в пределах 7 дней — та же покупка, не повтор. Свежие отгрузки попадают сюда почти все — клиент ещё не успел вернуться.')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type,
  data_type = EXCLUDED.data_type, source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters, tags = EXCLUDED.tags, is_active = EXCLUDED.is_active,
  is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, decimal_places = EXCLUDED.decimal_places,
  aggregation_fn = EXCLUDED.aggregation_fn, is_collect_ok = EXCLUDED.is_collect_ok,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  description = EXCLUDED.description, human_description = EXCLUDED.human_description;
