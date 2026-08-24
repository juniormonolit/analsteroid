-- Migration 181: «Коэфф. повторной выручки» в витрине «Повторная выручка» (задача #4994,
-- заказчик Серёга). БД: system (saved_reports). Накат с ноутбука:
--   node migrations/run_local.mjs migrations/181_repeat_revenue_ratio_column.sql
--
-- Метрика cohort_repeat_ratio = «Коэффициент повторной выручки» уже существует в
-- каталоге с 10.08 (миграция 174, metric_type='calculated', data_type='decimal',
-- decimal_places=2, formula '[cohort_ltv_total_revenue] / [cohort_first_revenue]',
-- dependencies [cohort_ltv_total_revenue, cohort_first_revenue]). Формула ровно
-- совпадает с ТЗ владельца: (Первые заказы + Повторная выручка) / Первые заказы,
-- потому что cohort_ltv_total_revenue уже включает первый заказ («LTV за все
-- время» = сумма всех отгрузок повторных клиентов когорты, включая первую).
-- Деление на ноль (нет первых заказов) даёт null в computeCalculated (isFinite
-- проверка) → formatValue рисует «—»; в «Итого» пересчитывается из СУММ строк
-- (computeTotals → computeCalculated), не как среднее по строкам — оба свойства
-- получены бесплатно от существующего движка, доп. кода не потребовалось.
--
-- Метрика просто не попала в metric_ids трёх отчётов «Повторная выручка» при
-- пересборке витрины (миграция 176, та же ночь 10.08) — добавляем последней
-- колонкой (после «LTV за все время»). Зависимости (cohort_ltv_total_revenue,
-- cohort_first_revenue) уже в каждом из трёх отчётов и так — withDependencies
-- их всё равно подтянул бы, но раз они и без того запрошены, новых полей в SQL
-- движка clientMetrics.ts это не добавляет. Сортировка по клику на заголовок —
-- сквозной механизм ReportTable (handleSort по m.id), доп. кода не требует.
--
-- Идемпотентно: array_append только если id ещё не в массиве.

BEGIN;

UPDATE saved_reports
   SET metric_ids = array_append(metric_ids, 'cohort_repeat_ratio')
 WHERE shared_section = 'repeat'
   AND deleted_at IS NULL
   AND name IN ('Менеджеры — Повторная выручка', 'Периоды — Повторная выручка', 'Товарные группы — Повторная выручка')
   AND NOT ('cohort_repeat_ratio' = ANY(metric_ids));

COMMIT;
