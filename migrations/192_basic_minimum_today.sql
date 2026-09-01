-- Миграция 192: отчёт «Базовый минимум» открывается за СЕГОДНЯ
-- БД: YC system. Накат:
--   node migrations/run_local.mjs migrations/192_basic_minimum_today.sql
--
-- Правка владельца 31.08: «при выборе отчёта "Базовый минимум" должен всегда
-- ставиться сегодняшний день». Сейчас у обоих отчётов с этим именем (общий в
-- «РОП мониторе» 4d82d6f0… и личная копия) period_mode=relative
-- {unit:month, anchor:current} — открывался текущий месяц. Меняем на
-- {unit:day, anchor:current}: resolveRelativePeriod (lib/saved-reports/period.ts)
-- резолвит его в «сегодня, живой срез по текущий момент» при КАЖДОМ открытии —
-- ровно просьба владельца, без изменений кода. Пересохранение отчёта с другим
-- периодом это, как и раньше, перепишет.

UPDATE saved_reports
SET period_mode = 'relative',
    relative_period = '{"unit": "day", "anchor": "current"}'::jsonb,
    fixed_period = NULL
WHERE name ILIKE 'базовый минимум' AND deleted_at IS NULL;

-- Проверка: у обоих должен быть {unit: day, anchor: current}.
SELECT id, name, is_shared, relative_period FROM saved_reports WHERE name ILIKE 'базовый минимум';
