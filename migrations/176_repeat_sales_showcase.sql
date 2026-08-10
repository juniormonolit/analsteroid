-- Migration 176: витрина «Повторные продажи» — 15 отчётов на новых метриках
-- БД: YC system (таблица saved_reports). Накат с ноутбука:
--   node migrations/run_local.mjs migrations/176_repeat_sales_showcase.sql
--
-- Задача владельца 10.08 (ночь): третья общая витрина «как Отчёты Стаса» с
-- преднастроенными отчётами по всем семьям раздела «Клиенты» (миграции 171–175).
--
-- ВАЖНАЯ НАХОДКА: секция shared_section='repeat' УЖЕ существовала с 13.07
-- (ТЗ #1725, 13 отчётов) — но была НЕВИДИМА: сайдбар рендерит только
-- rop_monitor/smekalochnaya, а три её слага (by-cohort, by-company,
-- by-next-product) не имеют ни страниц, ни движков. Мёртвая витрина на мёртвых
-- тогда метриках. Этой миграцией она пересобирается под список владельца;
-- старые строки — в saved_reports_backup_176 (вернуть можно всё).
--
-- Сопутствующий код (тот же коммит): AppShell/Главная рендерят секцию
-- «Повторные продажи», SaveReportModal даёт админам сохранять в неё,
-- типы/валидация принимают 'repeat'. CHECK-constraint уже включал 'repeat'.
--
-- Решения по дефолтам (скопированы с живых витринных отчётов):
--   * период относительный «текущий месяц», сравнение previous_tail;
--   * у отчётов «по периодам» — относительный «текущий год» (бакеты по месяцам
--     интереснее на годовом окне), шаг month, сравнение prev;
--   * «Товарная группа — Частота» — шкала by_max: считает по позициям
--     («так или иначе встречался»), на kc это была бы главная группа.

BEGIN;

CREATE TABLE IF NOT EXISTS saved_reports_backup_176 AS SELECT * FROM saved_reports WHERE false;
INSERT INTO saved_reports_backup_176
  SELECT * FROM saved_reports
   WHERE shared_section = 'repeat'
     AND NOT EXISTS (SELECT 1 FROM saved_reports_backup_176);

DELETE FROM saved_reports WHERE shared_section = 'repeat';

INSERT INTO saved_reports
  (user_login, report_slug, name, metric_ids, is_shared, shared_section, sort_order,
   period_mode, relative_period, comparison_mode,
   deal_scope, client_type, grouping, comparison_display, product_group_mode, account_type,
   period_unit, period_dimension, compare_mode)
VALUES
  -- ── 1. Repeat Rate ──────────────────────────────────────────────────────
  ('admin', 'by-managers', 'Менеджеры — Repeat Rate',
   ARRAY['new_clients_count','repeat_clients_delivered','repeat_rate_clients','new_clients_amount',
         'repeat_clients_amount','avg_orders_per_client','repeat_amount_share','complex_clients',
         'complex_clients_pct','avg_groups_per_client','avg_groups_per_order','avg_products_per_order'],
   true, 'repeat', 1, 'relative', '{"anchor":"current","unit":"month"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'full', 'kc', 'managers', NULL, NULL, NULL),
  ('admin', 'by-product-groups', 'Товарные группы — Repeat Rate',
   ARRAY['new_clients_count','repeat_clients_delivered','repeat_rate_clients','new_clients_amount',
         'repeat_clients_amount','avg_orders_per_client','repeat_amount_share','complex_clients',
         'complex_clients_pct','avg_groups_per_client','avg_groups_per_order','avg_products_per_order'],
   true, 'repeat', 2, 'relative', '{"anchor":"current","unit":"month"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'full', 'kc', 'managers', NULL, NULL, NULL),

  -- ── 2. Время ────────────────────────────────────────────────────────────
  ('admin', 'by-managers', 'Менеджеры — Время',
   ARRAY['median_time_to_2nd','median_time_between_orders','median_time_to_2nd_diff_cat','median_time_between_orders_diff_cat'],
   true, 'repeat', 3, 'relative', '{"anchor":"current","unit":"month"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'full', 'kc', 'managers', NULL, NULL, NULL),
  ('admin', 'by-product-groups', 'Товарные группы — Время',
   ARRAY['median_time_to_2nd','median_time_between_orders','median_time_to_2nd_diff_cat','median_time_between_orders_diff_cat'],
   true, 'repeat', 4, 'relative', '{"anchor":"current","unit":"month"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'full', 'kc', 'managers', NULL, NULL, NULL),

  -- ── 3. Контактируемость ─────────────────────────────────────────────────
  ('admin', 'by-managers', 'Менеджеры — Контактируемость',
   ARRAY['followup_clients_due','followup_clients_called','contactability_pct'],
   true, 'repeat', 5, 'relative', '{"anchor":"current","unit":"month"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'full', 'kc', 'managers', NULL, NULL, NULL),
  ('admin', 'by-product-groups', 'Товарные группы — Контактируемость',
   ARRAY['followup_clients_due','followup_clients_called','contactability_pct'],
   true, 'repeat', 6, 'relative', '{"anchor":"current","unit":"month"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'full', 'kc', 'managers', NULL, NULL, NULL),

  -- ── 4. Повторная выручка (LTV-когорты) ──────────────────────────────────
  ('admin', 'by-managers', 'Менеджеры — Повторная выручка',
   ARRAY['cohort_repeat_clients','cohort_first_revenue','cohort_repeat_revenue_30','cohort_repeat_revenue_60',
         'cohort_repeat_revenue_90','cohort_repeat_revenue_180','cohort_repeat_revenue_360','cohort_ltv_total_revenue'],
   true, 'repeat', 7, 'relative', '{"anchor":"current","unit":"month"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'full', 'kc', 'managers', NULL, NULL, NULL),
  ('admin', 'by-periods', 'Периоды — Повторная выручка',
   ARRAY['cohort_repeat_clients','cohort_first_revenue','cohort_repeat_revenue_30','cohort_repeat_revenue_60',
         'cohort_repeat_revenue_90','cohort_repeat_revenue_180','cohort_repeat_revenue_360','cohort_ltv_total_revenue'],
   true, 'repeat', 8, 'relative', '{"anchor":"current","unit":"year"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'full', 'kc', 'managers', 'month', 'managers', 'prev'),
  ('admin', 'by-product-groups', 'Товарные группы — Повторная выручка',
   ARRAY['cohort_repeat_clients','cohort_first_revenue','cohort_repeat_revenue_30','cohort_repeat_revenue_60',
         'cohort_repeat_revenue_90','cohort_repeat_revenue_180','cohort_repeat_revenue_360','cohort_ltv_total_revenue'],
   true, 'repeat', 9, 'relative', '{"anchor":"current","unit":"month"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'full', 'kc', 'managers', NULL, NULL, NULL),

  -- ── 5. Время жизни ──────────────────────────────────────────────────────
  ('admin', 'by-managers', 'Менеджеры — Время жизни',
   ARRAY['median_cycle_time_days','median_client_lifetime_months','avg_orders_per_client'],
   true, 'repeat', 10, 'relative', '{"anchor":"current","unit":"month"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'full', 'kc', 'managers', NULL, NULL, NULL),
  ('admin', 'by-product-groups', 'Товарные группы — Время жизни',
   ARRAY['median_cycle_time_days','median_client_lifetime_months','avg_orders_per_client'],
   true, 'repeat', 11, 'relative', '{"anchor":"current","unit":"month"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'full', 'kc', 'managers', NULL, NULL, NULL),

  -- ── 6–9. Компании / Заказчики / Доли / Частота ──────────────────────────
  ('admin', 'by-periods', 'Периоды — Компании',
   ARRAY['new_clients_count','first_repeat_clients','active_clients_90d'],
   true, 'repeat', 12, 'relative', '{"anchor":"current","unit":"year"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'full', 'kc', 'managers', 'month', 'managers', 'prev'),
  ('admin', 'by-clients', 'Заказчик — Заказы',
   ARRAY['client_days_since_last','client_order_frequency_days','client_ltv','client_categories_count'],
   true, 'repeat', 13, 'relative', '{"anchor":"current","unit":"month"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'full', 'kc', 'managers', NULL, NULL, NULL),
  ('admin', 'by-managers', 'Менеджеры — Доля компаний',
   ARRAY['all_clients_delivered','client_share_count_pct','client_share_amount_pct'],
   true, 'repeat', 14, 'relative', '{"anchor":"current","unit":"month"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'full', 'kc', 'managers', NULL, NULL, NULL),
  ('admin', 'by-product-groups', 'Товарные группы — Частота',
   ARRAY['group_buyers_count'],
   true, 'repeat', 15, 'relative', '{"anchor":"current","unit":"month"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'full', 'by_max', 'managers', NULL, NULL, NULL);

COMMIT;
