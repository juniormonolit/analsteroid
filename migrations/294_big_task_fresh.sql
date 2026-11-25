-- 294: индикатор «новое» на карточках канбана больших чеков (владелец 25.11: «при наличии новых действий или сообщений
--   в задаче или сделке — оповещение на карточке, чтобы работающий сразу видел, что есть новенькое»).
--   big_task_seen    — когда пользователь Монолитики последний раз открывал карточку задачи (task_id = 0 — точка отсчёта
--                      пользователя: включение фичи, чтобы при первом входе не загорелась вся доска).
--   big_task_lastmsg — последнее сообщение ЧЕЛОВЕКА в чате задачи (кэш: в Битрикс за чатом — только если сдвинулся
--                      ACTIVITY_DATE задачи; его двигают и служебные «задача просрочена», поэтому по нему одному нельзя).
-- БД: monolitika (systemDb), накат — под monolitik. Идемпотентна.
-- Откат: DROP TABLE big_task_seen, big_task_lastmsg;

CREATE TABLE IF NOT EXISTS big_task_seen (
  user_id  text NOT NULL,
  task_id  bigint NOT NULL,
  seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, task_id)
);

CREATE TABLE IF NOT EXISTS big_task_lastmsg (
  task_id     bigint PRIMARY KEY,
  chat_id     bigint,
  activity_at timestamptz,
  msg_at      timestamptz,
  msg_author  text,
  msg_author_name text,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Гранты роли приложения (как 291/293: копируем с repeat_kanban_events) ─────
DO $$
DECLARE r record; t text;
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
    FOREACH t IN ARRAY ARRAY['big_task_seen', 'big_task_lastmsg'] LOOP
      IF r.privs LIKE '%INSERT%' OR r.privs LIKE '%OWNER%' THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r.grantee);
      ELSE
        EXECUTE format('GRANT SELECT ON %I TO %I', t, r.grantee);
      END IF;
    END LOOP;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
