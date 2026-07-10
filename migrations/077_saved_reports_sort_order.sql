-- Правка владельца 10.07 («Сделай так, чтобы в меню выбора отчетов админы могли
-- двигать их вверх вниз»): ручной порядок сохранённых отчётов в сайдбаре
-- (components/layout/AppShell.tsx). Порядок — ПЕР-РАЗДЕЛ: у витрин («Роп монитор» /
-- «Смекалочная») один общий порядок для всех пользователей (двигают админы/
-- суперадмин — то же право action.shared_reports.manage, что и на сохранение/
-- перезапись витрины); у личных отчётов — свой порядок у каждого пользователя
-- (двигает владелец). 076 занят на проде — см. бриф, следующий свободный номер 077.
--
-- sort_order — просто целое число, МЕНЬШЕ = ВЫШЕ в списке. Новые отчёты получают
-- MAX(sort_order)+1 в своём скоупе (см. nextSortOrder в app/api/saved-reports/route.ts) —
-- всегда в конец раздела. «Вверх»/«Вниз» (POST .../[id]/move) — обмен sort_order с
-- соседней по порядку записью того же скоупа.
--
-- Backfill существующих строк: по created_at внутри скоупа (COALESCE(shared_section,
-- 'personal:'||user_login) — отдельная последовательность для каждой витрины и для
-- личного списка каждого пользователя), чтобы после накатки порядок совпадал с тем,
-- что видел пользователь раньше (сортировка была created_at DESC — тут ASC внутри
-- скоупа, т.к. sort_order растёт «к концу списка»; при желании владелец потом
-- переставит вручную).
ALTER TABLE saved_reports ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(shared_section, 'personal:' || user_login)
      ORDER BY created_at
    ) AS rn
  FROM saved_reports
  WHERE deleted_at IS NULL
)
UPDATE saved_reports sr
   SET sort_order = ranked.rn
  FROM ranked
 WHERE sr.id = ranked.id;

CREATE INDEX IF NOT EXISTS saved_reports_sort_order_idx ON saved_reports (sort_order);
