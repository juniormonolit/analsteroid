-- 284: доля повторных продаж в плане отдела (задача владельца 23.11).
-- «Сделать план по повторным продажам на текущий день, он должен считаться коэффициентом
-- от общего плана, который задаётся на каждый отдел: на МСК ОС я поставлю долю повторных
-- продаж 40 %, и если план условно 100, то план (повт.) 40».
--
-- Отдел = пара «филиал:категория» — те же ключи, что у plan_targets_year.scope='department'
-- (миграция 047) и у резолвера lib/org/deptCategories.ts (ANCESTOR_ANCHORS): 'МСК:ОС',
-- 'СПБ:НЦ ЖБИ' и т.д. Менеджер получает долю своего отдела; план менеджера (повт.) =
-- его план продаж × доля. Нет строки — доли нет, план (повт.) не считается (не 0 и не дефолт).
--
-- БД: monolitika (systemDb). Накат — под monolitik. Идемпотентна.
-- Откат: DROP TABLE dept_repeat_plan_share;

CREATE TABLE IF NOT EXISTS dept_repeat_plan_share (
  dept_key          text PRIMARY KEY,                 -- 'МСК:ОС'
  repeat_share_pct  numeric(5,2) NOT NULL CHECK (repeat_share_pct >= 0 AND repeat_share_pct <= 100),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        text                              -- логин/имя того, кто менял (для показа)
);

-- Права роли приложения — по образцу соседней таблицы планов (manager_plans):
-- кто может в неё писать, получает запись и сюда, остальные — чтение.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT grantee, string_agg(privilege_type, ', ') AS privs FROM (
      SELECT grantee::text, privilege_type::text FROM information_schema.role_table_grants
       WHERE table_name = 'manager_plans' AND table_schema = current_schema()
      UNION ALL
      SELECT tableowner::text, 'OWNER' FROM pg_tables WHERE tablename = 'manager_plans' AND schemaname = current_schema()
    ) x
     WHERE grantee <> current_user AND grantee <> 'PUBLIC'
     GROUP BY grantee
  LOOP
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON dept_repeat_plan_share TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON dept_repeat_plan_share TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на manager_plans: %)', r.grantee, r.privs;
  END LOOP;
END $$;
