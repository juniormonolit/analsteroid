-- 301: «Сторож увольнений» следит за несколькими чатами (владелец 27.11: «вот за этим чатом тоже надо следить. Тут
-- стажёры чисто — „Увольнение стажеров (Обучение/Адаптация)“»). У каждого чата свой курсор; код —
-- features/dismissal/watch/watcher.ts (loadChats/pollOne). Курсор основного чата переносится из
-- dismissal_watch_settings (старые объявления не перечитываются); у нового чата курсор NULL — первый опрос встанет на
-- последнее сообщение. settings.chat_id/cursor после 301 кодом не читаются (оставлены для отката).
-- БД: monolitika (systemDb), накат — под monolitik. Идемпотентна. Откат: DROP TABLE dismissal_watch_chats.

CREATE TABLE IF NOT EXISTS dismissal_watch_chats (
  chat_id     text PRIMARY KEY,                -- 'chat226952'
  title       text NOT NULL,                   -- как называть в сообщениях бота
  enabled     boolean NOT NULL DEFAULT true,
  cursor      bigint,                          -- id последнего обработанного сообщения; NULL — встать на последнее
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO dismissal_watch_chats (chat_id, title, cursor)
SELECT s.chat_id, 'Увольнения', s.cursor FROM dismissal_watch_settings s WHERE s.id = 1
ON CONFLICT (chat_id) DO NOTHING;

INSERT INTO dismissal_watch_chats (chat_id, title, cursor)
VALUES ('chat785030', 'Увольнение стажеров (Обучение/Адаптация)', NULL)
ON CONFLICT (chat_id) DO NOTHING;

-- ── Гранты роли приложения (как 287/291: копируем с repeat_kanban_events) ─────
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
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON dismissal_watch_chats TO %I', r.grantee);
    ELSE
      EXECUTE format('GRANT SELECT ON dismissal_watch_chats TO %I', r.grantee);
    END IF;
    RAISE NOTICE 'grants → % (на repeat_kanban_events: %)', r.grantee, r.privs;
  END LOOP;
END $$;
