-- Миграция 284: «Кол-во квал. сделок (повт.)»
-- БД: analytics (таблица metrics). Накат на проде — как 229:
--   ssh … docker exec -i analsteroid-sys-pg psql -U $POSTGRES_USER -d analytics -1 < migrations/284_repeat_qualified_deals.sql
--
-- ПОРЯДОК: СНАЧАЛА выкатить код (виртуальная дата _repeat_qualified_at в
-- lib/metrics/sqlGen.ts → VIRTUAL_DATE_FIELDS), ПОТОМ накатывать. Старый код склеит
-- d._repeat_qualified_at как колонку — отчёт с этой метрикой упадёт 500 (42703).
--
-- Задача владельца 23.11.2026 (дословно): «Добавить метрику "кол-во квал сделок
-- (повт.)". Квалифицированной считается любая сделка в повторной воронке, которая в
-- "созвонился и уточнил следующие материалы" и дальше в любой повторной воронке B2C и B2B».
--
-- Обычная collected-метрика (count_distinct deal_id), дата — виртуальная
-- _repeat_qualified_at = ПЕРВЫЙ вход сделки в квал-стадию или любую более позднюю
-- (sa.deal_events). Поэтому сама работает по менеджерам, товарным группам и периодам,
-- а клик по ячейке открывает список сделок (generic-путь /api/reports/deals).
-- Список стадий — REPEAT_QUALIFIED_STAGE_IDS в sqlGen.ts.
-- Только «(повт.)»: стадии «Созвонился и уточнил следующие материалы» в первичных
-- воронках нет, «(перв.)» была бы всегда 0, а «все» совпадала бы с «(повт.)».
-- Накат безопасен повторно (ON CONFLICT DO UPDATE).

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description, human_description, formula_human)
VALUES
  ('repeat_qualified_count', 'Кол-во квал. сделок (повт.)', 'Квал. сделки (повт.)', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', '_repeat_qualified_at',
   '[{"field":"funnel_type","op":"eq","value":"repeat"}]'::jsonb,
   ARRAY['deals','repeat'], false, true, false, false, 0, 'sum', false, false, true, false, 'Сделки', 109,
   'Сделки повторных воронок (B2C — воронка 2, B2B — воронка 3), ВПЕРВЫЕ попавшие в периоде в стадию «Созвонился и уточнил следующие материалы» или любую более позднюю, включая бронь, продажу и отгрузку (MIN(event_at) по sa.deal_events, стадии: C2:3, C2:PREPARATION, C2:PREPAYMENT_INVOICE, C2:4, C2:EXECUTING, C2:5, C2:FINAL_INVOICE, C2:WON, C3:3, C3:PREPARATION, C3:PREPAYMENT_INVOICE, C3:4, C3:EXECUTING, C3:FINAL_INVOICE, C3:1, C3:WON). Сделка, ушедшая потом в отказ, остаётся квалифицированной. Менеджер — текущий ответственный сделки, как у остальных collected-метрик. События стадий собираются с 03.04.2026 — раньше метрика недосчитывает.',
   'Сколько повторных сделок дошло до разговора по делу. 1) Берём сделки повторных воронок B2C и B2B. 2) Квалифицированная — та, что хоть раз была в стадии «Созвонился и уточнил следующие материалы» или дальше: запрос снабженцу, КП/материалы, цена дешевле, бронь, продано, отгружено. 3) В период сделка попадает по дате, когда она ВПЕРВЫЕ туда дошла. Потом ушла в отказ — всё равно считается: квалификация уже была.',
   '= число сделок повторных воронок, впервые вошедших в периоде в «Созвонился и уточнил следующие материалы» или любую стадию дальше (B2C + B2B). Данные событий — с 03.04.2026')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, metric_type = EXCLUDED.metric_type,
  data_type = EXCLUDED.data_type, source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters, tags = EXCLUDED.tags, is_active = EXCLUDED.is_active,
  is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, decimal_places = EXCLUDED.decimal_places,
  aggregation_fn = EXCLUDED.aggregation_fn, is_collect_ok = EXCLUDED.is_collect_ok,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  description = EXCLUDED.description, human_description = EXCLUDED.human_description,
  formula_human = EXCLUDED.formula_human;

SELECT id, name_ru, date_field, filters FROM metrics WHERE id = 'repeat_qualified_count';
