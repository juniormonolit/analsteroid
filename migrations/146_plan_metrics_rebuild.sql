-- Пересборка плановых метрик (задача владельца 03.08: «нужны вот такие метрики по
-- планам… коллеги выбирают не очевидные метрики — переименуй как я написал»).
-- БД: YC analytics (metrics).
--
-- МАТЕМАТИКА НЕ МЕНЯЕТСЯ: владелец подтвердил, что план продаж = план отгрузок / 0.8
-- (plan_n) — именно так код и считал. Меняются НАЗВАНИЯ (чтобы из списка было
-- очевидно, что выбираешь), СОСТАВ (16 видимых метрик вместо 12 видимых + 8
-- служебных) и семантика окна у процентов.
--
-- Итоговый набор — 16 видимых:
--   Планы продаж:   (месяц) / (дневной) / (на текущий день) / (период)
--   Планы отгрузок: те же четыре
--   % выполнения продаж:   (дневной) / (на текущий день) / (месяц) / (период)
--   % выполнения отгрузок: те же четыре
--
-- Что где взялось:
--   * «(дневной)» = план месяца / 20 — константа (plan_settings.daily_plan_mode
--     = divide20), НЕ зависит от числа рабочих дней в месяце;
--   * «(на текущий день)» = дневной × порядковый рабочий день месяца по
--     производственному календарю (working_calendar);
--   * «(период)» = сумма дневных планов по рабочим дням ВЫБРАННОГО в отчёте
--     периода — раньше это же число называлось «Таргет MTD (служебная)» и было
--     спрятано, поэтому владелец его не видел. Теперь видимое.
--   * % = факт СВОЕГО окна ÷ план того же окна (день / месяц-до-сегодня /
--     месяц / период) — раньше «% (месяц)» брал факт ПЕРИОДА, из-за чего при
--     недельном периоде показывал «неделя ÷ месячный план».
--
-- Удаляются дубликаты «(неделя)»: plan_execution_pct_*_week считали ровно то же
-- число, что «(день)» (см. комментарий в app/api/reports/run/route.ts) — две
-- метрики с одинаковым значением и были главной причиной путаницы.

-- ── 1. Единственная живая ссылка на удаляемую метрику: сохранённый «Стресс-отчет»
-- использовал plan_execution_pct_sales_week. Подменяем на новый id «(период)» —
-- это ТО ЖЕ число, отчёт ничего не теряет. (БД system, делается скриптом отдельно —
-- здесь только метрики; см. WORKLOG.)

-- ── 2. Планы: переименование под формулировки владельца ─────────────────────────
UPDATE metrics SET name_ru = 'План продаж (месяц)',            name_short_ru = 'План прод. (мес)',   sort_order = 800 WHERE id = 'plan_sales_month';
UPDATE metrics SET name_ru = 'План продаж (дневной)',           name_short_ru = 'План прод. (день)',  sort_order = 801 WHERE id = 'plan_sales_today';
UPDATE metrics SET name_ru = 'План продаж (на текущий день)',   name_short_ru = 'План прод. (тек)',   sort_order = 802 WHERE id = 'plan_sales_current_day';
UPDATE metrics SET name_ru = 'План отгрузок (месяц)',           name_short_ru = 'План отгр. (мес)',   sort_order = 810 WHERE id = 'plan_shipments_month';
UPDATE metrics SET name_ru = 'План отгрузок (дневной)',         name_short_ru = 'План отгр. (день)',  sort_order = 811 WHERE id = 'plan_shipments_today';
UPDATE metrics SET name_ru = 'План отгрузок (на текущий день)', name_short_ru = 'План отгр. (тек)',   sort_order = 812 WHERE id = 'plan_shipments_current_day';

-- «Таргет MTD (служебная)» → видимый «План … (период)» (то же число, был скрыт)
UPDATE metrics SET name_ru = 'План продаж (период)',   name_short_ru = 'План прод. (пер)', sort_order = 803,
       is_hidden_in_ui = false, is_active = true,
       description = 'Сумма дневных планов по рабочим дням выбранного периода (план месяца / 20 × будни периода). Выбран период из двух месяцев — получите план за два месяца.'
 WHERE id = 'plan_sales_target_mtd';
