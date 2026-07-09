-- БД: YC analytics (run_analytics.mjs). НЕ применять локально — накатывает Артём на проде.
--
-- Диагноз Маркуса (09.07): пилюля «Первичные/Повторные» (dealScope) резала ППП/ППО —
-- эти метрики считают "N-ю по счёту сделку клиента за ВСЮ историю" (contact_id), они
-- не про воронку сделки, попавшей в период, а про историю клиента. Баг: 107→12 на ППП
-- за 01-08.07 при фильтре «Первичные».
--
-- Фикс на стороне кода (features/reports/engine/{byManagers,byProductGroups,bySources}.ts::
-- aggregate()): метрики с тегом 'scope_independent' в metrics.tags больше не фильтруются
-- по dealScope (funnel_id primary/repeat), но по-прежнему фильтруются по clientType (б2б/б2с).
-- Эта миграция — источник правды тега для существующих ППП/ППО и для новых ППБ/ПППБ.

-- 1) Пометить существующие ППП/ППО как scope-independent
UPDATE metrics SET tags = array_append(tags, 'scope_independent')
WHERE id IN ('ppp_count', 'ppp_amount', 'ppo_count', 'ppo_amount')
  AND NOT ('scope_independent' = ANY(tags));

-- 2) Новые метрики: ППБ (вторая по счёту БРОНЬ клиента, reserved_at) и
--    ПППБ (вторая ПОДТВЕРЖДЁННАЯ бронь клиента, confirmed_at). Формула ранжирования
--    (ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY reserved_at/confirmed_at) rn=2,
--    contact_id IS NOT NULL) живёт в lib/metrics/sqlGen.ts::resolveFilterClause
--    (поля _ppb / _pppb), по аналогии с _ppp/_ppo.
INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'ppb_count', 'ППБ (кол-во)', 'ППБ', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'reserved_at',
  '[{"field":"_ppb","op":"eq","value":""}]'::jsonb,
  ARRAY['scope_independent'], false, true, false, false, 0, 'sum', false, false, true, false,
  'Продажи', 343, 'Вторая по счёту БРОНЬ клиента за всю историю (contact_id), попавшая датой reserved_at в период. Не зависит от пилюли Первичные/Повторные.'
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters, tags = EXCLUDED.tags,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'ppb_amount', 'Сумма ППБ', 'Сумма ППБ', 'collected', 'money', 'deals', 'sum', 'amount', 'reserved_at',
  '[{"field":"_ppb","op":"eq","value":""}]'::jsonb,
  ARRAY['scope_independent'], false, true, false, false, 0, 'sum', false, false, true, false,
  'Продажи', 344, 'Сумма второй по счёту БРОНИ клиента за всю историю. Не зависит от пилюли Первичные/Повторные.'
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters, tags = EXCLUDED.tags,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'pppb_count', 'ПППБ (кол-во)', 'ПППБ', 'collected', 'int', 'deals', 'count_distinct', 'deal_id', 'confirmed_at',
  '[{"field":"_pppb","op":"eq","value":""}]'::jsonb,
  ARRAY['scope_independent'], false, true, false, false, 0, 'sum', false, false, true, false,
  'Продажи', 345, 'Вторая по счёту ПОДТВЕРЖДЁННАЯ БРОНЬ клиента за всю историю (contact_id), попавшая датой confirmed_at в период. Не зависит от пилюли Первичные/Повторные.'
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters, tags = EXCLUDED.tags,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;

INSERT INTO metrics (id, name_ru, name_short_ru, metric_type, data_type, source, agg_fn, agg_field, date_field, filters, tags, is_core, is_active, is_hidden_in_ui, is_test, decimal_places, aggregation_fn, fill_ok, calc_ok, is_collect_ok, is_calc_ok, category, sort_order, description)
VALUES (
  'pppb_amount', 'Сумма ПППБ', 'Сумма ПППБ', 'collected', 'money', 'deals', 'sum', 'amount', 'confirmed_at',
  '[{"field":"_pppb","op":"eq","value":""}]'::jsonb,
  ARRAY['scope_independent'], false, true, false, false, 0, 'sum', false, false, true, false,
  'Продажи', 346, 'Сумма второй по счёту ПОДТВЕРЖДЁННОЙ БРОНИ клиента за всю историю. Не зависит от пилюли Первичные/Повторные.'
)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  source = EXCLUDED.source, agg_fn = EXCLUDED.agg_fn, agg_field = EXCLUDED.agg_field,
  date_field = EXCLUDED.date_field, filters = EXCLUDED.filters, tags = EXCLUDED.tags,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_collect_ok = EXCLUDED.is_collect_ok, description = EXCLUDED.description;
