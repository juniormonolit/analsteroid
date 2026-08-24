-- Migration 183: три новых отчёта «% вернувшихся клиентов» в витрине
-- «Повторные продажи» (задача #4996, заказчик Серёга, продолжение #4994).
-- БД: system (saved_reports). Накат с ноутбука:
--   node migrations/run_local.mjs migrations/183_returning_clients_showcase.sql
--
-- Макет заказчика: Когорта | Клиентов | % вернувшихся через 30/60/90/180/360
-- дней | Весь срок. Те же три когортных разреза, что у «Повторная выручка»
-- (миграция 176): Менеджеры / Периоды / Товарные группы. «Клиентов» —
-- cohort_clients (реактивированная миграцией 182 метрика; ПЕРВЫЙ черновик
-- этой миграции ставил сюда new_clients_count по совету комментария из
-- миграции 174 «отдельная метрика размера когорты не нужна» — прямая
-- SQL-проверка на разрезе «Периоды» это опровергла: new_clients_count в
-- разрезах period/product-group задваивает клиента между бакетами при
-- повторных покупках, см. подробный разбор в шапке миграции 182). Доли
-- cohort_return_rate_30..360/total — миграция 182.
--
-- Настройки строки скопированы с ЖИВЫХ (после 177/180) значений витрины
-- «Повторная выручка», а не с исходных из 176 — иначе следующий владелец,
-- открыв «% вернувшихся», увидел бы другой период/масштаб группы товаров, чем
-- в соседнем отчёте той же витрины: relative_period=год (180), comparison_
-- display='current' (177), product_group_mode='by_max' (180).
--
-- metric_ids ссылаются на РЕАКТИВИРОВАННЫЕ каталожные id из миграции 182
-- (cohort_return_rate_30..360 — существовали мёртвыми с ТЗ #1725, теперь
-- считаются; cohort_return_rate_total — новый). ЗАВИСИМОСТЬ ПОРЯДКА: 182
-- обязана накатиться раньше этой миграции — иначе withDependencies() не
-- найдёт calculated-метрику в каталоге и колонка останется пустой.
--
-- Идемпотентно: NOT EXISTS по (shared_section, name).

BEGIN;

INSERT INTO saved_reports
  (user_login, report_slug, name, metric_ids, is_shared, shared_section, sort_order,
   period_mode, relative_period, comparison_mode,
   deal_scope, client_type, grouping, comparison_display, product_group_mode, account_type,
   period_unit, period_dimension, compare_mode)
SELECT * FROM (VALUES
  ('admin', 'by-managers', 'Менеджеры — % вернувшихся клиентов',
   ARRAY['cohort_clients','cohort_return_rate_30','cohort_return_rate_60',
         'cohort_return_rate_90','cohort_return_rate_180','cohort_return_rate_360',
         'cohort_return_rate_total'],
   true, 'repeat', 16, 'relative', '{"anchor":"current","unit":"year"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'current', 'by_max', 'managers', NULL, NULL, NULL),
  ('admin', 'by-periods', 'Периоды — % вернувшихся клиентов',
   ARRAY['cohort_clients','cohort_return_rate_30','cohort_return_rate_60',
         'cohort_return_rate_90','cohort_return_rate_180','cohort_return_rate_360',
         'cohort_return_rate_total'],
   true, 'repeat', 17, 'relative', '{"anchor":"current","unit":"year"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'current', 'by_max', 'managers', 'month', 'managers', 'prev'),
  ('admin', 'by-product-groups', 'Товарные группы — % вернувшихся клиентов',
   ARRAY['cohort_clients','cohort_return_rate_30','cohort_return_rate_60',
         'cohort_return_rate_90','cohort_return_rate_180','cohort_return_rate_360',
         'cohort_return_rate_total'],
   true, 'repeat', 18, 'relative', '{"anchor":"current","unit":"year"}'::jsonb, 'previous_tail',
   'all', 'all', 'none', 'current', 'by_max', 'managers', NULL, NULL, NULL)
) AS v(user_login, report_slug, name, metric_ids, is_shared, shared_section, sort_order,
   period_mode, relative_period, comparison_mode,
   deal_scope, client_type, grouping, comparison_display, product_group_mode, account_type,
   period_unit, period_dimension, compare_mode)
WHERE NOT EXISTS (
  SELECT 1 FROM saved_reports sr
   WHERE sr.shared_section = 'repeat' AND sr.deleted_at IS NULL AND sr.name = v.name
);

COMMIT;
