-- Migration 177: витрина «Повторные продажи» — режим сравнения «Текущий»
-- БД: YC system (таблица saved_reports). Накат с ноутбука:
--   node migrations/run_local.mjs migrations/177_repeat_showcase_current_display.sql
--
-- Владелец 10.08 (следом за миграцией 176): «Во всех отчетах сверни метрики до
-- состояния сравнения "Текущий"». Применено к отчётам витрины «Повторные
-- продажи» (shared_section='repeat') — контекст запроса именно они; витрины
-- Стаса/Роп монитора не тронуты, там люди привыкли к своим режимам.
--
-- 'current' — режим колонок «только текущее значение», без «Пред./Δ/Δ%»
-- (ComparisonDisplay в lib/metrics/types.ts).

UPDATE saved_reports
   SET comparison_display = 'current'
 WHERE shared_section = 'repeat' AND deleted_at IS NULL;
