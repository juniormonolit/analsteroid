-- 293: комментарий к карточке канбана больших чеков (Осипов 25.11: «поле комментарий в карточке, и чтоб выводилось
--   на карточке в канбане»). Один комментарий на задачу Битрикса, общий для всех, кто видит задачу; пишет РОП.
--   В Битрикс не уходит — это заметка РОПа на доске, не сообщение менеджеру (для этого чат задачи).
-- БД: monolitika (systemDb), накат — под monolitik. Идемпотентна.
-- Откат: DROP TABLE big_task_notes;

CREATE TABLE IF NOT EXISTS big_task_notes (
  task_id     bigint PRIMARY KEY,
  text        text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  author_id   text,
  author_name text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Гранты роли приложения (как 291: копируем с repeat_kanban_events) ─────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT grantee, string_agg(privilege_type, ', ') AS privs FROM (
      SELECT grantee::text, privilege_type::text FROM information_schema.role_table_grants
       WHERE table_name = 'repeat_kanban_events' AND table_schema = current_schema()
      UNION ALL
      SELECT tableowner::text, 'OWNER' FROM pg_tables WHERE tablename = 'repeat_kanban_events' AND schemaname = current_schema()
    ) x
     WHERE grantee <> current_user AND grantee <> 'PUBLIC'
     GROUP BY grantee
  LOOP
    IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON big_task_notes TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON big_task_notes TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
