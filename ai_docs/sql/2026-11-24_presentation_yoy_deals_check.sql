-- Сверка «Год к году» презентации со «Сделками» отчёта по менеджерам (жалоба 24.11).
-- READ-ONLY. Прод: БД monolitika (схема sa + system-таблицы employees/metrics там же).
-- Запуск: psql ... -v dept='Департамент ОС' -f 2026-11-24_presentation_yoy_deals_check.sql
-- Окно: 1–23 ноября 2026 против 1–23 ноября 2025, полночь МСК.
\set ON_ERROR_STOP on
BEGIN READ ONLY;

-- 1. Определения метрик каталога, которыми теперь считает презентация.
SELECT id, name_ru, agg_fn, agg_field, date_field, filters::text, is_active
  FROM metrics WHERE id IN ('deals_count', 'primary_deals_count', 'primary_created_count');

-- 2. Сделки отдела: старая формула презентации против новой (каталог + население «Итого» отчёта).
WITH RECURSIVE root AS (
  SELECT bitrix_department_id FROM sa.departments
   WHERE is_active AND name ILIKE :'dept' || '%'
), tree AS (
  SELECT bitrix_department_id FROM root
  UNION
  SELECT d.bitrix_department_id FROM sa.departments d JOIN tree t ON d.parent_bitrix_department_id = t.bitrix_department_id
   WHERE d.is_active
), mgr AS (
  SELECT orh.manager_bitrix_user_id::int AS mgr,
         coalesce(lower(e.bitrix_login) LIKE 'manager%', false) AS is_report_row
    FROM sa.org_resolved_hierarchy orh
    JOIN sa.departments dp ON dp.id = orh.department_id
    LEFT JOIN employees e ON e.bitrix_user_id::text = orh.manager_bitrix_user_id::text AND e.is_active
   WHERE orh.is_active AND dp.bitrix_department_id IN (SELECT bitrix_department_id FROM tree)
), w(win, f, t) AS (VALUES
  ('2026', timestamptz '2026-11-01 00:00+03', timestamptz '2026-11-24 00:00+03'),
  ('2025', timestamptz '2025-11-01 00:00+03', timestamptz '2025-11-24 00:00+03')
)
SELECT w.win,
       count(*)                                                        AS old_all_roster,       -- было в презентации («Входящие»)
       count(*) FILTER (WHERE m.is_report_row)                         AS all_report_rows,      -- ≈ deals_count в «Итого» отчёта
       count(*) FILTER (WHERE m.is_report_row AND NOT coalesce(fn.is_repeat,false)) AS primary_report_rows, -- ≈ primary_deals_count
       count(*) FILTER (WHERE m.is_report_row AND fn.is_repeat)        AS repeat_report_rows,
       count(*) FILTER (WHERE NOT m.is_report_row)                     AS not_report_rows       -- РОПы/логисты/служебные, отчёт их не показывает
  FROM w
  JOIN sa.deals d ON d.created_at >= w.f AND d.created_at < w.t
  JOIN mgr m ON m.mgr = d.current_manager_id
  LEFT JOIN sa.funnels fn ON fn.id = d.funnel_id
 GROUP BY w.win ORDER BY w.win DESC;

-- 3. «Эффект выживших» прошлого года: сделки ноября 2025 всей компании, чей ТЕКУЩИЙ менеджер
--    уже неактивен (уволен/выведен) — в год-к-году по отделу они не попадают ни в отчёте, ни в презентации.
SELECT count(*) FILTER (WHERE orh.manager_bitrix_user_id IS NULL) AS deals_2025_of_inactive_managers,
       count(*)                                                    AS deals_2025_total
  FROM sa.deals d
  LEFT JOIN sa.org_resolved_hierarchy orh
         ON orh.manager_bitrix_user_id::text = d.current_manager_id::text AND orh.is_active
 WHERE d.created_at >= timestamptz '2025-11-01 00:00+03' AND d.created_at < timestamptz '2025-11-24 00:00+03';

ROLLBACK;