UPDATE metrics SET name_ru = 'План отгрузок (период)', name_short_ru = 'План отгр. (пер)', sort_order = 813,
       is_hidden_in_ui = false, is_active = true,
       description = 'Сумма дневных планов отгрузок по рабочим дням выбранного периода.'
 WHERE id = 'plan_shipments_target_mtd';

-- ── 3. Служебные факты: переименование смысла + новые окна ──────────────────────
UPDATE metrics SET name_ru = 'Факт продаж за период (служебная)'   WHERE id = 'sales_fact_mtd';
UPDATE metrics SET name_ru = 'Факт отгрузок за период (служебная)' WHERE id = 'shipments_fact_mtd';

INSERT INTO metrics (
  id, name_ru, name_short_ru, description, metric_type, data_type, formula, dependencies,
  decimal_places, aggregation_fn, category, sort_order,
  is_core, is_hidden_in_ui, is_active, is_test,
  source, agg_fn, agg_field, date_field, filters, tags, fill_ok, calc_ok, is_collect_ok, is_calc_ok
) VALUES
  ('sales_fact_today',      'Факт продаж за сегодня (служебная)',        NULL, NULL, 'external', 'money', NULL, ARRAY[]::text[], 0, 'sum', 'Планы', 840, false, true, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true),
  ('shipments_fact_today',  'Факт отгрузок за сегодня (служебная)',      NULL, NULL, 'external', 'money', NULL, ARRAY[]::text[], 0, 'sum', 'Планы', 841, false, true, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true),
  ('sales_fact_month',      'Факт продаж с начала месяца (служебная)',   NULL, NULL, 'external', 'money', NULL, ARRAY[]::text[], 0, 'sum', 'Планы', 842, false, true, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true),
  ('shipments_fact_month',  'Факт отгрузок с начала месяца (служебная)', NULL, NULL, 'external', 'money', NULL, ARRAY[]::text[], 0, 'sum', 'Планы', 843, false, true, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, is_active = EXCLUDED.is_active;

-- ── 4. Проценты выполнения: 4 окна × 2 направления ─────────────────────────────
-- Существующие два «(месяц)» — меняем числитель на факт МЕСЯЦА (был факт периода).
UPDATE metrics SET
  name_ru = 'Выполнение плана продаж, % (месяц)', name_short_ru = '% плана прод. (мес)',
  formula = '[sales_fact_month] / [plan_sales_month] * 100',
  dependencies = ARRAY['sales_fact_month','plan_sales_month'],
  sort_order = 822,
  description = 'Факт продаж с 1 числа текущего месяца по сегодня ÷ план продаж на месяц.'
 WHERE id = 'plan_execution_pct';
UPDATE metrics SET
  name_ru = 'Выполнение плана отгрузок, % (месяц)', name_short_ru = '% плана отгр. (мес)',
  formula = '[shipments_fact_month] / [plan_shipments_month] * 100',
  dependencies = ARRAY['shipments_fact_month','plan_shipments_month'],
  sort_order = 832,
  description = 'Факт отгрузок с 1 числа текущего месяца по сегодня ÷ план отгрузок на месяц.'
 WHERE id = 'plan_execution_pct_shipments_month';

-- Бывшие «(день)» считали «факт периода ÷ план периода» — это и есть «(период)».
UPDATE metrics SET
  name_ru = 'Выполнение плана продаж, % (период)', name_short_ru = '% плана прод. (пер)',
  formula = '[sales_fact_mtd] / [plan_sales_target_mtd] * 100',
  dependencies = ARRAY['sales_fact_mtd','plan_sales_target_mtd'],
  sort_order = 823,
  description = 'Факт продаж за выбранный период ÷ сумма дневных планов по рабочим дням этого периода.'
 WHERE id = 'plan_execution_pct_sales_day';
UPDATE metrics SET
  name_ru = 'Выполнение плана отгрузок, % (период)', name_short_ru = '% плана отгр. (пер)',
  formula = '[shipments_fact_mtd] / [plan_shipments_target_mtd] * 100',
  dependencies = ARRAY['shipments_fact_mtd','plan_shipments_target_mtd'],
  sort_order = 833,
  description = 'Факт отгрузок за выбранный период ÷ сумма дневных планов по рабочим дням этого периода.'
 WHERE id = 'plan_execution_pct_shipments_day';

-- Новые «(дневной)» и «(на текущий день)».
INSERT INTO metrics (
  id, name_ru, name_short_ru, description, metric_type, data_type, formula, dependencies,
  decimal_places, aggregation_fn, category, sort_order,
  is_core, is_hidden_in_ui, is_active, is_test,
  source, agg_fn, agg_field, date_field, filters, tags, fill_ok, calc_ok, is_collect_ok, is_calc_ok
) VALUES
  ('plan_exec_pct_sales_daily', 'Выполнение плана продаж, % (дневной)', '% плана прод. (день)',
   'Факт продаж за сегодня ÷ дневной план (план месяца / 20).',
   'calculated', 'percent', '[sales_fact_today] / [plan_sales_today] * 100',
   ARRAY['sales_fact_today','plan_sales_today'], 1, 'avg', 'Планы', 820,
   false, false, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true),
  ('plan_exec_pct_sales_current_day', 'Выполнение плана продаж, % (на текущий день)', '% плана прод. (тек)',
   'Факт продаж с начала месяца ÷ план на текущий день (дневной × прошедшие рабочие дни месяца).',
   'calculated', 'percent', '[sales_fact_month] / [plan_sales_current_day] * 100',
   ARRAY['sales_fact_month','plan_sales_current_day'], 1, 'avg', 'Планы', 821,
   false, false, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true),
  ('plan_exec_pct_shipments_daily', 'Выполнение плана отгрузок, % (дневной)', '% плана отгр. (день)',
   'Факт отгрузок за сегодня ÷ дневной план отгрузок.',
   'calculated', 'percent', '[shipments_fact_today] / [plan_shipments_today] * 100',
   ARRAY['shipments_fact_today','plan_shipments_today'], 1, 'avg', 'Планы', 830,
   false, false, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true),
  ('plan_exec_pct_shipments_current_day', 'Выполнение плана отгрузок, % (на текущий день)', '% плана отгр. (тек)',
   'Факт отгрузок с начала месяца ÷ план отгрузок на текущий день.',
   'calculated', 'percent', '[shipments_fact_month] / [plan_shipments_current_day] * 100',
   ARRAY['shipments_fact_month','plan_shipments_current_day'], 1, 'avg', 'Планы', 831,
   false, false, true, false, 'deals', NULL, NULL, NULL, '[]'::jsonb, ARRAY['plan']::text[], false, true, false, true)
ON CONFLICT (id) DO UPDATE SET
  name_ru = EXCLUDED.name_ru, name_short_ru = EXCLUDED.name_short_ru, description = EXCLUDED.description,
  formula = EXCLUDED.formula, dependencies = EXCLUDED.dependencies,
  metric_type = EXCLUDED.metric_type, data_type = EXCLUDED.data_type,
  decimal_places = EXCLUDED.decimal_places, aggregation_fn = EXCLUDED.aggregation_fn,
  category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
  is_hidden_in_ui = EXCLUDED.is_hidden_in_ui, is_active = EXCLUDED.is_active;

-- ── 5. Удаление дубликатов «(неделя)» и их служебных ────────────────────────────
DELETE FROM metrics WHERE id IN (
  'plan_execution_pct_sales_week', 'plan_execution_pct_shipments_week',
  'sales_fact_wtd', 'shipments_fact_wtd',
  'plan_sales_target_wtd', 'plan_shipments_target_wtd'
);
