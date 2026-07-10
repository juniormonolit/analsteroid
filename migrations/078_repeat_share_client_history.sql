-- Migration 078: «Доля повторных продаж» — фикс определения (баг #1556, Серёга)
-- БД: YC analytics (таблица metrics, run_analytics.mjs). НЕ применять локально —
-- накатывает Артём на проде.
--
-- Жалоба: «Доля повторных продаж считается не верно если ППП больше 0, значит
-- есть повторные, а в отчёте я вижу ппп больше 0, но долю повторных показывает 0».
--
-- Диагноз (Николай, 10.07): repeat_sales_count_pct/repeat_sales_amount_pct считали
-- «повторность» по funnel_type='repeat' (funnels.is_repeat) — т.е. по тому, в какую
-- воронку Bitrix попала сделка. ППП (ppp_count) считает «повторность» по ИСТОРИИ
-- КЛИЕНТА (contact_id, ROW_NUMBER() ORDER BY sold_at, rn=2 — вторая продажа) — это
-- ДВА РАЗНЫХ определения одного и того же по названию понятия. Вторая покупка
-- клиента вполне может пройти через ОБЫЧНУЮ воронку (ЧЛ/ЮЛ), а не через выделенную
-- «Повторные» — тогда funnel-счётчик (repeat_sales_count) даёт 0 для этого среза,
-- хотя клиент реально купил повторно (ppp_count > 0). Это тот же класс бага, что
-- уже чинили для ППП/ППО в 061 (там резала пилюля dealScope, здесь — сама база
-- расчёта другая), см. комментарий в 061 и в lib/metrics/sqlGen.ts::resolveFilterClause.
--
-- Живое воспроизведение на прод-данных (SA DB, sa.deals) 10.07:
--   менеджер current_manager_id=1868, сделки sold_at в июле 2026:
--     ppp_count (вторая продажа клиента, contact_id) = 2
--     repeat_sales_count (funnel_type='repeat', funnels.is_repeat)  = 0
--     primary_sales_count (funnel_type='primary')                  = 23
--   → repeat_sales_count_pct = 0 / (23 + 0) * 100 = 0%, при живых 2 повторных
--     клиентах за период. Целочисленного деления/округления в баге НЕТ — формула
--     считает корректно СВОЮ (неверную для этой задачи) базу.
--
-- Фикс: НЕ трогаем repeat_sales_count/primary_sales_count/repeat_sales_amount/
-- primary_sales_amount — они используются в ~8 других метриках (CR Бронь→Продажа
-- (повт.), CR Продажа→Отгрузка (повт.), средний чек (повт.) и т.д.), где funnel-based
-- срез — легитимный процессный смысл («сколько прошло через воронку повторных
-- продаж»), это вне рамок бага #1556. Вместо этого заводим ОТДЕЛЬНУЮ пару служебных
-- collected-метрик на базе истории клиента (тот же принцип ROW_NUMBER, что и у ППП:
-- _primary_hist = rn=1 (первая продажа клиента), _repeat_hist = rn>=2 (вторая и
-- далее) — новые SQL-фильтры в lib/metrics/sqlGen.ts::resolveFilterClause) и
-- перевешиваем формулу «Доля повторных» на них. Тег scope_independent — чтобы
-- пилюля «Первичные/Повторные» их не резала (то же решение, что в 061 для ППП/ППО):
-- «Доля повторных продаж» — про историю клиента, а не про воронку сделки в периоде.

-- 1) Служебные collected-метрики (историческая повторность клиента)
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'primary_sales_count_hist', 'Кол-во продаж (перв., по истории клиента) (служебная)', NULL, 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'sold_at',
  '[{"field":"_primary_hist","op":"eq","value":""}]'::jsonb,
  ARRAY['scope_independent'], false, true, true, false, 0, 'sum', false, false, true, false,
  'Продажи', 347, 'Сделка является ПЕРВОЙ по счёту продажей клиента за всю историю (contact_id, rn=1 по sold_at). Служебная — знаменатель для repeat_sales_count_pct. Не зависит от пилюли Первичные/Повторные.'
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters, tags = EXCLUDED.tags,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'repeat_sales_count_hist', 'Кол-во продаж (повт., по истории клиента) (служебная)', NULL, 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'sold_at',
  '[{"field":"_repeat_hist","op":"eq","value":""}]'::jsonb,
  ARRAY['scope_independent'], false, true, true, false, 0, 'sum', false, false, true, false,
  'Продажи', 348, 'Сделка НЕ первая по счёту продажа клиента за всю историю (contact_id, rn>=2 по sold_at) — вторая и далее. Служебная — числитель для repeat_sales_count_pct. Не зависит от пилюли Первичные/Повторные.'
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters, tags = EXCLUDED.tags,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'primary_sales_amount_hist', 'Сумма продаж (перв., по истории клиента) (служебная)', NULL, 'collected', 'money', 'deals', 'sum', 'amount', 'sold_at',
  '[{"field":"_primary_hist","op":"eq","value":""}]'::jsonb,
  ARRAY['scope_independent'], false, true, true, false, 0, 'sum', false, false, true, false,
  'Продажи', 349, 'Сумма первых по счёту продаж клиентов за всю историю (contact_id, rn=1 по sold_at). Служебная — знаменатель для repeat_sales_amount_pct. Не зависит от пилюли Первичные/Повторные.'
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters, tags = EXCLUDED.tags,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'repeat_sales_amount_hist', 'Сумма продаж (повт., по истории клиента) (служебная)', NULL, 'collected', 'money', 'deals', 'sum', 'amount', 'sold_at',
  '[{"field":"_repeat_hist","op":"eq","value":""}]'::jsonb,
  ARRAY['scope_independent'], false, true, true, false, 0, 'sum', false, false, true, false,
  'Продажи', 350, 'Сумма повторных (rn>=2) продаж клиентов за всю историю (contact_id, по sold_at). Служебная — числитель для repeat_sales_amount_pct. Не зависит от пилюли Первичные/Повторные.'
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters, tags = EXCLUDED.tags,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

-- 2) Перевешиваем «Доля повторных продаж» на историческую (client-history) базу
UPDATE metrics SET
  formula = '[repeat_sales_count_hist] / ([primary_sales_count_hist] + [repeat_sales_count_hist]) * 100',
  dependencies = ARRAY['repeat_sales_count_hist', 'primary_sales_count_hist'],
  description = 'Доля повторных продаж в общем количестве продаж (%), по истории клиента (contact_id) — согласовано с ППП. До 10.07 считалось по funnel_type=repeat (воронка Bitrix), из-за чего расходилось с ППП (баг #1556).'
WHERE id = 'repeat_sales_count_pct';

UPDATE metrics SET
  formula = '[repeat_sales_amount_hist] / ([primary_sales_amount_hist] + [repeat_sales_amount_hist]) * 100',
  dependencies = ARRAY['repeat_sales_amount_hist', 'primary_sales_amount_hist'],
  description = 'Доля суммы повторных продаж в общей сумме продаж (%), по истории клиента (contact_id) — согласовано с ППП. До 10.07 считалось по funnel_type=repeat (воронка Bitrix), из-за чего расходилось с ППП (баг #1556).'
WHERE id = 'repeat_sales_amount_pct';
