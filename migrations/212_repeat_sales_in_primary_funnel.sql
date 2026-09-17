-- Задача владельца 17.09.2026: «косячная воронка» — повторные (по истории заказчика)
-- продажи, оформленные в ПЕРВИЧНОЙ воронке Битрикса. Две метрики: количество и сумма.
--
-- Зачем. Разбор по Луневой 17.09: клиент купил «Фасад» 03.09 и «Теплоизоляцию»
-- 10.09 — обе сделки через воронку «Частные лица». ППП (по истории клиента)
-- вторую покупку засчитал, а «Сумма продаж (повт., по воронке)» показала 0 — для
-- вороночных метрик сделка первичная. Это тот же класс расхождения, что баг
-- #1556 (миграция 082): две базы «повторности» — по воронке и по истории.
-- Новые метрики измеряют сам зазор между базами: сколько повторных покупок
-- менеджеры проводят не через воронку повторных, и на какую сумму.
--
-- Определение. Сделка ПРОДАНА в периоде (sold_at), является ВТОРОЙ и далее
-- продажей заказчика за всю историю (contact_id, ROW_NUMBER по sold_at, rn >= 2 —
-- фильтр _repeat_hist, тот же, что у «(повт., по истории заказчика)»), и при этом
-- лежит в воронке с funnels.is_repeat = false (фильтр funnel_type = primary).
-- Оба фильтра — существующие поля sqlGen.ts::resolveFilterClause, объединяются
-- через AND в genDealsExpr; нового кода не требуется.
--
-- Почему по продажам, а не по всем сделкам. «Не первая по истории заказчика»
-- требует порядка, а осмысленный порядок задаёт факт покупки: повторным
-- заказчик становится, когда уже купил. Открытая сделка повторного клиента в
-- первичной воронке — тоже косяк, но её пришлось бы ранжировать по created_at
-- относительно чужих продаж; это отдельная метрика, если понадобится.
--
-- НЕ scope_independent сознательно: пилюля «Первичные/Повторные» режет по воронке,
-- а эти сделки в первичной воронке и есть — при «Повторные» метрика честно даёт 0.
--
-- Имена по правилам каталога (миграция 041/160): «Кол-во X» / «Сумма X», база
-- расчёта в названии. sort_order 351–352 (340–350 заняты ППП/ППБ/…_hist).
-- БД: YC analytics (run_analytics.mjs). Идемпотентно (ON CONFLICT).

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field,
                     filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn,
                     fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES
  ('repeat_sales_in_primary_funnel_count',
   'Кол-во повторных продаж в первичной воронке', 'Повт. в перв. воронке',
   'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'sold_at',
   '[{"op":"eq","field":"_repeat_hist","value":""},{"op":"eq","field":"funnel_type","value":"primary"}]'::jsonb,
   ARRAY['sales','repeat','funnel_mismatch'], false, true, false, false, 0, 'sum',
   false, false, true, false, 'Продажи', 351,
   'Продажи периода, которые являются второй и далее покупкой заказчика за всю историю (contact_id, по sold_at), но оформлены в ПЕРВИЧНОЙ воронке Битрикса (funnels.is_repeat = false). Измеряет зазор между «повторностью по истории» (как у ППП) и «повторностью по воронке»: столько повторных покупок менеджеры провели не через воронку повторных. Ноль — идеал.'),
  ('repeat_sales_in_primary_funnel_amount',
   'Сумма повторных продаж в первичной воронке', 'Сумма повт. в перв. вор.',
   'collected', 'money', 'deals', 'sum', 'amount', 'sold_at',
   '[{"op":"eq","field":"_repeat_hist","value":""},{"op":"eq","field":"funnel_type","value":"primary"}]'::jsonb,
   ARRAY['sales','repeat','funnel_mismatch','amount'], false, true, false, false, 0, 'sum',
   false, false, true, false, 'Продажи', 352,
   'Сумма продаж периода, которые являются второй и далее покупкой заказчика за всю историю (contact_id, по sold_at), но оформлены в ПЕРВИЧНОЙ воронке Битрикса. Денежная пара к «Кол-во повторных продаж в первичной воронке». Ноль — идеал.')
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters, tags = EXCLUDED.tags,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active, is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;
